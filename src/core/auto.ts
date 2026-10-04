import type { AppConfig } from '../config.js';
import { searchAndRank } from './search.js';
import { downloadUntilComplete } from './retry.js';
import {
  loadWatchlist,
  markEpisodesCompleted,
  saveWatchlist,
  watchlistPath,
  WATCHLIST_FILENAME,
  type WatchEntry
} from './watchlist.js';
import { PlannerClient, displayName, type AnimeGap } from '../planner/client.js';
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
};

export type AutoReport = {
  subjects: number;
  checked: number;
  downloaded: Array<{ query: string; episodes: number[]; files: number; completed: boolean; bytesWritten: number }>;
  skipped: Array<{ query: string; reason: string }>;
};

/** 跑一轮：对清单里每一部番，找出「还没下的集」并下载。 */
export async function runAuto(options: AutoOptions): Promise<AutoReport> {
  const { config } = options;
  const savePath = config.download.savePath || config.qbittorrent.savePath;
  if (!savePath) {
    log.error('没有配置下载目录：请在 config.json 里设置 download.savePath');
    return { subjects: 0, checked: 0, downloaded: [], skipped: [] };
  }

  // 优先问 Planner；连不上再退回本地清单
  if (options.preferPlanner !== false) {
    const fromPlanner = await runFromPlanner(options, savePath).catch((error: unknown) => {
      log.warn(`Planner 不可用（${(error as Error).message}），改用本地 watchlist.json`);
      return null;
    });
    if (fromPlanner) return fromPlanner;
  }

  return await runFromWatchlist(options, savePath);
}

/**
 * 数据来源一：Bangumi Watch Planner。
 *
 * 它给出的是「在看 + 未看 + 已播出」的准确集数，还带播出时刻 ——
 * 所以可以等「播出后 N 分钟」再开始找片源，而不是播出当天一整天瞎搜。
 */
async function runFromPlanner(options: AutoOptions, savePath: string): Promise<AutoReport | null> {
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

  const report: AutoReport = { subjects: gaps.length, checked: 0, downloaded: [], skipped: [] };
  if (gaps.length === 0) {
    log.info('Planner 里没有「已播出但没看」的集数');
    return report;
  }

  log.info(`数据来源：Bangumi Watch Planner（${config.plannerBaseUrl}）`);

  const maxPerSubject = options.maxEpisodesPerSubject ?? config.download.maxEpisodesPerSubjectPerRun ?? 999;

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
        saneEpisodeLimit: options.saneEpisodeLimit
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

  return report;
}

/** Planner 的某一集用哪条发布，交给和 download 命令相同的那条路径。 */
async function downloadForGap(gap: AnimeGap, options: {
  config: AppConfig;
  savePath: string;
  dryRun: boolean;
  maxPerSubject: number;
  retryRounds?: number;
  saneEpisodeLimit?: number;
}): Promise<EntryOutcome> {
  const { config } = options;
  const name = displayName(gap.subject);
  const wanted = gap.missingEpisodes.slice(0, options.maxPerSubject);

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

  if (options.dryRun) {
    return { episodes: wanted, reason: 'dry-run', downloaded: false, files: 0, completed: false };
  }

  const result = await downloadUntilComplete({
    candidates: outcome.ranked,
    config,
    episodes: wanted,
    savePath: options.savePath,
    rounds: options.retryRounds,
    onLog: (message) => log.debug(message)
  });

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

  const report: AutoReport = { subjects: list.entries.length, checked: 0, downloaded: [], skipped: [] };

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

    report.checked += 1;
    try {
      const outcome = await runForEntry(entry, {
        config,
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
    episodes: wanted,
    savePath: options.savePath,
    rounds: options.retryRounds,
    onLog: (message) => log.debug(message)
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
