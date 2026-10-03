import type { AppConfig } from '../config.js';
import type { QbittorrentClient } from '../qbittorrent/client.js';
import { parseTorrent, type TorrentMeta } from '../util/torrent-file.js';
import { parseReleaseName, matchesEpisode } from '../anime/parse.js';
import { magnetInfoHash } from '../util/magnet.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('push');

/**
 * 把「一个候选发布 → 推送到 qBittorrent」这段逻辑集中在这里，
 * 让自动化（sync）和 Web 手动下载共用，避免两边行为不一致。
 */

export type PushInput = {
  title: string;
  magnet?: string;
  torrentUrl?: string;
  /** 只下载这些集号；为空表示整包下载。 */
  episodes?: number[];
  /** 已知体积，用于判断是否需要先取种子文件清单。 */
  sizeBytes?: number | null;
  tracker?: string;
};

export type PushResult = {
  title: string;
  infoHash: string;
  /** 实际勾选的文件数；整包下载时为 null。 */
  fileCount: number | null;
  episodes: number[];
};

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

/**
 * 推送一个发布到 qBittorrent。
 *
 * 关键点：磁力链接在 qBittorrent 取到元数据前没有文件列表，无法指定「只下第 N 集」。
 * 所以当需要选集、且拿得到 .torrent 直链时，我们先自己下载并解析种子，
 * 挑出目标文件，再把种子内容直接喂给 qBittorrent，让 filePrio 在添加的瞬间生效。
 */
export async function pushRelease(
  client: QbittorrentClient,
  config: AppConfig,
  input: PushInput
): Promise<PushResult> {
  const { qbittorrent, trackers } = config;
  const episodes = input.episodes ?? [];
  const infoHash = input.magnet ? magnetInfoHash(input.magnet) : null;

  const base = {
    savePath: qbittorrent.savePath || undefined,
    category: qbittorrent.category || undefined,
    tags: qbittorrent.tags,
    paused: qbittorrent.paused
  };

  // 是否需要「先拿种子文件清单再选择性下载」。
  // 只有存在 .torrent 直链时才可行（磁力拿不到清单），
  // 并且确实有要挑的集，或体积大到值得多这一步。
  const wantsSelection = episodes.length > 0;
  const largeEnoughToWorry = typeof input.sizeBytes === 'number' && input.sizeBytes > 2 * 1024 ** 3;
  const canFetchMeta = Boolean(input.torrentUrl);

  if (canFetchMeta && (wantsSelection || largeEnoughToWorry)) {
    const bytes = await downloadTorrentBytes(input.torrentUrl as string, trackers.timeoutMs ?? 15000).catch(() => null);
    const meta: TorrentMeta | null = bytes ? parseTorrent(bytes) : null;

    if (meta && bytes && meta.files.length > 0) {
      const selected = wantsSelection ? selectFileIndexes(meta.files, episodes) : { indexes: [], matchedEpisodes: [] };
      const useSelection = selected.indexes.length > 0 && selected.indexes.length < meta.files.length;

      await client.addTorrent({
        torrentBuffer: bytes,
        ...base,
        fileIndexes: useSelection ? selected.indexes : undefined
      });

      const fileCount = useSelection ? selected.indexes.length : null;
      log.info(
        `已推送：${input.title.slice(0, 70)}` +
          (fileCount === null
            ? `（整包，${formatSize(input.sizeBytes ?? null)}）`
            : `（合集共 ${meta.files.length} 个文件，只下载 ${fileCount} 个）`)
      );

      return {
        title: input.title,
        infoHash: meta.infoHash,
        fileCount,
        episodes: useSelection ? selected.matchedEpisodes : episodes
      };
    }
  }

  const url = input.magnet || input.torrentUrl;
  if (!url) throw new Error('该结果既没有磁力链接也没有种子直链，无法下载');

  await client.addTorrent({ url, ...base });
  log.info(`已推送：${input.title.slice(0, 70)}（${formatSize(input.sizeBytes ?? null)}）`);

  return {
    title: input.title,
    infoHash: infoHash ?? '',
    fileCount: null,
    episodes
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
