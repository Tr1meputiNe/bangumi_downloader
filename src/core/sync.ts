import type { AppConfig } from '../config.js';
import type { AnimeGap, PlannerClient } from '../planner/client.js';
import { displayName } from '../planner/client.js';
import { pickRelease, type ScoredCandidate, type SearchResult, type TargetEpisode } from '../anime/rank.js';
import { matchesEpisode, parseReleaseName } from '../anime/parse.js';
import { searchAll } from '../trackers/index.js';
import type { QbittorrentClient } from '../qbittorrent/client.js';
import { FilePriority } from '../qbittorrent/client.js';
import type { StateStore } from '../state/store.js';
import { magnetInfoHash } from '../util/magnet.js';
import { parseTorrent, type TorrentMeta } from '../util/torrent-file.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('sync');

export type DownloadMode = 'enabled' | 'dry-run';

export type EpisodeDecision = {
  episode: number;
  outcome: 'download' | 'skip-history' | 'no-release' | 'limit';
  candidate?: ScoredCandidate;
  detail?: string;
};

export type SubjectPlan = {
  subjectId: number;
  subjectName: string;
  decisions: EpisodeDecision[];
};

export type TorrentPlan = {
  infoHash: string;
  title: string;
  tracker: string;
  sizeBytes: number | null;
  /** 该种子需要下载的集号。 */
  episodes: number[];
  subjectId: number;
  subjectName: string;
  candidate: ScoredCandidate;
};

export type AddedTorrent = {
  subjectName: string;
  episodes: number[];
  title: string;
  tracker: string;
  sizeBytes: number | null;
  /** 选择性下载时实际下载的文件数；未做选择时为 null。 */
  fileCount: number | null;
};

export type SyncReport = {
  mode: DownloadMode;
  subjects: SubjectPlan[];
  added: AddedTorrent[];
  failures: Array<{ subjectName: string; episode?: number; reason: string }>;
  stats: {
    subjects: number;
    missingEpisodes: number;
    planned: number;
    downloaded: number;
    skippedHistory: number;
    noRelease: number;
  };
};

export type SyncDeps = {
  planner: PlannerClient;
  state: StateStore;
  qbittorrent?: QbittorrentClient;
  config: AppConfig;
  /** 覆盖搜索实现，便于测试。 */
  search?: typeof searchAll;
  /** 覆盖当前日期，便于测试。 */
  today: string;
};

/** 一个 infohash 覆盖多集；把同一番剧的集号合并成一次推送。 */
export function groupByTorrent(
  entries: Array<{ episode: number; candidate: ScoredCandidate }>,
  subject: { id: number; name: string }
): TorrentPlan[] {
  const byHash = new Map<string, TorrentPlan>();
  for (const { episode, candidate } of entries) {
    const infoHash = magnetInfoHash(candidate.result.magnet) ?? `title:${candidate.result.title}`;
    const existing = byHash.get(infoHash);
    if (existing) {
      if (!existing.episodes.includes(episode)) existing.episodes.push(episode);
      continue;
    }
    byHash.set(infoHash, {
      infoHash,
      title: candidate.result.title,
      tracker: candidate.result.tracker,
      sizeBytes: candidate.result.sizeBytes,
      episodes: [episode],
      subjectId: subject.id,
      subjectName: subject.name,
      candidate
    });
  }
  for (const plan of byHash.values()) plan.episodes.sort((a, b) => a - b);
  return [...byHash.values()];
}

/** 从种子文件列表里挑出属于目标集的文件索引。 */
export function selectFileIndexes(
  files: ReadonlyArray<{ index: number; path?: string; name?: string }>,
  targetEpisodes: readonly number[]
): { indexes: number[]; matchedEpisodes: number[] } {
  const wanted = new Set(targetEpisodes);
  const indexes: number[] = [];
  const matchedEpisodes = new Set<number>();

  for (const file of files) {
    const filePath = file.path ?? file.name ?? '';
    const parsed = parseReleaseName(filePath);
    const hits = [...wanted].filter((episode) => matchesEpisode(parsed, episode));
    if (hits.length === 0) continue;
    indexes.push(file.index);
    for (const episode of hits) matchedEpisodes.add(episode);
  }

  return { indexes, matchedEpisodes: [...matchedEpisodes].sort((a, b) => a - b) };
}

/** 收集本次需要下载的目标集，附带季度信息供打分的季度校验使用。 */
export function buildTargets(gap: AnimeGap): TargetEpisode[] {
  return gap.missingEpisodes.map((episode) => ({
    subjectId: gap.subject.id,
    subjectName: gap.subject.name,
    subjectNameCn: gap.subject.nameCn,
    episode,
    season: gap.season,
    airDate: gap.episodeMeta.get(episode)?.airdate ?? null
  }));
}

/**
 * 主流程：拉取追番进度 → 找出未看集 → 搜种 → 打分选种 → 推送到 qBittorrent。
 * dry-run 模式下只挑选和打印，不推送、不写状态。
 */
export async function runSync(deps: SyncDeps, mode: DownloadMode): Promise<SyncReport> {
  const { config, planner, state, qbittorrent } = deps;
  const search = deps.search ?? searchAll;

  const report: SyncReport = {
    mode,
    subjects: [],
    added: [],
    failures: [],
    stats: { subjects: 0, missingEpisodes: 0, planned: 0, downloaded: 0, skippedHistory: 0, noRelease: 0 }
  };

  const gaps = await planner.collectGaps({
    collectionTypes: config.collectionTypes,
    includeBacklog: config.includeBacklog,
    today: deps.today,
    onlyAiredAfter: config.download.onlyAiredAfter ?? null,
    lookbackDays: config.download.lookbackDays ?? null
  });

  report.stats.subjects = gaps.length;
  const maxPerSubject = config.download.maxEpisodesPerSubjectPerRun ?? 3;
  const maxTorrents = config.download.maxTorrentsPerRun ?? 10;
  let torrentsPlanned = 0;

  for (const gap of gaps) {
    const name = displayName(gap.subject);
    const plan: SubjectPlan = { subjectId: gap.subject.id, subjectName: name, decisions: [] };

    // 先剔除已经推送过的集
    const pending: number[] = [];
    for (const episode of gap.missingEpisodes) {
      if (state.hasEpisode(gap.subject.id, episode)) {
        plan.decisions.push({ episode, outcome: 'skip-history' });
        report.stats.skippedHistory += 1;
      } else {
        pending.push(episode);
      }
    }

    report.stats.missingEpisodes += gap.missingEpisodes.length;
    if (pending.length === 0) {
      report.subjects.push(plan);
      continue;
    }

    const targets = buildTargets(gap);
    const targetsByEpisode = new Map(targets.map((target) => [target.episode, target]));

    // 按批搜索：一次搜索拿回的结果同时服务本批所有集，减少请求数
    const batchEpisodes = pending.slice(0, maxPerSubject);
    const batchTargets = batchEpisodes
      .map((episode) => targetsByEpisode.get(episode))
      .filter((item): item is TargetEpisode => Boolean(item));

    log.info(`《${name}》缺 ${pending.length} 集，本轮处理 第${batchEpisodes.join('/')}集`);
    const results = await search({ queries: gap.queries, config: config.trackers });

    if (results.length === 0) {
      for (const episode of batchEpisodes) {
        plan.decisions.push({ episode, outcome: 'no-release', detail: '所有片源都没有搜到结果' });
        report.stats.noRelease += 1;
      }
      report.subjects.push(plan);
      continue;
    }

    for (const episode of batchEpisodes) {
      const choice = chooseForEpisode(episode, batchTargets, results, gap, config);
      if (!choice) {
        plan.decisions.push({ episode, outcome: 'no-release', detail: '没有找到覆盖该集且符合偏好的发布' });
        report.stats.noRelease += 1;
        continue;
      }
      plan.decisions.push({ episode, outcome: 'download', candidate: choice });
    }

    // 超出单轮上限的集数留到下一轮
    for (const episode of pending.slice(maxPerSubject)) {
      plan.decisions.push({ episode, outcome: 'limit', detail: `本轮已达单番上限 ${maxPerSubject} 集` });
    }

    report.subjects.push(plan);

    const downloadable = plan.decisions.filter(
      (decision): decision is EpisodeDecision & { candidate: ScoredCandidate } =>
        decision.outcome === 'download' && Boolean(decision.candidate)
    );
    if (downloadable.length === 0) continue;

    // 同一番剧里多个集可能落在同一个种子（合集）上，合并成一次推送
    for (const torrentPlan of groupByTorrent(downloadable, { id: gap.subject.id, name })) {
      if (torrentsPlanned >= maxTorrents) {
        report.failures.push({ subjectName: name, reason: `本轮种子数已达上限 ${maxTorrents}，剩余留到下一轮` });
        break;
      }
      torrentsPlanned += 1;
      report.stats.planned += torrentPlan.episodes.length;

      if (mode === 'dry-run') {
        logChoice(torrentPlan);
        continue;
      }

      if (!qbittorrent) throw new Error('内部错误：非 dry-run 模式必须提供 qBittorrent 客户端');

      try {
        const added = await pushTorrent(qbittorrent, config, torrentPlan);
        report.stats.downloaded += torrentPlan.episodes.length;
        report.added.push(added);
        for (const episode of torrentPlan.episodes) {
          state.record({
            subjectId: gap.subject.id,
            subjectName: name,
            episode,
            infoHash: torrentPlan.infoHash,
            title: torrentPlan.title,
            tracker: torrentPlan.tracker,
            sizeBytes: torrentPlan.sizeBytes,
            added: true
          });
        }
        state.save();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.error(`推送《${name}》第${torrentPlan.episodes.join('/')}集失败：${reason}`);
        report.failures.push({ subjectName: name, reason });
      }
    }
  }

  state.save();
  return report;
}

/**
 * 为单集挑发布。把整批目标集一起传进去，这样覆盖了本批多集的合集
 * 能拿到额外加分并被合并推送。
 */
function chooseForEpisode(
  episode: number,
  batchTargets: TargetEpisode[],
  results: readonly SearchResult[],
  gap: AnimeGap,
  config: AppConfig
): ScoredCandidate | null {
  const { candidate } = pickRelease(results, {
    preference: config.preference,
    targets: batchTargets,
    targetSeason: gap.season
  });
  if (!candidate) return null;
  if (!matchesEpisode(candidate.parsed, episode)) return null;
  return candidate;
}

function logChoice(plan: TorrentPlan): void {
  log.info(
    `[dry-run] 《${plan.subjectName}》第${plan.episodes.join('/')}集 ← ${plan.tracker} | ${formatSize(plan.sizeBytes)} | ${plan.candidate.result.title}`
  );
  log.debug(`         打分 ${plan.candidate.score.toFixed(1)}：${plan.candidate.reasons.join('，')}`);
}

/**
 * 推送给 qBittorrent。
 *
 * 关键点：磁力链接在 qBittorrent 取到元数据前没有文件列表，无法指定「只下第 N 集」。
 * 所以当选中的是合集、而目标只是其中少数几集时，我们先自己拉一份 .torrent，
 * 解析出文件清单，挑选目标分集，再把种子内容直接喂给 qBittorrent，
 * 这样它在添加的瞬间就能应用 filePrio，不会白白下载整个合集。
 */
async function pushTorrent(
  client: QbittorrentClient,
  config: AppConfig,
  plan: TorrentPlan
): Promise<AddedTorrent> {
  const { qbittorrent, trackers } = config;
  const result = plan.candidate.result;

  const base = {
    savePath: qbittorrent.savePath || undefined,
    category: qbittorrent.category || undefined,
    tags: qbittorrent.tags,
    paused: qbittorrent.paused
  };

  // 单个文件覆盖全集数时不需要挑文件
  const needsSelection = result.sizeBytes !== null && result.sizeBytes > 4 * 1024 ** 3;
  let meta: TorrentMeta | null = null;
  let metaBytes: Uint8Array | null = null;

  if (needsSelection && result.torrentUrl) {
    // 只下载一次种子文件：既用来解析文件清单，也直接喂给 qBittorrent
    metaBytes = await downloadTorrentBytes(result.torrentUrl, trackers.timeoutMs ?? 15000).catch(() => null);
    if (metaBytes) meta = parseTorrent(metaBytes);
  }

  if (meta && metaBytes && meta.files.length > 0) {
    const selected = selectFileIndexes(meta.files, plan.episodes);
    if (selected.indexes.length > 0 && selected.indexes.length < meta.files.length) {
      await client.addTorrent({
        torrentBuffer: metaBytes,
        ...base,
        fileIndexes: selected.indexes
      });
      log.info(
        `已推送到 qBittorrent：《${plan.subjectName}》第${plan.episodes.join('/')}集 ` +
          `(${plan.tracker}, 合集共 ${formatSize(plan.sizeBytes)}, 只下载 ${selected.indexes.length}/${meta.files.length} 个文件)`
      );
      return {
        subjectName: plan.subjectName,
        episodes: plan.episodes,
        title: plan.title,
        tracker: plan.tracker,
        sizeBytes: plan.sizeBytes,
        fileCount: selected.indexes.length
      };
    }
  }

  // 普通单集发布：直接用磁力（或 .torrent 直链）
  const url = result.magnet || result.torrentUrl;
  if (!url) throw new Error('该搜索结果既没有磁力链接也没有种子直链，无法下载');
  await client.addTorrent({ url, ...base });
  log.info(
    `已推送到 qBittorrent：《${plan.subjectName}》第${plan.episodes.join('/')}集 (${plan.tracker}, ${formatSize(plan.sizeBytes)})`
  );
  return {
    subjectName: plan.subjectName,
    episodes: plan.episodes,
    title: plan.title,
    tracker: plan.tracker,
    sizeBytes: plan.sizeBytes,
    fileCount: null
  };
}

async function downloadTorrentBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!response.ok) throw new Error(`下载种子文件失败：HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

export { FilePriority };
