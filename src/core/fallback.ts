import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { ScoredCandidate } from '../anime/rank.js';
import { TorrentDownloader, type DownloadProgress } from '../bittorrent/downloader.js';
import { pickViableCandidate } from './viable.js';
import { selectFileIndexes, downloadTorrentBytes } from './push.js';
import { metaFromInfoBytes, parseTorrentFile } from '../bittorrent/metainfo.js';
import { sanitizeSegment } from '../bittorrent/storage.js';
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
  /**
   * 开始前先看一遍：哪些候选在磁盘上已经有数据了。
   * 有进度的直接续传，不再浪费一个试跑窗口重新测速。
   */
  probeExisting?: boolean;
};

export type FallbackResult = {
  infoHash: string;
  title: string;
  /** 实际落盘的文件路径。 */
  files: string[];
  bytesWritten: number;
  /** 完成整包还是只拿到了部分（超预算/试跑淘汰）。 */
  completed: boolean;
  /** 这一轮之前磁盘上已有的字节数（用于「续传」判断）。 */
  resumedBytes: number;
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
  let resumedTotal = 0;

  /*
   * 先看看有没有「上次下了一半」的候选。
   *
   * 这是让整件事可以无人值守的关键：上一轮可能因为时间预算用完而中断，
   * 如果这一轮还傻乎乎地从第一条重新试跑，就永远在原地打转，
   * 每次都要人来判断「其实该接着上次那条下」。
   */
  if (options.probeExisting !== false) {
    const resumed = await resumeExisting(ordered, options);
    if (resumed) return resumed;
  }

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
        resumedBytes: resumedTotal,
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
        resumedBytes: resumedTotal,
        attempts
      };
      if (finish.completed) return result;
      // 没跑完但已经有东西了，留着当兜底结果
      if (!best || result.bytesWritten > best.bytesWritten) best = result;
      continue;
    }

    /*
     * 速度不达标：清掉这条候选留下的东西。
     *
     * 注意不管「有没有拿到数据」都要清 —— 存储层一开始就把文件预分配到完整长度，
     * 所以哪怕一个分片都没下完，磁盘上也会留一个看着很大的空目录。
     * 早先只在 bytesWritten > 0 时清理，结果每次都留一堆空壳目录。
     */
    log.info(`    速度不达标（${(trial.throughput / 1024).toFixed(0)} KB/s），清掉试跑数据换下一条`);
    removeCandidateOutput(options.savePath, trial.infoHash, candidate.result.title);
  }

  if (best) {
    log.warn(`所有候选都没能完整下完，保留已拿到的部分数据：${formatSize(best.bytesWritten)}`);
    return best;
  }

  const summary = attempts.map((item) => `${item.title.slice(0, 40)}→${(item.throughput / 1024).toFixed(0)}KB/s`).join('；');
  throw new Error(`试过的候选都下不动（${attempts.length} 条：${summary}）`);
}

/**
 * 检查有没有「下到一半」的候选：磁盘上已经有数据的那条直接续传。
 *
 * 判定「有进度」的标准是**非填充文件的实际长度之和**，而不是分片校验结果 ——
 * 后者要扫全盘校验，对几 GB 的种子太慢；而这里只需要知道「值不值得接着下」。
 * 真正下的时候引擎会自己 resumeScan()，把已校验通过的分片挑出来跳过。
 */
async function resumeExisting(
  ordered: readonly ScoredCandidate[],
  options: FallbackOptions
): Promise<FallbackResult | null> {
  let bestCandidate: ScoredCandidate | null = null;
  let bestBytes = 0;

  for (const candidate of ordered.slice(0, options.maxAttempts ?? 8)) {
    const bytes = await existingBytesFor(candidate, options);
    if (bytes > bestBytes) {
      bestBytes = bytes;
      bestCandidate = candidate;
    }
  }

  // 少于 8MB 就当没有进度，正常走试跑流程（避免被一个刚开头就断的候选黏住）
  if (!bestCandidate || bestBytes < 8 * 1024 * 1024) return null;

  log.info(
    `发现上次没下完的：《${bestCandidate.result.title.slice(0, 56)}》，` +
      `磁盘上已有 ${formatSize(bestBytes)}，直接续传`
  );

  const remaining = Math.max(60_000, (options.budgetMs ?? 6 * 60 * 60_000));
  const outcome = await runAttempt(bestCandidate, {
    ...options,
    trialSeconds: Math.floor(remaining / 1000),
    remainingMs: remaining,
    // 续传时跳过热身性质的试跑判断，直接给它完整预算
    resume: true
  });

  return {
    infoHash: outcome.infoHash,
    title: bestCandidate.result.title,
    files: collectFiles(outcome.savePath),
    bytesWritten: outcome.bytesWritten,
    completed: outcome.completed,
    resumedBytes: bestBytes,
    attempts: [
      {
        title: bestCandidate.result.title,
        infoHash: outcome.infoHash,
        bytes: outcome.bytesWritten,
        throughput: outcome.throughput,
        reason: outcome.completed ? '续传完成' : outcome.reason
      }
    ]
  };
}

/**
 * 某个候选在下载目录里已经有多少字节。
 *
 * 目录名用的是种子内部的 name（不是发布标题），所以必须先拿到元数据才能定位。
 * 元数据来源优先 .torrent 直链；只有磁力时用 infohash 去 tracker 探一下再取。
 */
async function existingBytesFor(candidate: ScoredCandidate, options: FallbackOptions): Promise<number> {
  try {
    const meta = await metadataFor(candidate, options);
    if (!meta) return 0;

    const dir = join(options.savePath, sanitizeSegment(meta.name));
    if (!existsSync(dir)) return 0;

    return nonPaddingBytes(dir);
  } catch {
    return 0;
  }
}

/**
 * 拿到一个候选的元数据（只为定位下载目录）。
 *
 * 顺序：元数据缓存 → .torrent 直链 → 放弃。
 * 缓存这一环是必须的：磁力链接里没有文件名，只有 infohash，
 * 没有缓存的话「上次下到一半的目录叫什么」这个问题根本无从回答，
 * 续传就永远识别不出来（第一版就是这么漏的）。
 */
async function metadataFor(
  candidate: ScoredCandidate,
  options: FallbackOptions
): Promise<{ name: string } | null> {
  const cacheDir = metadataCacheDir(options);

  const magnet = candidate.result.magnet;
  const infoHash = magnet ? (magnet.match(/btih:([0-9a-fA-F]{40})/i)?.[1]?.toLowerCase() ?? null) : null;

  if (cacheDir && infoHash) {
    const cached = join(cacheDir, `${infoHash}.bin`);
    if (existsSync(cached)) {
      const meta = metaFromInfoBytes(new Uint8Array(readFileSync(cached)));
      if (meta) return meta;
    }
  }

  if (!candidate.result.torrentUrl) return null;

  const bytes = (await downloadTorrentBytes(candidate.result.torrentUrl, 10_000).catch(() => null)) ?? undefined;
  if (!bytes) return null;
  return parseTorrentFile(bytes);
}

/** 元数据缓存目录（与下载目录同级，避免污染下载内容）。 */
export function metadataCacheDir(options: { savePath: string }): string {
  return join(options.savePath, '.bangumi-meta');
}

/** 目录下所有非填充文件的长度之和。 */
function nonPaddingBytes(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/padding_file/i.test(entry.name)) continue;
      try {
        total += statSync(full).size;
      } catch {
        /* 忽略读不到的文件 */
      }
    }
  };
  walk(dir);
  return total;
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
  options: FallbackOptions & { trialSeconds: number; remainingMs: number; resume?: boolean }
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
    metadataCacheDir: metadataCacheDir(options),
    onLog: (message) => options.onLog?.(message),
    onProgress: (progress: DownloadProgress) => {
      latestDownloaded = progress.downloadedBytes;
      bytes = progress.downloadedBytes;
    }
  });

  const startedAt = Date.now();
  let reason = '试跑时间到';
  let completed = false;

  /*
   * 续传时的「有没有在动」看门狗。
   *
   * 死种的典型表现是：磁盘上有历史数据，连上去之后一个字节都拿不到。
   * 没有这个看门狗就会白等满整个时间预算（几小时），而其实早该换下一条了。
   */
  const baseline = options.resume ? nonPaddingBytes(options.savePath) : 0;
  let lastGainAt = Date.now();
  let lastSeen = baseline;
  let stalled = false;
  const stallGuard = options.resume
    ? setInterval(() => {
        const now = nonPaddingBytes(options.savePath);
        if (now > lastSeen + 256 * 1024) {
          // 每涨 256KB 才算「在动」，避免把零星的几个 block 当成有进展
          lastSeen = now;
          lastGainAt = Date.now();
        } else if (Date.now() - lastGainAt > RESUME_STALL_MS) {
          stalled = true;
          downloader.abort();
        }
      }, 15_000)
    : null;
  if (stallGuard) stallGuard.unref?.();

  try {
    const outcome = await downloader.download();
    bytes = outcome.bytesWritten;
    completed = true;
    reason = '完整下载完成';
  } catch (error) {
    reason = (error as Error).message;
    if (stalled) reason = `续传 ${Math.round(RESUME_STALL_MS / 1000)} 秒无新增数据，放弃这条`;
    // 超时/停滞都算「没跑完」，但已落盘的数据仍然有效
    bytes = Math.max(bytes, latestDownloaded ?? 0);
  } finally {
    if (stallGuard) clearInterval(stallGuard);
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

/** 续传时多久没有新增数据就判定这条已经死了。 */
const RESUME_STALL_MS = 150_000;

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

/**
 * 删除某条候选在下载目录下留下的产物。
 *
 * 目录名不一定等于发布名（用的是种子内部的 name 字段），所以这里做两手：
 *   - 按引擎返回的、本次实际创建的文件列表精确删；
 *   - 顺带删掉因此变空的父目录。
 */
export function removeCandidateOutput(savePath: string, infoHash: string, title: string): void {
  void infoHash;
  void title;
  if (!existsSync(savePath)) return;

  /*
   * 只回收「空目录」，绝不删文件。
   *
   * 曾经想在这里把淘汰候选的数据一并清掉，但那样会误伤：
   * 存储层预分配出来的稀疏文件看着「有内容」，而真正下到一半的候选
   * 和「一个分片都没下完的候选」在文件层面长得一模一样。
   * 既然分不清，就宁可留着（稀疏文件不占实际空间），也不能删掉可能是进度的那份。
   */
  const pruneEmptyDirs = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let remaining = 0;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!pruneEmptyDirs(full)) remaining += 1;
        continue;
      }
      remaining += 1;
    }
    if (remaining === 0 && dir !== savePath) {
      rmSync(dir, { recursive: true, force: true });
      return true;
    }
    return false;
  };

  pruneEmptyDirs(savePath);
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

