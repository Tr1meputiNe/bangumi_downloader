import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { metaFromInfoBytes, pieceSize, type TorrentMeta } from '../bittorrent/metainfo.js';
import { TorrentStorage } from '../bittorrent/storage.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('verify');

/**
 * 核对「下载目录里到底下好了什么」。
 *
 * 为什么需要这个命令：这个项目按断点续传来设计，文件一开始就被预分配到完整长度。
 * 于是**光看文件大小完全判断不出进度** —— 一个 700MB 的文件可能里面全是零。
 * 实测就踩过：13 个看着齐整的 mkv，实际只有前 6 个分片有数据，播放器一打开就报错。
 *
 * 这里用种子元数据里的分片哈希逐片校验，给出的才是真实进度。
 */

export type TorrentVerifyReport = {
  infoHash: string;
  name: string;
  /** 元数据里这个种子应有的文件数。 */
  expectedFiles: number;
  /** 目录里实际存在的文件数（不含填充文件）。 */
  presentFiles: number;
  pieceTotal: number;
  pieceDone: number;
  /** 已校验通过的分片字节数。 */
  bytesDone: number;
  bytesTotal: number;
  /** 0~1。 */
  ratio: number;
  /** 名义大小（文件长度之和，不反映真实进度）。 */
  nominalBytes: number;
  complete: boolean;
  /** 有没有文件实际一个数据分片都没有。 */
  empty: boolean;
};

export type VerifyOptions = {
  savePath: string;
  /** 元数据缓存目录，默认 <savePath>/.bangumi-meta。 */
  metadataDir?: string;
  /** 只核对这一个 infohash。 */
  infoHash?: string;
  /** 校验通过后，把「一片数据都没有」的目录连文件一起删掉。 */
  cleanEmpty?: boolean;
};

export function metadataDirOf(savePath: string, override?: string): string {
  return override ?? join(savePath, '.bangumi-meta');
}

/** 列出缓存里所有已知的种子元数据。 */
export function loadCachedMetas(savePath: string, metadataDir?: string): TorrentMeta[] {
  const dir = metadataDirOf(savePath, metadataDir);
  if (!existsSync(dir)) return [];

  const metas: TorrentMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.bin')) continue;
    try {
      const meta = metaFromInfoBytes(new Uint8Array(readFileSync(join(dir, name))));
      if (meta) metas.push(meta);
    } catch {
      // 坏掉的缓存跳过
    }
  }
  return metas;
}

/** 逐片校验一个种子在磁盘上的真实进度。 */
export function verifyTorrent(meta: TorrentMeta, savePath: string): TorrentVerifyReport {
  const dir = join(savePath, sanitize(meta.name));
  const exists = existsSync(dir);

  const report: TorrentVerifyReport = {
    infoHash: meta.infoHash,
    name: meta.name,
    expectedFiles: meta.files.filter((file) => !/padding_file/i.test(file.path)).length,
    presentFiles: 0,
    pieceTotal: meta.pieceCount,
    pieceDone: 0,
    bytesDone: 0,
    bytesTotal: meta.totalLength,
    ratio: 0,
    nominalBytes: 0,
    complete: false,
    empty: true
  };

  if (!exists) return report;

  report.presentFiles = countFiles(dir);
  report.nominalBytes = sumFileSizes(dir);

  // 用存储层自己的校验逻辑，避免两处实现不一致
  const storage = new TorrentStorage(meta, { savePath });
  try {
    storage.resumeScan();
    report.pieceDone = storage.verified.size;
    for (const piece of storage.verified) report.bytesDone += pieceSize(meta, piece);
  } finally {
    storage.close();
  }

  report.ratio = meta.pieceCount === 0 ? 0 : report.pieceDone / meta.pieceCount;
  report.complete = report.pieceDone >= meta.pieceCount;
  report.empty = report.pieceDone === 0;
  return report;
}

export type VerifyAllResult = {
  reports: TorrentVerifyReport[];
  removed: string[];
};

/** 核对全部缓存过的种子；可选清掉完全空壳的目录。 */
export async function verifyAll(options: VerifyOptions): Promise<VerifyAllResult> {
  const metas = loadCachedMetas(options.savePath, options.metadataDir).filter(
    (meta) => !options.infoHash || meta.infoHash === options.infoHash
  );

  const reports: TorrentVerifyReport[] = [];
  const removed: string[] = [];

  for (const meta of metas) {
    const report = verifyTorrent(meta, options.savePath);
    reports.push(report);

    if (options.cleanEmpty && report.empty && report.presentFiles > 0) {
      const dir = join(options.savePath, sanitize(meta.name));
      // 只删「一个有效分片都没有」的目录：那必然是历次尝试留下的空壳
      log.warn(`删除空壳目录（0 个有效分片，名义 ${formatSize(report.nominalBytes)}）：${dir}`);
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  return { reports, removed };
}

/** 把核对结果打印成人能看的报告。 */
export function printVerifyReport(report: TorrentVerifyReport): void {
  const percent = (report.ratio * 100).toFixed(1);
  const flag = report.complete ? '✅' : report.empty ? '⬜' : '⚠️ ';
  const state = report.complete
    ? '已下完'
    : report.empty
      ? '没有任何有效数据（空壳）'
      : `下了一半：${percent}%`;

  log.info(`${flag} 《${report.name}》`);
  log.info(
    `     ${state}｜有效数据 ${formatSize(report.bytesDone)} / ${formatSize(report.bytesTotal)}` +
      `（${report.pieceDone}/${report.pieceTotal} 分片）｜文件 ${report.presentFiles}/${report.expectedFiles} 个`
  );
  if (!report.complete && report.nominalBytes > report.bytesDone * 2) {
    // 这个提示很关键：文件大小会骗人，用户很容易以为已经下好了
    log.info(`     注意：目录里的文件名义大小是 ${formatSize(report.nominalBytes)}，但那是预分配的结果，不代表已下载`);
  }
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'torrent';
}

function countFiles(dir: string): number {
  let count = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!/padding_file/i.test(entry.name)) count += 1;
    }
  };
  walk(dir);
  return count;
}

function sumFileSizes(dir: string): number {
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
        /* 忽略 */
      }
    }
  };
  walk(dir);
  return total;
}


