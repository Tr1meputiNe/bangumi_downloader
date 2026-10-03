import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { bencode } from './bencode-encode.js';
import { bdecode, type BencodeValue } from '../util/bencode.js';
import { isDict, asBytes } from './metainfo.js';

/**
 * BitTorrent 对等连接（BEP 3 + BEP 10 扩展协议）。
 *
 * 只实现下载所必需的部分：
 *   - 标准消息：choke/unchoke/interested/notinterested/have/bitfield/request/piece/cancel
 *   - 扩展协议：握手交换，以及 BEP 9 的 ut_metadata（磁力链接拿 info 字典就靠它）
 * 不实现：uTP、协议加密、PEX、IPv6 DHT。种子都在公网 TCP 上，够用。
 */

export const PSTR = 'BitTorrent protocol';

/** 扩展协议里我们宣告的 id，对方发消息时会用我们给的值。 */
const OUR_EXTENDED_ID = 1;
const BLOCK_SIZE = 16 * 1024;
const MAX_FRAME = 2 * 1024 * 1024;

export type PeerMessage =
  | { type: 'choke' }
  | { type: 'unchoke' }
  | { type: 'interested' }
  | { type: 'notinterested' }
  | { type: 'have'; index: number }
  | { type: 'bitfield'; bits: Uint8Array }
  | { type: 'request'; index: number; begin: number; length: number }
  | { type: 'piece'; index: number; begin: number; block: Uint8Array }
  | { type: 'cancel'; index: number; begin: number; length: number }
  | { type: 'port'; port: number }
  | { type: 'extended'; extId: number; payload: Uint8Array };

/** 把一条消息编码成带 4 字节长度前缀的帧。 */
export function encodeMessage(message: PeerMessage): Uint8Array {
  const body = encodeBody(message);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, 4);
  return frame;
}

function encodeBody(message: PeerMessage): Uint8Array {
  switch (message.type) {
    case 'choke':
      return new Uint8Array([0]);
    case 'unchoke':
      return new Uint8Array([1]);
    case 'interested':
      return new Uint8Array([2]);
    case 'notinterested':
      return new Uint8Array([3]);
    case 'have':
      return integerBody(4, message.index);
    case 'bitfield':
      return concatBody([new Uint8Array([5]), message.bits]);
    case 'request':
      return integerBody(6, message.index, message.begin, message.length);
    case 'piece': {
      const head = integerBody(7, message.index, message.begin);
      return concatBody([head, message.block]);
    }
    case 'cancel':
      return integerBody(8, message.index, message.begin, message.length);
    case 'port':
      return integerBody(9, message.port);
    case 'extended': {
      const head = new Uint8Array([20, message.extId]);
      return concatBody([head, message.payload]);
    }
  }
}

function integerBody(id: number, ...values: number[]): Uint8Array {
  const out = new Uint8Array(1 + values.length * 4);
  out[0] = id;
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(1 + index * 4, value, false));
  return out;
}

function concatBody(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 解析一条消息体（不含长度前缀）。数据非法时返回 null。 */
export function decodeMessage(body: Uint8Array): PeerMessage | null {
  if (body.length === 0) return null;
  const id = body[0] as number;
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

  switch (id) {
    case 0:
      return { type: 'choke' };
    case 1:
      return { type: 'unchoke' };
    case 2:
      return { type: 'interested' };
    case 3:
      return { type: 'notinterested' };
    case 4:
      return body.length >= 5 ? { type: 'have', index: view.getUint32(1, false) } : null;
    case 5:
      return { type: 'bitfield', bits: body.subarray(1) };
    case 6:
      return body.length >= 13
        ? { type: 'request', index: view.getUint32(1, false), begin: view.getUint32(5, false), length: view.getUint32(9, false) }
        : null;
    case 7:
      return body.length >= 9
        ? { type: 'piece', index: view.getUint32(1, false), begin: view.getUint32(5, false), block: body.subarray(9) }
        : null;
    case 8:
      return body.length >= 13
        ? { type: 'cancel', index: view.getUint32(1, false), begin: view.getUint32(5, false), length: view.getUint32(9, false) }
        : null;
    case 9:
      return body.length >= 3 ? { type: 'port', port: view.getUint16(1, false) } : null;
    case 20:
      return body.length >= 2 ? { type: 'extended', extId: body[1] as number, payload: body.subarray(2) } : null;
    default:
      return null;
  }
}

export function buildHandshake(infoHash: Uint8Array, peerId: Uint8Array, options: { dht?: boolean; extended?: boolean } = {}): Uint8Array {
  const out = new Uint8Array(49 + PSTR.length);
  out[0] = PSTR.length;
  out.set(new TextEncoder().encode(PSTR), 1);

  /*
   * 保留位必须老实声明自己的能力，否则对端会按「你不支持」来对待：
   *   reserved[5] (第 6 个字节) 的 0x10 位 = 支持 BEP 10 扩展协议
   *   reserved[7] (第 8 个字节) 的 0x01 位 = 支持 DHT
   *
   * 之前只设了 DHT 位，结果对端（例如 qBittorrent）看到我们没声明扩展协议，
   * 就压根不发扩展握手 —— 表现为「BT 握手成功，但永远等不到扩展握手」，
   * 磁力链接因此永远取不到元数据。
   */
  out[25] = options.extended === false ? 0 : 0x10;
  out[27] = options.dht === false ? 0 : 0x01;

  out.set(infoHash, 28);
  out.set(peerId, 48);
  return out;
}

/** 解析对端握手。返回 infohash 与 peerId；长度不合法返回 null。 */
export function parseHandshake(
  buffer: Uint8Array
): { infoHash: Uint8Array; peerId: Uint8Array; supportsDht: boolean; supportsExtended: boolean } | null {
  if (buffer.length < 49 + PSTR.length) return null;
  if (buffer[0] !== PSTR.length) return null;
  const protocol = new TextDecoder().decode(buffer.subarray(1, 1 + PSTR.length));
  if (protocol !== PSTR) return null;
  return {
    infoHash: buffer.subarray(28, 48),
    peerId: buffer.subarray(48, 68),
    supportsDht: ((buffer[27] as number) & 0x01) !== 0,
    supportsExtended: ((buffer[25] as number) & 0x10) !== 0
  };
}

/** 扩展握手的 payload（BEP 10）。 */
export function buildExtendedHandshake(metadataSize: number | null, listenPort = 0): Uint8Array {
  const m: { [key: string]: number } = { ut_metadata: 1 };
  const dict: { [key: string]: unknown } = { m, v: 'bangumi-downloader/1.1', p: listenPort };
  if (metadataSize !== null) dict.metadata_size = metadataSize;
  return bencode(dict as never);
}

export type ExtendedHandshake = {
  metadataSize: number | null;
  /**
   * 对方为 ut_metadata 分配的扩展 id。
   *
   * 注意方向：这是**我们发消息给它时**要填的值。
   * 它发消息给我们时用的是**我们在 m 里宣告的**那个 id（见 localUtMetadataId）。
   */
  utMetadataId: number | null;
  /** 对方为 ut_pex 分配的 id，暂时只记录不用。 */
  utPexId: number | null;
};

export function parseExtendedHandshake(payload: Uint8Array): ExtendedHandshake {
  const result: ExtendedHandshake = { metadataSize: null, utMetadataId: null, utPexId: null };
  try {
    const value: BencodeValue = bdecode(payload);
    if (!isDict(value)) return result;
    if (typeof value.metadata_size === 'number') result.metadataSize = value.metadata_size;
    if (isDict(value.m)) {
      if (typeof value.m.ut_metadata === 'number') result.utMetadataId = value.m.ut_metadata;
      if (typeof value.m.ut_pex === 'number') result.utPexId = value.m.ut_pex;
    }
  } catch {
    // 对方发了不合规的 bencode，当作没握手
  }
  return result;
}

/** ut_metadata 请求（msg_type=0）。 */
export function buildMetadataRequest(piece: number): Uint8Array {
  return bencode({ msg_type: 0, piece });
}

/**
 * 构造 ut_metadata 数据消息（msg_type=1）。
 *
 * 规范（BEP 9）里这一条消息**不是一个纯 bencode 字典**：
 * 它是「bencode 头 + 紧跟其后的原始分片字节」，数据并不放在 data 字段里。
 * 我们只作为下载端，不主动发这个方向的消息，但保持一致以免误导。
 */
export function buildMetadataData(piece: number, totalSize: number, data: Uint8Array): Uint8Array {
  const head = bencode({ msg_type: 1, piece, total_size: totalSize });
  const out = new Uint8Array(head.length + data.length);
  out.set(head, 0);
  out.set(data, head.length);
  return out;
}

/**
 * 解析 ut_metadata 消息。
 *
 * 返回的 data 是「bencode 头之后剩下的原始字节」。这一点很容易踩坑：
 * 实测对端发来的内容是 `d8:msg_typei1e5:piecei0e10:total_sizei21307ee` + 原始分片，
 * 如果按 `4:data<len>:` 字段去取，永远取不到数据（bdecode 只会得到三个键）。
 */
export function parseMetadataMessage(payload: Uint8Array): {
  msgType: number;
  piece: number;
  totalSize: number | null;
  /** bencode 头之后的原始字节长度（msg_type=1 时即分片数据）。 */
  data: Uint8Array | null;
} | null {
  try {
    const value = bdecode(payload);
    if (!isDict(value)) return null;
    const msgType = typeof value.msg_type === 'number' ? value.msg_type : null;
    const piece = typeof value.piece === 'number' ? value.piece : null;
    if (msgType === null || piece === null) return null;

    return {
      msgType,
      piece,
      totalSize: typeof value.total_size === 'number' ? value.total_size : null,
      // 头之后的所有字节就是分片数据（拒绝消息 msg_type=2 时没有数据）
      data: msgType === 1 ? trailingBytes(payload) : null
    };
  } catch {
    return null;
  }
}

/** 量一下 bencode 值占了多少字节，用于切出「头之后的原始数据」。 */
function bencodeLength(buffer: Uint8Array, offset = 0): number {
  const marker = buffer[offset];
  if (marker === undefined) return 0;

  if (marker === 0x69) {
    const end = buffer.indexOf(0x65, offset);
    return end < 0 ? 0 : end + 1 - offset;
  }
  if (marker === 0x6c) {
    let cursor = offset + 1;
    for (;;) {
      if (cursor >= buffer.length) return 0;
      if (buffer[cursor] === 0x65) return cursor + 1 - offset;
      const step = bencodeLength(buffer, cursor);
      if (step === 0) return 0;
      cursor += step;
    }
  }
  if (marker === 0x64) {
    let cursor = offset + 1;
    for (;;) {
      if (cursor >= buffer.length) return 0;
      if (buffer[cursor] === 0x65) return cursor + 1 - offset;
      const keyStep = bencodeLength(buffer, cursor);
      if (keyStep === 0) return 0;
      cursor += keyStep;
      const valueStep = bencodeLength(buffer, cursor);
      if (valueStep === 0) return 0;
      cursor += valueStep;
    }
  }
  if (marker >= 0x30 && marker <= 0x39) {
    const colon = buffer.indexOf(0x3a, offset);
    if (colon < 0) return 0;
    const length = Number.parseInt(new TextDecoder().decode(buffer.subarray(offset, colon)), 10);
    return Number.isFinite(length) ? colon + 1 + length - offset : 0;
  }
  return 0;
}

function trailingBytes(payload: Uint8Array): Uint8Array | null {
  const headLength = bencodeLength(payload, 0);
  if (headLength <= 0 || headLength >= payload.length) return null;
  return payload.subarray(headLength);
}

export type PeerConnectionOptions = {
  host: string;
  port: number;
  infoHash: Uint8Array;
  peerId: Uint8Array;
  /** 需要对方通过 ut_metadata 提供 info 字典时填写其长度。 */
  metadataSize?: number | null;
  /** 本地监听端口，仅用于扩展握手里的 p 字段。 */
  listenPort?: number;
  connectTimeoutMs?: number;
  /**
   * 在返回连接之前同步调用的钩子。
   *
   * 必须在这里挂监听：TCP 是流式的，对方的 bitfield / 扩展握手经常和 BT 握手
   * 挤在同一个数据包里，如果等 connect() 的 Promise 落地再挂监听，
   * 这些事件已经 emit 过了 —— 会表现为「握手成功但永远收不到扩展握手」。
   */
  setup?: (connection: PeerConnection) => void;
};

/**
 * 一条已完成握手的 peer 连接。
 * 只负责收发与心跳，具体的调度（要哪些 piece）由下载引擎决定。
 */
export class PeerConnection extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly peerId: Uint8Array;
  /** 对端是否已解除阻塞。 */
  choked = true;
  /** 对端是否对我们感兴趣（我们只下载，不关心）。 */
  peerInterested = false;
  /** 对方宣告的扩展能力。 */
  extended: ExtendedHandshake | null = null;
  /**
   * 我们宣告给对方的各扩展 id（出站用对方的，入站认自己的）。
   * 入站消息要按这个值过滤，否则会把对方的 ut_metadata 数据当成未知扩展丢掉。
   */
  readonly localUtMetadataId: number;
  /** 对方已有哪些 piece（bitfield/have 累积）。 */
  readonly have = new Set<number>();
  /** 对端是否发送过 bitfield。 */
  gotBitfield = false;
  /** 本连接已下载的有效字节数。 */
  downloadedBytes = 0;

  #socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #handshakeDone = false;
  #closed = false;
  #expectedInfoHash: Uint8Array;
  #options: PeerConnectionOptions;
  #lastActivity = Date.now();
  #pendingHandshake: Uint8Array;
  #handshakeResolve: ((value: boolean) => void) | null = null;
  #extendedWaiters: Array<(value: ExtendedHandshake) => void> = [];

  constructor(socket: Socket, options: PeerConnectionOptions) {
    super();
    this.#socket = socket;
    this.#options = options;
    this.host = options.host;
    this.port = options.port;
    this.#expectedInfoHash = options.infoHash;
    this.peerId = options.peerId;
    this.localUtMetadataId = OUR_EXTENDED_ID;
    this.#pendingHandshake = buildHandshake(options.infoHash, options.peerId, { dht: true, extended: true });

    // 调用方通常在 connect() 成功之后才挂监听，而连接随时可能先断。
    // EventEmitter 对没有监听者的 'error' 会直接抛错，所以这里先挂一个空处理器兜底；
    // 调用方挂上自己的监听后，这个兜底仍会被调用，不影响它的处理逻辑。
    this.on('error', () => {
      /* 默认吞掉，避免把整个进程带崩；调用方自行决定要不要处理 */
    });

    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('连接被关闭')));
  }

  static connect(options: PeerConnectionOptions): Promise<PeerConnection> {
    const timeout = options.connectTimeoutMs ?? 12_000;
    return new Promise((resolve, reject) => {
      const socket = connect({ host: options.host, port: options.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 ${options.host}:${options.port} 超时`));
      }, timeout);

      const cleanup = () => clearTimeout(timer);

      socket.once('error', (error) => {
        cleanup();
        reject(error);
      });

      const connection = new PeerConnection(socket, options);
      // 先挂监听再等握手结果，避免丢掉早到的事件
      options.setup?.(connection);
      connection.#handshakeResolve = (ok) => {
        cleanup();
        if (ok) resolve(connection);
        else reject(new Error(`与 ${options.host}:${options.port} 握手失败`));
      };

      socket.once('connect', () => {
        connection.#lastActivity = Date.now();
        /*
         * 两个握手必须一起发。
         *
         * 相当一部分客户端（实测 qBittorrent 就如此）要**先收到我们的扩展握手**
         * 才会回它自己的。如果等 BT 握手 resolve 之后才发扩展握手，就会变成
         * 「我们在等它、它在等我们」的死等，表现是握手成功但永远收不到扩展握手。
         * 这里一次写完，对端立刻就有反应。
         */
        socket.write(connection.#outboundHandshakes());
      });
    });
  }

  /** BT 握手 + 扩展握手，拼成一次 write 发出去。 */
  #outboundHandshakes(): Buffer {
    const handshake = this.#pendingHandshake;
    const extended = encodeMessage({
      type: 'extended',
      extId: 0,
      payload: buildExtendedHandshake(null, this.#options.listenPort ?? 0)
    });
    const out = Buffer.alloc(handshake.length + extended.length);
    out.set(handshake, 0);
    out.set(extended, handshake.length);
    return out;
  }

  get lastActivity(): number {
    return this.#lastActivity;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get handshakeDone(): boolean {
    return this.#handshakeDone;
  }

  /**
   * 等对方的扩展握手（BEP 10）。
   * 已经收到过就直接返回；否则等下一次，超时抛错。
   */
  waitForExtendedHandshake(timeoutMs = 15_000): Promise<ExtendedHandshake> {
    if (this.extended) return Promise.resolve(this.extended);
    if (this.#closed) return Promise.reject(new Error('连接已关闭'));

    return new Promise<ExtendedHandshake>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#extendedWaiters = this.#extendedWaiters.filter((waiter) => waiter !== onHandshake);
        reject(new Error('等待扩展握手超时'));
      }, timeoutMs);

      const onHandshake = (value: ExtendedHandshake) => {
        clearTimeout(timer);
        resolve(value);
      };

      this.#extendedWaiters.push(onHandshake);
    });
  }

  /** 发送一条协议消息。连接已关闭时静默忽略。 */
  send(message: PeerMessage): void {
    if (this.#closed || this.#socket.destroyed) return;
    try {
      this.#socket.write(Buffer.from(encodeMessage(message)));
    } catch {
      this.destroy();
    }
  }

  sendRaw(bytes: Uint8Array): void {
    if (this.#closed || this.#socket.destroyed) return;
    try {
      this.#socket.write(Buffer.from(bytes));
    } catch {
      this.destroy();
    }
  }

  /**
   * 重新宣告一次扩展握手（例如拿到 metadata_size 后补发）。
   * 首次宣告已经在 connect 时和 BT 握手一起发出去了。
   */
  sendExtendedHandshake(metadataSize: number | null): void {
    this.send({ type: 'extended', extId: 0, payload: buildExtendedHandshake(metadataSize, this.#options.listenPort ?? 0) });
  }

  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.emit('close');
  }

  #onData(chunk: Buffer): void {
    this.#lastActivity = Date.now();
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    if (!this.#handshakeDone) {
      const need = 49 + PSTR.length;
      if (this.#buffer.length < need) return;
      const parsed = parseHandshake(new Uint8Array(this.#buffer.subarray(0, need)));
      if (!parsed || !equalBytes(parsed.infoHash, this.#expectedInfoHash)) {
        this.#handshakeResolve?.(false);
        this.#handshakeResolve = null;
        this.destroy();
        return;
      }
      this.#buffer = this.#buffer.subarray(need).length > 0 ? Buffer.from(this.#buffer.subarray(need)) : Buffer.alloc(0);
      this.#handshakeDone = true;
      this.#handshakeResolve?.(true);
      this.#handshakeResolve = null;
      this.emit('handshake');
    }

    // 逐帧解析：4 字节大端长度 + 消息体
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0) {
        // keep-alive
        this.#buffer = Buffer.from(this.#buffer.subarray(4));
        continue;
      }
      if (length > MAX_FRAME) {
        this.#fail(new Error(`消息长度异常：${length}`));
        return;
      }
      if (this.#buffer.length < 4 + length) return;

      const body = new Uint8Array(this.#buffer.subarray(4, 4 + length));
      this.#buffer = Buffer.from(this.#buffer.subarray(4 + length));

      const message = decodeMessage(body);
      if (!message) continue;
      this.#handle(message);
    }
  }

  #handle(message: PeerMessage): void {
    switch (message.type) {
      case 'choke':
        this.choked = true;
        this.emit('choke');
        break;
      case 'unchoke':
        this.choked = false;
        this.emit('unchoke');
        break;
      case 'interested':
        this.peerInterested = true;
        break;
      case 'notinterested':
        this.peerInterested = false;
        break;
      case 'have':
        this.have.add(message.index);
        this.emit('have', message.index);
        break;
      case 'bitfield': {
        this.gotBitfield = true;
        const bitCount = message.bits.length * 8;
        for (let index = 0; index < bitCount; index += 1) {
          const byte = message.bits[index >> 3];
          if (byte === undefined) break;
          if ((byte & (0x80 >> (index & 7))) !== 0) this.have.add(index);
        }
        this.emit('bitfield', message.bits);
        break;
      }
      case 'piece':
        this.downloadedBytes += message.block.length;
        this.emit('piece', message);
        break;
      case 'request':
        // 我们只做下载端，不回上传
        break;
      case 'extended': {
        if (message.extId === 0) {
          this.extended = parseExtendedHandshake(message.payload);
          const waiters = this.#extendedWaiters;
          this.#extendedWaiters = [];
          for (const waiter of waiters) waiter(this.extended);
          this.emit('extended', this.extended);
        } else {
          this.emit('extended-message', message.extId, message.payload);
        }
        break;
      }
      default:
        break;
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#handshakeResolve?.(false);
    this.#handshakeResolve = null;
    this.emit('error', error);
    this.emit('close');
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export { BLOCK_SIZE };

/** 生成一个看起来像正常客户端的 peerId（Azureus 风格）。 */
export function generatePeerId(prefix = '-BG1100-'): Uint8Array {
  const random = new Uint8Array(12);
  for (let i = 0; i < random.length; i += 1) random[i] = Math.floor(Math.random() * 256);
  const text = `${prefix}${[...random].map((byte) => String.fromCharCode(33 + (byte % 90))).join('')}`;
  return new TextEncoder().encode(text.slice(0, 20).padEnd(20, '0'));
}
