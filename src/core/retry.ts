import type { AppConfig } from '../config.js';
import type { ScoredCandidate } from '../anime/rank.js';
import { downloadWithFallback, type FallbackResult } from './fallback.js';
import { logger } from '../util/log.js';
import { formatSize } from '../util/text.js';

const log = logger('retry');

/**
 * 「一直试到下完为止」。
 *
 * 这是整套无人值守的关键一环。单次 downloadWithFallback 可能因为时间预算用完、
 * 或者这一轮 peer 太少而中途返回；但种子是活的、磁盘上的数据也在，
 * 下一轮换个时间点接着下就行 —— 缺的只是「谁来再试一次」。
 *
 * 所以这里把它包成一个循环：每次都从磁盘现状继续（引擎会 resumeScan），
 * 失败就等一会儿再来，直到下完或达到尝试上限。
 * 没人看着的时候，这个循环就是那个「判断」。
 */

export type RetryOptions = {
  candidates: readonly ScoredCandidate[];
  config: AppConfig;
  episodes: number[];
  savePath: string;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  /** 最多尝试几轮。默认 6。 */
  rounds?: number;
  /** 第一轮结束后等多久再试（毫秒），之后按倍数退避。默认 10 分钟。 */
  backoffMs?: number;
  /** 退避上限。默认 2 小时。 */
  maxBackoffMs?: number;
  /** 单轮的验证窗口：这一轮至少要新下多少字节才算「有进展」。默认 1MB。 */
  minProgressBytes?: number;
  /** 每轮的时间预算，覆盖配置里的 budgetMinutes。 */
  roundBudgetMs?: number;
};

export type RetryResult = FallbackResult & {
  rounds: number;
  /** 每轮的摘要，便于事后看它到底试了几次、每次拿到多少。 */
  history: Array<{ round: number; bytes: number; gained: number; completed: boolean; reason: string }>;
};

export async function downloadUntilComplete(options: RetryOptions): Promise<RetryResult> {
  const rounds = Math.max(1, options.rounds ?? 6);
  const baseBackoff = options.backoffMs ?? 10 * 60_000;
  const maxBackoff = options.maxBackoffMs ?? 2 * 60 * 60_000;
  const minProgress = options.minProgressBytes ?? 1024 * 1024;

  const history: RetryResult['history'] = [];
  let previousBytes = 0;
  let last: FallbackResult | null = null;

  for (let round = 1; round <= rounds; round += 1) {
    if (options.signal?.aborted) break;

    log.info(`第 ${round}/${rounds} 轮开始${round > 1 ? `（累计已下 ${formatSize(previousBytes)}）` : ''}`);

    try {
      last = await downloadWithFallback({
        candidates: options.candidates,
        config: options.config,
        episodes: options.episodes,
        savePath: options.savePath,
        signal: options.signal,
        onLog: options.onLog,
        budgetMs: options.roundBudgetMs ?? (options.config.download.budgetMinutes ?? 360) * 60_000,
        trialSeconds: options.config.download.trialSeconds ?? 90,
        minThroughput: (options.config.download.minThroughputKBps ?? 30) * 1024,
        maxAttempts: options.config.download.maxAttempts ?? 8,
        // 第一轮看有没有历史进度；后面几轮必然要看，因为上一轮就是我们自己下的
        probeExisting: true
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn(`第 ${round} 轮失败：${reason}`);
      history.push({ round, bytes: previousBytes, gained: 0, completed: false, reason });

      if (round < rounds) {
        const wait = Math.min(maxBackoff, baseBackoff * 2 ** (round - 1));
        await waitOrAbort(wait, options.signal);
      }
      continue;
    }

    const gained = Math.max(0, last.bytesWritten - previousBytes);
    history.push({
      round,
      bytes: last.bytesWritten,
      gained,
      completed: last.completed,
      reason: last.completed ? '完成' : `未完成（本轮新增 ${formatSize(gained)}）`
    });

    if (last.completed) {
      log.info(`第 ${round} 轮下完了：${last.files.length} 个文件，共 ${formatSize(last.bytesWritten)}`);
      return { ...last, rounds: round, history };
    }

    previousBytes = Math.max(previousBytes, last.bytesWritten);
    log.info(`第 ${round} 轮结束：未下完，磁盘上共 ${formatSize(previousBytes)}（本轮新增 ${formatSize(gained)}）`);

    if (gained < minProgress) {
      // 一轮下来几乎没动，说明现在是真没速度（不是预算问题），等久一点再来
      log.warn(`本轮新增不足 ${formatSize(minProgress)}，判断为当前没有可用速度`);
    }

    if (round < rounds) {
      const wait = Math.min(maxBackoff, baseBackoff * 2 ** (round - 1));
      log.info(`等 ${Math.round(wait / 60_000)} 分钟后再试（进度会保留，下轮接着下）`);
      await waitOrAbort(wait, options.signal);
    }
  }

  const finalResult: RetryResult = last
    ? { ...last, rounds: history.length, history }
    : {
        infoHash: '',
        title: '',
        files: [],
        bytesWritten: previousBytes,
        completed: false,
        resumedBytes: 0,
        attempts: [],
        rounds: history.length,
        history
      };

  log.warn(
    `试了 ${history.length} 轮仍未下完。已保留 ${formatSize(finalResult.bytesWritten)}，` +
      '下次运行会从这个进度继续（不会重下）。'
  );
  return finalResult;
}

/** 可被中断的等待。 */
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
