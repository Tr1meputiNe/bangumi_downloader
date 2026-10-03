import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { bdecode, buildMagnet, torrentInfoHash } from '../src/util/bencode.js';
import { parseTorrent } from '../src/util/torrent-file.js';
import { base32ToHex, magnetInfoHash, releaseKey } from '../src/util/magnet.js';

/** 最小的 bencode 编码器，用来在测试里生成合法的 .torrent 夹具。 */
function bencode(value: number | string | Uint8Array | unknown[] | Record<string, unknown>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const push = (bytes: Uint8Array) => parts.push(bytes);

  const walk = (node: unknown): void => {
    if (typeof node === 'number') {
      push(enc.encode(`i${node}e`));
      return;
    }
    if (typeof node === 'string') {
      const bytes = enc.encode(node);
      push(enc.encode(`${bytes.length}:`));
      push(bytes);
      return;
    }
    if (node instanceof Uint8Array) {
      push(enc.encode(`${node.length}:`));
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      push(enc.encode('l'));
      for (const item of node) walk(item);
      push(enc.encode('e'));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      push(enc.encode('d'));
      // bencode 要求字典键按字节序升序排列
      const entries = Object.entries(node as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [key, value] of entries) {
        walk(key);
        walk(value);
      }
      push(enc.encode('e'));
      return;
    }
    throw new Error(`无法编码的类型：${typeof node}`);
  };

  walk(value);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeSingleFileTorrent(name: string, length: number): Uint8Array {
  return bencode({
    announce: 'http://tracker.test/announce',
    info: {
      length,
      name,
      'piece length': 16384,
      pieces: new Uint8Array(20).fill(0x61)
    }
  });
}

/**
 * 独立的 info 字典切片实现（不引用被测代码）。
 * 按 bencode 语法逐字节前进，跳过字符串内容，
 * 因此字符串里出现的 'd'/'e' 不会被误当成结构标记。
 */
function sliceInfoDict(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder('latin1').decode(bytes);
  const start = text.indexOf('4:infod');
  expect(start).toBeGreaterThanOrEqual(0);
  const dictStart = start + '4:info'.length;

  let cursor = dictStart;
  const skipValue = (): void => {
    const marker = text[cursor]!;
    if (marker === 'i') {
      cursor = text.indexOf('e', cursor) + 1;
      return;
    }
    if (marker === 'l' || marker === 'd') {
      const closer = marker === 'l' ? 'e' : 'e';
      cursor += 1;
      while (text[cursor] !== closer) skipValue();
      cursor += 1;
      return;
    }
    // 字符串：<长度>:<内容>
    const colon = text.indexOf(':', cursor);
    const length = Number.parseInt(text.slice(cursor, colon), 10);
    cursor = colon + 1 + length;
  };

  expect(text[cursor]).toBe('d');
  cursor += 1;
  while (text[cursor] !== 'e') {
    skipValue(); // 键
    skipValue(); // 值
  }
  cursor += 1;
  return bytes.subarray(dictStart, cursor);
}

describe('bencode', () => {
  it('解析整数、字符串、列表、字典', () => {
    const enc = new TextEncoder();
    const value = bdecode(enc.encode('d1:ai1e1:b3:xyze1:cli1ei2eee'));
    expect(value).toMatchObject({ a: 1 });
    expect((value as Record<string, unknown>).b).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode((value as { b: Uint8Array }).b)).toBe('xyz');
  });

  it('从 .torrent 中算出 infohash（与独立实现一致）', () => {
    const bytes = makeSingleFileTorrent('test.mkv', 1234);
    const hash = torrentInfoHash(bytes);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);

    // 独立实现：不依赖被测模块，用字符级扫描截取 info 字典的字节
    const expected = createHash('sha1').update(sliceInfoDict(bytes)).digest('hex');
    expect(hash).toBe(expected);
  });

  it('非法数据返回 null', () => {
    expect(torrentInfoHash(new TextEncoder().encode('not a torrent'))).toBeNull();
  });

  it('buildMagnet 输出标准磁力链接', () => {
    const magnet = buildMagnet('a'.repeat(40), '葬送的芙莉莲 第05集', ['http://t.test/announce']);
    expect(magnet).toContain(`xt=urn:btih:${'a'.repeat(40)}`);
    expect(magnet).toContain('dn=');
    expect(magnet).toContain('tr=');
  });
});

describe('parseTorrent', () => {
  it('解析单文件种子的文件名与大小', () => {
    const bytes = makeSingleFileTorrent('Sousou no Frieren - 05.mkv', 536870912);
    const meta = parseTorrent(bytes);
    expect(meta).not.toBeNull();
    expect(meta!.files.length).toBe(1);
    expect(meta!.files[0]!.path).toBe('Sousou no Frieren - 05.mkv');
    expect(meta!.files[0]!.length).toBe(536870912);
    expect(meta!.infoHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('解析多文件合集的目录结构', () => {
    const bytes = bencode({
      announce: 'http://tracker.test/announce',
      info: {
        files: [
          { length: 100, path: ['Frieren 01', 'ep01.mkv'] },
          { length: 200, path: ['Frieren 01', 'ep02.mkv'] }
        ],
        name: 'Frieren 01',
        'piece length': 16384,
        pieces: new Uint8Array(20).fill(0x62)
      }
    });
    const meta = parseTorrent(bytes);
    expect(meta).not.toBeNull();
    expect(meta!.files.length).toBe(2);
    expect(meta!.files[0]!.path).toBe('Frieren 01/ep01.mkv');
    expect(meta!.files[1]!.path).toBe('Frieren 01/ep02.mkv');
    expect(meta!.files[1]!.index).toBe(1);
  });
});

describe('magnet utils', () => {
  it('解析 40 位 hex infohash', () => {
    const hash = 'abcdef0123456789abcdef0123456789abcdef01';
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${hash}&dn=x`)).toBe(hash);
  });

  it('base32 转 hex 结果长度为 40', () => {
    // 20 字节已知数据的 base32 编码
    const hex = '0123456789abcdef0123456789abcdef01234567';
    const bytes = Buffer.from(hex, 'hex');
    const base32 = base32Encode(bytes);
    expect(base32ToHex(base32)).toBe(hex);
  });

  it('releaseKey 对无 infohash 的输入返回稳定哈希', () => {
    const a = releaseKey('random title');
    const b = releaseKey('random title');
    expect(a).toBe(b);
    expect(a.length).toBe(40);
  });
});

function base32Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += alphabet[Number.parseInt(bits.slice(i, i + 5), 2)];
  }
  return output;
}
