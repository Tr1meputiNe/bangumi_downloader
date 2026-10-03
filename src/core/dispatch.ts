import type { AppConfig } from '../config.js';
import type { QbittorrentClient } from '../qbittorrent/client.js';
import { pushRelease, selectFileIndexes, downloadTorrentBytes, type PushInput, type PushResult } from './push.js';
import { parseTorrentFile } from '../bittorrent/metainfo.js';
import { TorrentDownloader } from '../bittorrent/downloader.js';
import { magnetInfoHash } from '../util/magnet.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('dispatch');

/**
 * 下载后端分发。
 *
 * 两套后端：
 *   - qbittorrent：把种子推给独立的 qBittorrent 程序（项目原本的设计）
 *   - builtin：用项目自带的 BitTorrent 引擎直接下（零外部依赖，适合无人值守的机器）
 *
 * Web 界面、手动下载、自动追番都走这里，避免三个入口各自判断后端。
 */

export type DownloadBackend = 'builtin' | 'qbittorrent';

export function resolveBackend(config: AppConfig): DownloadBackend {
  if (config.download.backend === 'qbittorrent') return 'qbittorrent';
  if (config.download.backend === 'builtin') return 'builtin';
  // 没显式配置时的默认值：本机自带引擎优先，它是零依赖、不需要额外装东西的那条路
  return 'builtin';
}

export type DispatchResult = PushResult & {
  backend: DownloadBackend;
  /** builtin 后端才有：实际落盘的文件路径。 */
  files?: string[];
};

export type DispatchDeps = {
  config: AppConfig;
  qbittorrent?: QbittorrentClient;
};

export async function dispatchDownload(deps: DispatchDeps, input: PushInput): Promise<DispatchResult> {
  const backend = resolveBackend(deps.config);
  if (backend === 'qbittorrent') {
    if (!deps.qbittorrent) throw new Error('配置要求使用 qBittorrent，但没有可用的客户端连接');
    const result = await pushRelease(deps.qbittorrent, deps.config, input);
    return { ...result, backend };
  }
  return await downloadWithBuiltin(deps.config, input);
}

/**
 * 用自带引擎下载一个发布。
 *
 * 选择性下载：有 .torrent 直链就先取下来解析文件清单，挑出目标集对应的文件序号，
 * 引擎只会分配并写入这些文件 —— 合集的其余部分完全不落盘。
 * 只有磁力链接时，引擎先通过 BEP 9 取元数据，拿到清单后再选文件。
 */
export async function downloadWithBuiltin(config: AppConfig, input: PushInput): Promise<DispatchResult> {
  const savePath = config.download.savePath || config.qbittorrent.savePath;
  if (!savePath) {
    throw new Error('内置下载后端需要配置 download.savePath（下载到哪个目录）');
  }

  const episodes = input.episodes ?? [];
  const infoHash = input.magnet ? magnetInfoHash(input.magnet) : null;
  const timeoutMs = config.trackers.timeoutMs ?? 20_000;

  // 优先用 .torrent 直链：省掉 BEP 9 那一步，也更容易在连不上 peer 时拿到文件清单
  let torrentFile: Uint8Array | undefined;
  if (input.torrentUrl) {
    torrentFile = (await downloadTorrentBytes(input.torrentUrl, timeoutMs).catch(() => null)) ?? undefined;
  }

  let selectedFiles: number[] | undefined;
  if (torrentFile) {
    const meta = parseTorrentFile(torrentFile);
    if (meta && meta.files.length > 0) {
      const selected = selectFileIndexes(meta.files, episodes);
      // 只有确实只覆盖一部分文件时才做筛选，否则整包下（省得漏掉正片之外的东西）
      if (selected.indexes.length > 0 && selected.indexes.length < meta.files.length) {
        selectedFiles = selected.indexes;
        log.info(
          `合集共 ${meta.files.length} 个文件，按目标集只取其中 ${selected.indexes.length} 个（${formatSize(
            selected.indexes.reduce((sum, index) => sum + (meta.files[index]?.length ?? 0), 0)
          )}）`
        );
      }
    }
  }

  const downloader = new TorrentDownloader({
    magnet: input.magnet || undefined,
    torrentFile,
    savePath,
    selectedFiles,
    timeoutMs: config.download.timeoutMs ?? 60 * 60_000,
    stallTimeoutMs: config.download.stallTimeoutMs ?? 180_000,
    onLog: (message) => log.info(message),
    onProgress: (progress) => {
      if (progress.ratio >= 1) return;
      log.debug(
        `进度 ${(progress.ratio * 100).toFixed(1)}%（${formatSize(progress.downloadedBytes)}/${formatSize(
          progress.totalBytes
        )}，${formatSize(progress.speed)}/s，peer ${progress.peers}）`
      );
    }
  });

  const outcome = await downloader.download();
  log.info(`下载完成：${input.title.slice(0, 70)}（${outcome.files.length} 个文件，${formatSize(outcome.bytesWritten)}）`);

  return {
    backend: 'builtin',
    title: input.title,
    infoHash: outcome.infoHash || infoHash || '',
    fileCount: outcome.files.length,
    episodes,
    files: outcome.files
  };
}
