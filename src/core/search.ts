import type { AppConfig } from '../config.js';
import { rankCandidates, type ScoredCandidate, type SearchResult, type TargetEpisode } from '../anime/rank.js';
import { searchAll, type TrackerDeps } from '../trackers/index.js';
import { buildQueries, today } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('search');

/**
 * 把「关键词 → 候选排名」这一段独立出来，
 * 让自动化（按 Planner 的番剧信息搜索）和手动搜索（用户直接输关键词）
 * 共用同一条代码路径，避免两边打分规则出现分歧。
 */

export type SearchMode = 'automation' | 'manual';

export type SearchAndRankOptions = {
  /** 用户或自动化给出的关键词。 */
  query: string;
  /** 可选的番剧原名，用于生成额外的关键词变体。 */
  altQuery?: string;
  config: AppConfig;
  /** 手动搜索不按集号做硬性淘汰；自动化必须严格匹配集号。 */
  mode: SearchMode;
  /** 覆盖搜索实现，便于测试。 */
  search?: typeof searchAll;
  deps?: TrackerDeps;
  /** 打分时使用的目标集数；手动搜索留空。 */
  targets?: TargetEpisode[];
  /** 季度校验用的季度号。 */
  targetSeason?: number | null;
  /** 是否解析 mikan 的 infohash（开着便于跨源去重）。 */
  resolveMikanMagnet?: boolean;
};

export type SearchAndRankResult = {
  /** 实际使用的关键词变体。 */
  queries: string[];
  /** 全部候选，含被淘汰的，便于前端展示「为什么没选它」。 */
  ranked: ScoredCandidate[];
  /** 去重合并后的结果数。 */
  rawCount: number;
  /** 每个源的失败情况。 */
  errors: Array<{ tracker: string; reason: string }>;
  elapsedMs: number;
};

export async function searchAndRank(options: SearchAndRankOptions): Promise<SearchAndRankResult> {
  const startedAt = Date.now();
  const queries = buildQueries(options.query, options.altQuery ?? options.query);
  const search = options.search ?? searchAll;

  const errors: Array<{ tracker: string; reason: string }> = [];
  const results = await search({
    queries,
    config: options.config.trackers,
    deps: options.deps,
    resolveMikanMagnet: options.resolveMikanMagnet ?? true
  }).catch((error: unknown) => {
    errors.push({ tracker: 'all', reason: error instanceof Error ? error.message : String(error) });
    return [] as SearchResult[];
  });

  const ranked = rankCandidates(results, {
    preference: options.config.preference,
    targets: options.targets ?? [],
    targetSeason: options.targetSeason ?? null,
    matchesEpisode: options.mode === 'automation'
  });

  log.debug(
    `「${options.query}」关键词 ${queries.length} 个，原始 ${results.length} 条，耗时 ${Date.now() - startedAt}ms`
  );

  return {
    queries,
    ranked,
    rawCount: results.length,
    errors,
    elapsedMs: Date.now() - startedAt
  };
}

export { today };
