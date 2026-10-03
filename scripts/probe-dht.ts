/** 诊断 DHT 引导：哪些 bootstrap 节点真的有响应。 */
import { DhtClient } from '../src/bittorrent/dht.js';
import { hexToBytes } from '../src/bittorrent/peer.js';

const dht = new DhtClient();
await dht.start();
console.log(`DHT 本地端口 ${dht.localPort}`);

const infoHash = hexToBytes(process.argv[2] ?? 'e3ccfbf78d009ab2c1e300d95b6d66677a16406d');
const started = Date.now();
const peers = await dht.lookupPeers(infoHash, { rounds: 5, timeoutMs: 6000, onPeers: (b) => console.log(`  实时收到 ${b.length} 个 peer`) });
console.log(`DHT 找到 ${peers.length} 个 peer，用时 ${Date.now() - started}ms`);
for (const peer of peers.slice(0, 10)) console.log(`  ${peer.host}:${peer.port}`);
dht.close();
