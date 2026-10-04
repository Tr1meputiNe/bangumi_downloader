import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** 条目的来源：本项目下的（有分片哈希可验），还是本地的（只能做基本检查）。 */
export type VerifySource = 'torrent' | 'local';

export type TorrentVerifyReport = {
  /** torrent：有种子元数据，能逐片校验；local：本地清单里的，只能看文件层面。 */
  source: VerifySource;
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
  /** 把下载目录里没被记录的内容加进本地清单。 */
  addLocal?: boolean;
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
    source: 'torrent',
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
  /** 新加入本地清单的条目名。 */
  added: string[];
};

/**
 * 本地清单。
 *
 * 用途：把「不是本项目下载的、但同样放在下载目录里」的内容也纳入统计 ——
 * 例如用户自己用别的工具下的剧场版。这些没有种子元数据，无法逐片校验，
 * 但至少能一起列出、一起看体积和文件数，不用在两处分别查。
 */
export type InventoryEntry = {
  name: string;
  /** 相对下载目录的路径。 */
  path: string;
  kind: 'series' | 'movie' | 'other';
  note?: string;
};

type InventoryFile = { version: 1; entries: InventoryEntry[] };

export const INVENTORY_FILENAME = 'inventory.json';

export function loadInventory(savePath: string, metadataDir?: string): InventoryEntry[] {
  const file = join(metadataDirOf(savePath, metadataDir), INVENTORY_FILENAME);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<InventoryFile>;
    return Array.isArray(parsed.entries) ? parsed.entries.filter((e): e is InventoryEntry => typeof e?.name === 'string') : [];
  } catch {
    return [];
  }
}

export function saveInventory(savePath: string, entries: InventoryEntry[], metadataDir?: string): void {
  const dir = metadataDirOf(savePath, metadataDir);
  mkdirSync(dir, { recursive: true });
  const payload: InventoryFile = { version: 1, entries };
  writeFileSync(join(dir, INVENTORY_FILENAME), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * 扫描下载目录，把「还没有被清单记录、也不是本项目下的」顶层目录加进清单。
 * 本项目的下载内容靠 .bangumi-meta/*.bin 识别，其余都算本地内容。
 */
export function scanForLocalItems(savePath: string, metadataDir?: string): { added: InventoryEntry[]; entries: InventoryEntry[] } {
  const entries = loadInventory(savePath, metadataDir);
  const known = new Set(entries.map((e) => e.path));
  const managed = new Set(loadCachedMetas(savePath, metadataDir).map((m) => sanitize(m.name)));
  const added: InventoryEntry[] = [];

  let dirs: string[] = [];
  try {
    dirs = readdirSync(savePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.bangumi-meta')
      .map((entry) => entry.name);
  } catch {
    return { added, entries };
  }

  for (const name of dirs) {
    if (known.has(name) || managed.has(name)) continue;
    const full = join(savePath, name);
    if (countFiles(full) === 0) continue;

    const entry: InventoryEntry = {
      name,
      path: name,
      kind: detectKind(full)
    };
    entries.push(entry);
    added.push(entry);
  }

  return { added, entries };
}

/** 粗略判断是剧集还是剧场版：有多个视频文件且名字里带集号的多半是剧集。 */
function detectKind(dir: string): InventoryEntry['kind'] {
  const videos: string[] = [];
  const walk = (current: string): void => {
    let kids;
    try {
      kids = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const kid of kids) {
      const full = join(current, kid.name);
      if (kid.isDirectory()) walk(full);
      else if (/\.(mkv|mp4|avi)$/i.test(kid.name)) videos.push(kid.name);
    }
  };
  walk(dir);
  if (videos.length >= 3) return 'series';
  if (videos.length >= 1) return 'movie';
  return 'other';
}

/** 对本地条目做基本检查（没有分片哈希，只能看文件层面）。 */
export function verifyLocal(entry: InventoryEntry, savePath: string): TorrentVerifyReport {
  const dir = join(savePath, entry.path);
  const report: TorrentVerifyReport = {
    source: 'local',
    infoHash: '',
    name: entry.name,
    expectedFiles: 0,
    presentFiles: 0,
    pieceTotal: 0,
    pieceDone: 0,
    bytesDone: 0,
    bytesTotal: 0,
    ratio: 0,
    nominalBytes: 0,
    complete: false,
    empty: true
  };

  if (!existsSync(dir)) return report;

  report.presentFiles = countFiles(dir);
  report.nominalBytes = sumFileSizes(dir);
  report.bytesDone = report.nominalBytes;
  report.bytesTotal = report.nominalBytes;
  report.empty = report.nominalBytes === 0;
  // 没有分片哈希就没法保证完整性，只能报「有内容」，不声称「已下完」
  report.complete = false;
  report.ratio = report.empty ? 0 : 1;
  return report;
}

/** 核对全部缓存过的种子；可选清掉完全空壳的目录。 */
export async function verifyAll(options: VerifyOptions): Promise<VerifyAllResult> {
  const metas = loadCachedMetas(options.savePath, options.metadataDir).filter(
    (meta) => !options.infoHash || meta.infoHash === options.infoHash
  );

  const reports: TorrentVerifyReport[] = [];
  const removed: string[] = [];
  const added: string[] = [];

  if (options.addLocal) {
    const scan = scanForLocalItems(options.savePath, options.metadataDir);
    if (scan.added.length > 0) {
      saveInventory(options.savePath, scan.entries, options.metadataDir);
      for (const entry of scan.added) added.push(entry.name);
    }
  }

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

  // 本地清单里的条目也一起纳入统计
  for (const entry of loadInventory(options.savePath, options.metadataDir)) {
    reports.push(verifyLocal(entry, options.savePath));
  }

  return { reports, removed, added };
}

/** 把核对结果打印成人能看的报告。 */
export function printVerifyReport(report: TorrentVerifyReport): void {
  const percent = (report.ratio * 100).toFixed(1);

  if (report.source === 'local') {
    // 本地条目没有分片哈希，只能说「有内容」，不能说「校验通过」
    const flag = report.empty ? '⬜' : '📁';
    log.info(`${flag} 《${report.name}》`);
    log.info(
      `     ${report.empty ? '没有任何数据' : `本地文件 ${formatSize(report.nominalBytes)}，${report.presentFiles} 个文件`}` +
        '（非本项目下载，无分片哈希，不做完整性校验）'
    );
    return;
  }

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


