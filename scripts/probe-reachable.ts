/**
 * 探「真的连得上吗」。
 *
 * tracker 报的做种数经常是假的（死种也会被算），所以这里对候选逐个做：
 *   announce 拿 peer 列表 → 真去 TCP 连一批 → 数有多少条能完成 BT 握手。
 * 只有握手成功的 peer 才有意义。
 *
 * 用法：npx tsx scripts/probe-reachable.ts <关键词> [每条最多试几个 peer] [最多看几条候选]
 */
import { loadConfig } from '../src/config.js';
import { searchAndRank } from '../src/core/search.js';
import { announce } from '../src/bittorrent/tracker.js';
import { PUBLIC_TRACKERS } from '../src/bittorrent/public-trackers.js';
import { PeerConnection, generatePeerId, hexToBytes } from '../src/bittorrent/peer.js';
import { parseMagnet } from '../src/bittorrent/metainfo.js';
import { formatSize } from '../src/util/text.js';

const query = process.argv[2] ?? '吹响上低音号';
const peerLimit = Number.parseInt(process.argv[3] ?? '14', 10);
const candidateLimit = Number.parseInt(process.argv[4] ?? '12', 10);

const config = loadConfig({ configPath: './config.json' }).config;
const result = await searchAndRank({ query, config, mode: 'manual' });
const candidates = result.ranked.filter((item) => !item.rejected && item.result.magnet).slice(0, candidateLimit);
const peerId = generatePeerId();

let index = 0;
for (const candidate of candidates) {
  index += 1;
  const magnet = parseMagnet(candidate.result.magnet);
  if (!magnet) continue;
  const infoHash = hexToBytes(magnet.infoHash);

  const results = await Promise.all(
    [...new Set([...magnet.trackers, ...PUBLIC_TRACKERS])].map((tracker) =>
      announce(tracker, { infoHash, peerId, port: 6881, uploaded: 0, downloaded: 0, left: 0, event: 'started', timeoutMs: 8_000 }).catch(() => null)
    )
  );

  const peers = new Map<string, { host: string; port: number }>();
  let seeders = 0;
  for (const item of results) {
    if (!item) continue;
    if (item.seeders !== null) seeders = Math.max(seeders, item.seeders);
    for (const peer of item.peers) peers.set(`${peer.host}:${peer.port}`, peer);
  }

  const sample = [...peers.values()].slice(0, peerLimit);
  let handshook = 0;
  await Promise.all(
    sample.map(async (peer) => {
      try {
        const connection = await PeerConnection.connect({
          host: peer.host, port: peer.port, infoHash, peerId, connectTimeoutMs: 6_000,
          setup: (pending) => { pending.on('error', () => undefined); }
        });
        handshook += 1;
        connection.destroy();
      } catch {
        /* 连不上就算了 */
      }
    })
  );

  const flag = handshook > 0 ? '✅' : '  ';
  console.log(
    `${flag} ${String(index).padStart(2)}. 握手 ${handshook}/${sample.length}（tracker 报做种 ${seeders}）` +
      ` | ${formatSize(candidate.result.sizeBytes)} | ${candidate.result.title.slice(0, 62)}`
  );
  console.log(`      ${magnet.infoHash}  ${candidate.result.tracker}`);
}
