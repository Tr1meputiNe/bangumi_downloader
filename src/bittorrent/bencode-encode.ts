/**
 * bencode 编码。
 *
 * 解码在 util/bencode.ts（只为读 .torrent 而写），这里补上编码方向，
 * 因为 UDP tracker 的 announce 请求和 BEP 10 扩展握手都要往外发 bencode。
 * 字典的键必须按字节序升序排列，这是规范要求，某些 tracker 会因此拒绝请求。
 */

export type BencodeOut = number | string | Uint8Array | BencodeOut[] | { [key: string]: BencodeOut | undefined };

const encoder = new TextEncoder();

export function bencode(value: BencodeOut): Uint8Array {
  const chunks: Uint8Array[] = [];
  encodeInto(value, chunks);
  return concat(chunks);
}

function encodeInto(value: BencodeOut, chunks: Uint8Array[]): void {
  if (value === undefined || value === null) {
    throw new Error('bencode 不能编码 undefined/null');
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`bencode 不能编码非有限数字：${value}`);
    chunks.push(encoder.encode(`i${Math.trunc(value)}e`));
    return;
  }

  if (typeof value === 'string') {
    const bytes = encoder.encode(value);
    encodeBytes(bytes, chunks);
    return;
  }

  if (value instanceof Uint8Array) {
    encodeBytes(value, chunks);
    return;
  }

  if (Array.isArray(value)) {
    chunks.push(encoder.encode('l'));
    for (const item of value) encodeInto(item, chunks);
    chunks.push(encoder.encode('e'));
    return;
  }

  chunks.push(encoder.encode('d'));
  const keys = Object.keys(value).sort(compareBytes);
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    encodeBytes(encoder.encode(key), chunks);
    encodeInto(item, chunks);
  }
  chunks.push(encoder.encode('e'));
}

function encodeBytes(bytes: Uint8Array, chunks: Uint8Array[]): void {
  chunks.push(encoder.encode(`${bytes.length}:`));
  chunks.push(bytes);
}

/** 按字节序比较两个字符串，用于 bencode 字典键排序。 */
function compareBytes(a: string, b: string): number {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] as number) - (right[i] as number);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
