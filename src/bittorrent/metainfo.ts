import { createHash } from 'node:crypto';
import { bdecodeTorrent, type BencodeValue } from '../util/bencode.js';
import { magnetInfoHash } from '../util/magnet.js';

/**
 * 种子元信息。
 *
 * 分两种来源：
 *  1. 直接拿到 .torrent 文件 —— info 字典的原始字节在手，infohash 可校验；
 *  2. 只有磁力链接 —— 必须先连上 peer 用 BEP 9 把 info 字典抓回来（见 metadata.ts）。
 *
 * 无论哪种来源，最终都要把 info 字典的原始字节保留下来：
 * 磁力下载时用它对 SHA1 校验 infohash，落盘时用它算每个 piece 的哈希。
 */

export type TorrentFile = {
  /** 文件序号，从 0 开始，与 pieces 映射一致。 */
  index: number;
  /** 相对路径，多文件种子形如 "CD1/01.mkv"。 */
  path: string;
  length: number;
  /** 该文件在整个种子里的起始字节偏移。 */
  offset: number;
};

export type TorrentMeta = {
  /** 40 位小写 hex。 */
  infoHash: string;
  /** info 字典原始字节，用于校验。 */
  infoBytes: Uint8Array;
  name: string;
  pieceLength: number;
  /** 每个 piece 的 SHA1，共 pieceCount 个。 */
  pieceHashes: Uint8Array[];
  pieceCount: number;
  /** 全部文件的总字节数。 */
  totalLength: number;
  files: TorrentFile[];
  /** 单文件种子的情况（files 只有一个元素，路径就是 name）。 */
  singleFile: boolean;
  /** 来自 .torrent 的 announce 列表；磁力链带来的 tracker 另行合并。 */
  trackers: string[];
  webSeeds: string[];
};

/** 磁力链接解析结果。 */
export type MagnetInfo = {
  infoHash: string;
  displayName: string;
  trackers: string[];
  webSeeds: string[];
};

/** 解析磁力链接。缺少合法 btih 时返回 null。 */
export function parseMagnet(uri: string): MagnetInfo | null {
  const trimmed = uri.trim();
  if (!/^magnet:\?/i.test(trimmed)) return null;

  const infoHash = magnetInfoHash(trimmed);
  if (!infoHash) return null;

  const params = new URLSearchParams(trimmed.slice('magnet:?'.length));
  const trackers = params.getAll('tr').filter((item) => item.length > 0);
  const webSeeds = params.getAll('ws').filter((item) => item.length > 0);

  return {
    infoHash,
    displayName: params.get('dn') ?? infoHash,
    trackers: [...new Set(trackers)],
    webSeeds: [...new Set(webSeeds)]
  };
}

/** 从已解析的 info 字典构造 TorrentMeta。infohash 由传入的原始字节算出。 */
export function metaFromInfoBytes(
  infoBytes: Uint8Array,
  extraTrackers: string[] = [],
  extraWebSeeds: string[] = []
): TorrentMeta | null {
  const decoded = bdecodeTorrent(wrapAsTorrent(infoBytes));
  if (!decoded) return null;

  const infoHash = createHash('sha1').update(infoBytes).digest('hex');
  return buildMeta(infoHash, infoBytes, decoded.info, extractTrackers(decoded.root), extractRootUrlList(decoded.root), extraTrackers, extraWebSeeds);
}

/**
 * 直接解析 .torrent 文件。
 * trackers / web seed 会与调用方额外提供的（例如搜索站给的磁力链里的）合并。
 */
export function parseTorrentFile(
  buffer: Uint8Array,
  extraTrackers: string[] = [],
  extraWebSeeds: string[] = []
): TorrentMeta | null {
  const decoded = bdecodeTorrent(buffer);
  if (!decoded) return null;

  const infoHash = createHash('sha1').update(decoded.infoBytes).digest('hex');
  return buildMeta(
    infoHash,
    decoded.infoBytes,
    decoded.info,
    extractTrackers(decoded.root),
    extractRootUrlList(decoded.root),
    extraTrackers,
    extraWebSeeds
  );
}

/** 把裸 info 字典包成完整 torrent，好复用同一套解析逻辑。 */
function wrapAsTorrent(infoBytes: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode('d4:info');
  const suffix = new TextEncoder().encode('e');
  const out = new Uint8Array(prefix.length + infoBytes.length + suffix.length);
  out.set(prefix, 0);
  out.set(infoBytes, prefix.length);
  out.set(suffix, prefix.length + infoBytes.length);
  return out;
}

function buildMeta(
  infoHash: string,
  infoBytes: Uint8Array,
  info: BencodeValue,
  trackers: string[],
  webSeeds: string[] = [],
  extraTrackers: string[] = [],
  extraWebSeeds: string[] = []
): TorrentMeta | null {
  if (!isDict(info)) return null;

  const nameBytes = asBytes(info.name);
  const name = nameBytes ? decodeText(nameBytes) : infoHash;
  const pieceLength = typeof info['piece length'] === 'number' ? info['piece length'] : 0;
  const piecesValue = asBytes(info.pieces);

  if (pieceLength <= 0 || !piecesValue || piecesValue.length % 20 !== 0) return null;

  const pieceHashes: Uint8Array[] = [];
  for (let offset = 0; offset < piecesValue.length; offset += 20) {
    pieceHashes.push(piecesValue.subarray(offset, offset + 20));
  }

  const parsedFiles = extractFileEntries(info, name);
  if (parsedFiles.length === 0) return null;

  const singleFile = !Array.isArray(info.files);

  let offset = 0;
  const files: TorrentFile[] = parsedFiles.map((entry, index) => {
    const file: TorrentFile = { index, path: entry.path, length: entry.length, offset };
    offset += entry.length;
    return file;
  });

  const totalLength = offset;
  const pieceCount = pieceHashes.length;
  const expectedPieces = Math.ceil(totalLength / pieceLength);
  // 有些老种子 pieces 会多出尾部填充，少一个则一定有问题
  if (pieceCount < expectedPieces) return null;

  return {
    infoHash,
    infoBytes,
    name,
    pieceLength,
    pieceHashes: pieceHashes.slice(0, expectedPieces),
    pieceCount: expectedPieces,
    totalLength,
    files,
    singleFile,
    trackers: [...new Set([...trackers, ...extraTrackers].map(normalizeTracker).filter((item) => item.length > 0))],
    webSeeds: [...new Set([...webSeeds, ...extraWebSeeds])]
  };
}

function extractFileEntries(info: { [key: string]: BencodeValue }, name: string): Array<{ path: string; length: number }> {
  const filesValue = info.files;
  if (!Array.isArray(filesValue)) {
    const length = typeof info.length === 'number' ? info.length : null;
    return length === null ? [] : [{ path: name, length }];
  }

  const entries: Array<{ path: string; length: number }> = [];
  for (const item of filesValue) {
    if (!isDict(item)) continue;
    const length = typeof item.length === 'number' ? item.length : null;
    const parts = Array.isArray(item.path)
      ? item.path.map((part) => asBytes(part)).filter((part): part is Uint8Array => part !== null)
      : [];
    if (length === null || parts.length === 0) continue;
    entries.push({ path: parts.map((part) => decodeText(part)).join('/'), length });
  }
  return entries;
}

function extractTrackers(root: BencodeValue): string[] {
  if (!isDict(root)) return [];
  const trackers: string[] = [];

  const announce = asBytes(root.announce);
  if (announce) trackers.push(decodeText(announce));

  const announceList = root['announce-list'];
  if (Array.isArray(announceList)) {
    for (const tier of announceList) {
      if (!Array.isArray(tier)) continue;
      for (const item of tier) {
        const bytes = asBytes(item);
        if (bytes) trackers.push(decodeText(bytes));
      }
    }
  }
  return trackers;
}

function extractRootUrlList(root: BencodeValue): string[] {
  if (!isDict(root)) return [];
  return extractUrlList(root, 'url-list');
}

function extractUrlList(dict: { [key: string]: BencodeValue }, key: string): string[] {
  const value = dict[key];
  const single = asBytes(value);
  if (single) return [decodeText(single)];
  if (Array.isArray(value)) {
    return value.map((item) => asBytes(item)).filter((item): item is Uint8Array => item !== null).map(decodeText);
  }
  return [];
}

/** tracker URL 规范化：补默认端口，去掉两侧空白。 */
function normalizeTracker(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.toString();
  } catch {
    return '';
  }
}

export function isDict(value: BencodeValue | undefined): value is { [key: string]: BencodeValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

export function asBytes(value: BencodeValue | undefined): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** 某个 piece 在种子里的长度（最后一个 piece 通常不满）。 */
export function pieceSize(meta: Pick<TorrentMeta, 'pieceLength' | 'totalLength'>, index: number): number {
  return Math.min(meta.pieceLength, meta.totalLength - index * meta.pieceLength);
}

/** 覆盖指定 piece 的文件区间：文件序号与该 piece 在文件内的起始偏移。 */
export function pieceFileRanges(
  meta: TorrentMeta,
  pieceIndex: number
): Array<{ fileIndex: number; fileOffset: number; length: number }> {
  const start = pieceIndex * meta.pieceLength;
  const end = start + pieceSize(meta, pieceIndex);
  const ranges: Array<{ fileIndex: number; fileOffset: number; length: number }> = [];

  for (const file of meta.files) {
    const fileStart = file.offset;
    const fileEnd = file.offset + file.length;
    if (fileEnd <= start || fileStart >= end) continue;
    const from = Math.max(start, fileStart);
    const to = Math.min(end, fileEnd);
    ranges.push({ fileIndex: file.index, fileOffset: from - fileStart, length: to - from });
  }
  return ranges;
}

/** 某个文件覆盖到的 piece 区间（左闭右开）。 */
export function filePieceRange(meta: TorrentMeta, file: TorrentFile): { first: number; last: number } {
  const first = Math.floor(file.offset / meta.pieceLength);
  const last = Math.floor((file.offset + Math.max(file.length - 1, 0)) / meta.pieceLength);
  return { first, last };
}

/** 全部文件都为空时给个兜底判断，避免拿着无效种子空转。 */
export function hasContent(meta: TorrentMeta): boolean {
  return meta.totalLength > 0 && meta.files.some((file) => file.length > 0);
}
