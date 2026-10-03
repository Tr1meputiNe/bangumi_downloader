import { createHash } from 'node:crypto';

/**
 * 极简 bencode 解析，只为从 .torrent 文件里取出 info 字典的原始字节并算 infohash。
 * 不引入第三方库是为了让最终产物保持零依赖、能打成单文件 exe。
 */

export type BencodeValue = number | Uint8Array | BencodeValue[] | { [key: string]: BencodeValue };

type ParseResult = { value: BencodeValue; next: number };

function parseAt(buffer: Uint8Array, offset: number): ParseResult {
  const marker = buffer[offset];
  if (marker === undefined) throw new Error('bencode 数据意外结束');

  if (marker === 0x69) {
    // 'i' 整数
    const end = buffer.indexOf(0x65, offset + 1);
    if (end < 0) throw new Error('bencode 整数缺少结束符');
    const text = new TextDecoder().decode(buffer.subarray(offset + 1, end));
    return { value: Number.parseInt(text, 10), next: end + 1 };
  }

  if (marker === 0x6c) {
    // 'l' 列表
    const list: BencodeValue[] = [];
    let cursor = offset + 1;
    while (buffer[cursor] !== 0x65) {
      if (cursor >= buffer.length) throw new Error('bencode 列表未闭合');
      const parsed = parseAt(buffer, cursor);
      list.push(parsed.value);
      cursor = parsed.next;
    }
    return { value: list, next: cursor + 1 };
  }

  if (marker === 0x64) {
    // 'd' 字典
    const dict: { [key: string]: BencodeValue } = {};
    let cursor = offset + 1;
    while (buffer[cursor] !== 0x65) {
      if (cursor >= buffer.length) throw new Error('bencode 字典未闭合');
      const key = parseAt(buffer, cursor);
      if (!(key.value instanceof Uint8Array)) throw new Error('bencode 字典的键必须是字符串');
      const value = parseAt(buffer, key.next);
      dict[new TextDecoder().decode(key.value)] = value.value;
      cursor = value.next;
    }
    return { value: dict, next: cursor + 1 };
  }

  if (marker >= 0x30 && marker <= 0x39) {
    // 字符串：<长度>:<内容>
    const colon = buffer.indexOf(0x3a, offset);
    if (colon < 0) throw new Error('bencode 字符串缺少冒号');
    const length = Number.parseInt(new TextDecoder().decode(buffer.subarray(offset, colon)), 10);
    if (!Number.isFinite(length) || length < 0) throw new Error('bencode 字符串长度非法');
    const start = colon + 1;
    const end = start + length;
    if (end > buffer.length) throw new Error('bencode 字符串越界');
    return { value: buffer.subarray(start, end), next: end };
  }

  throw new Error(`bencode 遇到未知标记 0x${marker.toString(16)}`);
}

/** 解析完整的 bencode 数据。 */
export function bdecode(buffer: Uint8Array): BencodeValue {
  const { value } = parseAt(buffer, 0);
  return value;
}

/**
 * 计算 .torrent 文件的 infohash：对整个 info 字典（含首尾标记）做 SHA1。
 * 返回 40 位小写 hex；文件不合法时返回 null。
 */
export function torrentInfoHash(buffer: Uint8Array): string | null {
  try {
    // 顶层必须是字典，定位到 "4:infod" 后重新解析该位置以拿到纯净的 info 切片。
    const needle = new TextEncoder().encode('4:infod');
    const index = indexOfBytes(buffer, needle);
    if (index < 0) return null;
    const infoStart = index + '4:info'.length;
    if (buffer[infoStart] !== 0x64) return null;
    const { next } = parseAt(buffer, infoStart);
    const infoBytes = buffer.subarray(infoStart, next);
    return createHash('sha1').update(infoBytes).digest('hex');
  } catch {
    return null;
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

/** 生成磁力链接。 */
export function buildMagnet(infoHash: string, displayName: string, trackers: string[] = []): string {
  const params = [`xt=urn:btih:${infoHash}`, `dn=${encodeURIComponent(displayName)}`];
  for (const tracker of trackers) {
    params.push(`tr=${encodeURIComponent(tracker)}`);
  }
  return `magnet:?${params.join('&')}`;
}
