import { logger } from '../util/log.js';
import { buildQueries, toDateOnly } from '../util/text.js';

const log = logger('planner');

/**
 * Bangumi Watch Planner（本机 3777 端口那个应用）的客户端。
 * 该应用的数据结构直接来自它的 REST API，字段名与它的 TypeScript 类型保持一致。
 */

export type PlannerEpisode = {
  id: number;
  subjectId: number;
  subjectName: string;
  subjectNameCn: string;
  subjectUrl?: string;
  episodeType: number;
  sort: number;
  /** 集号。可能为 null（尚未确定集号的未播集）。 */
  ep: number | null;
  name: string;
  nameCn: string;
  airdate: string;
  airTime?: string;
  /** 0 = 未看，2 = 已看。 */
  collectionType: number;
  dismissedAt?: string | null;
  snoozedUntil?: string | null;
};

export type PlannerSubject = {
  id: number;
  name: string;
  nameCn: string;
  eps: number;
  epStatus: number;
  image?: string | null;
  url?: string;
  /** 1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃 */
  collectionType: number;
  plannerMode?: string | null;
  seasonKey?: string | null;
  seasonKind?: string | null;
  airDate?: string | null;
  airYear?: number | null;
  totalEpisodesKnown?: boolean;
  completedAt?: string | null;
  /** 该番剧未看的正片集数，由 /api/dashboard 直接给出。 */
  unwatchedMainEpisodeCount?: number;
  unwatchedProgressEpisodeCount?: number;
  nextEpisode?: PlannerEpisode | null;
};

export type PlannerDashboard = {
  pendingEpisodes: PlannerEpisode[];
  subjects: PlannerSubject[];
  lastSyncAt: string | null;
  lastError: string | null;
};

/** 一部番剧 + 它缺失的集号，这是下载器的核心工作单元。 */
export type AnimeGap = {
  subject: PlannerSubject;
  /** 需要下载的集号，升序。 */
  missingEpisodes: number[];
  /** 集号 → 该集的元数据。 */
  episodeMeta: Map<number, PlannerEpisode>;
  /** 从标题推断出的季度号，用于过滤别的季度的发布。 */
  season: number | null;
  /** 用于搜索的关键词，按优先级排列。 */
  queries: string[];
};

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

type PlannerClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  retries: number;
};

/** 从 Planner 标题推断季度号：「第2期」「第二季」「S02」「2nd Season」。 */
export function inferSeason(name: string, nameCn: string): number | null {
  const sources = [name, nameCn];
  const patterns: RegExp[] = [
    /第\s*(\d{1,2})\s*(?:季|期|部|クール)/,
    /\bS(\d{1,2})\b/i,
    /\bSeason\s*(\d{1,2})\b/i,
    /\b(\d{1,2})(?:st|nd|rd|th)\s*Season\b/i,
    /\bPart\s*(\d{1,2})\b/i
  ];
  const cnDigits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
  };
  for (const source of sources) {
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (!match?.[1]) continue;
      const raw = match[1];
      const value = /^\d+$/.test(raw) ? Number(raw) : cnDigits[raw] ?? Number.NaN;
      if (Number.isFinite(value) && value >= 1 && value <= 20) return value;
    }
  }
  return null;
}

export class PlannerClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retries: number;

  constructor(options: PlannerClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs;
    this.#retries = options.retries;
  }

  async #fetchJson<T>(path: string): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: 'application/json' }
        });
        if (!response.ok) {
          throw new PlannerError(`GET ${path} 返回 ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (attempt < this.#retries) {
          const wait = 400 * (attempt + 1);
          log.debug(`${path} 失败（${isAbort ? '超时' : String(error)}），${wait}ms 后重试`);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastError instanceof PlannerError) throw lastError;
    throw new PlannerError(
      `无法连接 Bangumi Watch Planner（${this.#baseUrl}）：${lastError instanceof Error ? lastError.message : String(lastError)}\n` +
        '请确认该应用正在运行（浏览器打开 ' + this.#baseUrl + ' 可访问）。'
    );
  }

  /** 拉取首页数据：在看番剧列表 + 今天应该看的集数。 */
  async dashboard(): Promise<PlannerDashboard> {
    return this.#fetchJson<PlannerDashboard>('/api/dashboard');
  }

  /** 某部番剧的全部正片分集及观看状态。 */
  async subjectEpisodes(subjectId: number): Promise<PlannerEpisode[]> {
    const payload = await this.#fetchJson<{ episodes: PlannerEpisode[] }>(`/api/subjects/${subjectId}/episodes`);
    return payload.episodes ?? [];
  }

  /**
   * 计算「在看」番剧里还没看的集号。
   * 只取 episodeType === 0（正片），collectionType !== 2（未看），
   * 且已开播（airdate <= 今天）的集，避免去下还没播的集。
   */
  async collectGaps(options: {
    collectionTypes: number[];
    includeBacklog?: boolean;
    today: string;
    onlyAiredAfter?: string | null;
    lookbackDays?: number | null;
  }): Promise<AnimeGap[]> {
    const dashboard = await this.dashboard();
    const wanted = new Set(options.collectionTypes);
    const subjects = dashboard.subjects.filter((subject) => wanted.has(subject.collectionType));

    if (subjects.length === 0) {
      log.warn(`没有找到收藏状态为 ${[...wanted].join('/')} 的番剧，请先在 3777 页面把番剧标记为「在看」`);
      return [];
    }

    const lowerBound = options.lookbackDays
      ? shiftAiredLimit(options.today, options.lookbackDays)
      : options.onlyAiredAfter ?? null;

    const gaps: AnimeGap[] = [];
    for (const subject of subjects) {
      let episodes: PlannerEpisode[];
      try {
        episodes = await this.subjectEpisodes(subject.id);
      } catch (error) {
        log.warn(`读取《${displayName(subject)}》分集失败：${(error as Error).message}`);
        continue;
      }

      const episodeMeta = new Map<number, PlannerEpisode>();
      for (const episode of episodes) {
        if (episode.episodeType !== 0) continue;
        if (episode.collectionType === 2) continue;
        if (episode.ep === null || !Number.isFinite(episode.ep)) continue;
        const airDate = toDateOnly(episode.airdate);
        // 未播出的集不下载
        if (airDate === null || airDate > options.today) continue;
        if (lowerBound && airDate < lowerBound) continue;
        // 同集号取先出现的
        if (!episodeMeta.has(episode.ep)) episodeMeta.set(episode.ep, episode);
      }

      if (episodeMeta.size === 0) continue;

      gaps.push({
        subject,
        missingEpisodes: [...episodeMeta.keys()].sort((a, b) => a - b),
        episodeMeta,
        season: inferSeason(subject.name, subject.nameCn),
        queries: buildQueries(subject.nameCn, subject.name)
      });
    }

    log.info(`共 ${gaps.length} 部番剧有未看集数，合计 ${gaps.reduce((sum, gap) => sum + gap.missingEpisodes.length, 0)} 集`);
    return gaps;
  }
}

export function displayName(subject: Pick<PlannerSubject, 'nameCn' | 'name'>): string {
  return subject.nameCn?.trim() || subject.name;
}

function shiftAiredLimit(today: string, days: number): string {
  const parsed = new Date(`${today}T00:00:00`);
  parsed.setDate(parsed.getDate() - days);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}
