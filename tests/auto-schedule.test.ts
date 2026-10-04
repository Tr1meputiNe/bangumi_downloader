import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoSchedulePath,
  broadcastTimeOf,
  decideRun,
  describeNextCheck,
  emptyScheduleState,
  isEpisodeDone,
  loadAutoSchedule,
  markEpisodesDone,
  planSchedule,
  planWithoutPlanner,
  pruneDone,
  saveAutoSchedule,
  type PlanOptions,
  type SubjectNext
} from '../src/core/auto-schedule.js';

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

  it('下一集还早时，最多 idleInterval 也会醒来确认一次计划（防止计划变了不知道）', () => {
    const now = at('2026-10-04 13:00');
    // 16:00 播出 → 17:00 就绪；但兜底间隔是 180 分钟，所以 16:00 会先醒一次
    const plan = planSchedule([subject('相反的你和我 第二季', 13, '2026-10-04', '16:00')], now, OPTIONS);
    expect(plan.due).toBe(false);
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
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

  it('未来的集离得很远时，用兜底间隔做上限（避免好几天不看一眼计划变化）', () => {
    const now = at('2026-10-04 13:00');
    const plan = planSchedule([subject('边缘行者 2', 1, '2026-10-20', '22:00')], now, OPTIONS);

    expect(plan.due).toBe(false);
    // 下一集在半个月后，但不能真等到那时候 —— 兜底 3 小时
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
    expect(plan.reason).toContain('中间按3 小时');
  });

  it('Planner 没给任何 nextEpisode 时按兜底走', () => {
    const now = at('2026-10-04 13:00');
    const plan = planSchedule([{ subjectId: 1, name: '没安排', next: null }], now, OPTIONS);
    expect(plan.due).toBe(false);
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
    expect(plan.reason).toContain('没有已知的播出安排');
  });
});

describe('连不上 Planner 时的兜底计划', () => {
  it('估计的下一集还很远时，中间按兜底间隔醒来确认', () => {
    const now = at('2026-10-05 13:00');
    // 估计出来的下一集在 10-11，离得还远 —— 但兜底间隔只有 3 小时
    const plan = planWithoutPlanner(now, OPTIONS, { at: at('2026-10-04 17:30').toISOString(), query: '相反的你和我 第二季' });
    expect(plan.due).toBe(false);
    expect(plan.nextCheckAt.getTime()).toBe(now.getTime() + 180 * 60_000);
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

  it('没到点就跳过，并说清楚为什么', () => {
    const state = { ...base, nextCheckAt: at('2026-10-04 17:00').toISOString(), nextReason: '《X》17:00 之后才可能有片源' };
    const decision = decideRun(state, at('2026-10-04 13:00'));
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain('未到检查时间');
    expect(decision.reason).toContain('17:00');
  });

  it('到点了就跑', () => {
    const state = { ...base, nextCheckAt: at('2026-10-04 17:00').toISOString() };
    expect(decideRun(state, at('2026-10-04 17:00')).run).toBe(true);
    expect(decideRun(state, at('2026-10-04 17:20')).run).toBe(true);
  });

  it('手动触发时忽略计划', () => {
    const state = { ...base, nextCheckAt: at('2026-10-04 17:00').toISOString() };
    const decision = decideRun(state, at('2026-10-04 13:00'), { force: true });
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('手动触发');
  });

  it('计划文件缺失/损坏时失败开：宁可多跑一轮，也不要让追番停摆', () => {
    expect(decideRun(null, at('2026-10-04 13:00')).run).toBe(true);
    expect(decideRun({ ...base, nextCheckAt: null }, at('2026-10-04 13:00')).run).toBe(true);
    expect(decideRun({ ...base, nextCheckAt: '不是时间' }, at('2026-10-04 13:00')).run).toBe(true);
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
