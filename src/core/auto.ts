import type { AppConfig } from '../config.js';
import { searchAndRank } from './search.js';
import { downloadWithFallback } from './fallback.js';
import { loadWatchlist, saveWatchlist, watchlistPath, WATCHLIST_FILENAME, type WatchEntry } from './watchlist.js';
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
};

export type AutoReport = {
  subjects: number;
  checked: number;
  downloaded: Array<{ query: string; episodes: number[]; files: number; completed: boolean }>;
  skipped: Array<{ query: string; reason: string }>;
};

/** 跑一轮：对清单里每一部番，找出「还没下的集」并下载。 */
export async function runAuto(options: AutoOptions): Promise<AutoReport> {
  const { config } = options;
  const path = options.watchlistFile ?? watchlistPath(options.configPath);
  const list = loadWatchlist(path);

  const report: AutoReport = { subjects: list.entries.length, checked: 0, downloaded: [], skipped: [] };

  if (list.entries.length === 0) {
    log.warn(`追番清单是空的（${path}）。把要追的番名填进 entries 即可，例如：`);
    log.warn('  { "query": "吹响上低音号 第三季" }');
    return report;
  }

  const savePath = config.download.savePath || config.qbittorrent.savePath;
  if (!savePath) {
    log.error('没有配置下载目录：请在 config.json 里设置 download.savePath');
    return report;
  }

  const maxPerSubject = options.maxEpisodesPerSubject ?? config.download.maxEpisodesPerSubjectPerRun ?? 3;

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
        maxPerSubject
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
          completed: outcome.completed
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
};

async function runForEntry(
  entry: WatchEntry,
  options: { config: AppConfig; savePath: string; dryRun: boolean; maxPerSubject: number }
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

  if (available.size === 0) return { episodes: [], reason: '没搜到带集号的资源', downloaded: false, files: 0, completed: false };

  const start = (entry.startFrom ?? 1) > 0 ? (entry.startFrom as number) : 1;
  const done = entry.lastEpisode ?? start - 1;
  const wanted = [...available]
    .filter((episode) => episode >= start && episode > done)
    .sort((a, b) => a - b)
    .slice(0, options.maxPerSubject);

  if (wanted.length === 0) {
    const highest = Math.max(...available);
    return {
      episodes: [],
      reason: `已追到第 ${done} 集，片源最高第 ${highest} 集，没有新集`,
      downloaded: false,
      files: 0,
      completed: false
    };
  }

  log.info(`《${entry.query}》发现新集：第 ${wanted.join('/')} 集（已追到 ${done}）`);
  if (options.dryRun) {
    return { episodes: wanted, reason: 'dry-run', downloaded: false, files: 0, completed: false };
  }

  const result = await downloadWithFallback({
    candidates: outcome.ranked,
    config,
    episodes: wanted,
    savePath: options.savePath,
    trialSeconds: config.download.trialSeconds ?? 90,
    minThroughput: (config.download.minThroughputKBps ?? 30) * 1024,
    maxAttempts: config.download.maxAttempts ?? 8,
    budgetMs: (config.download.budgetMinutes ?? 360) * 60_000,
    onLog: (message) => log.debug(message)
  });

  return {
    episodes: wanted,
    reason: result.completed ? '完成' : '部分完成',
    downloaded: true,
    files: result.files.length,
    completed: result.completed
  };
}

export { WATCHLIST_FILENAME };
