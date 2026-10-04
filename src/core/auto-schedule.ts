import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../util/log.js';
import { isProcessAlive } from './inflight.js';

const log = logger('schedule');

/**
 * 自动追番的「什么时候该检查」计划。
 *
 * 为什么需要：原来计划任务每 15 分钟无脑跑一轮，不管有没有意义 ——
 * 一天 96 轮，绝大多数时候只是白白去问 Planner、搜片源站。
 * 而新番是**按周在固定时间播出**的，片源要等播出后半小时到一小时才出：
 * 真正需要盯着的只有「刚播完那一小段时间」。
 *
 * 所以这里把「什么时候值得检查」算出来记在磁盘上：
 *
 *   - 有集已经到点（播出 + 就绪延迟）却还没下到 → **活跃窗口**，每 15 分钟看一次
 *   - 下一集还没播 → 把下次检查安排在「它该出片源的那一刻」，中间一次都不跑
 *   - 播出超过窗口（默认 12 小时）还没有片源 → 不再密集检查，退回低频兜底
 *   - 不知道播出时间（清单模式 / Planner 没给时刻）→ 低频兜底，别死等
 *
 * 兜底那一档很重要：计划本身也会变（用户把某部番标记成在看、
 * Planner 同步到新集），所以无论如何至少每 idleInterval 分钟跑一次，
 * 不然「计划变了但程序不知道」会变成新的坑。
 *
 * 这个模块里的判断全是纯函数，便于测试 —— 时间一律由调用方传进来。
 */

/** 一个「刚播完、正在等片源」的窗口。 */
export type AutoWindow = {
  subjectId: number | null;
  query: string;
  episode: number | null;
  /** 播出时刻（本地时间，ISO）。 */
  broadcastAt: string | null;
  /** 从这一刻起就该能搜到片源了。 */
  readyAt: string;
  /** 超过这一刻还没下到就先放弃密集检查。 */
  until: string;
};

/** 「这一集已经下完了」的记录，用来避免重复下载。 */
export type AutoDoneRecord = {
  subjectId: number | null;
  episode: number | null;
  query: string;
  at: string;
};

export type AutoScheduleState = {
  version: 1;
  updatedAt: string;
  /** 下次该**真干活**的时刻（ISO）—— 完全由播出时间决定；null 表示还没算出来。 */
  nextCheckAt: string | null;
  /**
   * 下次**重新读一遍计划**的时刻（ISO）。
   *
   * 和 nextCheckAt 是两件事：计划本身会变（在 Planner 里加了新番、改了在看状态），
   * 但盯着「播出时间」的时候没有任何理由定期去搜片源站。
   * 所以到点之前只做「问一次 Planner、重算计划」，绝不搜种、绝不下东西。
   */
  nextRefreshAt: string | null;
  /** 为什么安排在这个时刻（给人看的一句话）。 */
  nextReason: string;
  /** 当前活跃的等待窗口。 */
  windows: AutoWindow[];
  /** 排给计划任务的触发窗口（ISO），界面上的「重排计划任务」直接用它。 */
  triggers: Array<{ start: string; until: string; label: string }>;
  /** 已经下完的集。 */
  done: AutoDoneRecord[];
  /** 上一次跳过的原因，用来避免每次都往日志里写同一行。 */
  lastSkipReason?: string | null;
  /**
   * 正在下载的那一条（没有就是 null）。
   *
   * 为什么要写进这个文件：下载跑在**另一个进程**里（计划任务触发的那次），
   * 而网页界面是常驻的那个进程 —— 不落盘的话，界面上完全看不到进度，
   * 只能去翻日志。实测用户就是因此以为「一直是 0 MB、没在动」。
   */
  running?: RunningDownload | null;
};

export type RunningDownload = {
  title: string;
  /** 写这条记录的进程号：进程已经不在了就说明这是残留，不该再显示成「正在下载」。 */
  pid?: number;
  /** 0~1。 */
  ratio: number;
  /** 已校验通过的字节 / 总字节。 */
  downloadedBytes: number;
  totalBytes: number;
  /** 网络速度（字节/秒，按收到的数据算）。 */
  speed: number;
  peers: number;
  startedAt: string;
  updatedAt: string;
};

export const AUTO_SCHEDULE_FILENAME = 'auto-schedule.json';

/** 计划文件放在 data/ 下（和日志、锁文件在一起）。 */
export function autoSchedulePath(configPath?: string): string {
  const dir = configPath ? dirname(configPath) : process.cwd();
  return join(dir, 'data', AUTO_SCHEDULE_FILENAME);
}

export function emptyScheduleState(now: Date): AutoScheduleState {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    nextCheckAt: null,
    nextRefreshAt: null,
    nextReason: '还没有跑过，先执行一轮再算计划',
    windows: [],
    triggers: [],
    done: [],
    lastSkipReason: null,
    running: null
  };
}

/** 把「正在下载」写进计划文件（供界面展示）。 */
export function publishRunning(path: string, info: RunningDownload): void {
  const state = loadAutoSchedule(path);
  state.running = { ...info, pid: process.pid };
  saveAutoSchedule(path, state);
}

/**
 * 现在**真的**在下载吗。
 *
 * 为什么要判进程：下载进程可能被杀（重启、断电、我手动 taskkill），
 * 而「正在下载」这条记录留在文件里，界面就会一直显示「正在下载 0%」，
 * 看着像卡死了。进程不在了就当没有，并顺手把残留清掉。
 */
export function effectiveRunning(state: AutoScheduleState | null): RunningDownload | null {
  const running = state?.running ?? null;
  if (!running) return null;
  if (typeof running.pid !== 'number') return null;
  if (running.pid === process.pid) return running;
  if (isProcessAlive(running.pid)) return running;
  return null;
}

/** 清掉残留的「正在下载」（进程已经不在的那种）。 */
export function clearStaleRunning(path: string): boolean {
  const state = loadAutoSchedule(path);
  if (!state.running) return false;
  if (effectiveRunning(state) !== null) return false;
  state.running = null;
  saveAutoSchedule(path, state);
  return true;
}

/** 下载结束后清掉「正在下载」。 */
export function clearRunning(path: string): void {
  const state = loadAutoSchedule(path);
  if (state.running === null || state.running === undefined) return;
  state.running = null;
  saveAutoSchedule(path, state);
}

export function loadAutoSchedule(path: string, now: Date = new Date()): AutoScheduleState {
  if (!existsSync(path)) return emptyScheduleState(now);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AutoScheduleState>;
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now.toISOString(),
      nextCheckAt: typeof raw.nextCheckAt === 'string' ? raw.nextCheckAt : null,
      nextRefreshAt: typeof raw.nextRefreshAt === 'string' ? raw.nextRefreshAt : null,
      nextReason: typeof raw.nextReason === 'string' ? raw.nextReason : '',
      windows: Array.isArray(raw.windows) ? (raw.windows as AutoWindow[]).filter((item) => typeof item?.readyAt === 'string') : [],
      triggers: Array.isArray(raw.triggers)
        ? (raw.triggers as AutoScheduleState['triggers']).filter((item) => typeof item?.start === 'string')
        : [],
      done: Array.isArray(raw.done)
        ? (raw.done as AutoDoneRecord[]).filter((item) => typeof item?.at === 'string' && typeof item?.query === 'string')
        : [],
      lastSkipReason: typeof raw.lastSkipReason === 'string' ? raw.lastSkipReason : null,
      running:
        raw.running && typeof raw.running === 'object' && typeof (raw.running as RunningDownload).title === 'string'
          ? (raw.running as RunningDownload)
          : null
    };
  } catch (error) {
    log.warn(`追番计划文件解析失败，按「没有计划」处理：${(error as Error).message}`);
    return emptyScheduleState(now);
  }
}

export function saveAutoSchedule(path: string, state: AutoScheduleState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    // 计划写不进去不该让追番失败：大不了下一轮多跑一次
    log.warn(`追番计划写入失败：${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 判断「现在要不要跑」
 * ------------------------------------------------------------------ */

/**
 * 这一轮该做什么。
 *
 *   run     真干活（搜片源、下载）—— 只在播出时间到点之后
 *   refresh 只重算计划（问一次 Planner，不搜种、不下载）—— 到点之前定期确认计划有没有变
 *   skip    什么都不做，连请求都不发
 *
 * 刻意**失败开**：计划文件缺失、损坏、时间不合法时都返回 run ——
 * 宁可多跑一轮，也不要因为一个坏掉的 json 让追番彻底停摆。
 */
export type RunDecision = { action: 'run' | 'refresh' | 'skip'; reason: string };

export function decideRun(state: AutoScheduleState | null, now: Date, options: { force?: boolean } = {}): RunDecision {
  if (options.force) return { action: 'run', reason: '手动触发，忽略计划' };
  if (!state || state.nextCheckAt === null) return { action: 'run', reason: '还没有计划记录，先跑一轮' };

  const next = new Date(state.nextCheckAt);
  if (Number.isNaN(next.getTime())) return { action: 'run', reason: '计划里的时间不合法，先跑一轮' };
  if (now.getTime() >= next.getTime()) {
    return { action: 'run', reason: `到点了：${state.nextReason || '计划里安排的检查时间已到'}` };
  }

  const refresh = state.nextRefreshAt === null ? null : new Date(state.nextRefreshAt);
  if (refresh && !Number.isNaN(refresh.getTime()) && now.getTime() >= refresh.getTime()) {
    return { action: 'refresh', reason: `到点前只刷新计划（下次干活安排在 ${formatClock(next)}）` };
  }

  return {
    action: 'skip',
    reason: `未到检查时间，本轮跳过 —— ${state.nextReason}（安排在 ${formatClock(next)}）`
  };
}

/* ------------------------------------------------------------------ *
 * 算计划
 * ------------------------------------------------------------------ */

/** 从 Planner 拿到的「这部番下一集是什么」。 */
export type SubjectNext = {
  subjectId: number;
  name: string;
  /** Planner 的 nextEpisode；没有就是没安排。 */
  next: { ep: number | null; airdate: string; airTime: string | null } | null;
};

export type PlanOptions = {
  /** 播出后多少分钟才算「片源该出来了」。 */
  readyDelayMinutes: number;
  /** 活跃窗口内的检查间隔（分钟）。 */
  activeIntervalMinutes: number;
  /** 不知道播出时间时的兜底间隔（分钟）。 */
  idleIntervalMinutes: number;
  /** 一集播出后最多盯多少小时。 */
  releaseWindowHours: number;
};

export type SchedulePlan = {
  /** 现在就有窗口到点 —— 该干活了。 */
  due: boolean;
  /** 下次真干活的时刻：**完全由播出时间决定**。 */
  nextCheckAt: Date;
  /** 下次重读计划的时刻（只看计划变没变，不搜片源）。 */
  nextRefreshAt: Date;
  reason: string;
  /**
   * 「哪几段时间需要盯着」——直接用来排 Windows 计划任务的触发器。
   *
   * 每一段是 [start, until]：到 start 开始每 activeInterval 分钟看一次，
   * 到 until 还没下到就放过这一集。计划任务本身按这个排，就不用靠
   * 「每 15 分钟无脑触发 + 程序自己判断要不要干」了。
   */
  triggers: Array<{ start: Date; until: Date; label: string }>;
  windows: AutoWindow[];
  /** 播出很久还没下到的（本轮不再密集检查）。 */
  stale: Array<{ query: string; episode: number | null; broadcastAt: string | null }>;
};

/** 「2026-10-04」+「16:00」→ 本地时间。缺时刻时按当天 00:00 算。 */
export function broadcastTimeOf(airdate: string, airTime: string | null | undefined): Date | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(airdate.trim());
  if (!date) return null;

  const time = typeof airTime === 'string' ? /^(\d{1,2}):(\d{2})/.exec(airTime.trim()) : null;
  const hour = time ? Number(time[1]) : 0;
  const minute = time ? Number(time[2]) : 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;

  // 用本地时间构造：Planner 给的就是这台机器所在时区的播出时刻
  return new Date(
    Number(date[1]),
    Number(date[2]) - 1,
    Number(date[3]),
    hour,
    minute,
    0,
    0
  );
}

/**
 * @param done 已经下完的集（`doneKey` 的集合）。
 *   下过的集不该再占着「等待窗口」—— 否则它会一直触发、每轮都只是打一行
 *   「已经下过」，直到 Planner 那边标记成已看为止（实测会白跑几十轮）。
 */
export function planSchedule(
  subjects: readonly SubjectNext[],
  now: Date,
  options: PlanOptions,
  done: ReadonlySet<string> = new Set()
): SchedulePlan {
  const activeInterval = Math.max(1, options.activeIntervalMinutes);
  const idleInterval = Math.max(activeInterval, options.idleIntervalMinutes);
  const readyDelayMs = Math.max(0, options.readyDelayMinutes) * 60_000;
  const windowMs = Math.max(1, options.releaseWindowHours) * 3_600_000;

  const windows: AutoWindow[] = [];
  const future: Array<{ at: Date; label: string }> = [];
  const triggers: SchedulePlan['triggers'] = [];
  const stale: SchedulePlan['stale'] = [];

  for (const subject of subjects) {
    const next = subject.next;
    if (!next) continue;

    // 这一集已经下过了：Planner 还标着「未看」是因为用户还没看，
    // 但我们这边不用再安排检查了（等用户看完，Planner 自然会给下一集）
    if (next.ep !== null && done.has(doneKey(subject.subjectId, next.ep))) continue;

    const broadcast = broadcastTimeOf(next.airdate, next.airTime);
    if (!broadcast) continue;

    const readyAt = new Date(broadcast.getTime() + readyDelayMs);
    const until = new Date(broadcast.getTime() + windowMs);
    const episodeText = next.ep === null ? '最新一集' : `第 ${next.ep} 集`;
    const broadcastText = next.airTime ? `${formatClock(broadcast)}` : `${formatDate(broadcast)}（没给播出时刻）`;

    if (now.getTime() < readyAt.getTime()) {
      future.push({
        at: readyAt,
        label: `《${subject.name}》${episodeText} ${broadcastText} 播出，${formatClock(readyAt)} 之后开始找片源`
      });
      triggers.push({ start: readyAt, until, label: `《${subject.name}》${episodeText}` });
      continue;
    }

    if (now.getTime() <= until.getTime()) {
      windows.push({
        subjectId: subject.subjectId,
        query: subject.name,
        episode: next.ep,
        broadcastAt: broadcast.toISOString(),
        readyAt: readyAt.toISOString(),
        until: until.toISOString()
      });
      // 已经在窗口里：下一个检查点开始（和程序自己的 nextCheckAt 对齐，
      // 免得触发器在没到点的时候空跑一轮）
      triggers.push({
        start: new Date(now.getTime() + activeInterval * 60_000),
        until,
        label: `《${subject.name}》${episodeText}`
      });
      continue;
    }

    stale.push({ query: subject.name, episode: next.ep, broadcastAt: broadcast.toISOString() });
  }

  const idleAt = new Date(now.getTime() + idleInterval * 60_000);
  future.sort((a, b) => a.at.getTime() - b.at.getTime());
  const nearest = future[0];

  // 有集到点了：活跃窗口，每 activeInterval 分钟干一次活
  if (windows.length > 0) {
    const names = windows
      .slice(0, 3)
      .map((window) => `《${window.query}》${window.episode === null ? '' : `第 ${window.episode} 集`}`)
      .join('、');
    return {
      due: true,
      nextCheckAt: new Date(now.getTime() + activeInterval * 60_000),
      nextRefreshAt: new Date(now.getTime() + activeInterval * 60_000),
      reason:
        `${windows.length} 集已经到点、正在等片源（${names}${windows.length > 3 ? ' 等' : ''}），` +
        `每 ${activeInterval} 分钟看一次`,
      windows,
      stale,
      triggers: triggers.sort((a, b) => a.start.getTime() - b.start.getTime())
    };
  }

  /*
   * 没有集到点：**下一次干活就安排在下一集的播出时间上**，中间不搜片源。
   *
   * 这和原来「每 idleInterval 分钟检查一次」是两回事：那时候每一轮都可能去搜种，
   * 现在中间的轮次只重算计划（问一次 Planner），真正的检查精确落在播出时刻。
   * idleInterval 只用来决定「多久重读一遍计划」—— 计划变了（新加了番）
   * 最多这么久就会被发现。
   */
  if (nearest) {
    return {
      due: false,
      nextCheckAt: nearest.at,
      nextRefreshAt: new Date(Math.min(idleAt.getTime(), nearest.at.getTime())),
      reason: nearest.label,
      windows,
      stale,
      triggers: triggers.sort((a, b) => a.start.getTime() - b.start.getTime())
    };
  }

  return {
    due: false,
    nextCheckAt: idleAt,
    nextRefreshAt: idleAt,
    reason: `没有已知的播出安排，先按${formatMinutes(idleInterval)}的节奏确认计划有没有变`,
    windows,
    stale,
    triggers: []
  };
}

/**
 * 连不上 Planner 时的兜底计划。
 *
 * 本地清单没有播出时间，只能按「新番一周一集」去估：
 * 拿上次下到的时间 + 7 天当下一集的预计时刻。
 *
 * 注意这个估计仍然要服从兜底间隔（下面 planSchedule 的规则一样）：
 * 估计出来的时间离得还远时，中间照样会按 idleInterval 醒来确认一次计划 ——
 * 不然「用户新加了一部番」这种变化要等一周才被发现。
 */
export function planWithoutPlanner(
  now: Date,
  options: PlanOptions,
  lastDownload: { at: string; query: string } | null
): SchedulePlan {
  const idleInterval = Math.max(1, options.idleIntervalMinutes);
  const idleAt = new Date(now.getTime() + idleInterval * 60_000);
  const windowMs = Math.max(1, options.releaseWindowHours) * 3_600_000;

  // 上次下到的时间 + 一周（提前一小时开始盯）
  let estimate: Date | null = null;
  if (lastDownload) {
    const last = new Date(lastDownload.at);
    if (!Number.isNaN(last.getTime())) estimate = new Date(last.getTime() + 7 * 24 * 3_600_000 - 3_600_000);
  }

  if (estimate && estimate.getTime() > now.getTime() && estimate.getTime() < idleAt.getTime()) {
    return {
      due: false,
      nextCheckAt: estimate,
      nextRefreshAt: new Date(Math.min(idleAt.getTime(), estimate.getTime())),
      reason: `连不上 Planner；《${lastDownload?.query ?? '上次那部'}》上次是 ${formatClock(new Date(lastDownload?.at ?? ''))} 下到的，按一周一集估下次在 ${formatClock(estimate)} 前后`,
      windows: [],
      stale: [],
      triggers: [{ start: estimate, until: new Date(estimate.getTime() + windowMs), label: `《${lastDownload?.query ?? '上次那部'}》下一集（估算）` }]
    };
  }

  return {
    due: false,
    nextCheckAt: idleAt,
    nextRefreshAt: idleAt,
    reason: estimate
      ? `连不上 Planner；按一周一集估下次在 ${formatClock(estimate)} 前后，中间先按${formatMinutes(idleInterval)}的节奏确认计划`
      : `连不上 Planner，也没有可参考的下载记录，先按${formatMinutes(idleInterval)}的节奏兜底`,
    windows: [],
    stale: [],
    triggers: []
  };
}

/* ------------------------------------------------------------------ *
 * 「这一集已经下过了」
 * ------------------------------------------------------------------ */

export function doneKey(subjectId: number | null, episode: number | null): string {
  return `${subjectId ?? '-'}#${episode ?? '-'}`;
}

export function doneKeys(state: AutoScheduleState | null): Set<string> {
  const keys = new Set<string>();
  for (const record of state?.done ?? []) keys.add(doneKey(record.subjectId, record.episode));
  return keys;
}

export function isEpisodeDone(state: AutoScheduleState | null, subjectId: number | null, episode: number | null): boolean {
  if (episode === null) return false;
  return doneKeys(state).has(doneKey(subjectId, episode));
}

/** 记下「已经下完」，返回新增条数。 */
export function markEpisodesDone(
  state: AutoScheduleState,
  records: ReadonlyArray<{ subjectId: number | null; episode: number | null; query: string }>,
  at: Date
): number {
  const existing = doneKeys(state);
  let added = 0;
  for (const record of records) {
    if (record.episode === null) continue;
    const key = doneKey(record.subjectId, record.episode);
    if (existing.has(key)) continue;
    existing.add(key);
    state.done.push({ ...record, at: at.toISOString() });
    added += 1;
  }
  return added;
}

/** 老记录定期清掉，别让 json 无限长大。 */
export function pruneDone(state: AutoScheduleState, now: Date, retentionDays = 60): number {
  const cutoff = now.getTime() - retentionDays * 24 * 3_600_000;
  const before = state.done.length;
  state.done = state.done.filter((record) => {
    const at = new Date(record.at).getTime();
    return Number.isNaN(at) || at >= cutoff;
  });
  return before - state.done.length;
}

/** 把计划写进状态对象（不改 done）。 */
export function applyPlan(state: AutoScheduleState, plan: SchedulePlan, now: Date): AutoScheduleState {
  state.updatedAt = now.toISOString();
  state.nextCheckAt = plan.nextCheckAt.toISOString();
  state.nextRefreshAt = plan.nextRefreshAt.toISOString();
  state.nextReason = plan.reason;
  state.windows = plan.windows;
  state.triggers = plan.triggers.map((item) => ({
    start: item.start.toISOString(),
    until: item.until.toISOString(),
    label: item.label
  }));
  return state;
}

/* ------------------------------------------------------------------ *
 * 展示用
 * ------------------------------------------------------------------ */

export function formatClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 「下次检查」给人看的相对说法。 */
export function describeNextCheck(state: AutoScheduleState, now: Date = new Date()): string {
  if (!state.nextCheckAt) return '还没安排';
  const next = new Date(state.nextCheckAt);
  if (Number.isNaN(next.getTime())) return '还没安排';

  const diffMinutes = Math.round((next.getTime() - now.getTime()) / 60_000);
  if (diffMinutes <= 0) return '就是现在';
  if (diffMinutes < 60) return `${diffMinutes} 分钟后（${formatClock(next)}）`;
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return `${hours} 小时后（${formatClock(next)}）`;
  return `${Math.floor(hours / 24)} 天后（${formatClock(next)}）`;
}

/* ------------------------------------------------------------------ *
 * 按播出时间排出来的计划表（界面上的「计划」页就是它）
 * ------------------------------------------------------------------ */

export type PlanRowStatus = 'done' | 'waiting' | 'upcoming' | 'stale' | 'unknown';

export type PlanRow = {
  subjectId: number;
  name: string;
  episode: number | null;
  /** Planner 给的原始播出日期与时刻。 */
  airdate: string;
  airTime: string | null;
  /** 播出时刻（ISO），算不出来时为 null。 */
  broadcastAt: string | null;
  /** 从这一刻起该有片源了。 */
  readyAt: string | null;
  /** 超过这一刻还没下到就不再多盯。 */
  until: string | null;
  status: PlanRowStatus;
  statusText: string;
};

const STATUS_TEXT: Record<PlanRowStatus, string> = {
  done: '已下完',
  waiting: '正在等片源',
  upcoming: '等播出',
  stale: '播出已久仍无片源',
  unknown: '时间未知'
};

/**
 * 把「这部番下一集」排成一张按播出时间升序的表。
 *
 * 为什么不按番名或按状态排：这张表回答的是「接下来会发生什么」，
 * 唯一的自然顺序就是时间轴 —— 下一集什么时候播、什么时候去取，
 * 一眼从上往下看就是了。
 */
export function buildPlanRows(
  subjects: readonly SubjectNext[],
  now: Date,
  options: { readyDelayMinutes: number; releaseWindowHours: number },
  done: ReadonlySet<string> = new Set()
): PlanRow[] {
  const readyDelayMs = Math.max(0, options.readyDelayMinutes) * 60_000;
  const windowMs = Math.max(1, options.releaseWindowHours) * 3_600_000;

  const rows: PlanRow[] = subjects.map((subject) => {
    const next = subject.next;
    const base = {
      subjectId: subject.subjectId,
      name: subject.name,
      episode: next?.ep ?? null,
      airdate: next?.airdate ?? '',
      airTime: next?.airTime ?? null
    };

    if (!next) return { ...base, broadcastAt: null, readyAt: null, until: null, status: 'unknown' as const, statusText: STATUS_TEXT.unknown };

    const broadcast = broadcastTimeOf(next.airdate, next.airTime);
    if (!broadcast) return { ...base, broadcastAt: null, readyAt: null, until: null, status: 'unknown' as const, statusText: STATUS_TEXT.unknown };

    const readyAt = new Date(broadcast.getTime() + readyDelayMs);
    const until = new Date(broadcast.getTime() + windowMs);
    const isDone = next.ep !== null && done.has(doneKey(subject.subjectId, next.ep));

    let status: PlanRowStatus;
    if (isDone) status = 'done';
    else if (now.getTime() < readyAt.getTime()) status = 'upcoming';
    else if (now.getTime() <= until.getTime()) status = 'waiting';
    else status = 'stale';

    return {
      ...base,
      broadcastAt: broadcast.toISOString(),
      readyAt: readyAt.toISOString(),
      until: until.toISOString(),
      status,
      statusText: STATUS_TEXT[status]
    };
  });

  // 时间升序；算不出时间的排在最后（它们没法参与时间轴）
  return rows.sort((a, b) => {
    if (a.broadcastAt === null && b.broadcastAt === null) return a.name.localeCompare(b.name);
    if (a.broadcastAt === null) return 1;
    if (b.broadcastAt === null) return -1;
    return a.broadcastAt < b.broadcastAt ? -1 : a.broadcastAt > b.broadcastAt ? 1 : 0;
  });
}
