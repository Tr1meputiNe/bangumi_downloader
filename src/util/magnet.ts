import { createHash } from 'node:crypto';

/**
 * 计算磁力链接的 infohash（40 位小写 hex），用于跨轮次去重。
 * BitTorrent v1 的 btih 既可能是 40 位 hex 也可能是 32 位 base32。
 */
export function magnetInfoHash(magnet: string): string | null {
  const match = /xt=urn:btih:([A-Za-z0-9]+)/i.exec(magnet);
  if (!match?.[1]) return null;
  const value = match[1];
  if (/^[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (/^[A-Za-z2-7]{32}$/.test(value)) return base32ToHex(value);
  return null;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32（RFC4648，无填充）转 hex。 */
export function base32ToHex(input: string): string | null {
  const value = input.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of value) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  if (bytes.length !== 20) return null;
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 由磁力链接构造一个稳定的 key，缺少 infohash 时退回标题哈希。 */
export function releaseKey(magnetOrTitle: string): string {
  const infoHash = magnetInfoHash(magnetOrTitle);
  if (infoHash) return infoHash;
  return createHash('sha1').update(magnetOrTitle).digest('hex');
}

/** 生成 qBittorrent 需要的标准磁力链接（补上 dn 显示名）。 */
export function withDisplayName(magnet: string, displayName: string): string {
  if (/[?&]dn=/i.test(magnet)) return magnet;
  const separator = magnet.includes('?') ? '&' : '?';
  return `${magnet}${separator}dn=${encodeURIComponent(displayName)}`;
}
