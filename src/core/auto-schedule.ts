import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../util/log.js';

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
  /** 下次该检查的时刻（ISO）；null 表示还没算出来。 */
  nextCheckAt: string | null;
  /** 为什么安排在这个时刻（给人看的一句话）。 */
  nextReason: string;
  /** 当前活跃的等待窗口。 */
  windows: AutoWindow[];
  /** 已经下完的集。 */
  done: AutoDoneRecord[];
  /** 上一次跳过的原因，用来避免每次都往日志里写同一行。 */
  lastSkipReason?: string | null;
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
    nextReason: '还没有跑过，先执行一轮再算计划',
    windows: [],
    done: [],
    lastSkipReason: null
  };
}

export function loadAutoSchedule(path: string, now: Date = new Date()): AutoScheduleState {
  if (!existsSync(path)) return emptyScheduleState(now);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AutoScheduleState>;
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now.toISOString(),
      nextCheckAt: typeof raw.nextCheckAt === 'string' ? raw.nextCheckAt : null,
      nextReason: typeof raw.nextReason === 'string' ? raw.nextReason : '',
      windows: Array.isArray(raw.windows) ? (raw.windows as AutoWindow[]).filter((item) => typeof item?.readyAt === 'string') : [],
      done: Array.isArray(raw.done)
        ? (raw.done as AutoDoneRecord[]).filter((item) => typeof item?.at === 'string' && typeof item?.query === 'string')
        : [],
      lastSkipReason: typeof raw.lastSkipReason === 'string' ? raw.lastSkipReason : null
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

export type RunDecision = { run: boolean; reason: string };

/**
 * 现在该不该真干活。
 *
 * 刻意**失败开**：计划文件缺失、损坏、时间不合法时都返回「跑」——
 * 宁可多跑一轮，也不要因为一个坏掉的 json 让追番彻底停摆。
 */
export function decideRun(state: AutoScheduleState | null, now: Date, options: { force?: boolean } = {}): RunDecision {
  if (options.force) return { run: true, reason: '手动触发，忽略计划' };
  if (!state || state.nextCheckAt === null) return { run: true, reason: '还没有计划记录，先跑一轮' };

  const next = new Date(state.nextCheckAt);
  if (Number.isNaN(next.getTime())) return { run: true, reason: '计划里的时间不合法，先跑一轮' };
  if (now.getTime() >= next.getTime()) {
    return { run: true, reason: `到点了：${state.nextReason || '计划里安排的检查时间已到'}` };
  }
  return {
    run: false,
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
  nextCheckAt: Date;
  reason: string;
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

export function planSchedule(subjects: readonly SubjectNext[], now: Date, options: PlanOptions): SchedulePlan {
  const activeInterval = Math.max(1, options.activeIntervalMinutes);
  const idleInterval = Math.max(activeInterval, options.idleIntervalMinutes);
  const readyDelayMs = Math.max(0, options.readyDelayMinutes) * 60_000;
  const windowMs = Math.max(1, options.releaseWindowHours) * 3_600_000;

  const windows: AutoWindow[] = [];
  const future: Array<{ at: Date; label: string }> = [];
  const stale: SchedulePlan['stale'] = [];

  for (const subject of subjects) {
    const next = subject.next;
    if (!next) continue;

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
      continue;
    }

    stale.push({ query: subject.name, episode: next.ep, broadcastAt: broadcast.toISOString() });
  }

  const idleAt = new Date(now.getTime() + idleInterval * 60_000);
  future.sort((a, b) => a.at.getTime() - b.at.getTime());
  const nearest = future[0];

  if (windows.length > 0) {
    const names = windows
      .slice(0, 3)
      .map((window) => `《${window.query}》${window.episode === null ? '' : `第 ${window.episode} 集`}`)
      .join('、');
    return {
      due: true,
      nextCheckAt: new Date(now.getTime() + activeInterval * 60_000),
      reason:
        `${windows.length} 集已经到点、正在等片源（${names}${windows.length > 3 ? ' 等' : ''}），` +
        `每 ${activeInterval} 分钟看一次`,
      windows,
      stale
    };
  }

  if (nearest && nearest.at.getTime() < idleAt.getTime()) {
    return {
      due: false,
      nextCheckAt: nearest.at,
      reason: nearest.label,
      windows,
      stale
    };
  }

  return {
    due: false,
    nextCheckAt: idleAt,
    reason:
      nearest === undefined
        ? `没有已知的播出安排，先按${formatMinutes(idleInterval)}的节奏确认计划有没有变`
        : `${nearest.label}（还早，中间按${formatMinutes(idleInterval)}的节奏确认计划）`,
    windows,
    stale
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
      reason: `连不上 Planner；《${lastDownload?.query ?? '上次那部'}》上次是 ${formatClock(new Date(lastDownload?.at ?? ''))} 下到的，按一周一集估下次在 ${formatClock(estimate)} 前后`,
      windows: [],
      stale: []
    };
  }

  return {
    due: false,
    nextCheckAt: idleAt,
    reason: estimate
      ? `连不上 Planner；按一周一集估下次在 ${formatClock(estimate)} 前后，中间先按${formatMinutes(idleInterval)}的节奏确认计划`
      : `连不上 Planner，也没有可参考的下载记录，先按${formatMinutes(idleInterval)}的节奏兜底`,
    windows: [],
    stale: []
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
  state.nextReason = plan.reason;
  state.windows = plan.windows;
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
