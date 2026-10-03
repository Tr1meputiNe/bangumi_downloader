/**
 * 逐 peer 诊断元数据获取。
 *
 * 用法：npx tsx scripts/diag-peer.ts <infohash> [savePath 可选]
 * 会对每个候选 peer 依次报告：TCP+BT 握手 / 扩展握手 / ut_metadata / 最终结果，
 * 用来定位「是谁在拖后腿」还是「本地网络根本连不出去」。
 */
import { PeerConnection, generatePeerId, hexToBytes } from '../src/bittorrent/peer.js';
import { announce } from '../src/bittorrent/tracker.js';
import { DhtClient } from '../src/bittorrent/dht.js';
import { fetchMetadataFromPeer } from '../src/bittorrent/metadata.js';
import { PUBLIC_TRACKERS } from '../src/bittorrent/public-trackers.js';

const infoHashHex = process.argv[2];
if (!infoHashHex) {
  console.error('用法：npx tsx scripts/diag-peer.ts <infohash>');
  process.exit(2);
}

const infoHash = hexToBytes(infoHashHex);
const peerId = generatePeerId();
const candidates = new Map<string, { host: string; port: number }>();
const add = (address: { host: string; port: number }) => {
  if (address.port > 0 && address.host !== '0.0.0.0') candidates.set(`${address.host}:${address.port}`, address);
};

console.log('=== tracker announce ===');
const trackerResults = await Promise.all(
  PUBLIC_TRACKERS.map((tracker) =>
    announce(tracker, { infoHash, peerId, port: 6881, uploaded: 0, downloaded: 0, left: 0, event: 'started', timeoutMs: 10_000 })
      .then((result) => ({ tracker, result }))
      .catch(() => ({ tracker, result: null }))
  )
);
for (const { tracker, result } of trackerResults) {
  console.log(`  ${tracker} → ${result ? `${result.peers.length} peer（做种 ${result.seeders ?? '?'}）` : '无返回'}`);
  for (const peer of result?.peers ?? []) add(peer);
}

console.log('=== DHT ===');
const dht = new DhtClient();
await dht.start();
console.log(`  本地 UDP 端口 ${dht.localPort}`);
const dhtPeers = await dht.lookupPeers(infoHash, { rounds: 4, timeoutMs: 6_000, onPeers: (b) => b.forEach(add) });
dhtPeers.forEach(add);
console.log(`  DHT 找到 ${dhtPeers.length} 个 peer`);
dht.close();

console.log(`=== 候选 peer 共 ${candidates.size} 个，逐个尝试 ===`);
const list = [...candidates.values()].slice(0, 25);

let tcpOk = 0;
let extOk = 0;
let metaOk = 0;

await Promise.all(
  list.map(async (address) => {
    const key = `${address.host}:${address.port}`;
    let stage = 'TCP 连接';
    try {
      const connection = await PeerConnection.connect({
        host: address.host,
        port: address.port,
        infoHash,
        peerId,
        connectTimeoutMs: 8_000,
        setup: (pending) => {
          pending.on('error', () => undefined);
          pending.on('extended', (ext) => {
            console.log(`  [${key}] 扩展握手 metadata_size=${ext.metadataSize} ut_metadata=${ext.utMetadataId}`);
          });
        }
      });
      tcpOk += 1;
      stage = '扩展握手';
      const ext = await connection.waitForExtendedHandshake(12_000).catch(() => null);
      if (ext?.utMetadataId !== null && ext?.metadataSize !== null) extOk += 1;

      stage = '元数据';
      const meta = await fetchMetadataFromPeer(connection, infoHash, { timeoutMs: 20_000 });
      metaOk += 1;
      console.log(`  [${key}] ✅ 元数据 ${meta.infoBytes.length} 字节`);
      connection.destroy();
    } catch (error) {
      console.log(`  [${key}] ❌ 卡在「${stage}」：${(error as Error).message}`);
    }
  })
);

console.log(`\n汇总：候选 ${list.length}，TCP 握手成功 ${tcpOk}，扩展握手 ${extOk}，元数据成功 ${metaOk}`);
