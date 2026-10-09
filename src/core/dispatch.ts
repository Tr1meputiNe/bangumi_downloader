import type { AppConfig } from '../config.js';
import type { QbittorrentClient } from '../qbittorrent/client.js';
import { pushRelease, selectFileIndexes, downloadTorrentBytes, type PushInput, type PushResult } from './push.js';
import { parseTorrentFile } from '../bittorrent/metainfo.js';
import { TorrentDownloader } from '../bittorrent/downloader.js';
import { magnetInfoHash } from '../util/magnet.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';
import { claimDownload, downloadKeyOf, inflightPath, releaseDownload } from './inflight.js';
import { searchAndRank } from './search.js';
import { showNameFromTitle } from '../util/text.js';
import { probeSeeders } from './viable.js';

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
  /**
   * 进度与日志钩子。
   *
   * Web 界面把下载放到后台队列里跑，需要实时把进度反映到任务上，
   * 否则用户点了「下载」只能干等，看不到任何反馈。
   */
  onLog?: (message: string) => void;
  onProgress?: (progress: {
    ratio: number;
    downloadedBytes: number;
    totalBytes: number;
    speed: number;
    peers: number;
  }) => void;
  /**
   * 取消信号。Web 界面的「暂停/取消」靠它真正停住下载
   * （引擎会关掉连接，但已经校验通过的分片留在磁盘上，继续时接着下）。
   */
  signal?: AbortSignal;
  /** config.json 的路径（跨进程去重用）。 */
  configPath?: string;
};

/**
 * 按标题找回同一条发布的磁力。
 *
 * 用于「.torrent 直链失效、又没有磁力」的救援（mikan 会清理老文件，
 * 从那里添加的任务过一阵子就会遇到）。匹配要保守：
 *   - 优先标题完全一致（规范化后比较，忽略大小写/空白/括号）
 *   - 其次要求「同一字幕组标签 + 体积接近（±2%）」，避免搜到别的版本
 * 找不到就返回 null，让调用方照常报错。
 */
export async function recoverMagnetByTitle(
  config: AppConfig,
  title: string,
  sizeBytes: number | null,
  hooks: { onLog?: (message: string) => void } = {}
): Promise<string | null> {
  // 界面会给标题追加「（检索用：xxx）」，那是搜索提示，不是发布名的一部分
  const cleaned = title.replace(/（检索用：.*?）/g, '').trim();
  const query = cleaned.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() || cleaned;

  try {
    const outcome = await searchAndRank({ query, config, mode: 'manual', resolveMikanMagnet: true });
    const norm = (value: string): string =>
      value.toLowerCase().replace(/[\s[\]（）()【】_·・!！~～-]+/g, '');
    const wanted = norm(cleaned);
    const group = /^\[([^\]]+)\]/.exec(cleaned)?.[1] ?? '';

    const candidates = outcome.ranked.filter((item) => item.result.magnet);
    const exact = candidates.find((item) => norm(item.result.title) === wanted);
    const sameGroup = candidates.find((item) => {
      if (group !== '' && !item.result.title.includes(group)) return false;
      if (sizeBytes === null || sizeBytes <= 0) return true;
      const size = item.result.sizeBytes ?? 0;
      return size > 0 && Math.abs(size - sizeBytes) / sizeBytes <= 0.02;
    });

    const picked = exact ?? sameGroup;
    if (!picked) {
      hooks.onLog?.(`种子直链已失效，按标题也没找到同一条发布（搜了「${query.slice(0, 40)}」）`);
      return null;
    }
    hooks.onLog?.(
      `种子直链已失效（mikan 会清理老链接），已按标题找回同一条发布，改用磁力：` +
        `${picked.result.title.slice(0, 60)}`
    );
    return picked.result.magnet;
  } catch (error) {
    hooks.onLog?.(`按标题找回磁力失败：${(error as Error).message}`);
    return null;
  }
}

export async function dispatchDownload(deps: DispatchDeps, input: PushInput): Promise<DispatchResult> {
  const backend = resolveBackend(deps.config);
  if (backend === 'qbittorrent') {
    if (!deps.qbittorrent) throw new Error('配置要求使用 qBittorrent，但没有可用的客户端连接');
    const result = await pushRelease(deps.qbittorrent, deps.config, input);
    return { ...result, backend };
  }
  return await downloadWithBuiltin(
    deps.config,
    input,
    {
      onLog: deps.onLog,
      onProgress: deps.onProgress,
      signal: deps.signal
    },
    deps.configPath
  );
}

/**
 * 用自带引擎下载一个发布。
 *
 * 选择性下载：有 .torrent 直链就先取下来解析文件清单，挑出目标集对应的文件序号，
 * 引擎只会分配并写入这些文件 —— 合集的其余部分完全不落盘。
 * 只有磁力链接时，引擎先通过 BEP 9 取元数据，拿到清单后再选文件。
 */
export async function downloadWithBuiltin(
  config: AppConfig,
  input: PushInput,
  hooks: {
    onLog?: (message: string) => void;
    onProgress?: DispatchDeps['onProgress'];
    signal?: AbortSignal;
  } = {},
  /** config.json 的路径：用来定位跨进程的「正在下载」登记簿。 */
  configPath?: string
): Promise<DispatchResult> {
  const savePath = config.download.savePath || config.qbittorrent.savePath;
  if (!savePath) {
    throw new Error('内置下载后端需要配置 download.savePath（下载到哪个目录）');
  }

  /*
   * 认领这个种子。
   *
   * 这条是网页那条路（任务队列），而计划任务触发的 auto 是另一个进程 ——
   * 两边的锁互相看不见，不认领的话同一个种子会被同时下两遍：
   * 带宽对半分，还可能落成两个目录。实测被用户抓到过「两个一起在下」。
   */
  const claimKey = downloadKeyOf({ magnet: input.magnet, torrentUrl: input.torrentUrl, title: input.title });
  const inflightFile = inflightPath(configPath);
  const claim = claimDownload(inflightFile, { key: claimKey, title: input.title });
  if (!claim.ok) {
    throw new Error(
      `同一个种子已经在别处下载了（${claim.holder.title.slice(0, 40)}，pid ${claim.holder.pid}，` +
        `开始于 ${claim.holder.startedAt}）。等它下完再试，或者先把它停掉。`
    );
  }

  try {
    return await downloadWithBuiltinClaimed(config, input, hooks);
  } finally {
    releaseDownload(inflightFile, claimKey);
  }
}

async function downloadWithBuiltinClaimed(
  config: AppConfig,
  input: PushInput,
  hooks: {
    onLog?: (message: string) => void;
    onProgress?: DispatchDeps['onProgress'];
    signal?: AbortSignal;
  }
): Promise<DispatchResult> {
  const savePath = config.download.savePath || config.qbittorrent.savePath;
  if (!savePath) throw new Error('内置下载后端需要配置 download.savePath（下载到哪个目录）');

  const timeoutMs = config.trackers.timeoutMs ?? 20_000;

  // 优先用 .torrent 直链：省掉 BEP 9 那一步，也更容易在连不上 peer 时拿到文件清单
  let torrentFile: Uint8Array | undefined;
  if (input.torrentUrl) {
    torrentFile = (await downloadTorrentBytes(input.torrentUrl, timeoutMs).catch(() => null)) ?? undefined;
  }

  /*
   * 直链拿不到（没给，或者像 mikan 那样老链接被清理成 404）、又没有磁力时，
   * 按标题把同一条发布的磁力找回来。
   *
   * 实测踩到：用户从 mikan 加的任务只有 .torrent 直链，链接过期后既没有可用直链、
   * 也没有磁力，引擎无从下手 —— 表现就是「这条下载不了」。
   * 标题里带着足够信息（字幕组、番名、集数、分辨率），搜一次就能找回同一条发布。
   */
  let magnet = input.magnet ?? '';
  if (!torrentFile && !magnet && input.title.trim() !== '') {
    const recovered = await recoverMagnetByTitle(config, input.title, input.sizeBytes ?? null, hooks);
    if (recovered) magnet = recovered;
  }

  const episodes = input.episodes ?? [];
  const infoHash = magnet ? magnetInfoHash(magnet) : null;

  /*
   * 探活：先问公共 tracker「这个种子有多少做种」，写进任务日志。
   *
   * 手动点「下载」时用户已经选定了这一条，所以探活**不拦**，
   * 只是把「有没有人做种」提前告诉他 —— 0 做种还要下的话心里有数。
   */
  if (infoHash && (config.download.probeCandidates ?? 0) > 0) {
    try {
      const probe = await probeSeeders(infoHash, {
        timeoutMs: Math.min(config.trackers.timeoutMs ?? 15_000, 8_000),
        signal: hooks.signal
      });
      hooks.onLog?.(
        probe.seeders > 0 || probe.peers > 0
          ? `探活：公共 tracker 报 ${probe.seeders} 个做种、${probe.peers} 个 peer 地址`
          : '探活：公共 tracker 没报做种（可能是死种，也可能是 tracker 不认识这个 infohash）—— 仍按你的选择继续'
      );
    } catch (error) {
      hooks.onLog?.(`探活失败（${(error as Error).message}），直接开始下载`);
    }
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

  /*
   * 目录归纳：所有番剧都放进 savePath/seriesRoot 下，一部番一个文件夹。
   * 单文件种子用发布名当文件夹名 —— 否则单集会散落在下载根目录里。
   */
  const seriesRoot = config.download.seriesDir?.trim() || undefined;
  /*
   * 单集种子放哪个目录：优先从标题里认出的番剧名，认不出才用发布标题。
   * 这样手动下的新番也会和自动追番下的进同一个文件夹（同名时）。
   */
  const singleFileDir = showNameFromTitle(input.title) ?? input.title;
  if (singleFileDir !== input.title) {
    hooks.onLog?.(`单集归入番剧目录：《${singleFileDir}》`);
  }

  const downloader = new TorrentDownloader({
    magnet: magnet || undefined,
    torrentFile,
    savePath,
    seriesRoot,
    singleFileDir,
    selectedFiles,
    timeoutMs: config.download.timeoutMs ?? 60 * 60_000,
    stallTimeoutMs: config.download.stallTimeoutMs ?? 180_000,
    signal: hooks.signal,
    onLog: (message) => {
      log.info(message);
      hooks.onLog?.(message);
    },
    onProgress: (progress) => {
      hooks.onProgress?.({
        ratio: progress.ratio,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        speed: progress.speed,
        peers: progress.peers
      });
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
