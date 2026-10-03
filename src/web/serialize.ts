import type { ScoredCandidate } from '../anime/rank.js';
import { magnetInfoHash } from '../util/magnet.js';

/**
 * 把后端的 ScoredCandidate 转成前端要用的形状。
 *
 * 单独一层是为了不把内部类型（里面还有 SearchResult、ParsedReleaseName 等）
 * 直接泄露给前端：前端只关心展示需要的字段，接口保持稳定。
 */

export type DisplayResult = {
  key: string;
  title: string;
  magnet: string;
  torrentUrl: string | null;
  sizeBytes: number | null;
  publishedAt: string | null;
  seederCount: number | null;
  leecherCount: number | null;
  tracker: string;
  provider: string;
  pageUrl: string | null;
  parsed: {
    episodes: number[];
    episodeFrom: number | null;
    episodeTo: number | null;
    kind: string;
    season: number | null;
    isSpecial: boolean;
    resolution: string | null;
    container: string | null;
    subtitle: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    bitDepth: number | null;
    source: string | null;
    group: string | null;
  };
  score: number;
  reasons: string[];
  rejected: boolean;
  rejectReason: string | null;
};

export function toDisplayResult(candidate: ScoredCandidate): DisplayResult {
  const { result, parsed } = candidate;
  const infoHash = result.magnet ? magnetInfoHash(result.magnet) : null;

  return {
    // 用 infohash 做前端 key：跨源去重后它才是稳定标识
    key: infoHash ?? `t:${result.title}`,
    title: result.title,
    magnet: result.magnet,
    torrentUrl: result.torrentUrl ?? null,
    sizeBytes: result.sizeBytes,
    publishedAt: result.publishedAt,
    seederCount: result.seederCount,
    leecherCount: result.leecherCount,
    tracker: result.tracker,
    provider: result.provider,
    pageUrl: result.pageUrl ?? null,
    parsed: {
      episodes: parsed.episodes,
      episodeFrom: parsed.episodeFrom,
      episodeTo: parsed.episodeTo,
      kind: parsed.kind,
      season: parsed.season,
      isSpecial: parsed.isSpecial,
      resolution: parsed.resolution,
      container: parsed.container,
      subtitle: parsed.subtitle,
      videoCodec: parsed.videoCodec,
      audioCodec: parsed.audioCodec,
      bitDepth: parsed.bitDepth,
      source: parsed.source,
      group: parsed.group
    },
    score: candidate.score,
    reasons: candidate.reasons,
    rejected: candidate.rejected,
    rejectReason: candidate.rejectReason ?? null
  };
}
