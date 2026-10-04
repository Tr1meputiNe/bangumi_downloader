import type { AppConfig } from '../config.js';
import { searchAndRank } from './search.js';
import type { ScoredCandidate } from '../anime/rank.js';
import { downloadUntilComplete } from './retry.js';
import {
  isEntryComplete,
  loadWatchlist,
  markEpisodesCompleted,
  syncFromPlanner,
  saveWatchlist,
  watchlistPath,
  WATCHLIST_FILENAME,
  type WatchEntry
} from './watchlist.js';
import { PlannerClient, displayName, type AnimeGap } from '../planner/client.js';
import { buildTaskSchedule, syncTaskSchedule, type SyncResult } from './task-schedule.js';
import {
  applyPlan,
  autoSchedulePath,
  clearStaleRunning,
  broadcastTimeOf,
  doneKeys,
  clearRunning,
  publishRunning,
  decideRun,
  formatClock,
  isEpisodeDone,
  loadAutoSchedule,
  markEpisodesDone,
  planSchedule,
  planWithoutPlanner,
  pruneDone,
  saveAutoSchedule,
  type AutoScheduleState,
  type PlanOptions,
  type SchedulePlan,
  type SubjectNext
} from './auto-schedule.js';
import { today as todayString } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('auto');

/**
 * 基于本机追番清单的自动追番。
 *
 * 与 sync 的区别：sync 的「要下什么」来自本机 Watch Planner（那是个独立的服务），
 * 这里来自同目录下的 watchlist.json —— 不需要任何外部依赖，适合放在
 * Windows 计划任务里长期跑。挑选、下载仍然复用同一条代码路径。
 */

export type AutoOptions = {
  config: AppConfig;
  configPath?: string;
  /** 只跑一轮（默认就是一轮；run 模式在外面循环）。 */
  dryRun: boolean;
  /** 覆盖清单路径。 */
  watchlistFile?: string;
  /** 每部番单轮最多下几集。 */
  maxEpisodesPerSubject?: number;
  /** 每部番最多重试几轮（每轮都会从磁盘进度继续）。 */
  retryRounds?: number;
  /** 集号的合理上限（配合中位数判断，用来过滤剧场版年份/分辨率被误认成集号）。 */
  saneEpisodeLimit?: number;
  /**
   * 优先从 Bangumi Watch Planner（默认 127.0.0.1:3777）取「要下什么」，
   * 而不是读本地的 watchlist.json。
   *
   * 这是两种数据来源：
   *   - Planner：权威的在看/未看/已播出状态，跨机器（例如下载器在 Windows，
   *     Planner 在 Mac 上，经 Tailscale 访问）
   *   - 清单：不依赖任何外部服务，但需要自己维护番名
   * 连不上 Planner 时自动退回清单，不会因为 Planner 没开就什么都不做。
   */
  preferPlanner?: boolean;
  /**
   * 忽略「什么时候该检查」的计划，立刻真干活。
   *
   * 手动触发（网页上点「立即跑一轮」、命令行 `auto --force`）用它；
   * 计划任务不加 —— 那里正是要靠计划把 96 轮/天压到「只在播出前后跑」。
   */
  force?: boolean;
  /** 关掉计划判断（调试用：等价于永远 force）。 */
  respectSchedule?: boolean;
  /**
   * 顺手把「什么时候检查」写进 Windows 计划任务的触发器（默认关）。
   *
   * 打开之后，任务计划程序本身就是按播出时间触发的：播出前后那段时间每 15 分钟
   * 一次，其余时间只有「重读计划」的低频触发。计划任务里的命令加上 `--sync-task`
   * 即可（install-startup.ps1 已经这么写了）。
   */
  syncTask?: boolean;
  /** 要同步的计划任务名，默认 BangumiDownloader。 */
  taskName?: string;
  /** 当前时间（测试注入用）。 */
  now?: Date;
};

export type AutoReport = {
  subjects: number;
  checked: number;
  /**
   * 本轮「要下什么」是从哪来的。
   *
   * 界面需要它：preferPlanner 打开时 Planner 连不上会自动退回清单，
   * 而两种来源的结果长得一模一样 —— 不标出来的话，用户会以为
   * Planner 里的「在看」被处理了，实际看的是另一份清单。
   */
  source: 'planner' | 'watchlist';
  downloaded: Array<{ query: string; episodes: number[]; files: number; completed: boolean; bytesWritten: number }>;
  skipped: Array<{ query: string; reason: string }>;
  /** 因为「还没到播出的检查时间」整轮没干活。 */
  skippedBySchedule?: boolean;
  /** 没干活的那一轮具体做了什么：只刷新了计划（refresh）还是连请求都没发（skip）。 */
  mode?: 'run' | 'refresh' | 'skip';
  /** 本轮之后安排的下次检查，界面上直接显示。 */
  schedule?: { nextCheckAt: string | null; reason: string; due: boolean };
  /** 计划任务触发器的同步结果（只有开了 syncTask 才有）。 */
  taskSync?: SyncResult;
};

/** 跑一轮：对清单里每一部番，找出「还没下的集」并下载。 */
export async function runAuto(options: AutoOptions): Promise<AutoReport> {
  const { config } = options;
  const savePath = config.download.savePath || config.qbittorrent.savePath;
  if (!savePath) {
    log.error('没有配置下载目录：请在 config.json 里设置 download.savePath');
    return { subjects: 0, checked: 0, downloaded: [], skipped: [], source: 'watchlist' };
  }

  const now = options.now ?? new Date();
  const schedulePath = autoSchedulePath(options.configPath);
  const respectSchedule = options.respectSchedule !== false && options.force !== true;

  /*
   * 第一步：现在值得跑吗。
   *
   * 新番按周在固定时间播出，片源要等播出后半小时到一小时 ——
   * 每 15 分钟无脑跑一轮的话，一天 96 轮里绝大多数只是白问一遍 Planner、
   * 白搜一遍片源站。这里先看计划，没到点就**一次网络请求都不发**直接退出。
   */
  let state: AutoScheduleState | null = null;
  if (options.configPath) {
    // 上一轮如果被杀掉，「正在下载」会残留在计划文件里，界面会一直显示 0%
    if (clearStaleRunning(schedulePath)) log.info('清掉了上一次残留的「正在下载」记录（那个进程已经不在了）');
    state = loadAutoSchedule(schedulePath, now);
  }

  if (respectSchedule && options.configPath) {
    const decision = decideRun(state, now, { force: false });

    /*
     * 到点之前的两件事分开处理：
     *   refresh —— 只重算计划（问一次 Planner，不搜种、不下载）
     *   skip    —— 连请求都不发
     * 日志只在「原因变了」的时候打一遍：每 15 分钟写一行同样的字会把日志刷满，
     * 真正的问题反而被埋掉。
     */
    if (decision.action !== 'run') {
      const changed = state?.lastSkipReason !== decision.reason;
      if (changed) log.info(decision.reason);
      else log.debug(decision.reason);

      const updated = state ?? loadAutoSchedule(schedulePath, now);
      let taskSync: SyncResult | undefined;
      if (decision.action === 'refresh') {
        const plan = await computePlan(options, { subjects: 0, checked: 0, downloaded: [], skipped: [], source: 'planner' }, now);
        const previousTriggers = updated.triggers;
        applyPlan(updated, plan, now);
        log.info(`计划已刷新，下次检查：${formatClock(plan.nextCheckAt)} —— ${plan.reason}`);
        taskSync = await maybeSyncTask(options, plan, now, previousTriggers);
      }

      updated.lastSkipReason = decision.reason;
      saveAutoSchedule(schedulePath, updated);

      return {
        subjects: 0,
        checked: 0,
        downloaded: [],
        skipped: [],
        source: 'planner',
        skippedBySchedule: true,
        mode: decision.action,
        schedule: { nextCheckAt: updated.nextCheckAt, reason: updated.nextReason, due: false },
        taskSync
      };
    }
    log.info(`开始检查：${decision.reason}`);
  }

  const report = await runAutoInner(options, savePath, state, now);

  // 第三步：算下一轮什么时候再来（这一步只问 Planner，不搜片源）
  if (options.configPath) {
    const plan = await computePlan(options, report, now);
    const updated = state ?? loadAutoSchedule(schedulePath, now);
    const previousTriggers = updated.triggers;
    applyPlan(updated, plan, now);
    updated.lastSkipReason = null;
    pruneDone(updated, now);
    saveAutoSchedule(schedulePath, updated);

    report.schedule = { nextCheckAt: plan.nextCheckAt.toISOString(), reason: plan.reason, due: plan.due };
    log.info(`下次检查：${formatClock(plan.nextCheckAt)} —— ${plan.reason}`);
    report.taskSync = await maybeSyncTask(options, plan, now, previousTriggers);
    for (const item of plan.stale.slice(0, 5)) {
      log.debug(`《${item.query}》第 ${item.episode ?? '?'} 集播出已久仍没找到片源，本集不再密集检查`);
    }
  }

  return report;
}

/**
 * 按播出时间重排 Windows 计划任务的触发器。
 *
 * 为什么放在程序里而不是安装脚本里：播出安排每周都在变，
 * 只在安装时排一次的话第二天就不准了。每次跑完顺手重排一次最省心。
 */
async function maybeSyncTask(
  options: AutoOptions,
  plan: SchedulePlan,
  now: Date,
  previousTriggers: AutoScheduleState['triggers']
): Promise<SyncResult | undefined> {
  if (options.syncTask !== true) return undefined;

  const taskPlan = buildTaskSchedule(plan, now, {
    activeIntervalMinutes: options.config.download.activeIntervalMinutes ?? 15,
    idleIntervalMinutes: options.config.download.idleIntervalMinutes ?? 180
  });

  /*
   * 安排没变就别去动计划任务了。
   *
   * 活跃窗口里每 15 分钟跑一轮，如果每轮都去起一个 PowerShell 改触发器，
   * 那是白烧 CPU（而且任务计划程序每次都会重新计算下次时间）。
   * 只有窗口集合真的变了才同步。
   */
  const next = taskPlan.triggers.map((item) => `${item.start.toISOString()}|${item.until.toISOString()}`);
  const previous = previousTriggers.map((item) => `${item.start}|${item.until}`);
  if (next.length === previous.length && next.every((value, index) => value === previous[index])) {
    log.debug('播出安排没变，计划任务触发器保持原样');
    return { ok: true, message: '播出安排没变，触发器保持原样' };
  }

  return await syncTaskSchedule({
    taskName: options.taskName ?? 'BangumiDownloader',
    plan: taskPlan,
    apply: true
  });
}

/** 真正干活的两种数据来源。 */
async function runAutoInner(
  options: AutoOptions,
  savePath: string,
  state: AutoScheduleState | null,
  now: Date
): Promise<AutoReport> {
  if (options.preferPlanner !== false) {
    const fromPlanner = await runFromPlanner(options, savePath, state, now).catch((error: unknown) => {
      log.warn(`Planner 不可用（${(error as Error).message}），改用本地 watchlist.json`);
      return null;
    });
    if (fromPlanner) return fromPlanner;
  }

  return await runFromWatchlist(options, savePath);
}

/** 算下一轮检查时间：优先按 Planner 的播出安排，问不到就按上次下载时间估。 */
async function computePlan(options: AutoOptions, report: AutoReport, now: Date): Promise<SchedulePlan> {
  const planOptions: PlanOptions = {
    readyDelayMinutes: options.config.download.readyDelayMinutes ?? 60,
    activeIntervalMinutes: options.config.download.activeIntervalMinutes ?? 15,
    idleIntervalMinutes: options.config.download.idleIntervalMinutes ?? 180,
    releaseWindowHours: options.config.download.releaseWindowHours ?? 12
  };

  const planner = new PlannerClient({
    baseUrl: options.config.plannerBaseUrl,
    timeoutMs: Math.min(options.config.trackers.timeoutMs ?? 15_000, 8000),
    retries: 0
  });

  try {
    const dashboard = await planner.dashboard();
    const wanted = new Set(options.config.collectionTypes);
    const subjects: SubjectNext[] = dashboard.subjects
      .filter((subject) => wanted.has(subject.collectionType))
      .map((subject) => ({
        subjectId: subject.id,
        name: displayName(subject),
        next: subject.nextEpisode
          ? { ep: subject.nextEpisode.ep, airdate: subject.nextEpisode.airdate, airTime: subject.nextEpisode.airTime ?? null }
          : null
      }));

    if (subjects.length > 0) {
      const state = options.configPath ? loadAutoSchedule(autoSchedulePath(options.configPath), now) : null;
      return planSchedule(subjects, now, planOptions, doneKeys(state));
    }
    log.debug(`Planner 里没有收藏状态为 ${[...wanted].join('/')} 的番剧，计划退回兜底节奏`);
  } catch (error) {
    log.debug(`算计划时问不到 Planner：${(error as Error).message}`);
  }

  // 兜底：用刚下到的最后一条（或者历史上最后一条）当「一周一集」的参考
  const last = report.downloaded.filter((item) => item.completed).at(-1) ?? null;
  const state = options.configPath ? loadAutoSchedule(autoSchedulePath(options.configPath), now) : null;
  const reference =
    last !== null
      ? { at: now.toISOString(), query: last.query }
      : (() => {
          const done = state?.done.at(-1);
          return done ? { at: done.at, query: done.query } : null;
        })();

  return planWithoutPlanner(now, planOptions, reference);
}

/**
 * 数据来源一：Bangumi Watch Planner。
 *
 * 它给出的是「在看 + 未看 + 已播出」的准确集数，还带播出时刻 ——
 * 所以可以等「播出后 N 分钟」再开始找片源，而不是播出当天一整天瞎搜。
 */
async function runFromPlanner(
  options: AutoOptions,
  savePath: string,
  state: AutoScheduleState | null,
  now: Date
): Promise<AutoReport | null> {
  const { config } = options;
  const planner = new PlannerClient({
    baseUrl: config.plannerBaseUrl,
    timeoutMs: config.trackers.timeoutMs ?? 15_000,
    retries: 1
  });

  const gaps = await planner.collectGaps({
    collectionTypes: config.collectionTypes,
    includeBacklog: config.includeBacklog,
    today: todayString(),
    onlyAiredAfter: config.download.onlyAiredAfter ?? null,
    lookbackDays: config.download.lookbackDays ?? null,
    readyDelayMinutes: config.download.readyDelayMinutes ?? null
  });

  /*
   * 顺手把「在看」的番同步进本地清单。
   *
   * 本地清单是 Planner 挂掉时的兜底数据源；不同步的话，Planner 一不可用
   * 就只剩清单里那几条在追（实测差 7 部）。只补缺，不动已有的条目。
   */
  if (options.configPath) {
    try {
      const dashboard = await planner.dashboard();
      const wantedTypes = new Set(config.collectionTypes);
      const synced = syncFromPlanner(
        options.watchlistFile ?? watchlistPath(options.configPath),
        dashboard.subjects
          .filter((subject) => wantedTypes.has(subject.collectionType))
          .map((subject) => ({
            name: displayName(subject),
            eps: subject.eps ?? 0,
            epStatus: subject.epStatus ?? 0,
            unwatched: subject.unwatchedMainEpisodeCount ?? 0
          }))
      );
      if (synced.added.length > 0) {
        log.info(`已把 Planner 里的 ${synced.added.length} 部番补进本地清单（Planner 不可用时的兜底）：${synced.added.join('、')}`);
      }
    } catch (error) {
      log.debug(`同步本地清单失败：${(error as Error).message}`);
    }
  }

  const report: AutoReport = { subjects: gaps.length, checked: 0, downloaded: [], skipped: [], source: 'planner' };
  if (gaps.length === 0) {
    log.info('Planner 里没有「已播出但没看」的集数');
    return report;
  }

  log.info(`数据来源：Bangumi Watch Planner（${config.plannerBaseUrl}）`);

  const maxPerSubject = options.maxEpisodesPerSubject ?? config.download.maxEpisodesPerSubjectPerRun ?? 999;
  const roundStartedAt = new Date().toISOString();

  try {
    for (const gap of gaps) {
    const name = displayName(gap.subject);
    report.checked += 1;
    try {
      const outcome = await downloadForGap(gap, {
        config,
        savePath,
        dryRun: options.dryRun,
        maxPerSubject,
        retryRounds: options.retryRounds,
        saneEpisodeLimit: options.saneEpisodeLimit,
        onProgress: makeProgressReporter(options.configPath, roundStartedAt),
        // 已经下过的集不再重复搜索下载（Planner 的「未看」不会因为我们下完就变）
        isDone: (episode) => isEpisodeDone(state, gap.subject.id, episode),
        onCompleted: (episodes) => {
          if (!state) return;
          const added = markEpisodesDone(
            state,
            episodes.map((episode) => ({ subjectId: gap.subject.id, episode, query: name })),
            now
          );
          if (added > 0) log.info(`《${name}》第 ${episodes.join('/')} 集已记录为「已下完」，下轮不会再下`);
        }
      });

      if (outcome.episodes.length === 0) {
        report.skipped.push({ query: name, reason: outcome.reason });
        log.info(`《${name}》：${outcome.reason}`);
        continue;
      }
      if (!outcome.downloaded) {
        report.skipped.push({ query: name, reason: 'dry-run 模式，只挑选' });
        continue;
      }
      report.downloaded.push({
        query: name,
        episodes: outcome.episodes,
        files: outcome.files,
        completed: outcome.completed,
        bytesWritten: outcome.bytesWritten ?? 0
      });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.skipped.push({ query: name, reason });
        log.warn(`《${name}》处理失败：${reason}`);
      }
    }
  } finally {
    // 不管这一轮怎么结束，界面上的「正在下载」都要清掉
    if (options.configPath) clearRunning(autoSchedulePath(options.configPath));
  }

  return report;
}

/**
 * 造一个「把下载进度写到计划文件」的回调。
 *
 * 下载跑在计划任务触发的那个进程里，网页界面是另一个常驻进程 ——
 * 不落盘的话界面上什么都看不到（用户就是这么以为「一直 0 MB」的）。
 * 节流到 10 秒一次：进度条不需要更细，写文件太勤反而浪费。
 */
function makeProgressReporter(configPath: string | undefined, startedAt: string) {
  let lastWrite = 0;
  return (info: {
    title: string;
    downloadedBytes: number;
    totalBytes: number;
    speed: number;
    peers: number;
    piecesDone: number;
    piecesTotal: number;
  }): void => {
    if (!configPath) return;
    const now = Date.now();
    if (now - lastWrite < 10_000) return;
    lastWrite = now;
    publishRunning(autoSchedulePath(configPath), {
      title: info.title,
      ratio: info.piecesTotal === 0 ? 0 : info.piecesDone / info.piecesTotal,
      downloadedBytes: info.downloadedBytes,
      totalBytes: info.totalBytes,
      speed: info.speed,
      peers: info.peers,
      startedAt,
      updatedAt: new Date().toISOString()
    });
  };
}

/** 目标集的播出时刻（拿不到就返回 null）。 */
export function airedAtOf(gap: AnimeGap, episode: number): Date | null {
  const meta = gap.episodeMeta.get(episode);
  if (!meta) return null;
  return broadcastTimeOf(meta.airdate, meta.airTime ?? null);
}

/**
 * 从「按集号严格匹配用不上」的候选里挑出疑似同一集的发布。
 *
 * 判据（全部要满足）：
 *   - 单集发布（不是合集：合集没法确认它到底含不含这一集）
 *   - 没被偏好淘汰、有下载链接
 *   - 集号**大于**目标集号（编号偏移只会让数字变大，不会变小）
 *   - 集号没离谱（目标 + 200 以内；长篇番的连续编号可能很大，但不会到天上去）
 *   - 发布时间在目标集播出之后（这是最强的约束：字幕组不会提前放没播的集）
 *
 * 为什么值得冒这个险：真实的例子是 Planner 按季内编号说「第 13 集」，
 * 而字幕组用全季连续编号写成 S01E25 —— 严格匹配只剩一条没种的 raw，
 * 做种多、内封字幕的那几条全被扔掉，结果一整晚只下了几十 MB。
 */
export function selectRelaxedCandidates(input: {
  ranked: readonly ScoredCandidate[];
  targetEpisode: number;
  airedAt: Date | null;
  season?: number | null;
  limit?: number;
}): ScoredCandidate[] {
  const limit = input.limit ?? 6;
  const maxEpisode = input.targetEpisode + 200;
  // 播出前几小时就发布的（有些组会提前挂种）留一点余量
  const earliest = input.airedAt === null ? null : input.airedAt.getTime() - 6 * 3_600_000;

  const picked: ScoredCandidate[] = [];
  for (const item of input.ranked) {
    if (item.rejected) continue;
    if (!item.result.magnet && !item.result.torrentUrl) continue;
    if (item.parsed.isSpecial) continue;
    if (item.parsed.episodes.length !== 1) continue;

    const episode = item.parsed.episodes[0] as number;
    if (episode <= input.targetEpisode) continue;
    if (episode > maxEpisode) continue;

    if (earliest !== null) {
      const published = item.result.publishedAt ? Date.parse(item.result.publishedAt) : Number.NaN;
      // 发布时间缺失时放行（拿不到不代表不对），能拿到就必须在播出之后
      if (!Number.isNaN(published) && published < earliest) continue;
    }

    picked.push(item);
    if (picked.length >= limit) break;
  }

  return picked;
}

/** Planner 的某一集用哪条发布，交给和 download 命令相同的那条路径。 */
async function downloadForGap(gap: AnimeGap, options: {
  config: AppConfig;
  savePath: string;
  dryRun: boolean;
  maxPerSubject: number;
  retryRounds?: number;
  saneEpisodeLimit?: number;
  /** 这一集是不是之前已经下完了（Planner 那边仍显示「未看」）。 */
  isDone?: (episode: number) => boolean;
  /** 确认下完之后回调，用来记住「别再下了」。 */
  onCompleted?: (episodes: number[]) => void;
  /** config.json 的路径（跨进程去重用）。 */
  configPath?: string;
  /** 下载进度（界面展示用）。 */
  onProgress?: (info: {
    title: string;
    downloadedBytes: number;
    totalBytes: number;
    speed: number;
    peers: number;
    piecesDone: number;
    piecesTotal: number;
  }) => void;
}): Promise<EntryOutcome> {
  const { config } = options;
  const name = displayName(gap.subject);

  /*
   * Planner 的「未看」只反映你有没有看，不反映我们下没下过。
   * 不管这一层的话，一集下完之后每个 15 分钟周期都会再去搜一遍同一个种子，
   * 直到用户看完它为止 —— 既是白费带宽，也是在反复捶片源站。
   */
  const already = gap.missingEpisodes.filter((episode) => options.isDone?.(episode) === true);
  const pending = gap.missingEpisodes.filter((episode) => !already.includes(episode));
  if (already.length > 0) log.debug(`《${name}》第 ${already.join('/')} 集已经下过了，跳过`);
  if (pending.length === 0) {
    return {
      episodes: [],
      reason: `第 ${already.join('/')} 集已经下过（等你看完，Planner 就会给下一集）`,
      downloaded: false,
      files: 0,
      completed: false
    };
  }

  const wanted = pending.slice(0, options.maxPerSubject);

  if (wanted.length === 0) {
    return { episodes: [], reason: '没有已播出的未看集数', downloaded: false, files: 0, completed: false };
  }

  log.info(`《${name}》待下第 ${wanted.join('/')} 集`);

  const targets = gap.missingEpisodes.map((episode) => {
    const meta = gap.episodeMeta.get(episode);
    return {
      subjectId: gap.subject.id,
      subjectName: gap.subject.name,
      subjectNameCn: gap.subject.nameCn,
      episode,
      season: meta ? gap.season : gap.season,
      airDate: meta ? meta.airdate : null
    };
  });

  const outcome = await searchAndRank({
    query: gap.queries[0] ?? name,
    altQuery: gap.queries[1],
    config,
    // 自动追番必须按集号严格匹配：下错集是硬伤
    mode: 'automation',
    targets: targets.filter((target) => wanted.includes(target.episode)),
    targetSeason: gap.season
  });

  if (outcome.ranked.length === 0) {
    return { episodes: wanted, reason: '没搜到任何候选', downloaded: false, files: 0, completed: false };
  }

  /*
   * 严格按集号匹配可能只匹配到一条「别人不用这个编号」的发布。
   *
   * 真实例子：Planner 说《相反的你和我 第二季》第 13 集（按季内编号），
   * 而绝大多数字幕组用的是**全季连续编号** —— 同一集写成 S01E25。
   * 严格匹配于是只剩一条几乎没种的 raw（20 KB/s 下了几个小时），
   * 而做种多、内封字幕的那几条全被判成「集号不对」扔掉。
   *
   * 所以严格匹配的候选偏少时，再搜一次并放宽：同一部番、发布时间在目标集
   * 播出之后、集号比目标大（编号偏移一定更大）的单集发布，一并作为候选排在后面。
   * 严格匹配的仍然排在最前面 —— 有对的就先下对的。
   */
  let relaxed: ScoredCandidate[] = [];
  const strictCount = outcome.ranked.filter((item) => !item.rejected && (item.result.magnet || item.result.torrentUrl)).length;
  if (strictCount < 3 && wanted.length === 1) {
    const targetEpisode = wanted[0] as number;
    try {
      const wide = await searchAndRank({
        query: gap.queries[0] ?? name,
        altQuery: gap.queries[1],
        config,
        mode: 'manual'
      });
      relaxed = selectRelaxedCandidates({
        ranked: wide.ranked,
        targetEpisode,
        airedAt: airedAtOf(gap, targetEpisode),
        season: gap.season
      });
      if (relaxed.length > 0) {
        log.info(
          `严格匹配只有 ${strictCount} 条可用，另有 ${relaxed.length} 条疑似同一集（集号 ` +
            `${relaxed.map((item) => item.parsed.episodes[0]).join('/')}，可能是全季连续编号），一并作为候选`
        );
      }
    } catch (error) {
      log.warn(`放宽集号匹配时搜索失败：${(error as Error).message}`);
    }
  }

  if (options.dryRun) {
    return { episodes: wanted, reason: 'dry-run', downloaded: false, files: 0, completed: false };
  }

  const result = await downloadUntilComplete({
    candidates: [...outcome.ranked, ...relaxed],
    config,
    configPath: options.configPath,
    episodes: wanted,
    savePath: options.savePath,
    rounds: options.retryRounds,
    onLog: (message) => log.debug(message),
    onProgress: options.onProgress,
    /*
     * 每轮开始前重新搜一遍。
     *
     * 这是「新番刚播完」场景的关键：那时片源站上往往只有一两条候选，
     * 而且可能是几乎没种的 raw；字幕组版本要晚几个小时才出、做种多得多。
     * 不重新搜的话，六轮重试都在捧同一份列表，好版本永远轮不到。
     */
    refreshCandidates: async () => {
      const again = await searchAndRank({
        query: gap.queries[0] ?? name,
        altQuery: gap.queries[1],
        config,
        mode: 'automation',
        targets: targets.filter((target) => wanted.includes(target.episode)),
        targetSeason: gap.season
      });
      // 新出现的、疑似同一集但编号方式不同的发布也要带上
      const wide = await searchAndRank({ query: gap.queries[0] ?? name, altQuery: gap.queries[1], config, mode: 'manual' });
      const relaxedAgain = selectRelaxedCandidates({
        ranked: wide.ranked,
        targetEpisode: wanted[0] as number,
        airedAt: airedAtOf(gap, wanted[0] as number),
        season: gap.season
      });
      return [...again.ranked, ...relaxedAgain];
    }
  });

  // 只有真下完了才记「别再下了」：下到一半的下一轮还要继续
  if (result.completed) options.onCompleted?.(wanted);

  return {
    episodes: wanted,
    reason: result.completed ? '完成' : `试了 ${result.rounds} 轮仍未下完`,
    downloaded: true,
    files: result.files.length,
    completed: result.completed,
    bytesWritten: result.bytesWritten
  };
}

/** 数据来源二：本地 watchlist.json。 */
async function runFromWatchlist(options: AutoOptions, savePath: string): Promise<AutoReport> {
  const { config } = options;
  const path = options.watchlistFile ?? watchlistPath(options.configPath);
  const list = loadWatchlist(path);

  const report: AutoReport = { subjects: list.entries.length, checked: 0, downloaded: [], skipped: [], source: 'watchlist' };

  if (list.entries.length === 0) {
    log.warn(`追番清单是空的（${path}）。把要追的番名填进 entries 即可，例如：`);
    log.warn('  { "query": "吹响上低音号 第三季" }');
    return report;
  }

  /*
   * 如果清单里一条可用的都没有（典型情况：还是模板，示例条目带着 enabled:false），
   * 要明确告警。无人值守时静默跳过等于「装好了但什么都不做」，最难排查。
   */
  const active = list.entries.filter((entry) => entry.enabled !== false);
  if (active.length === 0) {
    log.warn(`追番清单里 ${list.entries.length} 条全被禁用了（enabled: false），本轮不会做任何事。`);
    log.warn(`清单文件：${path} 把 enabled 改成 true 或删掉该字段即可启用。`);
    return report;
  }

  const maxPerSubject = options.maxEpisodesPerSubject ?? config.download.maxEpisodesPerSubjectPerRun ?? 999;

  for (const entry of list.entries) {
    if (entry.enabled === false) {
      report.skipped.push({ query: entry.query, reason: '清单里标了 enabled: false' });
      continue;
    }

    /*
     * 已知总集数、而且已经追满了就直接跳过，连搜都不用搜。
     *
     * 实测的坑：清单里「吹响上低音号 第三季」写着追到第 13 集，而这一季总共就 13 集，
     * 于是「下一集」算成第 14 集 —— 界面上挂着一条不存在的集数，
     * 兜底模式下还会一直去搜一个永远不会有的第 14 集。
     */
    if (isEntryComplete(entry)) {
      report.skipped.push({ query: entry.query, reason: `全 ${entry.totalEpisodes} 集都已下完` });
      log.info(`《${entry.query}》全 ${entry.totalEpisodes} 集都已下完，不用再找`);
      continue;
    }

    report.checked += 1;
    try {
      const outcome = await runForEntry(entry, {
        config,
        configPath: options.configPath,
        savePath,
        dryRun: options.dryRun,
        maxPerSubject,
        retryRounds: options.retryRounds,
        saneEpisodeLimit: options.saneEpisodeLimit,
        onEpisodesCompleted: (episodes) => {
          markEpisodesCompleted(path, entry.query, episodes);
          log.info(`已记录《${entry.query}》第 ${episodes.join('/')} 集为「已下完」，下轮不会再下`);
        }
      });

      if (outcome.episodes.length === 0) {
        report.skipped.push({ query: entry.query, reason: outcome.reason });
        log.info(`《${entry.query}》：${outcome.reason}`);
        continue;
      }

      if (outcome.downloaded) {
        report.downloaded.push({
          query: entry.query,
          episodes: outcome.episodes,
          files: outcome.files,
          completed: outcome.completed,
          bytesWritten: outcome.bytesWritten ?? 0
        });
        // 只有真正下完了才推进进度，避免「下了一半就当已看过」
        if (outcome.completed) {
          entry.lastEpisode = Math.max(entry.lastEpisode ?? 0, ...outcome.episodes);
          saveWatchlist(path, list);
        }
      } else {
        report.skipped.push({ query: entry.query, reason: 'dry-run 模式，只挑选' });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      report.skipped.push({ query: entry.query, reason });
      log.warn(`《${entry.query}》处理失败：${reason}`);
    }
  }

  return report;
}

type EntryOutcome = {
  episodes: number[];
  reason: string;
  downloaded: boolean;
  files: number;
  completed: boolean;
  bytesWritten?: number;
};

async function runForEntry(
  entry: WatchEntry,
  options: {
    config: AppConfig;
    /** config.json 的路径（跨进程去重用）。 */
    configPath?: string;
    savePath: string;
    dryRun: boolean;
    maxPerSubject: number;
    retryRounds?: number;
    saneEpisodeLimit?: number;
    onEpisodesCompleted?: (episodes: number[]) => void;
  }
): Promise<EntryOutcome> {
  const { config } = options;
  const outcome = await searchAndRank({ query: entry.query, config, mode: 'manual' });

  // 从候选里归纳出「这个季度目前出到第几集」
  const available = new Set<number>();
  for (const item of outcome.ranked) {
    if (item.rejected) continue;
    if (item.parsed.isSpecial) continue;
    for (const episode of item.parsed.episodes) available.add(episode);
    const from = item.parsed.episodeFrom;
    const to = item.parsed.episodeTo;
    if (from !== null && to !== null && to - from < 200) {
      for (let episode = from; episode <= to; episode += 1) available.add(episode);
    }
  }

  /*
   * 剔除「看起来不是集号」的解析结果。
   *
   * 起因是一个很难发现的错误：剧场版/电影版的发布名会被解析出离谱的集号 ——
   * 「剧场版 …最终乐章 前篇～」(BDRip 1080p …) 解析成第 264 集（分辨率残片），
   * 「…莉兹与青鸟～ Liz to aoi tori 2018」解析成第 2018 集（年份）。
   * 于是「片源最高第 2018 集」，整季都被判成「没有新集」，一条都不下。
   *
   * 判据：中位数附近才是真正的集号。比中位数大 3 倍以上的一律当噪声丢掉。
   * 对 13 集的番，阈值就是 39，264 和 2018 都会被清掉；
   * 对真正上百集的长篇，中位数本身就大，不会误伤。
   *
   * 极端情况下如果全被清空（例如只搜到电影版），退回原始集合并告警 ——
   * 宁可下错也不要静默地什么都不做。
   */
  const numbers = [...available].sort((a, b) => a - b);
  const median = numbers.length > 0 ? (numbers[Math.floor((numbers.length - 1) / 2)] as number) : 0;
  const limit = Math.max(options.saneEpisodeLimit ?? 52, median * 3);
  for (const episode of numbers) {
    if (episode > limit) {
      log.debug(`集号 ${episode} 超过合理上限 ${limit}，按解析噪声忽略`);
      available.delete(episode);
    }
  }
  if (available.size === 0 && numbers.length > 0) {
    log.warn('所有候选的集号都超出合理范围，退回原始集号（可能是只搜到了剧场版）');
    for (const episode of numbers) available.add(episode);
  }

  if (available.size === 0) return { episodes: [], reason: '没搜到带集号的资源', downloaded: false, files: 0, completed: false };

  // 注意别写成 (entry.startFrom ?? 1) > 0 ? entry.startFrom : 1 —— 那样缺省值会漏成 undefined，
  // 而 episode >= undefined 恒为 false，表现为「明明有新集却说没有新集」，一条都不下。
  const startFrom = entry.startFrom;
  const start = typeof startFrom === 'number' && startFrom > 0 ? startFrom : 1;
  const done = entry.lastEpisode ?? start - 1;
  /*
   * 「已下完」的判定要同时看两个来源：
   *   - completedEpisodes：逐集的精确记录（合集下了一半时全靠它）
   *   - lastEpisode：连续追到的位置（兼容手写的清单）
   */
  const completed = new Set<number>([...(entry.completedEpisodes ?? []), ...rangeUpTo(done)]);
  const wanted = selectWantedEpisodes({ available, completed, start, limit: options.maxPerSubject });

  log.debug(
    `判定依据：可用集号 ${[...available].sort((a, b) => a - b).join(',')}｜` +
      `已下完 ${[...completed].sort((a, b) => a - b).join(',') || '（无）'}｜` +
      `start=${start} lastEpisode=${done}｜本轮目标 ${wanted.join(',') || '（无）'}`
  );

  if (wanted.length === 0) {
    const highest = Math.max(...available);
    return {
      episodes: [],
      reason: `已下完到第 ${done} 集，片源最高第 ${highest} 集，没有新集`,
      downloaded: false,
      files: 0,
      completed: false
    };
  }

  log.info(`《${entry.query}》发现新集：第 ${wanted.join('/')} 集（已追到 ${done}）`);
  if (options.dryRun) {
    return { episodes: wanted, reason: 'dry-run', downloaded: false, files: 0, completed: false };
  }

  // 用「试到下完为止」的循环，而不是单次尝试 —— 无人值守时没人来点第二次
  const result = await downloadUntilComplete({
    candidates: outcome.ranked,
    config,
    configPath: options.configPath,
    episodes: wanted,
    savePath: options.savePath,
    rounds: options.retryRounds,
    onLog: (message) => log.debug(message),
    // 每轮重新搜一遍：第一轮那批候选可能只有一两条，而且未必下得动
    refreshCandidates: async () => (await searchAndRank({ query: entry.query, config, mode: 'manual' })).ranked
  });

  /*
   * 只有「整包下完」才标记这些集已完成。
   *
   * 下到一半就当已完成，是无人值守场景里最危险的错误：那一集会被永久跳过，
   * 用户以为下好了，播放时才发现是半集。宁可下一轮再挑一次（反正会续传）。
   */
  if (result.completed && options.onEpisodesCompleted) {
    options.onEpisodesCompleted(wanted);
  }

  return {
    episodes: wanted,
    reason: result.completed ? '完成' : `试了 ${result.rounds} 轮仍未下完`,
    downloaded: true,
    files: result.files.length,
    completed: result.completed,
    bytesWritten: result.bytesWritten
  };
}

/**
 * 挑出本轮要下的集号：从 start 起、不在 completed 里、按集号升序、最多 limit 个。
 *
 * 抽成纯函数是因为这里踩过一个隐蔽的坑：start 缺省时如果漏成 undefined，
 * 比较结果恒为 false，整季会被判成「没有新集」而静默地什么都不做。
 * 有单测盯着比靠人眼复查可靠。
 */
export function selectWantedEpisodes(input: {
  available: ReadonlySet<number>;
  completed: ReadonlySet<number>;
  start: number;
  limit: number;
}): number[] {
  const start = Number.isFinite(input.start) && input.start > 0 ? input.start : 1;
  const limit = Number.isFinite(input.limit) && input.limit > 0 ? input.limit : Number.MAX_SAFE_INTEGER;
  return [...input.available]
    .filter((episode) => episode >= start && !input.completed.has(episode))
    .sort((a, b) => a - b)
    .slice(0, limit);
}

/** startFrom..upper 的连续集号（用于把 lastEpisode 也纳入「已完成」集合）。 */
function rangeUpTo(upper: number): number[] {
  if (!Number.isFinite(upper) || upper < 1) return [];
  const limit = Math.min(upper, 5000);
  return Array.from({ length: limit }, (_, index) => index + 1);
}

export { WATCHLIST_FILENAME };
