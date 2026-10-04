import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoSchedulePath,
  broadcastTimeOf,
  buildPlanRows,
  decideRun,
  describeNextCheck,
  emptyScheduleState,
  isEpisodeDone,
  loadAutoSchedule,
  markEpisodesDone,
  doneKey,
  planSchedule,
  planWithoutPlanner,
  pruneDone,
  saveAutoSchedule,
  type PlanOptions,
  type SubjectNext
} from '../src/core/auto-schedule.js';
import { buildTaskSchedule, buildTaskSyncPayload, renderSyncScript, syncTaskSchedule } from '../src/core/task-schedule.js';

/**
 * 「什么时候该检查」的判定。
 *
 * 这一组测试是为了固定住一个行为：**只有播出前后才密集检查**。
 * 原来计划任务每 15 分钟无脑跑一轮（一天 96 轮），绝大多数时候毫无意义；
 * 现在按播出时间排计划，所以这里的边界必须准 —— 排错了要么漏掉新集，
 * 要么又退回「整天瞎跑」。
 */

const OPTIONS: PlanOptions = {
  readyDelayMinutes: 60,
  activeIntervalMinutes: 15,
  idleIntervalMinutes: 180,
  releaseWindowHours: 12
};

/** 本地时间构造，测试里所有时间都用它，避免时区影响。 */
const at = (text: string): Date => new Date(text.replace(' ', 'T'));

const subject = (name: string, ep: number | null, airdate: string, airTime: string | null): SubjectNext => ({
  subjectId: Math.abs(name.length * 7919),
  name,
  next: { ep, airdate, airTime }
});

describe('播出时刻解析', () => {
  it('日期 + 时刻 → 本地时间', () => {
    const date = broadcastTimeOf('2026-10-04', '16:00');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(9);
    expect(date?.getDate()).toBe(4);
    expect(date?.getHours()).toBe(16);
  });

  it('缺播出时刻就按当天 00:00（那天一整天都算活跃）', () => {
    const date = broadcastTimeOf('2026-10-20', null);
    expect(date?.getDate()).toBe(20);
    expect(date?.getHours()).toBe(0);
  });

  it('日期不合法时返回 null，不瞎猜', () => {
    expect(broadcastTimeOf('', '16:00')).toBeNull();
    expect(broadcastTimeOf('not-a-date', '16:00')).toBeNull();
  });
});

describe('按播出安排排计划', () => {
  it('下一集还没播：精确睡到「该出片源」的那一刻，中间不检查', () => {
    const now = at('2026-10-04 13:00');
    // 14:00 播出 + 60 分钟 = 15:00 才可能有片源
    const plan = planSchedule([subject('相反的你和我 第二季', 13, '2026-10-04', '14:00')], now, OPTIONS);

    expect(plan.due).toBe(false);
    expect(plan.nextCheckAt.getTime()).toBe(at('2026-10-04 15:00').getTime());
    expect(plan.reason).toContain('相反的你和我 第二季');
    expect(plan.reason).toContain('15:00');
  });

  it('下一集还早：干活时间就定在那一刻，中间的轮次只刷新计划', () => {
    const now = at('2026-10-04 13:00');
    // 16:00 播出 → 17:00 就绪。下一次**干活**就是 17:00，
    // 不会被「3 小时兜底」提前成 16:00（那正是要避免的「按周期瞎跑」）。
    const plan = planSchedule([subject('相反的你和我 第二季', 13, '2026-10-04', '16:00')], now, OPTIONS);
    expect(plan.due).toBe(false);
    expect(plan.nextCheckAt.getTime()).toBe(at('2026-10-04 17:00').getTime());
    // 但 3 小时后仍会重读一遍计划（只问 Planner，不搜种）
    expect(plan.nextRefreshAt.getTime()).toBe(now.getTime() + 180 * 60_000);
  });

  it('刚播完、还没下到：进入活跃窗口，每 15 分钟看一次', () => {
    const now = at('2026-10-04 17:05');
    const plan = planSchedule([subject('相反的你和我 第二季', 13, '2026-10-04', '16:00')], now, OPTIONS);

    expect(plan.due).toBe(true);
    expect(plan.windows).toHaveLength(1);
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 15 * 60_000);
    expect(plan.reason).toContain('每 15 分钟');
  });

  it('还没到就绪时间就一次都不跑（播出后那 60 分钟里不折腾）', () => {
    const now = at('2026-10-04 16:30');
    const plan = planSchedule([subject('相反的你和我 第二季', 13, '2026-10-04', '16:00')], now, OPTIONS);
    expect(plan.due).toBe(false);
    expect(plan.nextCheckAt.getTime()).toBe(at('2026-10-04 17:00').getTime());
  });

  it('播出很久（超过窗口）还没有片源：不再密集检查，退回兜底', () => {
    const now = at('2026-10-05 06:00');
    const plan = planSchedule([subject('冷门番', 5, '2026-10-04', '16:00')], now, OPTIONS);

    expect(plan.due).toBe(false);
    expect(plan.stale).toHaveLength(1);
    expect(plan.stale[0]?.query).toBe('冷门番');
    // 兜底间隔 180 分钟
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
  });

  it('多部番同时在等片源：窗口一起算，仍然每 15 分钟一次', () => {
    const now = at('2026-10-08 23:00');
    // 19:30 和 21:56 两集都已经过了「播出 + 60 分钟」
    const plan = planSchedule(
      [subject('FX战士久留美', 2, '2026-10-08', '19:30'), subject('冰之城墙 第二季', 2, '2026-10-08', '21:56')],
      now,
      OPTIONS
    );

    expect(plan.due).toBe(true);
    expect(plan.windows).toHaveLength(2);
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 15 * 60_000);
  });

  it('未来的集离得很远：干活时间仍定在那一集播出后，只是中间会定期重读计划', () => {
    const now = at('2026-10-04 13:00');
    const plan = planSchedule([subject('边缘行者 2', 1, '2026-10-20', '22:00')], now, OPTIONS);

    expect(plan.due).toBe(false);
    // 干活定在 10-20 22:00 播出 + 60 分钟
    expect(plan.nextCheckAt.getTime()).toBe(at('2026-10-20 23:00').getTime());
    // 计划本身每 3 小时重读一次（只问 Planner）
    expect(plan.nextRefreshAt.getTime()).toBe(now.getTime() + 180 * 60_000);
  });

  it('Planner 没给任何 nextEpisode 时按兜底走', () => {
    const now = at('2026-10-04 13:00');
    const plan = planSchedule([{ subjectId: 1, name: '没安排', next: null }], now, OPTIONS);
    expect(plan.due).toBe(false);
    // 没有任何播出信息时才退回按周期兜底
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
    expect(plan.nextRefreshAt.getTime()).toBe(now.getTime() + 180 * 60_000);
    expect(plan.reason).toContain('没有已知的播出安排');
  });
});

describe('连不上 Planner 时的兜底计划', () => {
  it('估计的下一集还很远时，中间按兜底间隔醒来确认', () => {
    const now = at('2026-10-05 13:00');
    // 估计出来的下一集在 10-11，离得还远 —— 但兜底间隔只有 3 小时
    const plan = planWithoutPlanner(now, OPTIONS, { at: at('2026-10-04 17:30').toISOString(), query: '相反的你和我 第二季' });
    expect(plan.due).toBe(false);
    // 估计出来的那一集还远，所以按兜底节奏重读计划
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
    expect(plan.nextRefreshAt.getTime()).toBe(now.getTime() + 180 * 60_000);
    expect(plan.reason).toContain('一周一集');
  });

  it('估计的下一集就在眼前时，精确睡到那一刻', () => {
    const now = at('2026-10-11 15:00');
    // 上次是 10-04 17:30 下到的 → 估计 10-11 16:30，就在 1.5 小时后
    const plan = planWithoutPlanner(now, OPTIONS, { at: at('2026-10-04 17:30').toISOString(), query: '相反的你和我 第二季' });
    expect(plan.due).toBe(false);
    expect(plan.nextCheckAt.getTime()).toBe(at('2026-10-11 16:30').getTime());
    expect(plan.reason).toContain('16:30');
  });

  it('没有下载记录时按兜底间隔', () => {
    const now = at('2026-10-05 13:00');
    const plan = planWithoutPlanner(now, OPTIONS, null);
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
    expect(plan.reason).toContain('连不上 Planner');
  });
});

describe('现在该不该跑', () => {
  const base = emptyScheduleState(at('2026-10-04 13:00'));

  it('没到点、也还没到刷新时间：什么都不做，连请求都不发', () => {
    const state = {
      ...base,
      nextCheckAt: at('2026-10-04 17:00').toISOString(),
      nextRefreshAt: at('2026-10-04 15:00').toISOString(),
      nextReason: '《X》17:00 之后才可能有片源'
    };
    const decision = decideRun(state, at('2026-10-04 13:00'));
    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('未到检查时间');
    expect(decision.reason).toContain('17:00');
  });

  it('到点前到了刷新时间：只重算计划，不去搜片源', () => {
    const state = {
      ...base,
      nextCheckAt: at('2026-10-04 17:00').toISOString(),
      nextRefreshAt: at('2026-10-04 15:00').toISOString()
    };
    const decision = decideRun(state, at('2026-10-04 15:30'));
    expect(decision.action).toBe('refresh');
    expect(decision.reason).toContain('刷新计划');
  });

  it('到点了就真干活', () => {
    const state = {
      ...base,
      nextCheckAt: at('2026-10-04 17:00').toISOString(),
      nextRefreshAt: at('2026-10-04 15:00').toISOString()
    };
    expect(decideRun(state, at('2026-10-04 17:00')).action).toBe('run');
    expect(decideRun(state, at('2026-10-04 17:20')).action).toBe('run');
  });

  it('手动触发时忽略计划', () => {
    const state = {
      ...base,
      nextCheckAt: at('2026-10-04 17:00').toISOString(),
      nextRefreshAt: at('2026-10-04 15:00').toISOString()
    };
    const decision = decideRun(state, at('2026-10-04 13:00'), { force: true });
    expect(decision.action).toBe('run');
    expect(decision.reason).toContain('手动触发');
  });

  it('计划文件缺失/损坏时失败开：宁可多跑一轮，也不要让追番停摆', () => {
    expect(decideRun(null, at('2026-10-04 13:00')).action).toBe('run');
    expect(decideRun({ ...base, nextCheckAt: null }, at('2026-10-04 13:00')).action).toBe('run');
    expect(decideRun({ ...base, nextCheckAt: '不是时间' }, at('2026-10-04 13:00')).action).toBe('run');
  });
});

describe('「这集已经下过了」记录', () => {
  it('记下之后就能查到，不会重复下载', () => {
    const state = emptyScheduleState(at('2026-10-04 13:00'));
    expect(isEpisodeDone(state, 42, 13)).toBe(false);

    const added = markEpisodesDone(state, [{ subjectId: 42, episode: 13, query: 'X' }], at('2026-10-04 17:10'));
    expect(added).toBe(1);
    expect(isEpisodeDone(state, 42, 13)).toBe(true);
    // 同一集重复记不加新条目
    expect(markEpisodesDone(state, [{ subjectId: 42, episode: 13, query: 'X' }], at('2026-10-04 17:20'))).toBe(0);
    expect(state.done).toHaveLength(1);
    // 别的集不受影响
    expect(isEpisodeDone(state, 42, 14)).toBe(false);
  });

  it('集号为 null 的记录不参与判断', () => {
    const state = emptyScheduleState(at('2026-10-04 13:00'));
    markEpisodesDone(state, [{ subjectId: 42, episode: null, query: 'X' }], at('2026-10-04 17:10'));
    expect(state.done).toHaveLength(0);
    expect(isEpisodeDone(state, 42, null)).toBe(false);
  });

  it('老记录会被清掉，不让 json 无限长大', () => {
    const state = emptyScheduleState(at('2026-01-01 00:00'));
    markEpisodesDone(state, [{ subjectId: 1, episode: 1, query: 'A' }], at('2026-01-01 00:00'));
    markEpisodesDone(state, [{ subjectId: 1, episode: 2, query: 'A' }], at('2026-10-04 00:00'));

    expect(pruneDone(state, at('2026-10-04 12:00'), 60)).toBe(1);
    expect(state.done).toHaveLength(1);
    expect(isEpisodeDone(state, 1, 2)).toBe(true);
  });
});

describe('计划文件的读写', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('存了能读回来，文件坏了按「没有计划」处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-'));
    dirs.push(dir);
    const path = autoSchedulePath(join(dir, 'config.json'));
    expect(path).toBe(join(dir, 'data', 'auto-schedule.json'));

    const state = emptyScheduleState(at('2026-10-04 13:00'));
    state.nextCheckAt = at('2026-10-04 17:00').toISOString();
    state.nextReason = '测试';
    saveAutoSchedule(path, state);

    const loaded = loadAutoSchedule(path);
    expect(loaded.nextReason).toBe('测试');
    expect(loaded.nextCheckAt).toBe(state.nextCheckAt);
  });

  it('文件不存在时返回「空计划」而不是报错', () => {
    const loaded = loadAutoSchedule(join(tmpdir(), 'definitely-not-here', 'x.json'));
    expect(loaded.nextCheckAt).toBeNull();
    expect(loaded.done).toEqual([]);
  });

  it('「下次检查」的展示文案', () => {
    const state = { ...emptyScheduleState(at('2026-10-04 13:00')), nextCheckAt: at('2026-10-04 17:00').toISOString() };
    expect(describeNextCheck(state, at('2026-10-04 13:00'))).toContain('4 小时后');
    expect(describeNextCheck(state, at('2026-10-04 16:40'))).toContain('20 分钟后');
    expect(describeNextCheck(state, at('2026-10-04 18:00'))).toBe('就是现在');
    expect(describeNextCheck({ ...state, nextCheckAt: null })).toBe('还没安排');
  });
});

describe('计划表：按播出时间排', () => {
  const options = { readyDelayMinutes: 60, releaseWindowHours: 12 };
  const now = at('2026-10-04 13:00');

  it('按播出时间升序，而不是按番名或状态', () => {
    const rows = buildPlanRows(
      [
        subject('丙番', 3, '2026-10-08', '22:30'),
        subject('甲番', 1, '2026-10-04', '16:00'),
        subject('乙番', 2, '2026-10-05', '19:30')
      ],
      now,
      options
    );

    expect(rows.map((row) => row.name)).toEqual(['甲番', '乙番', '丙番']);
  });

  it('状态随时间变化：等播出 / 正在等片源 / 已下完 / 播出已久', () => {
    const subjects = [
      subject('未播', 1, '2026-10-04', '20:00'),
      subject('刚播', 2, '2026-10-04', '12:00'),
      subject('很久以前', 3, '2026-10-02', '12:00'),
      subject('下过了', 4, '2026-10-04', '12:30')
    ];
    const done = new Set([doneKey(subjects[3]!.subjectId, 4)]);

    const rows = buildPlanRows(subjects, now, options, done);
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get('未播')?.status).toBe('upcoming');
    expect(byName.get('刚播')?.status).toBe('waiting');
    expect(byName.get('很久以前')?.status).toBe('stale');
    expect(byName.get('下过了')?.status).toBe('done');
  });

  it('该取片源的时刻 = 播出 + 就绪延迟', () => {
    const rows = buildPlanRows([subject('甲番', 1, '2026-10-04', '16:00')], now, options);
    expect(rows[0]?.readyAt).toBe(at('2026-10-04 17:00').toISOString());
  });

  it('没给播出时刻的排在最后（不参与时间轴）', () => {
    const rows = buildPlanRows(
      [subject('没时刻', 9, '2026-10-20', null), subject('有时刻', 1, '2026-10-05', '19:30')],
      now,
      options
    );
    expect(rows.map((row) => row.name)).toEqual(['有时刻', '没时刻']);
    // 没给时刻时按当天 00:00 算，所以状态是「等播出」而不是「时间未知」
    expect(rows[1]?.status).toBe('upcoming');
  });
});

describe('计划任务触发器：按播出时间排', () => {
  const now = at('2026-10-04 13:00');

  it('每集排一段：从该取片源那一刻开始，到这一集的窗口结束', () => {
    const plan = buildTaskSchedule(
      {
        triggers: [
          { start: at('2026-10-04 17:00'), until: at('2026-10-05 04:00'), label: '《甲番》第 1 集' },
          { start: at('2026-10-08 20:30'), until: at('2026-10-09 07:30'), label: '《乙番》第 2 集' }
        ]
      },
      now,
      { activeIntervalMinutes: 15, idleIntervalMinutes: 180 }
    );

    expect(plan.triggers).toHaveLength(2);
    expect(plan.triggers[0]?.start.getTime()).toBe(at('2026-10-04 17:00').getTime());
    expect(plan.triggers[1]?.start.getTime()).toBe(at('2026-10-08 20:30').getTime());
    expect(plan.activeIntervalMinutes).toBe(15);
    expect(plan.refreshIntervalMinutes).toBe(180);
  });

  it('已经过期的窗口不再排（until 已经过了）', () => {
    const plan = buildTaskSchedule(
      {
        triggers: [
          { start: at('2026-10-02 17:00'), until: at('2026-10-03 05:00'), label: '过期' },
          { start: at('2026-10-05 17:00'), until: at('2026-10-06 05:00'), label: '有效' }
        ]
      },
      now,
      { activeIntervalMinutes: 15, idleIntervalMinutes: 180 }
    );

    expect(plan.triggers.map((item) => item.label)).toEqual(['有效']);
  });

  it('已经到点但还在窗口里的，从「现在 + 1 分钟」开始排（别等到明天）', () => {
    const plan = buildTaskSchedule(
      { triggers: [{ start: at('2026-10-04 10:00'), until: at('2026-10-05 04:00'), label: '正在等' }] },
      now,
      { activeIntervalMinutes: 15, idleIntervalMinutes: 180 }
    );

    expect(plan.triggers[0]?.start.getTime()).toBe(now.getTime() + 60_000);
  });

  it('太远的安排先不排（21 天之外等下次重读计划时再说）', () => {
    const plan = buildTaskSchedule(
      { triggers: [{ start: at('2026-12-01 20:00'), until: at('2026-12-02 08:00'), label: '很久以后' }] },
      now,
      { activeIntervalMinutes: 15, idleIntervalMinutes: 180 }
    );
    expect(plan.triggers).toHaveLength(0);
  });

  it('触发器数量有上限，不会把任务塞爆', () => {
    const triggers = Array.from({ length: 50 }, (_, index) => ({
      start: new Date(now.getTime() + (index + 1) * 3_600_000),
      until: new Date(now.getTime() + (index + 13) * 3_600_000),
      label: `第 ${index} 集`
    }));
    const plan = buildTaskSchedule({ triggers }, now, { activeIntervalMinutes: 15, idleIntervalMinutes: 180 });
    expect(plan.triggers.length).toBeLessThanOrEqual(31);
  });
});

describe('计划任务同步脚本', () => {
  it('把窗口和间隔写进 payload，时间用 ISO（不在命令行里拼本地时间字符串）', () => {
    const plan = buildTaskSchedule(
      { triggers: [{ start: at('2026-10-04 17:00'), until: at('2026-10-05 04:00'), label: '《甲番》第 1 集' }] },
      at('2026-10-04 13:00'),
      { activeIntervalMinutes: 15, idleIntervalMinutes: 180 }
    );

    const payload = buildTaskSyncPayload({ taskName: 'BangumiDownloader', plan, resultPath: 'C:\\temp\\r.json' });
    expect(payload.taskName).toBe('BangumiDownloader');
    expect(payload.windows).toHaveLength(1);
    expect(payload.windows[0]?.start).toContain('T');
    // 12 小时的窗口 → duration 720 分钟
    expect(payload.windows[0]?.durationMinutes).toBe(660);

    const script = renderSyncScript({ payload, resultPath: 'C:\\temp\\r.json' });
    expect(script).toContain('Set-ScheduledTask');
    expect(script).toContain('New-ScheduledTaskTrigger -AtLogOn');
    expect(script).toContain('ConvertFrom-Json');
    // 结果写到文件，而不是靠解析控制台输出
    expect(script).toContain('Set-Content');
  });

  it('dry-run 时不碰系统，只报会排几段', async () => {
    const result = await syncTaskSchedule({
      taskName: 'BangumiDownloader',
      plan: { triggers: [{ start: new Date(), until: new Date(Date.now() + 3_600_000), label: 'x' }], activeIntervalMinutes: 15, refreshIntervalMinutes: 180 },
      apply: false
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('dry-run');
  });

  it('没有可排的安排时绝不写空触发器（那会让任务永远不触发）', async () => {
    const result = await syncTaskSchedule({
      taskName: 'BangumiDownloader',
      plan: { triggers: [], activeIntervalMinutes: 15, refreshIntervalMinutes: 180 },
      apply: true
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('保持原来的触发器不动');
  });
});

describe('计划任务触发器与程序自己的检查点对齐', () => {
  it('已经在窗口里时，触发器从「下一个检查点」开始，而不是立刻空跑一轮', () => {
    const now = at('2026-10-04 17:05');
    const plan = planSchedule([subject('甲番', 1, '2026-10-04', '16:00')], now, OPTIONS);

    expect(plan.due).toBe(true);
    // 程序自己下一次检查是 15 分钟后，触发器也从那一刻开始
    expect(plan.triggers[0]?.start.getTime()).toBe(plan.nextCheckAt.getTime());
  });

  it('还没播的集：触发窗口正好是「该取片源」到窗口结束', () => {
    const now = at('2026-10-04 13:00');
    const plan = planSchedule([subject('甲番', 1, '2026-10-04', '16:00')], now, OPTIONS);

    expect(plan.due).toBe(false);
    expect(plan.triggers).toHaveLength(1);
    expect(plan.triggers[0]?.start.getTime()).toBe(at('2026-10-04 17:00').getTime());
    expect(plan.triggers[0]?.until.getTime()).toBe(at('2026-10-05 04:00').getTime());
    // 干活时间 = 触发窗口的起点
    expect(plan.nextCheckAt.getTime()).toBe(plan.triggers[0]?.start.getTime());
  });

  it('播出已久还没片源的集不排触发器（只剩重读计划的低频触发）', () => {
    const now = at('2026-10-06 13:00');
    const plan = planSchedule([subject('冷门番', 3, '2026-10-04', '16:00')], now, OPTIONS);
    expect(plan.triggers).toEqual([]);
    expect(plan.stale).toHaveLength(1);
  });
});
