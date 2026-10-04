import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { metaFromInfoBytes, pieceSize, type TorrentMeta } from '../bittorrent/metainfo.js';
// 目录名归一化复用存储层的实现，避免两处规则不一致
import { TorrentStorage, sanitizeSegment as sanitize, sanitizeRelativePath } from '../bittorrent/storage.js';
import { checkVideoFile, describeIssue, isVideoFile, type PlayabilityIssue } from './video-check.js';
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
  /** 实际去哪个目录找的（绝对路径）。找不到时把「本该在哪」也列出来，方便排查。 */
  dir: string;
  /** 那个目录在不在。不在 = 还没下过；在但 empty = 下过但一个分片都没成。 */
  dirExists: boolean;
  /** 内容相对下载目录的路径（以实际找到的位置为准，带正斜杠）。 */
  relativePath: string;
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
  /** 抽检过的视频文件数（只统计有内容的）。 */
  videosChecked: number;
  /** 其中有致命问题的（播不了）。 */
  videosUnplayable: number;
  /** 有问题的文件明细，最多保留若干条，避免报告刷屏。 */
  videoIssues: Array<{ file: string; issues: PlayabilityIssue[] }>;
};

export type VerifyOptions = {
  savePath: string;
  /**
   * 番剧文件夹的统一父目录（config.download.seriesDir）。
   *
   * 必须传：下载内容现在归纳在 savePath/番剧/ 下面，
   * 不带这个信息去核对，会把已经下完的番当成「空壳」
   * —— 找不到文件时每个分片自然都校验不过。
   */
  seriesDir?: string;
  /** 元数据缓存目录，默认 <savePath>/.bangumi-meta。 */
  metadataDir?: string;
  /** 只核对这一个 infohash。 */
  infoHash?: string;
  /** 校验通过后，把「一片数据都没有」的目录连文件一起删掉。 */
  cleanEmpty?: boolean;
  /** 把下载目录里没被记录的内容加进本地清单。 */
  addLocal?: boolean;
  /** 是否做可播性抽检，默认做。 */
  checkPlayable?: boolean;
  /** 扫描本地内容时要跳过的顶层目录名（程序目录会自动识别，这里用于额外排除）。 */
  ignoreDirs?: readonly string[];
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

/**
 * 这个种子实际落在磁盘上的哪个目录。
 *
 * 为什么需要单独一步：落盘位置有三套规则，光看种子元数据推不出来 ——
 *   1. 多文件种子：savePath/[番剧]/种子名/
 *   2. 老布局（还没启用番剧目录时下的）：savePath/种子名/
 *   3. 单文件种子：目录名是**发布标题**（调用方给的 singleFileDir），
 *      不是种子名；而且标题里可能带空格和方括号，没法反推
 *
 * 这里按「先找得到、再按规则猜」的顺序定位：
 * 路径能对上就用，对不上就（对单文件种子）在可能的父目录里找
 * 「哪个子目录里正好有那个文件」。找不到时返回按规则算出来的路径，
 * 让报告里能显示「我去哪儿找过了」。
 */
export type TorrentLocation = {
  /** 内容所在目录（绝对路径）。 */
  dir: string;
  /** 该目录是否真的存在。 */
  exists: boolean;
  /** 传给 TorrentStorage 的 seriesRoot（为空表示内容直接放在 savePath 下）。 */
  seriesRoot?: string;
  /** 传给 TorrentStorage 的 singleFileDir（单文件种子用）。 */
  singleFileDir?: string;
};

export function locateTorrent(
  // 只依赖这几个字段，好让「只知道文件名」的调用方（例如 fallback 里的定位）也能用
  meta: Pick<TorrentMeta, 'name' | 'singleFile'> & { files: ReadonlyArray<{ path: string }> },
  savePath: string,
  seriesDir?: string
): TorrentLocation {
  const seriesRoot = seriesDir?.trim() || '';
  const nestedRoot = seriesRoot === '' ? null : join(savePath, sanitize(seriesRoot));
  const folderName = sanitize(meta.name);

  const candidates: TorrentLocation[] = [
    // 1) 当前布局：番剧子目录下的种子名
    ...(nestedRoot === null
      ? []
      : [{ dir: join(nestedRoot, folderName), exists: false, seriesRoot, singleFileDir: meta.singleFile ? folderName : undefined }]),
    // 2) 老布局：直接在下载根目录下
    { dir: join(savePath, folderName), exists: false, singleFileDir: meta.singleFile ? folderName : undefined }
  ];

  /*
   * 3) 单文件种子：目录名是发布标题。在可能的父目录里找
   *    「哪个子目录里正好有那个文件名」，找到了就是它。
   */
  if (meta.singleFile) {
    const relative = sanitizeRelativePath(meta.files[0]?.path ?? meta.name);
    const fileName = basename(relative) || folderName;
    for (const base of [nestedRoot, savePath].filter((item): item is string => item !== null)) {
      let children;
      try {
        children = readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (!existsSync(join(base, child.name, fileName))) continue;
        candidates.push({
          dir: join(base, child.name),
          exists: true,
          seriesRoot: base === nestedRoot ? seriesRoot : undefined,
          singleFileDir: child.name
        });
      }
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.dir)) return { ...candidate, exists: true };
  }
  return candidates[0] as TorrentLocation;
}

/** 逐片校验一个种子在磁盘上的真实进度。 */
export function verifyTorrent(
  meta: TorrentMeta,
  savePath: string,
  options: { checkPlayable?: boolean; seriesDir?: string } = {}
): TorrentVerifyReport {
  const location = locateTorrent(meta, savePath, options.seriesDir);
  const dir = location.dir;

  const report: TorrentVerifyReport = {
    source: 'torrent',
    infoHash: meta.infoHash,
    name: meta.name,
    dir,
    dirExists: location.exists,
    relativePath: relativePathOf(savePath, dir),
    expectedFiles: meta.files.filter((file) => !/padding_file/i.test(file.path)).length,
    presentFiles: 0,
    pieceTotal: meta.pieceCount,
    pieceDone: 0,
    bytesDone: 0,
    bytesTotal: meta.totalLength,
    ratio: 0,
    nominalBytes: 0,
    complete: false,
    empty: true,
    videosChecked: 0,
    videosUnplayable: 0,
    videoIssues: []
  };

  if (!location.exists) return report;

  report.presentFiles = countFiles(dir);
  report.nominalBytes = sumFileSizes(dir);
  if (options.checkPlayable !== false) Object.assign(report, checkVideosIn(dir));

  // 用存储层自己的校验逻辑，避免两处实现不一致
  const storage = new TorrentStorage(meta, {
    savePath,
    seriesRoot: location.seriesRoot,
    singleFileDir: location.singleFileDir
  });
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
export function scanForLocalItems(
  savePath: string,
  metadataDir?: string,
  ignoreNames: readonly string[] = [],
  seriesDir?: string
): { added: InventoryEntry[]; entries: InventoryEntry[] } {
  const entries = loadInventory(savePath, metadataDir);
  const known = new Set(entries.map((e) => e.path));
  const managed = new Set(loadCachedMetas(savePath, metadataDir).map((m) => sanitize(m.name)));
  const added: InventoryEntry[] = [];

  /*
   * 扫描范围：启用了「番剧目录」就扫它里面，否则扫下载根目录。
   *
   * 这里必须跟着归纳规则走 —— 否则在 savePath 下只会看到一个叫「番剧」的
   * 大目录，被整条登记成「本地内容」，而里面每一部番都看不到。
   */
  const seriesRoot = seriesDir?.trim();
  const scanDir = seriesRoot && existsSync(join(savePath, sanitize(seriesRoot))) ? join(savePath, sanitize(seriesRoot)) : savePath;
  const prefix = scanDir === savePath ? '' : sanitize(seriesRoot as string);

  let dirs: string[] = [];
  try {
    dirs = readdirSync(scanDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '.bangumi-meta')
      .map((entry) => entry.name);
  } catch {
    return { added, entries };
  }

  for (const name of dirs) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (known.has(path) || known.has(name) || managed.has(name)) continue;
    if (ignoreNames.includes(name)) continue;

    const full = join(scanDir, name);
    if (countFiles(full) === 0) continue;
    /*
     * 跳过「程序自己的目录」。
     *
     * 场景：把软件放进了下载目录（例如 D:\anime_download\bangumi-downloader），
     * 这样一切都在一处。但扫描逻辑会把任何顶层目录当成「本地下载内容」，
     * 于是程序目录会被登记成一条动画条目 —— 明显不对。
     * 用「里面有没有程序本体」自识别，比要求用户手工排除可靠。
     */
    if (looksLikeAppDirectory(full)) continue;

    const entry: InventoryEntry = {
      name,
      path,
      kind: detectKind(full)
    };
    entries.push(entry);
    added.push(entry);
  }

  return { added, entries };
}

/** 这个目录是不是「程序自己」（里面有 bangumi-downloader.exe 或 package.json + release）。 */
export function looksLikeAppDirectory(dir: string): boolean {
  const markers = ['bangumi-downloader.exe', 'bangumi-downloader', join('release', 'windows', 'bangumi-downloader.exe')];
  for (const marker of markers) {
    if (existsSync(join(dir, marker))) return true;
  }
  // 源码目录：同时有 package.json 和 src/
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'));
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

/** 把一个绝对路径换算成相对下载目录的写法（统一用正斜杠）。 */
export function relativePathOf(savePath: string, dir: string): string {
  const rel = relative(resolve(savePath), resolve(dir));
  return rel.split(sep).join('/');
}

/**
 * 本地内容实际在哪儿。
 *
 * 为什么不能直接用清单里记的 path：清单是历史记录。内容从「直接放在下载
 * 根目录」改成「归纳进番剧子目录」之后，老记录还指着根目录，
 * 于是核对时找不到文件，整条被报成「空壳」——看上去像内容丢了。
 * 这里按「记录的位置 → 番剧目录下同名 → 根目录下同名」依次找，
 * 找到就用，并让调用方有机会把记录改写过来。
 */
export function locateLocal(
  entry: InventoryEntry,
  savePath: string,
  seriesDir?: string
): { dir: string; exists: boolean; relativePath: string } {
  const seriesRoot = seriesDir?.trim();
  const name = basename(entry.path) || entry.name;

  const candidates = [
    ...(seriesRoot ? [join(savePath, sanitize(seriesRoot), name)] : []),
    join(savePath, entry.path),
    join(savePath, name)
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { dir: candidate, exists: true, relativePath: relativePathOf(savePath, candidate) };
    }
  }

  const fallback = join(savePath, entry.path);
  return { dir: fallback, exists: false, relativePath: entry.path };
}

/** 对本地条目做基本检查（没有分片哈希，只能看文件层面）。 */
export function verifyLocal(
  entry: InventoryEntry,
  savePath: string,
  options: { checkPlayable?: boolean; seriesDir?: string } = {}
): TorrentVerifyReport {
  const location = locateLocal(entry, savePath, options.seriesDir);
  const dir = location.dir;
  const report: TorrentVerifyReport = {
    source: 'local',
    infoHash: '',
    name: entry.name,
    dir,
    dirExists: location.exists,
    relativePath: location.relativePath,
    expectedFiles: 0,
    presentFiles: 0,
    pieceTotal: 0,
    pieceDone: 0,
    bytesDone: 0,
    bytesTotal: 0,
    ratio: 0,
    nominalBytes: 0,
    complete: false,
    empty: true,
    videosChecked: 0,
    videosUnplayable: 0,
    videoIssues: []
  };

  if (!existsSync(dir)) return report;

  report.presentFiles = countFiles(dir);
  report.nominalBytes = sumFileSizes(dir);
  report.bytesDone = report.nominalBytes;
  report.bytesTotal = report.nominalBytes;

  /*
   * 本地条目没有分片哈希，唯一的证据就是文件内容本身。
   * 这里逐个视频做可播性检查 —— 比看文件大小可靠得多：
   * 实测遇到过一个 3.78GB 的目录，13 个文件大小都对，内容却全是零。
   */
  if (options.checkPlayable !== false) {
    Object.assign(report, checkVideosIn(dir));
    report.empty = report.videosChecked === 0 || report.videosUnplayable >= report.videosChecked;
  } else {
    /*
     * 没做可播性抽检时，只能按「目录里有没有文件」判断。
     *
     * 以前这里不看这个条件：抽检被关掉时 videosChecked 恒为 0，
     * 于是 `empty` 恒为 true —— 用户那几部 12GB 的剧场版被报成「空壳」，
     * 看着像内容丢了。判断依据没了就该说「没检查」，而不是编一个结论。
     */
    report.empty = report.presentFiles === 0 || report.nominalBytes === 0;
  }
  // 没有分片哈希就没法保证完整性，只能报「有内容」，不声称「已下完」
  report.complete = false;
  report.ratio = report.empty ? 0 : 1;
  return report;
}

/** 对一个目录里的所有视频做可播性抽检。 */
function checkVideosIn(dir: string): {
  videosChecked: number;
  videosUnplayable: number;
  videoIssues: Array<{ file: string; issues: PlayabilityIssue[] }>;
} {
  const videos: string[] = [];
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
      else if (isVideoFile(entry.name)) videos.push(full);
    }
  };
  walk(dir);

  let checked = 0;
  let unplayable = 0;
  const issues: Array<{ file: string; issues: PlayabilityIssue[] }> = [];

  for (const file of videos) {
    const check = checkVideoFile(file);
    if (check.sizeBytes === 0) continue; // 空文件（例如占位字幕）不算视频
    checked += 1;
    if (check.issues.length > 0) {
      issues.push({ file: file.slice(dir.length + 1), issues: check.issues });
      if (!check.playable) unplayable += 1;
    }
  }

  return { videosChecked: checked, videosUnplayable: unplayable, videoIssues: issues.slice(0, 6) };
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
    const scan = scanForLocalItems(options.savePath, options.metadataDir, options.ignoreDirs ?? [], options.seriesDir);
    if (scan.added.length > 0) {
      saveInventory(options.savePath, scan.entries, options.metadataDir);
      for (const entry of scan.added) added.push(entry.name);
    }
  }

  for (const meta of metas) {
    const report = verifyTorrent(meta, options.savePath, {
      checkPlayable: options.checkPlayable,
      seriesDir: options.seriesDir
    });
    reports.push(report);

    if (options.cleanEmpty && report.empty && report.presentFiles > 0) {
      /*
       * 删的是**实际找到的那个目录**，不是按规则猜出来的路径。
       * 这里如果猜错（例如单文件种子的目录名是发布标题），
       * 就会去删一个别的番剧的目录 —— 比不删危险得多。
       */
      const dir = report.dir;
      log.warn(`删除空壳目录（0 个有效分片，名义 ${formatSize(report.nominalBytes)}）：${dir}`);
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  // 本地清单里的条目也一起纳入统计
  const inventory = loadInventory(options.savePath, options.metadataDir);
  let relocated = 0;
  for (const entry of inventory) {
    const report = verifyLocal(entry, options.savePath, {
      checkPlayable: options.checkPlayable,
      seriesDir: options.seriesDir
    });
    reports.push(report);

    /*
     * 内容挪过地方就把清单记录改过来。
     *
     * 场景：内容原先在下载根目录，后来归纳进了「番剧」子目录，
     * 老记录还指着根目录 —— 每次核对都报「找不到」，看着像东西丢了。
     * 找到就顺手修正，下次核对直接命中。
     */
    if (report.dirExists && report.relativePath !== entry.path) {
      log.info(`修正本地内容位置：${entry.path} → ${report.relativePath}`);
      entry.path = report.relativePath;
      relocated += 1;
    }
  }
  if (relocated > 0) saveInventory(options.savePath, inventory, options.metadataDir);

  return { reports, removed, added };
}

/** 把核对结果打印成人能看的报告。 */
export function printVerifyReport(report: TorrentVerifyReport): void {
  const percent = (report.ratio * 100).toFixed(1);

  if (report.source === 'local') {
    const broken = report.videosUnplayable > 0;
    const flag = report.empty ? '⬜' : broken ? '❌' : '📁';
    log.info(`${flag} 《${report.name}》`);
    if (!report.dirExists) {
      // 「目录不在」和「目录在但没内容」是两回事，别都说成「没有任何能播的内容」
      log.info(`     找不到这个目录：${report.dir}`);
    } else if (report.empty) {
      log.info('     没有任何能播的内容');
    } else if (broken) {
      log.info(
        `     ${report.videosUnplayable}/${report.videosChecked} 个视频播不了` +
          `（本地文件 ${formatSize(report.nominalBytes)}，${report.presentFiles} 个文件）`
      );
    } else {
      log.info(
        `     本地文件 ${formatSize(report.nominalBytes)}，${report.presentFiles} 个文件，` +
          `${report.videosChecked} 个视频抽检正常（非本项目下载，无分片哈希，不做完整性校验）`
      );
    }
    printVideoIssues(report);
    return;
  }

  const flag = report.complete ? '✅' : report.empty ? '⬜' : '⚠️ ';
  const state = report.complete
    ? '已下完'
    : report.empty
      ? report.dirExists
        ? '没有任何有效数据（空壳）'
        : '目录还没建（还没下过）'
      : `下了一半：${percent}%`;

  log.info(`${flag} 《${report.name}》`);
  if (!report.dirExists) log.info(`     找的是：${report.dir}`);
  log.info(
    `     ${state}｜有效数据 ${formatSize(report.bytesDone)} / ${formatSize(report.bytesTotal)}` +
      `（${report.pieceDone}/${report.pieceTotal} 分片）｜文件 ${report.presentFiles}/${report.expectedFiles} 个`
  );
  if (!report.complete && report.nominalBytes > report.bytesDone * 2) {
    // 这个提示很关键：文件大小会骗人，用户很容易以为已经下好了
    log.info(`     注意：目录里的文件名义大小是 ${formatSize(report.nominalBytes)}，但那是预分配的结果，不代表已下载`);
  }

  /*
   * 分片校验和可播性检查是两件事：
   *   分片校验说「相对种子是否完整」，可播性说「这个文件本身能不能打开」。
   * 正常情况下分片全过就意味着能播；这里报出问题，说明写入或磁盘层面出了岔子，
   * 属于必须让人看见的异常。
   */
  if (report.videosUnplayable > 0) {
    log.warn(
      `     异常：分片校验${report.complete ? '已通过' : '未通过'}，但有 ${report.videosUnplayable} 个视频播不了 —— 请检查磁盘`
    );
  }
  printVideoIssues(report);
}

/** 打印前几条文件级问题。 */
function printVideoIssues(report: TorrentVerifyReport): void {
  for (const item of report.videoIssues) {
    const reasons = item.issues.map(describeIssue).join('；');
    log.info(`       · ${item.file.slice(-60)} → ${reasons}`);
  }
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


