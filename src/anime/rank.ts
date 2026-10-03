import type { ReleasePreference, ScoreWeights } from '../config.js';
import { DEFAULT_WEIGHTS } from '../config.js';
import { matchesEpisode, parseReleaseName, seasonCompatible, type ParsedReleaseName } from './parse.js';

export type SearchResult = {
  title: string;
  /** 磁力链接。没有磁力时留空，由调用方补 infohash。 */
  magnet: string;
  /** .torrent 直链。部分源（mikan）只有直链。 */
  torrentUrl?: string;
  sizeBytes: number | null;
  publishedAt: string | null;
  seederCount: number | null;
  leecherCount: number | null;
  tracker: string;
  provider: string;
  pageUrl?: string;
};

export type TargetEpisode = {
  subjectId: number;
  subjectName: string;
  subjectNameCn: string;
  episode: number;
  /** 发布名里显式季度写别的季度时用来排除，未知则传 null。 */
  season: number | null;
  airDate: string | null;
};

export type ScoredCandidate = {
  result: SearchResult;
  parsed: ParsedReleaseName;
  score: number;
  reasons: string[];
  /** 该发布覆盖到的、本次需要的集号。 */
  coversEpisodes: number[];
  /** 是否命中硬性淘汰条件。 */
  rejected: boolean;
  rejectReason?: string;
};

export type PickOutcome = {
  candidate: ScoredCandidate | null;
  /** 按分数排序的全部候选，便于 dry-run 展示与排错。 */
  ranked: ScoredCandidate[];
};

function normalizeKeyword(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function keywordHits(haystack: string, keywords: readonly string[] | undefined): string[] {
  if (!keywords || keywords.length === 0) return [];
  const hay = normalizeKeyword(haystack);
  return keywords.filter((keyword) => keyword.trim() !== '' && hay.includes(normalizeKeyword(keyword)));
}

function weightOf(preference: ReleasePreference, key: keyof ScoreWeights): number {
  return preference.weights?.[key] ?? DEFAULT_WEIGHTS[key];
}

/** 列表里越靠前拿分越高；未命中拿 0。 */
function rankScore(value: string | null, list: readonly string[] | undefined, weight: number): number {
  if (!list || list.length === 0 || weight === 0) return 0;
  if (value === null) return 0;
  const normalized = normalizeKeyword(value);
  const index = list.findIndex((item) => normalizeKeyword(item) === normalized);
  if (index < 0) return 0;
  return weight * (1 - index / list.length);
}

function groupScore(parsed: ParsedReleaseName, preference: ReleasePreference): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const group = parsed.group;
  if (group) {
    const normalized = normalizeKeyword(group);
    const preferred = (preference.preferGroups ?? []).findIndex((item) => normalizeKeyword(item) === normalized);
    const avoided = (preference.avoidGroups ?? []).findIndex((item) => normalizeKeyword(item) === normalized);
    if (preferred >= 0) {
      score += weightOf(preference, 'group') * (1 - preferred / Math.max(1, preference.preferGroups!.length));
      reasons.push(`字幕组偏好 +${score.toFixed(1)}`);
    }
    if (avoided >= 0) {
      const penalty = weightOf(preference, 'group') * (1 - avoided / Math.max(1, preference.avoidGroups!.length));
      score -= penalty;
      reasons.push(`字幕组规避 -${penalty.toFixed(1)}`);
    }
  }
  return { score, reasons };
}

export type ScoreContext = {
  preference: ReleasePreference;
  targets: TargetEpisode[];
  /** 目标番剧的季度号，用于排除明确写了别的季度的发布。 */
  targetSeason: number | null;
  /**
   * 是否要求集号覆盖目标集。
   *
   * 自动化必须为 true：下错集是硬伤。
   * 手动搜索为 false：用户搜「葬送的芙莉莲」是想看全部资源，
   * 如果按「第 1 集」做硬性淘汰，几十条结果里只会剩下一两条，没法挑。
   * 关掉之后集号仍然会被解析和展示，只是不再作为淘汰依据。
   */
  matchesEpisode?: boolean;
};

/**
 * 对一个搜索结果打分。
 * 硬性淘汰（排除词、必需词、集号/季度不匹配）会标记 rejected 而不是直接丢弃，
 * 这样 dry-run 能告诉你「为什么没选中」。
 */
export function scoreCandidate(result: SearchResult, context: ScoreContext): ScoredCandidate {
  const parsed = parseReleaseName(result.title);
  const reasons: string[] = [];
  let score = 0;
  let rejected = false;
  let rejectReason: string | undefined;

  const reject = (reason: string) => {
    if (!rejected) {
      rejected = true;
      rejectReason = reason;
    }
  };

  const excluded = keywordHits(result.title, context.preference.excludeKeywords);
  if (excluded.length > 0) reject(`命中排除词 ${excluded.join('/')}`);

  const required = context.preference.requireKeywords ?? [];
  if (required.length > 0) {
    const hits = keywordHits(result.title, required);
    if (hits.length === 0) reject(`缺少必需关键词 ${required.join('/')}`);
  }

  if (parsed.isSpecial && context.targets.every((target) => !parsed.episodes.includes(target.episode))) {
    reject('特别篇/特典，不匹配正片');
  }

  const coversEpisodes = context.targets
    .map((target) => target.episode)
    .filter((episode) => matchesEpisode(parsed, episode));

  // 只有自动化模式才把「集号不覆盖」当作淘汰条件
  if (context.matchesEpisode !== false && coversEpisodes.length === 0) {
    reject(parsed.kind === 'unknown' ? '无法识别集号' : `集号不覆盖 第${context.targets.map((t) => t.episode).join('/')}集`);
  }

  if (!seasonCompatible(parsed, context.targetSeason)) {
    reject(`季度不匹配（发布为 S${parsed.season}）`);
  }

  // 基础质量分
  const containerScore = rankScore(parsed.container, context.preference.containerPreference, weightOf(context.preference, 'container'));
  if (containerScore > 0) reasons.push(`容器 ${parsed.container} +${containerScore.toFixed(1)}`);
  score += containerScore;

  const resolutionScore = rankScore(parsed.resolution, context.preference.resolutionPreference, weightOf(context.preference, 'resolution'));
  if (resolutionScore > 0) reasons.push(`分辨率 ${parsed.resolution} +${resolutionScore.toFixed(1)}`);
  else if (parsed.resolution === null) reasons.push('分辨率未知 +0');
  score += resolutionScore;

  const preferenceList = context.preference.subtitlePreference ?? [];
  let subtitleScore = rankScore(parsed.subtitle, preferenceList, weightOf(context.preference, 'subtitle'));
  // 「字幕」这种泛化命中只给一半分，避免无语言信息的发布压过明确的简中
  if (parsed.subtitle === '字幕' && subtitleScore > 0) subtitleScore *= 0.5;
  if (subtitleScore > 0) reasons.push(`字幕 ${parsed.subtitle} +${subtitleScore.toFixed(1)}`);
  score += subtitleScore;

  const group = groupScore(parsed, context.preference);
  score += group.score;
  reasons.push(...group.reasons);

  const saturation = context.preference.seederSaturation ?? 20;
  if (result.seederCount !== null && saturation > 0) {
    const ratio = Math.max(0, Math.min(1, Math.log10(1 + result.seederCount) / Math.log10(1 + saturation)));
    const seederScore = weightOf(context.preference, 'seeders') * ratio;
    score += seederScore;
    reasons.push(`做种 ${result.seederCount} +${seederScore.toFixed(1)}`);
  }

  // 缺多集时更值得下合集
  if (parsed.kind === 'batch' && context.targets.length > 1 && (context.preference.preferBatch ?? true)) {
    const bonus = weightOf(context.preference, 'batch') * Math.min(1, coversEpisodes.length / context.targets.length);
    score += bonus;
    reasons.push(`合集覆盖 ${coversEpisodes.length} 集 +${bonus.toFixed(1)}`);
  }

  // 覆盖更多需要的集数小幅加分，但幅度必须小于画质分，避免为了省事下一个巨大的低画质合集
  if (context.targets.length > 1 && coversEpisodes.length > 1) {
    score += Math.min(5, coversEpisodes.length);
    reasons.push(`覆盖集数 +${Math.min(5, coversEpisodes.length)}`);
  }

  if (parsed.bitDepth === 10) {
    score += 3;
    reasons.push('10bit +3');
  }

  return { result, parsed, score, reasons, coversEpisodes, rejected, rejectReason };
}

/** 给一组搜索结果排序；默认把被淘汰的排在最后。 */
export function rankCandidates(results: readonly SearchResult[], context: ScoreContext): ScoredCandidate[] {
  return results
    .map((result) => scoreCandidate(result, context))
    .sort((a, b) => {
      if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return (b.result.seederCount ?? 0) - (a.result.seederCount ?? 0);
    });
}

/**
 * 为一组目标集数挑选一个发布。
 * 优先在未被淘汰的候选里挑分数最高的。
 */
export function pickRelease(results: readonly SearchResult[], context: ScoreContext): PickOutcome {
  const ranked = rankCandidates(results, context);
  const candidate = ranked.find((item) => !item.rejected) ?? null;
  return { candidate, ranked };
}
