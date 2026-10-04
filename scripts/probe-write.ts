/**
 * 验证「引擎说写了」和「磁盘上真有」是否一致。
 *
 * 用法：npx tsx scripts/probe-write.ts <磁力> <秒数>
 * 跑完后直接读回分片位置算 SHA1，和种子里的哈希比 —— 不信 statSync，
 * 只看内容（Windows 上稀疏文件的 size 会骗人）。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TorrentDownloader } from '../src/bittorrent/downloader.js';
import { pieceSize } from '../src/bittorrent/metainfo.js';
import type { TorrentMeta } from '../src/bittorrent/metainfo.js';

const magnet = process.argv[2] as string;
const seconds = Number.parseInt(process.argv[3] ?? '60', 10);
const dir = mkdtempSync(join(tmpdir(), 'bt-write-'));

let meta: TorrentMeta | null = null;
let reported = 0;

const downloader = new TorrentDownloader({
  magnet,
  savePath: dir,
  timeoutMs: seconds * 1000,
  stallTimeoutMs: seconds * 1000,
  onMetadata: (m) => {
    meta = m;
    console.log(`元数据：《${m.name}》${m.pieceCount} 个分片，pieceLength=${m.pieceLength}`);
  },
  onProgress: (p) => {
    reported = p.piecesDone;
  }
});

await downloader.download().catch((error: unknown) => console.log(`提前结束：${(error as Error).message}`));

if (!meta) {
  console.log('没拿到元数据，无法校验');
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

// 用引擎自己的 resumeScan 判断「磁盘上真正通过校验的分片有几个」
const { TorrentStorage } = await import('../src/bittorrent/storage.js');
const storage = new TorrentStorage(meta, { savePath: dir });
const reused = storage.resumeScan();
console.log(`引擎本轮报告完成 ${reported} 个分片；重新扫描磁盘后通过校验的有 ${reused} 个`);

// 再手工抽查前面几个分片，独立确认扫描结果可信（不依赖引擎自己的判断）
const { pieceFileRanges } = await import('../src/bittorrent/metainfo.js');
for (const pieceIndex of [0, 1, 2]) {
  const size = pieceSize(meta, pieceIndex);
  if (size <= 0) continue;
  const buf = Buffer.alloc(size);
  let cursor = 0;
  for (const range of pieceFileRanges(meta, pieceIndex)) {
    const entry = storage.files[range.fileIndex];
    if (!entry || entry.fd === null) {
      cursor = -1;
      break;
    }
    readSync(entry.fd, buf, cursor, range.length, range.fileOffset);
    cursor += range.length;
  }
  if (cursor < 0) {
    console.log(`  分片 ${pieceIndex}：文件句柄不可用`);
    continue;
  }
  const expected = meta.pieceHashes[pieceIndex];
  const actual = createHash('sha1').update(buf).digest();
  const ok = expected ? Buffer.from(expected).equals(actual) : false;
  console.log(`  独立复核分片 ${pieceIndex} 整片：${ok ? '✅ 磁盘内容正确' : '❌ 磁盘内容是空的或错的'}`);
}
storage.close();

rmSync(dir, { recursive: true, force: true });
