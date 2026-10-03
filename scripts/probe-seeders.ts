/**
 * 给搜索结果里每条候选做一次 tracker announce，看真实做种数，
 * 用来判断哪条种子是活的（搜索结果里的 seederCount 经常是空的）。
 *
 * 用法：npx tsx scripts/probe-seeders.ts "关键词" [最多测几条]
 */
import { loadConfig } from '../src/config.js';
import { searchAndRank } from '../src/core/search.js';
import { announce } from '../src/bittorrent/tracker.js';
import { parseMagnet } from '../src/bittorrent/metainfo.js';
import { generatePeerId, hexToBytes } from '../src/bittorrent/peer.js';
import { formatSize } from '../src/util/text.js';

const query = process.argv[2] ?? '吹响上低音号 第三季';
const limit = Number.parseInt(process.argv[3] ?? '8', 10);

const config = loadConfig({ configPath: './config.json' }).config;
const result = await searchAndRank({ query, config, mode: 'manual' });

const candidates = result.ranked.filter((item) => !item.rejected && item.result.magnet).slice(0, limit);
const peerId = generatePeerId();

/** 公共 tracker，够用来探活。 */
const PROBE_TRACKERS = [
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'http://nyaa.tracker.wf:7777/announce'
];

for (const [index, candidate] of candidates.entries()) {
  const magnet = parseMagnet(candidate.result.magnet);
  if (!magnet) {
    console.log(`${index + 1}. 磁力解析失败：${candidate.result.title.slice(0, 60)}`);
    continue;
  }

  const trackers = [...new Set([...magnet.trackers, ...PROBE_TRACKERS])];
  const results = await Promise.all(
    trackers.map((tracker) =>
      announce(tracker, {
        infoHash: hexToBytes(magnet.infoHash),
        peerId,
        port: 6881,
        uploaded: 0,
        downloaded: 0,
        left: 0,
        event: 'started',
        timeoutMs: 8_000
      }).catch(() => null)
    )
  );

  let peers = 0;
  let seeders: number | null = null;
  for (const item of results) {
    if (!item) continue;
    peers += item.peers.length;
    if (item.seeders !== null) seeders = Math.max(seeders ?? 0, item.seeders);
  }

  console.log(
    `${String(index + 1).padStart(2)}. [${candidate.result.tracker}] 种子 ${candidate.result.seederCount ?? '?'} / tracker 实报 ${seeders ?? '?'} / peer ${peers} | ${formatSize(candidate.result.sizeBytes)} | ${candidate.result.title.slice(0, 72)}`
  );
  console.log(`    ${magnet.infoHash}`);
}
