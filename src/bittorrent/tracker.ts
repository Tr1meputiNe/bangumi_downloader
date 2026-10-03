import { createSocket, type Socket } from 'node:dgram';
import { bdecode, type BencodeValue } from '../util/bencode.js';
import { isDict, asBytes, decodeText } from './metainfo.js';
import { logger } from '../util/log.js';

const log = logger('bt-tracker');

/**
 * Tracker 通信（BEP 3 的 HTTP announce + BEP 15 的 UDP announce）。
 *
 * 两个协议都只做「要 peers」这一件事：上传量恒为 0，left 用真实剩余量，
 * event 只在首次 announce 时发 started。拿到的 peer 列表交给下载引擎去连。
 */

export type PeerAddress = { host: string; port: number };

export type AnnounceOptions = {
  infoHash: Uint8Array;
  peerId: Uint8Array;
  port: number;
  uploaded: number;
  downloaded: number;
  left: number;
  event?: 'started' | 'completed' | 'stopped' | null;
  numWant?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type AnnounceResult = {
  peers: PeerAddress[];
  intervalSeconds: number;
  seeders: number | null;
  leechers: number | null;
};

const UDP_MAGIC = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;

/** 按协议派发 announce。无法识别或失败时返回 null。 */
export async function announce(trackerUrl: string, options: AnnounceOptions): Promise<AnnounceResult | null> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  try {
    const protocol = new URL(trackerUrl).protocol;
    if (protocol === 'udp:') return await announceUdp(trackerUrl, options, timeoutMs);
    if (protocol === 'http:' || protocol === 'https:') return await announceHttp(trackerUrl, options, timeoutMs);
  } catch (error) {
    log.debug(`tracker ${trackerUrl} 请求失败：${(error as Error).message}`);
  }
  return null;
}

export async function announceHttp(trackerUrl: string, options: AnnounceOptions, timeoutMs: number): Promise<AnnounceResult | null> {
  const base = new URL(trackerUrl);
  const query = [
    rawBytesParam('info_hash', options.infoHash),
    rawBytesParam('peer_id', options.peerId),
    `port=${options.port}`,
    `uploaded=${Math.max(0, Math.trunc(options.uploaded))}`,
    `downloaded=${Math.max(0, Math.trunc(options.downloaded))}`,
    `left=${Math.max(0, Math.trunc(options.left))}`,
    'compact=1',
    `numwant=${options.numWant ?? 80}`,
    `key=${randomUint32().toString(16)}`
  ];
  if (options.event) query.push(`event=${options.event}`);

  const finalUrl = `${base.origin}${base.pathname}?${query.join('&')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(finalUrl, {
      signal: controller.signal,
      headers: { 'user-agent': 'bangumi-downloader/1.1' }
    });
    if (!response.ok) {
      log.debug(`tracker ${trackerUrl} 返回 HTTP ${response.status}`);
      return null;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    return parseAnnounceResponse(buffer);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** 把原始字节编成 tracker 认识的百分号转义（未保留字符保持原样）。 */
function rawBytesParam(key: string, value: Uint8Array): string {
  let encoded = '';
  for (const byte of value) {
    const unreserved =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x2e ||
      byte === 0x7e;
    encoded += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return `${key}=${encoded}`;
}

/** 解析 HTTP announce 的返回。同时支持 compact 与字典两种 peers 形式。 */
export function parseAnnounceResponse(buffer: Uint8Array): AnnounceResult | null {
  let value: BencodeValue;
  try {
    value = bdecode(buffer);
  } catch {
    return null;
  }
  if (!isDict(value)) return null;

  const failure = asBytes(value['failure reason']);
  if (failure) {
    log.debug(`tracker 拒绝：${decodeText(failure)}`);
    return null;
  }

  const peers: PeerAddress[] = [];
  const compact = asBytes(value.peers);
  if (compact) {
    for (let offset = 0; offset + 6 <= compact.length; offset += 6) {
      const host = `${compact[offset]}.${compact[offset + 1]}.${compact[offset + 2]}.${compact[offset + 3]}`;
      const port = ((compact[offset + 4] as number) << 8) | (compact[offset + 5] as number);
      if (port > 0) peers.push({ host, port });
    }
  } else if (Array.isArray(value.peers)) {
    for (const item of value.peers) {
      if (!isDict(item)) continue;
      const ip = asBytes(item.ip);
      const port = typeof item.port === 'number' ? item.port : 0;
      if (ip && port > 0) peers.push({ host: decodeText(ip), port });
    }
  }

  const peers6 = asBytes(value.peers6);
  if (peers6) {
    for (let offset = 0; offset + 18 <= peers6.length; offset += 18) {
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) {
        groups.push((((peers6[offset + i] as number) << 8) | (peers6[offset + i + 1] as number)).toString(16));
      }
      const port = ((peers6[offset + 16] as number) << 8) | (peers6[offset + 17] as number);
      if (port > 0) peers.push({ host: groups.join(':'), port });
    }
  }

  return {
    peers,
    intervalSeconds: typeof value.interval === 'number' ? value.interval : 1800,
    seeders: typeof value.complete === 'number' ? value.complete : null,
    leechers: typeof value.incomplete === 'number' ? value.incomplete : null
  };
}

/** UDP tracker 协议（BEP 15）。 */
export async function announceUdp(trackerUrl: string, options: AnnounceOptions, timeoutMs: number): Promise<AnnounceResult | null> {
  const url = new URL(trackerUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 80);
  const family = host.includes(':') ? 'udp6' : 'udp4';

  const socket = createSocket(family);
  try {
    await bindSocket(socket);
    const connectionId = await udpConnect(socket, host, port, timeoutMs);
    if (connectionId === null) return null;
    return await udpAnnounce(socket, host, port, connectionId, options, timeoutMs);
  } finally {
    socket.close();
  }
}

function bindSocket(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, () => resolve());
  });
}

async function udpConnect(socket: Socket, host: string, port: number, timeoutMs: number): Promise<bigint | null> {
  const transactionId = randomUint32();
  const request = new Uint8Array(16);
  const view = new DataView(request.buffer);
  view.setBigUint64(0, UDP_MAGIC, false);
  view.setUint32(8, ACTION_CONNECT, false);
  view.setUint32(12, transactionId, false);

  const response = await exchangeUdp(socket, host, port, request, timeoutMs);
  if (!response || response.length < 16) return null;

  const responseView = new DataView(response.buffer, response.byteOffset, response.byteLength);
  if (responseView.getUint32(0, false) !== ACTION_CONNECT) return null;
  if (responseView.getUint32(4, false) !== transactionId) return null;
  return responseView.getBigUint64(8, false);
}

async function udpAnnounce(
  socket: Socket,
  host: string,
  port: number,
  connectionId: bigint,
  options: AnnounceOptions,
  timeoutMs: number
): Promise<AnnounceResult | null> {
  const transactionId = randomUint32();
  const request = new Uint8Array(98);
  const view = new DataView(request.buffer);
  view.setBigUint64(0, connectionId, false);
  view.setUint32(8, ACTION_ANNOUNCE, false);
  view.setUint32(12, transactionId, false);
  request.set(options.infoHash, 16);
  request.set(options.peerId, 36);
  view.setBigUint64(56, BigInt(Math.max(0, Math.trunc(options.downloaded))), false);
  view.setBigUint64(64, BigInt(Math.max(0, Math.trunc(options.left))), false);
  view.setBigUint64(72, BigInt(Math.max(0, Math.trunc(options.uploaded))), false);
  view.setUint32(80, eventCode(options.event), false);
  view.setUint32(84, 0, false); // ip：0 表示由 tracker 取来源地址
  view.setUint32(88, randomUint32(), false); // key
  view.setUint32(92, options.numWant ?? 80, false);
  view.setUint16(96, options.port, false);

  const response = await exchangeUdp(socket, host, port, request, timeoutMs);
  if (!response || response.length < 20) return null;

  const responseView = new DataView(response.buffer, response.byteOffset, response.byteLength);
  const action = responseView.getUint32(0, false);
  if (action === ACTION_ERROR) {
    log.debug(`UDP tracker ${host}:${port} 返回错误`);
    return null;
  }
  if (action !== ACTION_ANNOUNCE || responseView.getUint32(4, false) !== transactionId) return null;

  const intervalSeconds = responseView.getUint32(8, false);
  const leechers = responseView.getUint32(12, false);
  const seeders = responseView.getUint32(16, false);

  const peers: PeerAddress[] = [];
  for (let offset = 20; offset + 6 <= response.length; offset += 6) {
    const peerHost = `${response[offset]}.${response[offset + 1]}.${response[offset + 2]}.${response[offset + 3]}`;
    const peerPort = ((response[offset + 4] as number) << 8) | (response[offset + 5] as number);
    if (peerPort > 0) peers.push({ host: peerHost, port: peerPort });
  }

  return { peers, intervalSeconds, seeders, leechers };
}

function eventCode(event: AnnounceOptions['event']): number {
  switch (event) {
    case 'completed':
      return 1;
    case 'started':
      return 2;
    case 'stopped':
      return 3;
    default:
      return 0;
  }
}

/**
 * 发一个 UDP 包并等第一个回包。
 * 同一个 socket 会被复用（connect 与 announce 各一次），所以超时靠定时器而不是关 socket。
 */
function exchangeUdp(socket: Socket, host: string, port: number, request: Uint8Array, timeoutMs: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      resolve(value);
    };

    const onMessage = (message: Buffer, remote: { address: string; port: number }) => {
      if (remote.port !== port) return;
      finish(new Uint8Array(message));
    };

    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.send(Buffer.from(request), port, host, (error) => {
      if (error) finish(null);
    });
  });
}

function randomUint32(): number {
  return Math.floor(Math.random() * 0xffffffff);
}
