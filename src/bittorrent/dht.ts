import { createSocket, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { bencode } from './bencode-encode.js';
import { bdecode, type BencodeValue } from '../util/bencode.js';
import { isDict, asBytes, decodeText } from './metainfo.js';
import type { PeerAddress } from './tracker.js';
import { logger } from '../util/log.js';

const log = logger('bt-dht');

/**
 * 最小可用的 DHT 客户端（BEP 5）。
 *
 * 磁力链接经常只带极少的 tracker（甚至一个都没有），真正的 peer 来源是 DHT。
 * 这里只实现「找 peer」所需的子集：
 *   - get_peers / announce_peer
 *   - find_node 用于在路由表为空时先摸到一批节点
 * 路由表只在内存里维护一次运行的节点集合，不做持久化 —— 每次启动从
 * 公共 bootstrap 节点重新查找，对「下完就退」的批处理场景足够。
 */

const BOOTSTRAP_NODES: PeerAddress[] = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 }
];

const K = 8;

export type DhtOptions = {
  /** 本地 UDP 端口，0 表示随机。 */
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type DhtNode = { id: Uint8Array; host: string; port: number };

export class DhtClient {
  #socket: Socket | null = null;
  #nodeId: Uint8Array;
  #nodes: DhtNode[] = [];
  #transactions = new Map<string, (value: BencodeValue | null) => void>();
  #port: number;
  #closed = false;
  #listening = false;

  constructor(options: DhtOptions = {}) {
    this.#nodeId = randomBytes(20);
    this.#port = options.port ?? 0;
  }

  get nodeId(): Uint8Array {
    return this.#nodeId;
  }

  /** 启动 UDP 监听（幂等）。 */
  async start(): Promise<void> {
    if (this.#listening || this.#closed) return;

    const socket = createSocket({ type: 'udp4' });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      socket.once('error', onError);
      socket.bind(this.#port, () => {
        socket.off('error', onError);
        resolve();
      });
    });

    socket.on('error', () => {
      /* 单个包出错不影响整体，交给超时处理 */
    });
    socket.on('message', (message: Buffer, remote: { address: string; port: number }) => {
      this.#onMessage(message, remote);
    });

    this.#socket = socket;
    this.#port = socket.address().port;
    this.#listening = true;
  }

  get listening(): boolean {
    return this.#listening;
  }

  get localPort(): number {
    return this.#port;
  }

  /**
   * 迭代查找某个 infohash 的 peer。
   * 会持续向更靠近目标的节点发 get_peers，直到查够轮次或拿到足够多的 peer。
   */
  async lookupPeers(
    infoHash: Uint8Array,
    options: { rounds?: number; timeoutMs?: number; signal?: AbortSignal; onPeers?: (peers: PeerAddress[]) => void } = {}
  ): Promise<PeerAddress[]> {
    if (this.#closed) return [];
    await this.start();

    const rounds = options.rounds ?? 6;
    const timeoutMs = options.timeoutMs ?? 6_000;
    const deadline = Date.now() + rounds * timeoutMs;
    const found = new Map<string, PeerAddress>();

    await this.#bootstrap();
    if (this.#closed) return [];

    const queried = new Set<string>();

    for (let round = 0; round < rounds && Date.now() < deadline; round += 1) {
      if (options.signal?.aborted) break;

      const candidates = [...this.#nodes]
        .filter((node) => !queried.has(`${node.host}:${node.port}`))
        .sort((a, b) => compareDistance(a.id, b.id, infoHash))
        .slice(0, K);

      if (candidates.length === 0) break;

      const responses = await Promise.all(
        candidates.map((node) => {
          queried.add(`${node.host}:${node.port}`);
          return this.#queryNode(node, 'get_peers', { info_hash: infoHash }, timeoutMs);
        })
      );

      for (const response of responses) {
        if (!response || !isDict(response)) continue;
        this.#absorbNodes(response);
        const values = response.values;
        if (Array.isArray(values)) {
          const batch: PeerAddress[] = [];
          for (const item of values) {
            const address = parseCompactPeer(item);
            if (address) batch.push(address);
          }
          for (const address of batch) {
            const key = `${address.host}:${address.port}`;
            if (!found.has(key)) found.set(key, address);
          }
          if (batch.length > 0) options.onPeers?.(batch);
        }
      }
    }

    log.debug(`DHT 找到 ${found.size} 个 peer（infohash ${Buffer.from(infoHash).toString('hex').slice(0, 16)}…）`);
    return [...found.values()];
  }

  /** 向所有已知节点宣告我们在该 infohash 上监听。失败不影响下载。 */
  async announcePeer(infoHash: Uint8Array, port: number): Promise<void> {
    if (this.#closed) return;
    await this.start();
    const nodes = this.#nodes.slice(0, K);
    await Promise.all(
      nodes.map((node) => this.#queryNode(node, 'announce_peer', { info_hash: infoHash, port, implied_port: 1 }, 5_000))
    );
  }

  close(): void {
    this.#closed = true;
    for (const [, resolve] of this.#transactions) resolve(null);
    this.#transactions.clear();
    this.#socket?.close();
    this.#socket = null;
    this.#listening = false;
  }

  async #bootstrap(): Promise<void> {
    if (this.#nodes.length >= K) return;

    // 先解析 bootstrap 域名，再发 find_node
    const resolved: DhtNode[] = [];
    for (const entry of BOOTSTRAP_NODES) {
      try {
        const addresses = await resolveHost(entry.host);
        for (const host of addresses) {
          resolved.push({ id: randomBytes(20), host, port: entry.port });
        }
      } catch {
        // 某个 bootstrap 节点解析不了就跳过
      }
    }

    await Promise.all(
      resolved.map(async (node) => {
        const response = await this.#queryNode(node, 'find_node', { target: this.#nodeId }, 6_000);
        if (response && isDict(response)) this.#absorbNodes(response);
      })
    );

    log.debug(`DHT 引导完成，已知节点 ${this.#nodes.length} 个`);
  }

  /** 从响应里把 nodes / nodes6 收进路由表。 */
  #absorbNodes(response: { [key: string]: BencodeValue }): void {
    const nodes = asBytes(response.nodes);
    if (nodes) {
      for (let offset = 0; offset + 26 <= nodes.length; offset += 26) {
        const id = nodes.subarray(offset, offset + 20);
        const host = `${nodes[offset + 20]}.${nodes[offset + 21]}.${nodes[offset + 22]}.${nodes[offset + 23]}`;
        const port = ((nodes[offset + 24] as number) << 8) | (nodes[offset + 25] as number);
        if (port > 0 && !host.startsWith('0.')) this.#addNode({ id: Uint8Array.from(id), host, port });
      }
    }

    const nodes6 = asBytes(response.nodes6);
    if (nodes6) {
      for (let offset = 0; offset + 38 <= nodes6.length; offset += 38) {
        const id = nodes6.subarray(offset, offset + 20);
        const groups: string[] = [];
        for (let i = 0; i < 16; i += 2) {
          groups.push((((nodes6[offset + 20 + i] as number) << 8) | (nodes6[offset + 21 + i] as number)).toString(16));
        }
        const port = ((nodes6[offset + 36] as number) << 8) | (nodes6[offset + 37] as number);
        if (port > 0) this.#addNode({ id: Uint8Array.from(id), host: groups.join(':'), port });
      }
    }
  }

  #addNode(node: DhtNode): void {
    if (this.#nodes.length >= 512) {
      // 路由表满了就丢掉最远的节点，保持内存有界
      this.#nodes.sort((a, b) => compareDistance(a.id, b.id, this.#nodeId));
      this.#nodes.pop();
    }
    const key = `${node.host}:${node.port}`;
    if (this.#nodes.some((existing) => `${existing.host}:${existing.port}` === key)) return;
    this.#nodes.push(node);
  }

  #queryNode(
    node: DhtNode,
    method: 'find_node' | 'get_peers' | 'announce_peer',
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<BencodeValue | null> {
    const socket = this.#socket;
    if (!socket || this.#closed) return Promise.resolve(null);

    const transactionId = randomBytes(2).toString('hex');
    const payload = bencode({
      t: transactionId,
      y: 'q',
      q: method,
      a: { id: this.#nodeId, ...args } as never
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#transactions.delete(transactionId);
        resolve(null);
      }, timeoutMs);

      this.#transactions.set(transactionId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });

      try {
        socket.send(Buffer.from(payload), node.port, node.host, (error) => {
          if (error) {
            clearTimeout(timer);
            this.#transactions.delete(transactionId);
            resolve(null);
          }
        });
      } catch {
        clearTimeout(timer);
        this.#transactions.delete(transactionId);
        resolve(null);
      }
    });
  }

  #onMessage(message: Buffer, remote: { address: string; port: number }): void {
    let value: BencodeValue;
    try {
      value = bdecode(new Uint8Array(message));
    } catch {
      return;
    }
    if (!isDict(value)) return;

    const transactionIdBytes = asBytes(value.t);
    const transactionId = transactionIdBytes ? decodeText(transactionIdBytes) : '';
    const type = asBytes(value.y) ? decodeText(asBytes(value.y) as Uint8Array) : '';

    if (type === 'r' && isDict(value.r)) {
      const responderId = asBytes(value.r.id);
      if (responderId) this.#addNode({ id: Uint8Array.from(responderId), host: remote.address, port: remote.port });
      const pending = this.#transactions.get(transactionId);
      if (pending) {
        this.#transactions.delete(transactionId);
        pending(value.r);
      }
      return;
    }

    if (type === 'q') {
      // 我们只下载不上传，收到查询一律不回，避免被当成可用的 DHT 节点
      return;
    }

    if (type === 'e') {
      const pending = this.#transactions.get(transactionId);
      if (pending) {
        this.#transactions.delete(transactionId);
        pending(null);
      }
    }
  }
}

/** 解析 DHT 响应里的 compact peer（6 字节）。 */
function parseCompactPeer(value: BencodeValue): PeerAddress | null {
  const bytes = asBytes(value);
  if (!bytes || bytes.length < 6) return null;
  const host = `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  const port = ((bytes[4] as number) << 8) | (bytes[5] as number);
  return port > 0 ? { host, port } : null;
}

/** 比较 a、b 谁离 target 更近。 */
function compareDistance(a: Uint8Array, b: Uint8Array, target: Uint8Array): number {
  const left = xorDistance(a, target);
  const right = xorDistance(b, target);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** 两个 20 字节 id 的异或距离，转成 BigInt 好比较。 */
function xorDistance(a: Uint8Array, b: Uint8Array): bigint {
  let distance = 0n;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    distance = (distance << 8n) | BigInt((a[i] as number) ^ (b[i] as number));
  }
  return distance;
}

async function resolveHost(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const result = await lookup(host, { all: true });
  return result.filter((entry) => entry.family === 4).map((entry) => entry.address);
}
