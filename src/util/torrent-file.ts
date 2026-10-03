import { bdecode, buildMagnet, torrentInfoHash, type BencodeValue } from './bencode.js';

/**
 * 解析 .torrent 文件的 info 字典，取出文件名列表。
 *
 * 为什么需要这个：qBittorrent 通过磁力链接添加种子时，在拿到元数据之前
 * 是不知道里面有哪些文件的，因此无法在添加的瞬间用 filePrio 指定「只下第 3 集」。
 * 而合集动辄几十 GB，整包下载再删除会造成巨大的磁盘浪费。
 * 所以对于「只缺一两集但只找到合集」的情况，我们先自己拉一份 .torrent，
 * 解析出文件清单和 infohash，挑选目标文件，再把文件清单以 base64 形式
 * 直接喂给 /api/v2/torrents/add —— 这样 qBittorrent 立刻就有元数据，选择性下载才能生效。
 */

export type TorrentFileEntry = {
  /** 文件在种子里的序号，从 0 开始，与 filePrio 的 index 对应。 */
  index: number;
  /** 完整路径（多文件种子含目录）。 */
  path: string;
  /** 单个文件字节数。 */
  length: number;
};

export type TorrentMeta = {
  infoHash: string;
  name: string;
  files: TorrentFileEntry[];
  magnet: string;
};

function asBytes(value: BencodeValue | undefined): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function decode(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(value);
}

/** 从已解析的 info 字典里抽文件列表，兼容单文件与多文件两种形态。 */
export function extractFiles(info: BencodeValue): TorrentFileEntry[] {
  if (typeof info !== 'object' || info === null || Array.isArray(info) || info instanceof Uint8Array) return [];
  const dict = info as { [key: string]: BencodeValue };

  const filesValue = dict.files;
  if (Array.isArray(filesValue)) {
    const entries: TorrentFileEntry[] = [];
    let index = 0;
    for (const item of filesValue) {
      if (typeof item !== 'object' || item === null || Array.isArray(item) || item instanceof Uint8Array) continue;
      const file = item as { [key: string]: BencodeValue };
      const length = typeof file.length === 'number' ? file.length : null;
      const parts = Array.isArray(file.path) ? file.path.map((part) => asBytes(part)).filter((part): part is Uint8Array => part !== null) : [];
      if (length === null || parts.length === 0) continue;
      entries.push({
        index,
        path: parts.map((part) => decode(part)).join('/'),
        length
      });
      index += 1;
    }
    return entries;
  }

  // 单文件种子：文件名在 info.name
  const nameBytes = asBytes(dict.name);
  const length = typeof dict.length === 'number' ? dict.length : null;
  if (nameBytes && length !== null) {
    return [{ index: 0, path: decode(nameBytes), length }];
  }
  return [];
}

function extractTrackers(root: BencodeValue): string[] {
  const trackers: string[] = [];
  if (typeof root !== 'object' || root === null || Array.isArray(root) || root instanceof Uint8Array) return trackers;
  const announce = asBytes((root as { [key: string]: BencodeValue }).announce);
  if (announce) trackers.push(decode(announce));
  const announceList = (root as { [key: string]: BencodeValue })['announce-list'];
  if (Array.isArray(announceList)) {
    for (const tier of announceList) {
      if (!Array.isArray(tier)) continue;
      for (const item of tier) {
        const bytes = asBytes(item);
        if (bytes) trackers.push(decode(bytes));
      }
    }
  }
  return [...new Set(trackers)];
}

/** 解析整个 .torrent 文件。失败返回 null。 */
export function parseTorrent(buffer: Uint8Array): TorrentMeta | null {
  try {
    const root = bdecode(buffer);
    if (typeof root !== 'object' || root === null || Array.isArray(root) || root instanceof Uint8Array) return null;
    const info = (root as { [key: string]: BencodeValue }).info;
    if (!info) return null;

    const infoHash = torrentInfoHash(buffer);
    if (!infoHash) return null;

    const nameBytes = asBytes((info as { [key: string]: BencodeValue }).name);
    const name = nameBytes ? decode(nameBytes) : infoHash;
    const files = extractFiles(info);
    const trackers = extractTrackers(root);

    return {
      infoHash,
      name,
      files,
      magnet: buildMagnet(infoHash, name, trackers)
    };
  } catch {
    return null;
  }
}

/** 下载 .torrent 文件并解析。用于在推送前拿到文件清单。 */
export async function fetchTorrentMeta(
  url: string,
  options: { timeoutMs: number }
): Promise<TorrentMeta | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!response.ok) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    return parseTorrent(buffer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
