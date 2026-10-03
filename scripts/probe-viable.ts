/**
 * 实测「这条种子能不能真的下动」。
 *
 * 握手成功不等于能拿到数据，所以这里直接起引擎跑一小段时间，看它到底
 * 拿到了多少字节 —— 这是唯一可信的判据。
 *
 * 用法：npx tsx scripts/probe-viable.ts <关键词> [每条观察秒数] [最多几条候选]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { searchAndRank } from '../src/core/search.js';
import { TorrentDownloader } from '../src/bittorrent/downloader.js';
import { formatSize } from '../src/util/text.js';

const query = process.argv[2] ?? '吹响上低音号';
const observeSeconds = Number.parseInt(process.argv[3] ?? '75', 10);
const limit = Number.parseInt(process.argv[4] ?? '6', 10);

const config = loadConfig({ configPath: './config.json' }).config;
const result = await searchAndRank({ query, config, mode: 'manual' });

// 只看「整季」的候选：明确合集，或标题里没有单集号的那种整季发布
const batches = result.ranked
  .filter((item) => !item.rejected && item.result.magnet)
  .filter((item) => item.parsed.kind !== 'single')
  .slice(0, limit);

console.log(`关键词「${query}」，取 ${batches.length} 条整季候选做实测\n`);

for (const [index, candidate] of batches.entries()) {
  const dir = mkdtempSync(join(tmpdir(), 'bt-viable-'));
  let bytes = 0;
  let peers = 0;
  let metaOk = false;
  let metaName = '';
  let metaSize = 0;

  const downloader = new TorrentDownloader({
    magnet: candidate.result.magnet,
    savePath: dir,
    timeoutMs: observeSeconds * 1000,
    stallTimeoutMs: observeSeconds * 1000,
    onMetadata: (meta) => {
      metaOk = true;
      metaName = meta.name;
      metaSize = meta.totalLength;
    },
    onProgress: (progress) => {
      bytes = progress.downloadedBytes;
      peers = progress.peers;
    }
  });

  const started = Date.now();
  await downloader.download().catch(() => undefined);
  const elapsed = (Date.now() - started) / 1000;

  const flag = bytes > 0 ? '✅' : metaOk ? '⚠️ ' : '❌';
  console.log(
    `${flag} ${String(index + 1).padStart(2)}. ${formatSize(bytes)} / ${formatSize(candidate.result.sizeBytes)}` +
      `（${(bytes / 1024 / elapsed).toFixed(0)} KB/s，peer ${peers}）${metaOk ? '' : ' 元数据都没拿到'}`
  );
  console.log(`      ${candidate.result.title.slice(0, 76)}`);
  if (metaOk) console.log(`      实际内容：《${metaName}》${formatSize(metaSize)}`);
  console.log(`      ${candidate.result.magnet.slice(7, 47)}`);

  rmSync(dir, { recursive: true, force: true });
}
