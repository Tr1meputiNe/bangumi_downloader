/** 对单个 infohash 起引擎实测，看 N 秒内实际拿到多少数据。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TorrentDownloader } from '../src/bittorrent/downloader.js';
import { formatSize } from '../src/util/text.js';

const magnet = process.argv[2] as string;
const seconds = Number.parseInt(process.argv[3] ?? '90', 10);
const dir = mkdtempSync(join(tmpdir(), 'bt-one-'));

let bytes = 0;
let peers = 0;
let pieces = 0;
let name = '';
let total = 0;
let metaOk = false;

const downloader = new TorrentDownloader({
  magnet,
  savePath: dir,
  timeoutMs: seconds * 1000,
  stallTimeoutMs: seconds * 1000,
  onMetadata: (meta) => {
    metaOk = true;
    name = meta.name;
    total = meta.totalLength;
    console.log(`元数据 OK：《${meta.name}》${meta.files.length} 个文件，共 ${formatSize(meta.totalLength)}`);
  },
  onProgress: (progress) => {
    bytes = progress.downloadedBytes;
    peers = progress.peers;
    pieces = progress.piecesDone;
  }
});

const started = Date.now();
await downloader.download().catch((error: unknown) => console.log(`提前结束：${(error as Error).message}`));
const elapsed = (Date.now() - started) / 1000;

console.log(`\n${metaOk ? '' : '元数据未取到；'}实测 ${elapsed.toFixed(0)} 秒：拿到 ${formatSize(bytes)}，分片 ${pieces}，peer ${peers}，均速 ${(bytes / 1024 / elapsed).toFixed(0)} KB/s`);
rmSync(dir, { recursive: true, force: true });
