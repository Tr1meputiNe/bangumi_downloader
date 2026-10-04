import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metaFromInfoBytes, type TorrentMeta } from '../src/bittorrent/metainfo.js';
import { sanitizeSegment } from '../src/bittorrent/storage.js';
import { locateTorrent, verifyAll, verifyTorrent } from '../src/core/verify.js';

/**
 * 核对功能必须能在**实际落盘布局**里找到文件。
 *
 * 这一组测试是有来历的：下载内容改成归纳进 savePath/番剧/ 之后，
 * verify 还在按老布局（savePath/种子名）去找，于是已经下完的番
 * 全被报成「空壳」—— 屏幕上看起来像数据丢了。这里把三种布局都钉住：
 *   1. 多文件种子 + 番剧子目录（当前布局）
 *   2. 多文件种子 + 直接放下载根目录（旧布局，要兼容）
 *   3. 单文件种子 + 以发布标题命名的目录（目录名跟种子名不一样）
 */

function bencode(node: unknown): Buffer {
  const parts: Buffer[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'number') {
      parts.push(Buffer.from(`i${value}e`));
      return;
    }
    if (typeof value === 'string') {
      const bytes = Buffer.from(value, 'utf8');
      parts.push(Buffer.from(`${bytes.length}:`), bytes);
      return;
    }
    if (Buffer.isBuffer(value)) {
      parts.push(Buffer.from(`${value.length}:`), value);
      return;
    }
    if (Array.isArray(value)) {
      parts.push(Buffer.from('l'));
      for (const item of value) walk(item);
      parts.push(Buffer.from('e'));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      parts.push(Buffer.from('d'));
      for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        walk(key);
        walk(item);
      }
      parts.push(Buffer.from('e'));
    }
  };
  walk(node);
  return Buffer.concat(parts);
}

const PIECE = 16384;

type Built = {
  root: string;
  meta: TorrentMeta;
  /** 正确内容的字节。 */
  data: Buffer;
};

/** 造一个真实可校验的种子：内容 = 指定字节，分片哈希由内容算出。 */
function buildTorrent(options: {
  name: string;
  /** 多文件形态。 */
  files?: Array<{ path: string[]; length: number }>;
  /** 单文件形态（真实单文件种子里没有 files，只有 length）。 */
  length?: number;
  fill?: number;
}): { infoBytes: Buffer; meta: TorrentMeta; data: Buffer } {
  const single = options.files === undefined;
  const lengths = single ? [options.length ?? PIECE] : (options.files ?? []).map((file) => file.length);
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const data = Buffer.alloc(total, options.fill ?? 9);

  const pieces: Buffer[] = [];
  for (let offset = 0; offset < total; offset += PIECE) {
    pieces.push(createHash('sha1').update(data.subarray(offset, Math.min(offset + PIECE, total))).digest());
  }

  const common = { name: options.name, 'piece length': PIECE, pieces: Buffer.concat(pieces) };
  const info = single
    ? { ...common, length: total }
    : { ...common, files: (options.files ?? []).map((file) => ({ length: file.length, path: file.path })) };

  const infoBytes = bencode(info);
  const meta = metaFromInfoBytes(new Uint8Array(infoBytes));
  if (!meta) throw new Error('测试种子解析失败');

  return { infoBytes, meta, data };
}

function makeRoot(options: {
  name: string;
  files?: Array<{ path: string[]; length: number }>;
  length?: number;
}): Built {
  const { infoBytes, meta, data } = buildTorrent(options);
  const root = mkdtempSync(join(tmpdir(), 'verify-layout-'));
  mkdirSync(join(root, '.bangumi-meta'), { recursive: true });
  writeFileSync(join(root, '.bangumi-meta', `${meta.infoHash}.bin`), infoBytes);
  return { root, meta, data };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function track(root: string): string {
  roots.push(root);
  return root;
}

describe('核对：内容位置', () => {
  it('多文件种子在番剧子目录里能被正确核对（当前布局）', () => {
    const { root, meta } = makeRoot({
      name: '[BDrip] Test Show S01',
      files: [
        { path: ['01.mkv'], length: PIECE },
        { path: ['02.mkv'], length: PIECE }
      ]
    });
    track(root);

    const dir = join(root, '番剧', sanitizeSegment(meta.name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01.mkv'), Buffer.alloc(PIECE, 9));
    writeFileSync(join(dir, '02.mkv'), Buffer.alloc(PIECE, 9));

    const report = verifyTorrent(meta, root, { checkPlayable: false, seriesDir: '番剧' });
    expect(report.dir).toBe(dir);
    expect(report.dirExists).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.pieceDone).toBe(2);
    expect(report.empty).toBe(false);
  });

  it('旧布局（直接放在下载根目录）仍然能核对', () => {
    const { root, meta } = makeRoot({
      name: 'Legacy Show',
      files: [{ path: ['01.mkv'], length: PIECE }]
    });
    track(root);

    const dir = join(root, sanitizeSegment(meta.name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01.mkv'), Buffer.alloc(PIECE, 9));

    const report = verifyTorrent(meta, root, { checkPlayable: false, seriesDir: '番剧' });
    expect(report.complete).toBe(true);
    expect(report.dir).toBe(dir);
  });

  it('单文件种子的目录名是发布标题，也能靠文件名找到', () => {
    const { root, meta } = makeRoot({
      name: '[Group] Test Show - 01 [1080p].mkv',
      length: PIECE
    });
    track(root);
    expect(meta.singleFile).toBe(true);

    // 目录名是「发布标题」，而种子名只是文件名 —— 两者不一样
    const dir = join(root, '番剧', '[Group] Test Show - 01 [1080p][简繁]');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sanitizeSegment(meta.name)), Buffer.alloc(PIECE, 9));

    const location = locateTorrent(meta, root, '番剧');
    expect(location.dir).toBe(dir);
    expect(location.singleFileDir).toBe('[Group] Test Show - 01 [1080p][简繁]');

    const report = verifyTorrent(meta, root, { checkPlayable: false, seriesDir: '番剧' });
    expect(report.complete).toBe(true);
  });

  it('预分配的空壳：目录在、文件大小对，但一个分片都没成', () => {
    const { root, meta } = makeRoot({
      name: 'Empty Shell Show',
      files: [{ path: ['01.mkv'], length: PIECE }]
    });
    track(root);

    const dir = join(root, '番剧', sanitizeSegment(meta.name));
    mkdirSync(dir, { recursive: true });
    // 预分配到完整长度，但内容是零 —— 文件大小完全看不出来
    writeFileSync(join(dir, '01.mkv'), Buffer.alloc(PIECE, 0));

    const report = verifyTorrent(meta, root, { checkPlayable: false, seriesDir: '番剧' });
    expect(report.dirExists).toBe(true);
    expect(report.empty).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.presentFiles).toBe(1);
    expect(report.nominalBytes).toBe(PIECE);
  });

  it('还没下过：目录不存在，报告里指出找的是哪儿', () => {
    const { root, meta } = makeRoot({ name: 'Not Downloaded', files: [{ path: ['01.mkv'], length: PIECE }] });
    track(root);

    const report = verifyTorrent(meta, root, { checkPlayable: false, seriesDir: '番剧' });
    expect(report.dirExists).toBe(false);
    expect(report.empty).toBe(true);
    expect(report.dir).toContain('番剧');
  });
});

describe('核对：清理空壳', () => {
  it('只删真正空壳的那个目录，下完的和一半的都不动', async () => {
    const good = makeRoot({ name: 'Good Show', files: [{ path: ['01.mkv'], length: PIECE }] });
    const half = makeRoot({ name: 'Half Show', files: [{ path: ['01.mkv'], length: PIECE * 2 }] });
    const shell = makeRoot({ name: 'Shell Show', files: [{ path: ['01.mkv'], length: PIECE }] });
    const root = track(good.root);
    // 三个种子共用一个下载根目录
    for (const built of [half, shell]) {
      mkdirSync(join(root, '.bangumi-meta'), { recursive: true });
      writeFileSync(join(root, '.bangumi-meta', `${built.meta.infoHash}.bin`), (built.meta as TorrentMeta).infoBytes);
      roots.push(built.root);
    }

    const goodDir = join(root, '番剧', sanitizeSegment(good.meta.name));
    const halfDir = join(root, '番剧', sanitizeSegment(half.meta.name));
    const shellDir = join(root, '番剧', sanitizeSegment(shell.meta.name));
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(halfDir, { recursive: true });
    mkdirSync(shellDir, { recursive: true });

    writeFileSync(join(goodDir, '01.mkv'), Buffer.alloc(PIECE, 9)); // 完整
    writeFileSync(join(halfDir, '01.mkv'), Buffer.concat([Buffer.alloc(PIECE, 9), Buffer.alloc(PIECE, 0)])); // 一半
    writeFileSync(join(shellDir, '01.mkv'), Buffer.alloc(PIECE, 0)); // 空壳

    const result = await verifyAll({ savePath: root, seriesDir: '番剧', cleanEmpty: true, checkPlayable: false });

    expect(existsSync(goodDir)).toBe(true);
    expect(existsSync(halfDir)).toBe(true);
    expect(existsSync(shellDir)).toBe(false);
    expect(result.removed).toEqual([shellDir]);

    const shellReport = result.reports.find((report) => report.name === 'Shell Show');
    expect(shellReport?.empty).toBe(true);
    const halfReport = result.reports.find((report) => report.name === 'Half Show');
    expect(halfReport?.pieceDone).toBe(1);
    expect(halfReport?.complete).toBe(false);
  });
});
