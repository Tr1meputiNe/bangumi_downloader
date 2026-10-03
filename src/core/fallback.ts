import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { ScoredCandidate } from '../anime/rank.js';
import { TorrentDownloader, type DownloadProgress } from '../bittorrent/downloader.js';
import { pickViableCandidate } from './viable.js';
import { selectFileIndexes, downloadTorrentBytes } from './push.js';
import { parseTorrentFile } from '../bittorrent/metainfo.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('fallback');

/**
 * 带自动降级的下载。
 *
 * 为什么要降级：公共种子的「能不能下动」和「打分高不高」几乎无关 ——
 * 实测做种数最多的那条合集，拿到的有效数据只有 2.7 KB/s，按这个速度下 10GB 要几天。
 * 所以这里对候选逐个**实测**：先跑一小段时间看真实吞吐，不行就换下一条。
 *
 * 降级顺序：整季合集 → 没有集号信息的整季发布 → 单集。
 * 整季都给不出速度时，会退化成「一集一集下」，尽量让用户拿到能看的东西。
 */

export type FallbackOptions = {
  candidates: readonly ScoredCandidate[];
  config: AppConfig;
  /** 要下载哪些集；留空表示尽量整季。 */
  episodes: number[];
  savePath: string;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  /** 试跑多少秒后判断这条候选值不值得继续。默认 90 秒。 */
  trialSeconds?: number;
  /** 试跑期最低吞吐（字节/秒），低于它判定为「下不动」。默认 40 KB/s。 */
  minThroughput?: number;
  /** 最多试几条候选。默认 8。 */
  maxAttempts?: number;
  /** 整体时间预算（毫秒）。默认 6 小时。 */
  budgetMs?: number;
};

export type FallbackResult = {
  infoHash: string;
  title: string;
  /** 实际落盘的文件路径。 */
  files: string[];
  bytesWritten: number;
  /** 完成整包还是只拿到了部分（超预算/试跑淘汰）。 */
  completed: boolean;
  attempts: Array<{
    title: string;
    infoHash: string;
    bytes: number;
    throughput: number;
    reason: string;
  }>;
};

export async function downloadWithFallback(options: FallbackOptions): Promise<FallbackResult> {
  const trialSeconds = options.trialSeconds ?? 90;
  const minThroughput = options.minThroughput ?? 40 * 1024;
  const maxAttempts = options.maxAttempts ?? 8;
  const budgetMs = options.budgetMs ?? 6 * 60 * 60_000;
  const startedAt = Date.now();

  const attempts: FallbackResult['attempts'] = [];
  const ordered = orderCandidates(options.candidates, options.episodes);

  if (ordered.length === 0) throw new Error('没有可下载的候选');

  let best: FallbackResult | null = null;

  for (const [index, candidate] of ordered.slice(0, maxAttempts).entries()) {
    if (options.signal?.aborted) break;
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining < 30_000) {
      log.warn('整体时间预算已用完，停止继续尝试');
      break;
    }

    const label = candidate.result.title.slice(0, 66);
    log.info(`[${index + 1}/${Math.min(ordered.length, maxAttempts)}] 试下：${label}`);

    const trial = await runAttempt(candidate, {
      ...options,
      // 试跑阶段只给 trialSeconds，够判断速度；有速度再按剩余预算正式跑完
      trialSeconds,
      remainingMs: remaining
    });

    attempts.push({
      title: candidate.result.title,
      infoHash: trial.infoHash,
      bytes: trial.bytesWritten,
      throughput: trial.throughput,
      reason: trial.reason
    });

    log.info(
      `    → ${trial.completed ? '完成' : trial.reason}：${formatSize(trial.bytesWritten)}` +
        `（${(trial.throughput / 1024).toFixed(0)} KB/s）`
    );

    // 跑完了：直接成功返回
    if (trial.completed) {
      return {
        infoHash: trial.infoHash,
        title: candidate.result.title,
        files: collectFiles(trial.savePath),
        bytesWritten: trial.bytesWritten,
        completed: true,
        attempts
      };
    }

    // 有部分数据且速度达标：把这条当成目前最好的结果，并继续用剩余预算把它跑完
    if (trial.throughput >= minThroughput && trial.bytesWritten > 0) {
      log.info(`    速度达标，继续把这条下完（已拿到 ${formatSize(trial.bytesWritten)}）`);
      const finish = await runAttempt(candidate, {
        ...options,
        trialSeconds: Math.max(60, Math.floor((budgetMs - (Date.now() - startedAt)) / 1000)),
        remainingMs: Math.max(0, budgetMs - (Date.now() - startedAt))
      });
      attempts.push({
        title: candidate.result.title,
        infoHash: finish.infoHash,
        bytes: finish.bytesWritten,
        throughput: finish.throughput,
        reason: finish.reason
      });

      const result: FallbackResult = {
        infoHash: finish.infoHash,
        title: candidate.result.title,
        files: collectFiles(finish.savePath),
        bytesWritten: finish.bytesWritten,
        completed: finish.completed,
        attempts
      };
      if (finish.completed) return result;
      // 没跑完但已经有东西了，留着当兜底结果
      if (!best || result.bytesWritten > best.bytesWritten) best = result;
      continue;
    }

    // 速度不达标：把这次试跑的数据清掉，避免磁盘上留一堆没用的半成品
    if (trial.bytesWritten > 0) {
      log.info(`    速度不达标（${(trial.throughput / 1024).toFixed(0)} KB/s），清掉试跑数据换下一条`);
      rmSync(trial.savePath, { recursive: true, force: true });
    }
  }

  if (best) {
    log.warn(`所有候选都没能完整下完，保留已拿到的部分数据：${formatSize(best.bytesWritten)}`);
    return best;
  }

  const summary = attempts.map((item) => `${item.title.slice(0, 40)}→${(item.throughput / 1024).toFixed(0)}KB/s`).join('；');
  throw new Error(`试过的候选都下不动（${attempts.length} 条：${summary}）`);
}

type AttemptOutcome = {
  completed: boolean;
  infoHash: string;
  bytesWritten: number;
  throughput: number;
  reason: string;
  savePath: string;
};

async function runAttempt(
  candidate: ScoredCandidate,
  options: FallbackOptions & { trialSeconds: number; remainingMs: number }
): Promise<AttemptOutcome> {
  const seconds = Math.max(20, Math.min(options.trialSeconds, Math.floor(options.remainingMs / 1000)));
  const infoHash = candidate.result.magnet ? (candidate.result.magnet.match(/btih:([0-9a-fA-F]{40})/)?.[1]?.toLowerCase() ?? '') : '';

  // 有 .torrent 直链就先拿文件清单，好在试跑阶段就只下需要的集
  let torrentFile: Uint8Array | undefined;
  if (candidate.result.torrentUrl) {
    torrentFile = (await downloadTorrentBytes(candidate.result.torrentUrl, 15_000).catch(() => null)) ?? undefined;
  }

  let selectedFiles: number[] | undefined;
  if (torrentFile && options.episodes.length > 0) {
    const meta = parseTorrentFile(torrentFile);
    if (meta && meta.files.length > 0) {
      const selected = selectFileIndexes(meta.files, options.episodes);
      if (selected.indexes.length > 0 && selected.indexes.length < meta.files.length) selectedFiles = selected.indexes;
    }
  }

  let bytes: number = 0;
  let latestDownloaded: number | null = null;

  const downloader = new TorrentDownloader({
    magnet: candidate.result.magnet || undefined,
    torrentFile,
    savePath: options.savePath,
    selectedFiles,
    timeoutMs: seconds * 1000,
    // 试跑阶段不要因为「暂时没进度」提前退出，让它把观察窗口跑满
    stallTimeoutMs: Math.max(seconds * 1000, options.config.download.stallTimeoutMs ?? 180_000),
    signal: options.signal,
    onLog: (message) => options.onLog?.(message),
    onProgress: (progress: DownloadProgress) => {
      latestDownloaded = progress.downloadedBytes;
      bytes = progress.downloadedBytes;
    }
  });

  const startedAt = Date.now();
  let reason = '试跑时间到';
  let completed = false;

  try {
    const outcome = await downloader.download();
    bytes = outcome.bytesWritten;
    completed = true;
    reason = '完整下载完成';
  } catch (error) {
    reason = (error as Error).message;
    // 超时/停滞都算「没跑完」，但已落盘的数据仍然有效
    bytes = Math.max(bytes, latestDownloaded ?? 0);
  }

  /*
   * 只认引擎自己报的「已校验分片字节数」。
   *
   * 这里踩过一个很贵的坑：存储层为了断点续传会把文件预分配到完整长度（稀疏文件），
   * 于是磁盘占用一开始就是 8.8GB —— 拿它当「已下载量」算出来 123 MB/s，
   * 一条其实一个分片都没下完的候选被判成「速度达标」，白等了一轮。
   * 稀疏文件的 size/blocks 都不能用来衡量进度。
   */
  const finalBytes = bytes;
  const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);

  return {
    completed,
    infoHash: infoHash || candidate.result.magnet.slice(0, 40),
    bytesWritten: finalBytes,
    throughput: finalBytes / elapsed,
    reason,
    savePath: options.savePath
  };
}

/**
 * 目录里所有文件「名义长度」之和。
 *
 * 只用于「整包下完没有」之类的判断，**不能**用来衡量下载进度：
 * 存储层会预分配，没下完的文件名义长度也是满的。
 */
export function nominalSize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        total += statSync(full).size;
      } catch {
        /* 忽略读不到的文件 */
      }
    }
  };
  walk(path);
  return total;
}

/** 候选的尝试顺序：整季合集 → 无集号的整季发布 → 单集（按集号升序）。 */
export function orderCandidates(candidates: readonly ScoredCandidate[], episodes: number[]): ScoredCandidate[] {
  const usable = candidates.filter((item) => !item.rejected && (item.result.magnet || item.result.torrentUrl));
  const wanted = new Set(episodes);

  const score = (candidate: ScoredCandidate): number => {
    if (wanted.size > 0) {
      const covered = candidate.parsed.episodes.filter((episode) => wanted.has(episode)).length;
      if (covered > 0) return 1000 + covered;
    }
    if (candidate.parsed.kind === 'batch') return 900;
    if (candidate.parsed.kind === 'unknown') return 800;
    return 100;
  };

  return [...usable].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    // 同类里先下集号小的，保证「从头开始」的观感
    const episodeDiff = (a.parsed.episodes[0] ?? 999) - (b.parsed.episodes[0] ?? 999);
    if (episodeDiff !== 0) return episodeDiff;
    return b.score - a.score;
  });
}

/** 目录下所有文件的总大小。 */
function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          /* 忽略读不到的文件 */
        }
      }
    }
  };
  walk(path);
  return total;
}

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path);
  return files;
}

