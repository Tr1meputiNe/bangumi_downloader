import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../util/log.js';

const log = logger('inflight');

/**
 * 「这个种子正在被下载」的跨进程登记。
 *
 * 为什么需要：这套东西有两个入口会真的去下东西 ——
 *   - 计划任务触发的 `auto`（另一个进程）
 *   - 网页界面里点「开始下载」的任务队列（常驻的那个进程）
 * 两边的锁是各自的（auto 用的是单实例锁，队列是内存里的），互相看不见，
 * 于是同一个种子会被两个进程同时下：带宽对半分、进度各写一份、
 * 而且很可能落成**两个目录**。实测就被用户抓到了「怎么两个一起在下」。
 *
 * 所以用一个 json 文件当登记簿：开工前先认领，收工释放；
 * 认领时顺手把「进程已经不在」的僵尸记录清掉（和单实例锁同一套判断）。
 */

export type InflightEntry = {
  key: string;
  title: string;
  pid: number;
  startedAt: string;
};

type InflightFile = { version: 1; entries: InflightEntry[] };

export const INFLIGHT_FILENAME = 'downloading.json';

export function inflightPath(configPath?: string): string {
  const dir = configPath ? dirname(configPath) : process.cwd();
  return join(dir, 'data', INFLIGHT_FILENAME);
}

/** 进程还在不在（Windows 上 process.kill(pid, 0) 也适用）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于我们；ESRCH = 不存在
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function read(file: string): InflightEntry[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<InflightFile>;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return entries.filter((item): item is InflightEntry => typeof item?.key === 'string' && typeof item?.pid === 'number');
  } catch {
    return [];
  }
}

function write(file: string, entries: InflightEntry[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.warn(`下载登记簿写入失败：${(error as Error).message}`);
  }
}

/** 当前真正在下载的条目（顺手清掉进程已死的记录）。 */
export function listInflight(file: string): InflightEntry[] {
  const entries = read(file);
  const alive = entries.filter((entry) => entry.pid === process.pid || isProcessAlive(entry.pid));
  if (alive.length !== entries.length) write(file, alive);
  return alive;
}

export type ClaimResult = { ok: true } | { ok: false; holder: InflightEntry };

/**
 * 认领一个下载。
 *
 * 同一个进程重复认领同一个 key 视为成功（重试同一轮很正常）；
 * 被**别的活着的进程**占着就返回失败，调用方应该跳过这个候选。
 */
export function claimDownload(file: string, input: { key: string; title: string }): ClaimResult {
  const entries = listInflight(file);
  const existing = entries.find((entry) => entry.key === input.key);
  if (existing && existing.pid !== process.pid) return { ok: false, holder: existing };

  const next = entries.filter((entry) => entry.key !== input.key);
  next.push({ key: input.key, title: input.title.slice(0, 120), pid: process.pid, startedAt: new Date().toISOString() });
  write(file, next);
  return { ok: true };
}

export function releaseDownload(file: string, key: string): void {
  const entries = read(file).filter((entry) => !(entry.key === key && entry.pid === process.pid));
  if (entries.length === 0) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 删不掉也无所谓，下次认领会覆盖 */
    }
    return;
  }
  write(file, entries);
}

/** 按 infohash（没有就用标题）算一个稳定的 key。 */
export function downloadKeyOf(input: { magnet?: string; torrentUrl?: string; title: string }): string {
  const magnet = input.magnet ?? '';
  const hash = /btih:([0-9a-fA-F]{40})/.exec(magnet)?.[1]?.toLowerCase();
  if (hash) return hash;
  const fromUrl = /([0-9a-fA-F]{40})/.exec(input.torrentUrl ?? '')?.[1]?.toLowerCase();
  return fromUrl ?? `t:${input.title}`;
}
