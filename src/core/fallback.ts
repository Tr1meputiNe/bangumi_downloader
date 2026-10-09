import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { ScoredCandidate } from '../anime/rank.js';
import { TorrentDownloader, type DownloadProgress } from '../bittorrent/downloader.js';
import { selectFileIndexes, downloadTorrentBytes } from './push.js';
import { metaFromInfoBytes, parseTorrentFile, type TorrentMeta } from '../bittorrent/metainfo.js';
import { locateTorrent } from './verify.js';
import { pickViableCandidate } from './viable.js';
import { showNameFromTitle } from '../util/text.js';
import { claimDownload, downloadKeyOf, inflightPath, releaseDownload } from './inflight.js';
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
  /**
   * 续传那一份先观察多久（毫秒，默认 15 分钟）。
   *
   * 注意这是**观察窗口**，不是硬性中断：窗口结束时看它到底拿到了多少 ——
   *   - 拿得动（≥ minResumeGainBytes）：继续用它下到底，绝不打断健康下载
   *   - 拿不动：把它记成兜底结果，去试别的候选（可能是新发布的更好版本）
   *
   * 之前这里是「到点就掐」，于是 86% 下到一半的健康下载被硬生生切断，
   * 用户看到的就是「15 分钟之内没下完就被中断」。
   */
  resumeSliceMs?: number;
  /** 观察窗口内至少拿到这么多字节才算「拿得动」。默认 8MB。 */
  minResumeGainBytes?: number;
  /** config.json 的路径：用来定位跨进程的「正在下载」登记簿。 */
  configPath?: string;
  /** 番剧名：单集种子用它当目录名（同一部番的剧集放一起）。 */
  seriesName?: string;
  /** 探活实现（默认问公共 tracker，测试可替换）。 */
  probe?: (infoHash: string, options: { timeoutMs?: number; signal?: AbortSignal }) => Promise<import('./viable.js').SeederProbe>;
  /** 下载过程中的进度回调（界面上的「正在下载」用它）。 */
  onProgress?: (info: {
    title: string;
    downloadedBytes: number;
    totalBytes: number;
    speed: number;
    peers: number;
    piecesDone: number;
    piecesTotal: number;
  }) => void;
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
  let ordered = orderCandidates(options.candidates, options.episodes);

  if (ordered.length === 0) throw new Error('没有可下载的候选');

  /*
   * 下载前探活：问一下公共 tracker「这个种子有多少做种」，按真实做种数重排候选。
   *
   * 为什么值得：打分高低和「下不下得动」几乎无关（实测做种最多的那条只有 2.7 KB/s）。
   * 探活比「试跑 75 秒」便宜得多，可以先据此把明显是死种的排到后面。
   *
   * 之前这个能力是死代码：`probeCandidates` 这个配置项在界面上能调，
   * 但没有任何代码读它 —— 用户问「下载前有没有探活」时，答案是「没有」。
   */
  const probeLimit = options.config.download.probeCandidates ?? 0;
  if (probeLimit > 0 && ordered.length > 1) {
    try {
      const pick = await pickViableCandidate(ordered, {
        probeLimit,
        episodes: options.episodes,
        timeoutMs: Math.min(options.config.trackers.timeoutMs ?? 15_000, 8_000),
        signal: options.signal,
        probe: options.probe
      });
      if (pick) {
        const before = ordered[0]?.result.title.slice(0, 40);
        const after = pick.candidate.result.title.slice(0, 40);
        ordered = pick.ranked.map((item) => item.candidate);
        if (before !== after) log.info(`探活后换了候选：${before} → ${after}`);
      }
    } catch (error) {
      log.warn(`探活失败（${(error as Error).message}），按原顺序试`);
    }
  }

  let best: FallbackResult | null = null;
  /** 试跑没达标、但确实拿到了数据的候选（全都不达标时用它兜底）。 */
  let slowest: { candidate: ScoredCandidate; outcome: AttemptOutcome } | null = null;
  const resumedTotal = 0;
  // （续传结果在下面 probeExisting 之后拿到）

  /*
   * 先看看有没有「上次下了一半」的候选。
   *
   * 这是让整件事可以无人值守的关键：上一轮可能因为时间预算用完而中断，
   * 如果这一轮还傻乎乎地从第一条重新试跑，就永远在原地打转，
   * 每次都要人来判断「其实该接着上次那条下」。
   */
  /*
   * 先试「上次下了一半」的那条，但只给一段有界的时间。
   *
   * 为什么不是直接返回它：磁盘上那份进度可能是死种留下的，
   * 而这段时间里片源站可能已经出了做种多得多的版本（字幕组一般晚几个小时）。
   * 之前一口气把整个预算都给了续传，新版本根本没机会被试到 ——
   * 表现就是「一直在下、速度几十 KB/s、几个小时下不完」。
   */
  let resumed: FallbackResult | null = null;
  if (options.probeExisting !== false) {
    resumed = await resumeExisting(ordered, options);
    if (resumed?.completed) return resumed;
  }
  const resumedInfoHash = resumed?.infoHash ?? null;
  if (resumed) {
    log.info(`    续传这一轮拿到 ${formatSize(resumed.bytesWritten)}，继续看有没有更好的候选`);
    best = resumed;
  }

  for (const [index, candidate] of ordered.slice(0, maxAttempts).entries()) {
    if (options.signal?.aborted) break;
    // 续传阶段已经试过这条了，别浪费第二个窗口
    if (resumedInfoHash !== null && candidate.result.magnet.includes(resumedInfoHash)) continue;
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
        files: filesOf(trial),
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
        files: filesOf(finish),
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
     * 速度不达标：记下「确实收到了数据」的那条当兜底，然后继续看下一条。
     *
     * 为什么要留兜底：用户那条链路对公共种子的实际速度经常只有 10~40 KB/s，
     * 全都达不到 20 KB/s 的门槛。全扔掉的话每轮都是「试过的候选都下不动」，
     * 下一轮从头再来一遍 —— 数据虽然不会丢（引擎会续传），但永远下不完。
     * 有一条在动就让它继续动，总比空手强。
     */
    if (trial.receivedBytes > 2 * 1024 * 1024) {
      if (!slowest || trial.receivedBytes > slowest.outcome.receivedBytes) slowest = { candidate, outcome: trial };
      log.info(
        `    速度不达标（收到 ${(trial.receivedBytes / 1024 / 1024).toFixed(1)} MB，` +
          `${(trial.throughput / 1024).toFixed(0)} KB/s），先记下这条，继续看下一条`
      );
    } else {
      log.info(`    速度不达标（${(trial.throughput / 1024).toFixed(0)} KB/s），清掉试跑数据换下一条`);
    }
    removeCandidateOutput(options.savePath, trial.infoHash, candidate.result.title);
  }

  /*
   * 所有候选都没达到最低速度：如果有一条确实在收数据，就用它把这一轮跑下去。
   * 这是「慢但能下」和「永远下不动」的区别 —— 实测用户的链路大多属于前者。
   */
  if (!best && slowest) {
    log.warn(
      `所有候选都没达到最低速度（${(minThroughput / 1024).toFixed(0)} KB/s），` +
        `但《${slowest.candidate.result.title.slice(0, 50)}》至少收到了 ` +
        `${(slowest.outcome.receivedBytes / 1024 / 1024).toFixed(1)} MB，继续用它下`
    );
    const remaining = Math.max(60_000, budgetMs - (Date.now() - startedAt));
    const finish = await runAttempt(slowest.candidate, {
      ...options,
      trialSeconds: Math.floor(remaining / 1000),
      remainingMs: remaining
    });
    best = {
      infoHash: finish.infoHash,
      title: slowest.candidate.result.title,
      files: filesOf(finish),
      bytesWritten: finish.bytesWritten,
      completed: finish.completed,
      resumedBytes: resumedTotal,
      attempts
    };
    if (best.completed) return best;
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

  const budget = Math.max(60_000, options.budgetMs ?? 6 * 60 * 60_000);
  // 续传先给一段有界的时间（默认 15 分钟）：够它把「有速度」证明出来，
  // 又不至于把整个预算吃光、让后面新发布的候选完全没机会。
  const slice = Math.max(60_000, Math.min(budget, options.resumeSliceMs ?? RESUME_SLICE_MS));
  const first = await runAttempt(bestCandidate, {
    ...options,
    trialSeconds: Math.floor(slice / 1000),
    remainingMs: slice,
    // 续传时跳过热身性质的试跑判断，直接把这段时间给它
    resume: true
  });

  /*
   * 观察窗口结束：还在动就让它继续下到底。
   *
   * 这里以前是「到点就交差」，结果一条已经下到 86%、速度 1.2 MB/s 的健康下载
   * 被硬切断，然后去试别的慢候选 —— 用户报的「15 分钟之内没下完会被中断」
   * 就是这个。下载这事情，只要在动就该让它动完。
   */
  const minGain = options.minResumeGainBytes ?? 8 * 1024 * 1024;
  if (!first.completed && first.bytesWritten - 0 >= minGain && first.bytesWritten > bestBytes) {
    const remaining = Math.max(60_000, budget - slice);
    log.info(
      `续传这一段拿到了 ${formatSize(first.bytesWritten)}（在动），继续用它下到底（剩余预算 ${Math.round(remaining / 60_000)} 分钟）`
    );
    const rest = await runAttempt(bestCandidate, {
      ...options,
      trialSeconds: Math.floor(remaining / 1000),
      remainingMs: remaining,
      resume: true
    });
    return {
      infoHash: rest.infoHash,
      title: bestCandidate.result.title,
      files: filesOf(rest),
      bytesWritten: rest.bytesWritten,
      completed: rest.completed,
      resumedBytes: bestBytes,
      attempts: [
        {
          title: bestCandidate.result.title,
          infoHash: rest.infoHash,
          bytes: rest.bytesWritten,
          throughput: rest.throughput,
          reason: rest.completed ? '续传完成' : rest.reason
        }
      ]
    };
  }

  const outcome = first;

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

    /*
     * 用和核对功能同一套定位规则（locateTorrent），别自己拼路径。
     * 之前这里只认 savePath/种子名，于是内容归纳进「番剧」子目录之后，
     * 明明下过一半的种子会被判成「磁盘上没有数据」，每次都从零试跑。
     */
    const location = locateTorrent(meta, options.savePath, options.config.download.seriesDir);
    if (!location.exists) return 0;

    /*
     * 注意这里是「抽样估算真实数据」，不是文件名义长度。
     *
     * 存储层为了断点续传会把文件预分配到完整长度，所以一个**一个分片都没下成**
     * 的目录，名义上也有 900MB。之前用名义长度判断「上次下到一半」，
     * 于是每轮都认定「磁盘上已有 913MB，直接续传」，把时间全花在一条
     * 其实早死掉的种子上，新发布的、做种多的版本永远轮不到 ——
     * 这正是「下了几个小时还没下完」的直接原因。
     */
    return sampledRealBytes(location.dir);
  } catch {
    return 0;
  }
}

/**
 * 抽样估算目录里「真的有数据」的字节数。
 *
 * 每个文件最多读 8 个窗口（每窗 64KB）铺满整个文件，用非零比例外推总字节数。
 * 对「预分配的空壳」得到接近 0，对「下了一部分」得到接近真实进度。
 * 只用来判断「值不值得续传」（8MB 门槛），不需要精确。
 */
function sampledRealBytes(dir: string): number {
  /*
   * 32 个窗口 × 64KB ≈ 2MB 采样量。
   *
   * 为什么不是 8 个：分片是「最稀有优先」分散下载的，一个有 24MB 真实数据的
   * 912MB 文件，那 24MB 会散在十几个 2MB 的块里；只采 8 个 64KB 的窗口
   * 命中概率只有两成，会把它误判成「没有进度」。
   * 采样密一点成本仍然可忽略（2MB 读盘），而漏判的代价是白白重头试跑。
   */
  const SAMPLES = 32;
  const WINDOW = 64 * 1024;
  let estimate = 0;

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

      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size <= 0) continue;

      const window = Math.max(1, Math.min(WINDOW, Math.ceil(size / SAMPLES)));
      const span = Math.max(1, size - window);
      let fd: number | null = null;
      let nonzero = 0;
      let total = 0;
      try {
        fd = openSync(full, 'r');
        for (let index = 0; index < SAMPLES; index += 1) {
          const offset = Math.floor((span * index) / (SAMPLES - 1));
          const buffer = Buffer.alloc(window);
          let read = 0;
          try {
            read = readSync(fd, buffer, 0, window, offset);
          } catch {
            continue;
          }
          for (let i = 0; i < read; i += 1) if (buffer[i] !== 0) nonzero += 1;
          total += read;
        }
      } catch {
        continue;
      } finally {
        if (fd !== null) closeSync(fd);
      }

      if (total > 0) estimate += (nonzero / total) * size;
    }
  };

  walk(dir);
  return estimate;
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
): Promise<TorrentMeta | null> {
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

type AttemptOutcome = {
  completed: boolean;
  infoHash: string;
  bytesWritten: number;
  /** 累计收到的字节（含未凑成分片的 block）。 */
  receivedBytes: number;
  throughput: number;
  reason: string;
  /** 引擎报的落盘文件（绝对路径）。 */
  files: string[];
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
  let latestReceived = 0;

  /*
   * 目录归纳规则必须和 dispatch（网页那条路）保持一致：
   * 番剧统一放进 savePath/seriesDir，单文件种子用发布名当文件夹名。
   * 这里以前漏了这两项，结果自动化下的内容散在下载根目录里，
   * 而「片库」页只扫番剧子目录 —— 下好了却在界面上看不见。
   *
   * 单文件种子的目录名还有个坑：以前用的是种子里的文件名，
   * 现在是发布标题，同一个种子换个规则就会**再建一个目录**，
   * 于是同一集出现两份（一份老命名、一份新命名），看着像下了两个。
   * 所以先按 locateTorrent 找一遍磁盘上已有的那份，找到就用它的目录名。
   */
  const existing = await metadataFor(candidate, options)
    .then((meta) => (meta ? locateTorrent(meta, options.savePath, options.config.download.seriesDir) : null))
    .catch(() => null);
  /*
   * 单集种子放哪个文件夹。
   *
   * 优先级：
   *   1. 磁盘上已经有的那份（续传要用它原来的目录，否则同一集会落成两份）
   *   2. 调用方给的番剧名（自动追番从 Planner 拿到的名字，例如「相反的你和我 第二季」）
   *   3. 从发布标题里猜出来的番剧名
   *   4. 实在猜不出来才用发布标题
   *
   * 用户的要求是「新番不要每集新建文件夹，视频直接放在番剧文件夹里方便整理观看」——
   * 所以同一部番的每一集都进同一个目录，而不是一集一个以发布标题命名的目录。
   */
  const singleFileDir =
    existing?.exists
      ? existing.singleFileDir
      : options.seriesName?.trim() ||
        showNameFromTitle(candidate.result.title) ||
        candidate.result.title;

  const downloader = new TorrentDownloader({
    magnet: candidate.result.magnet || undefined,
    torrentFile,
    savePath: options.savePath,
    seriesRoot: options.config.download.seriesDir?.trim() || undefined,
    singleFileDir,
    selectedFiles,
    timeoutMs: seconds * 1000,
    // 试跑阶段不要因为「暂时没进度」提前退出，让它把观察窗口跑满
    stallTimeoutMs: Math.max(seconds * 1000, options.config.download.stallTimeoutMs ?? 180_000),
    signal: options.signal,
    metadataCacheDir: metadataCacheDir(options),
    onLog: (message) => options.onLog?.(message),
    onProgress: (progress: DownloadProgress) => {
      latestDownloaded = progress.downloadedBytes;
      latestReceived = progress.receivedBytes;
      bytes = progress.downloadedBytes;
      options.onProgress?.({
        title: candidate.result.title,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        speed: progress.speed,
        peers: progress.peers,
        piecesDone: progress.piecesDone,
        piecesTotal: progress.piecesTotal
      });
    }
  });

  const startedAt = Date.now();
  let reason = '试跑时间到';
  let completed = false;
  let files: string[] = [];

  /*
   * 认领这个种子：别的进程（网页界面的下载队列）正在下同一个种子时直接跳过。
   * 不认领的话两边会各下一份、带宽对半分，还可能落成两个目录 —— 实测出现过。
   */
  const claimKey = downloadKeyOf({
    magnet: candidate.result.magnet,
    torrentUrl: candidate.result.torrentUrl ?? undefined,
    title: candidate.result.title
  });
  const inflightFile = inflightPath(options.configPath);
  const claim = claimDownload(inflightFile, { key: claimKey, title: candidate.result.title });
  if (!claim.ok) {
    log.info(
      `这个种子正在被另一个进程下载（${claim.holder.title.slice(0, 40)}，pid ${claim.holder.pid}），这条跳过`
    );
    return {
      completed: false,
      infoHash: claimKey,
      bytesWritten: 0,
      receivedBytes: 0,
      throughput: 0,
      reason: '同一个种子正在被另一个进程下载',
      files: [],
      savePath: options.savePath
    };
  }

  /*
   * 续传时的「有没有在动」看门狗。
   *
   * 死种的典型表现是：磁盘上有历史数据，连上去之后一个字节都拿不到。
   * 没有这个看门狗就会白等满整个时间预算（几小时），而其实早该换下一条了。
   *
   * 判据用**引擎自己报的已校验字节数**，不再去数文件系统 ——
   * 之前数的是整个下载根目录的增量，别的下载、甚至别的番的进度都会被算进来，
   * 而且加了「番剧子目录」之后那个路径本来就不对了。
   */
  let lastGainAt = Date.now();
  let lastSeen = 0;
  let stalled = false;
  const stallGuard = options.resume
    ? setInterval(() => {
        const now = latestDownloaded ?? 0;
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
    files = outcome.files;
    completed = true;
    reason = '完整下载完成';
  } catch (error) {
    reason = (error as Error).message;
    if (stalled) reason = `续传 ${Math.round(RESUME_STALL_MS / 1000)} 秒无新增数据，放弃这条`;
    // 超时/停滞都算「没跑完」，但已落盘的数据仍然有效
    bytes = Math.max(bytes, latestDownloaded ?? 0);
  } finally {
    if (stallGuard) clearInterval(stallGuard);
    releaseDownload(inflightFile, claimKey);
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
    /*
     * 吞吐按「收到的数据」算，不按「已校验的分片」算。
     * 分片粒度是 2MB：75 秒的试跑窗口里，只要链路低于约 27 KB/s 就一片都凑不齐，
     * 按分片算会得到 0 KB/s，把一条其实在动的候选判成死种 ——
     * 实测就是这样：8~20 KB/s 的链路被判「下不动」，75 秒一扔，
     * 每 15 分钟重来一次，用户看到的就是「下不完就被中断」。
     */
    throughput: Math.max(finalBytes, latestReceived) / elapsed,
    receivedBytes: latestReceived,
    reason,
    // 落盘文件用引擎报的清单；它没给（例如失败在取元数据阶段）就退回整目录扫描
    files: files.length > 0 ? files : [],
    savePath: options.savePath
  };
}

/** 续传时多久没有新增数据就判定这条已经死了。 */
const RESUME_STALL_MS = 150_000;

/** 续传那一份最多先给多久，然后就去试别的候选。 */
const RESUME_SLICE_MS = 15 * 60_000;

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

/**
 * 这一轮落了哪些文件。
 *
 * 优先用引擎报的清单；拿不到时才退回扫描目录（老实现是直接扫整个下载根目录，
 * 于是「落盘文件」里会列出所有番剧的文件 —— 报告完全不可信）。
 */
function filesOf(outcome: AttemptOutcome): string[] {
  if (outcome.files.length > 0) return outcome.files;
  return collectFiles(outcome.savePath);
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

