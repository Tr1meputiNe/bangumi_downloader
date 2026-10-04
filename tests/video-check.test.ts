import { describe, expect, it, afterEach } from 'vitest';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVideoFile, isVideoFile } from '../src/core/video-check.js';

/**
 * 这些用例全部来自真实踩过的坑：
 *   - 预分配的空壳（大小对、内容全零）被当成下好了
 *   - MP4 缺 moov，播放器直接拒绝
 *   - 用别的下载器留下的半成品
 */

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'video-check-'));
  dirs.push(dir);
  return dir;
}

/** 造一个「预分配到指定长度、但内容是零」的文件——正是断点续传留下的形态。 */
function makeSparse(path: string, size: number, header?: Buffer): void {
  writeFileSync(path, Buffer.alloc(0));
  const fd = openSync(path, 'w+');
  ftruncateSync(fd, size);
  if (header) writeSync(fd, header, 0, header.length, 0);
  closeSync(fd);
}

function mkHeader(kind: 'mkv' | 'mp4'): Buffer {
  const head = Buffer.alloc(64);
  if (kind === 'mkv') {
    head[0] = 0x1a; head[1] = 0x45; head[2] = 0xdf; head[3] = 0xa3;
    head.write('matroska', 8, 'latin1');
  } else {
    head.write('ftypisom', 4, 'latin1');
  }
  return head;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('isVideoFile', () => {
  it('认识常见的视频后缀', () => {
    expect(isVideoFile('a.mkv')).toBe(true);
    expect(isVideoFile('a.MP4')).toBe(true);
    expect(isVideoFile('a.ass')).toBe(false);
    expect(isVideoFile('a.torrent')).toBe(false);
  });
});

describe('checkVideoFile', () => {
  it('全是零的预分配空壳：判定为 empty、不可播', () => {
    const dir = tempDir();
    const file = join(dir, 'empty.mkv');
    makeSparse(file, 8 * 1024 * 1024); // 8MB 的零

    const check = checkVideoFile(file);
    expect(check.issues).toContain('empty');
    expect(check.playable).toBe(false);
  });

  it('只有头部有魔数、其余全零：必须判定为 empty（最容易骗过人的情况）', () => {
    const dir = tempDir();
    const file = join(dir, 'header-only.mkv');
    makeSparse(file, 8 * 1024 * 1024, mkHeader('mkv'));

    const check = checkVideoFile(file);
    expect(check.container).toBe('mkv');
    // 关键：文件头那几十个字节让非零率不严格为 0，但它仍然是空壳
    expect(check.issues).toContain('empty');
    expect(check.playable).toBe(false);
  });

  it('下了一部分（中间有数据、其余为零）：不是空壳，可播', () => {
    const dir = tempDir();
    const file = join(dir, 'partial.mkv');
    makeSparse(file, 8 * 1024 * 1024, mkHeader('mkv'));

    // 写 1MB：真实半成品的规模，足以让任何一个采样窗口采到
    const payload = Buffer.alloc(1024 * 1024, 0x55);
    const fd = openSync(file, 'r+');
    const written = writeSync(fd, payload, 0, payload.length, 4 * 1024 * 1024);
    closeSync(fd);
    expect(written).toBe(payload.length);

    const check = checkVideoFile(file);
    // 关键：不能因为「头部之外不是满的」就判成空壳 —— 这段数据是真的
    expect(check.issues).not.toContain('empty');
    expect(check.issues).not.toContain('bad-container');
    expect(check.playable).toBe(true);
  });

  it('数据量极少（刚开头就断了）：标记为 sparse', () => {
    const dir = tempDir();
    const file = join(dir, 'scattered.mkv');
    makeSparse(file, 32 * 1024 * 1024, mkHeader('mkv'));

    // 32MB 里只写 128KB：超过了「空壳」的下限（4KB），但明显没下完
    const fd = openSync(file, 'r+');
    writeSync(fd, Buffer.alloc(128 * 1024, 0x66), 0, 128 * 1024, 16 * 1024 * 1024);
    closeSync(fd);

    const check = checkVideoFile(file);
    expect(check.issues).not.toContain('empty');
    expect(check.issues).toContain('sparse');
  });

  it('有一定数据量时不报「稀疏」（宁可只报事实，也不误报）', () => {
    const dir = tempDir();
    const file = join(dir, 'six-percent.mkv');
    makeSparse(file, 16 * 1024 * 1024, mkHeader('mkv'));

    // 约 6% 密度：真实视频文件也可能长这样，不该报警
    const chunk = Buffer.alloc(64 * 1024, 0x66);
    const fd = openSync(file, 'r+');
    for (let i = 1; i <= 15; i += 1) writeSync(fd, chunk, 0, chunk.length, i * 1024 * 1024);
    closeSync(fd);

    const check = checkVideoFile(file);
    expect(check.issues).not.toContain('empty');
    expect(check.issues).not.toContain('sparse');
    expect(check.playable).toBe(true);
  });

  it('真实比例的半成品（覆盖率 10%）不会被误判为空壳', () => {
    const dir = tempDir();
    const file = join(dir, 'tenth.mkv');
    // 8MB 的文件里写满前 800KB，其余为零 —— 相当于下到 10% 就断了
    const data = Buffer.alloc(800 * 1024, 0x77);
    mkHeader('mkv').copy(data, 0);
    writeFileSync(file, data);
    const fd = openSync(file, 'r+');
    ftruncateSync(fd, 8 * 1024 * 1024);
    closeSync(fd);

    const check = checkVideoFile(file);
    expect(check.issues).not.toContain('empty');
    expect(check.playable).toBe(true);
  });

  it('MKV 有真实数据：结构正常、可播', () => {
    const dir = tempDir();
    const file = join(dir, 'good.mkv');
    const data = Buffer.alloc(4 * 1024 * 1024);
    data.fill(0x42);
    mkHeader('mkv').copy(data, 0);
    writeFileSync(file, data);

    const check = checkVideoFile(file);
    expect(check.container).toBe('mkv');
    expect(check.issues).toEqual([]);
    expect(check.playable).toBe(true);
    expect(check.dataRatio).toBeGreaterThan(0.9);
  });

  it('MP4 缺 moov：标记出来（播放器多半打不开）', () => {
    const dir = tempDir();
    const file = join(dir, 'no-moov.mp4');
    const data = Buffer.alloc(2 * 1024 * 1024);
    data.fill(0x11);
    mkHeader('mp4').copy(data, 0);
    writeFileSync(file, data);

    const check = checkVideoFile(file);
    expect(check.container).toBe('mp4');
    expect(check.issues).toContain('missing-moov');
  });

  it('MP4 带 moov：不报问题', () => {
    const dir = tempDir();
    const file = join(dir, 'with-moov.mp4');
    const data = Buffer.alloc(2 * 1024 * 1024);
    data.fill(0x11);
    mkHeader('mp4').copy(data, 0);
    data.write('moov', 200, 'latin1');
    writeFileSync(file, data);

    const check = checkVideoFile(file);
    expect(check.issues).not.toContain('missing-moov');
    expect(check.playable).toBe(true);
  });

  it('认不出的文件头：判定为 bad-container', () => {
    const dir = tempDir();
    const file = join(dir, 'weird.mkv');
    const data = Buffer.alloc(1024 * 1024);
    data.fill(0x33);
    writeFileSync(file, data);

    const check = checkVideoFile(file);
    expect(check.issues).toContain('bad-container');
  });

  it('零字节文件：empty 且不崩', () => {
    const dir = tempDir();
    const file = join(dir, 'zero.mkv');
    writeFileSync(file, Buffer.alloc(0));

    const check = checkVideoFile(file);
    expect(check.sizeBytes).toBe(0);
    expect(check.issues).toContain('empty');
  });

  it('文件不存在：unreadable 且不抛异常', () => {
    const dir = tempDir();
    const check = checkVideoFile(join(dir, 'nope.mkv'));
    expect(check.issues).toContain('unreadable');
    expect(check.playable).toBe(false);
  });
});
