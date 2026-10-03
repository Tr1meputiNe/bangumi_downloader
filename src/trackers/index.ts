import type { TrackerConfig } from '../config.js';
import type { SearchResult } from '../anime/rank.js';
import { magnetInfoHash } from '../util/magnet.js';
import { logger } from '../util/log.js';
import { searchAnimesGarden } from './animes-garden.js';
import { searchMikan } from './mikan.js';
import { searchNyaa } from './nyaa.js';

const log = logger('search');

export type TrackerDeps = {
  searchAnimesGarden?: typeof searchAnimesGarden;
  searchMikan?: typeof searchMikan;
  searchNyaa?: typeof searchNyaa;
};

/** 把一份配置整理成各 tracker 需要的选项。 */
function trackerOptions(config: TrackerConfig) {
  return {
    maxResults: config.maxResultsPerTracker ?? 60,
    timeoutMs: config.timeoutMs ?? 15000,
    retries: config.retries ?? 2
  };
}

/** 去重键：优先 infohash，其次磁力原串，最后标题。 */
export function dedupeKey(result: SearchResult): string {
  const fromMagnet = result.magnet ? magnetInfoHash(result.magnet) : null;
  if (fromMagnet) return `ih:${fromMagnet}`;
  if (result.magnet) return `mg:${result.magnet}`;
  if (result.torrentUrl) return `tu:${result.torrentUrl}`;
  return `ti:${result.title.normalize('NFKC').toLowerCase()}`;
}

/** 同一发布被多个源收录时，合并信息（做种数、体积、磁力）。 */
export function mergeResults(results: readonly SearchResult[]): SearchResult[] {
  const byKey = new Map<string, SearchResult>();
  for (const result of results) {
    const key = dedupeKey(result);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...result });
      continue;
    }
    if (!existing.magnet && result.magnet) existing.magnet = result.magnet;
    if (!existing.torrentUrl && result.torrentUrl) existing.torrentUrl = result.torrentUrl;
    if (existing.sizeBytes === null && result.sizeBytes !== null) existing.sizeBytes = result.sizeBytes;
    if (existing.publishedAt === null && result.publishedAt !== null) existing.publishedAt = result.publishedAt;
    if (existing.seederCount === null && result.seederCount !== null) existing.seederCount = result.seederCount;
    if (existing.leecherCount === null && result.leecherCount !== null) existing.leecherCount = result.leecherCount;
    // 记录额外的来源，方便排查
    if (!existing.provider.includes(result.provider)) {
      existing.provider = `${existing.provider},${result.provider}`;
    }
  }
  return [...byKey.values()];
}

export type SearchAllOptions = {
  queries: readonly string[];
  config: TrackerConfig;
  deps?: TrackerDeps;
  /**
   * mikan 只有 .torrent 直链，为了跨源去重需要下载种子反算 infohash。
   * 连通性检查和候选预览不需要 infohash，关掉可以省掉大量请求。
   */
  resolveMikanMagnet?: boolean;
};

/**
 * 用一个番剧的多个关键词变体搜遍所有启用的源，合并去重后返回。
 * 同一个关键词只会请求一次（进程内缓存由调用方负责）。
 */
export async function searchAll(options: SearchAllOptions): Promise<SearchResult[]> {
  const { config, queries } = options;
  const deps: Required<TrackerDeps> = {
    searchAnimesGarden: options.deps?.searchAnimesGarden ?? searchAnimesGarden,
    searchMikan: options.deps?.searchMikan ?? searchMikan,
    searchNyaa: options.deps?.searchNyaa ?? searchNyaa
  };
  const base = trackerOptions(config);

  const jobs: Array<Promise<SearchResult[]>> = [];
  for (const query of queries) {
    if (query.trim() === '') continue;
    if (config.animesGarden) {
      jobs.push(deps.searchAnimesGarden(query, base).catch(() => []));
    }
    if (config.mikan) {
      jobs.push(
        deps
          .searchMikan(query, { ...base, base: config.mikanBase, resolveMagnet: options.resolveMikanMagnet })
          .catch(() => [])
      );
    }
    if (config.nyaa) {
      jobs.push(
        deps
          .searchNyaa(query, { ...base, hosts: config.nyaaHosts ?? ['https://nyaa.land', 'https://nyaa.si'] })
          .catch(() => [])
      );
    }
  }

  if (jobs.length === 0) return [];
  const settled = await Promise.all(jobs);
  const merged = mergeResults(settled.flat());
  log.debug(`关键词 ${queries.length} 个，原始 ${settled.flat().length} 条，去重后 ${merged.length} 条`);
  return merged;
}
