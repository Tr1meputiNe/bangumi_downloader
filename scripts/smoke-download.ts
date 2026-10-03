/**
 * 下载冒烟测试：搜索 → 取一个候选 → 用内置 BT 引擎真的拉下来。
 *
 * 只用于开发期验证，不进产物。参数：
 *   npx tsx scripts/smoke-download.ts "关键词" [文件序号,文件序号] [savePath]
 */
import { loadConfig } from '../src/config.js';
import { searchAndRank } from '../src/core/search.js';
import { TorrentDownloader } from '../src/bittorrent/downloader.js';
import { formatSize } from '../src/util/text.js';

const query = process.argv[2] ?? '吹响上低音号';
const selected = process.argv[3]
  ? process.argv[3].split(',').map((item) => Number.parseInt(item.trim(), 10)).filter((item) => Number.isFinite(item))
  : [];
const savePath = process.argv[4] ?? '/tmp/bt-smoke';

let magnetUri: string;
let label: string;

if (query.startsWith('magnet:')) {
  // 直接喂磁力：用于单独验证下载引擎，不走搜索
  magnetUri = query;
  label = '（命令行直接给定磁力）';
} else {
  const config = loadConfig({ configPath: process.env.SMOKE_CONFIG ?? './config.json' }).config;
  const result = await searchAndRank({ query, config, mode: 'manual' });
  console.log(`搜索到 ${result.ranked.length} 条候选`);
  const usable = result.ranked.filter((item) => !item.rejected && item.result.magnet);
  const candidate = usable.find((item) => (item.result.sizeBytes ?? 0) > 0) ?? usable[0];
  if (!candidate) {
    console.error('没有可用候选');
    process.exit(1);
  }
  magnetUri = candidate.result.magnet;
  label = candidate.result.title;
  console.log(`  来源：${candidate.result.tracker}｜体积：${formatSize(candidate.result.sizeBytes)}｜做种：${candidate.result.seederCount ?? '?'}`);
}

console.log(`选中：${label}`);
console.log(`  磁力：${magnetUri.slice(0, 120)}…`);
console.log(`  保存到：${savePath}${selected.length > 0 ? `（只取文件 ${selected.join(',')}）` : ''}`);

let lastLog = 0;
const downloader = new TorrentDownloader({
  magnet: magnetUri,
  savePath,
  selectedFiles: selected.length > 0 ? selected : undefined,
  timeoutMs: 20 * 60_000,
  stallTimeoutMs: 120_000,
  onLog: (message) => console.log(`[engine] ${message}`),
  onMetadata: (meta) => {
    console.log(`[元数据] 《${meta.name}》共 ${meta.files.length} 个文件，${formatSize(meta.totalLength)}`);
    meta.files.slice(0, 30).forEach((file) => console.log(`   #${file.index} ${formatSize(file.length).padStart(9)}  ${file.path}`));
  },
  onProgress: (progress) => {
    const now = Date.now();
    if (now - lastLog < 5_000) return;
    lastLog = now;
    const eta = progress.etaSeconds === null ? '?' : `${Math.round(progress.etaSeconds)}s`;
    console.log(
      `[进度] ${(progress.ratio * 100).toFixed(1)}%  ` +
        `${formatSize(progress.downloadedBytes)}/${formatSize(progress.totalBytes)}  ` +
        `${formatSize(progress.speed)}/s  peer=${progress.peers}  eta=${eta}  ` +
        `piece ${progress.piecesDone}/${progress.piecesTotal}`
    );
  }
});

const outcome = await downloader.download();
console.log('=== 下载完成 ===');
console.log(`infohash: ${outcome.infoHash}`);
console.log(`名称：${outcome.name}`);
console.log(`文件：${outcome.files.length} 个，共 ${formatSize(outcome.bytesWritten)}`);
for (const file of outcome.files.slice(0, 20)) console.log(`  · ${file}`);
console.log(`用时：${(outcome.elapsedMs / 1000).toFixed(1)} 秒`);
