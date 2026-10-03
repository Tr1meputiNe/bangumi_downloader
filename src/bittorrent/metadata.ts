import { createHash } from 'node:crypto';
import { PeerConnection, buildMetadataRequest, parseMetadataMessage } from './peer.js';
import { logger } from '../util/log.js';

const log = logger('bt-meta');

/**
 * BEP 9：从 peer 那里把 info 字典抓回来（磁力链接必需）。
 *
 * 流程：
 *   1. 完成 BT 握手（此时我们还不认识 info 字典里的任何字段）
 *   2. 发扩展握手，宣告 ut_metadata，并读对方的 metadata_size
 *   3. 按 16KB 分片依次请求（msg_type=0），收 msg_type=1 的数据
 *   4. 拼完后 SHA1 必须等于 infohash，否则这份元数据是脏的，丢掉重来
 *
 * metadata_size 要先知道才能分片。如果对方在扩展握手第一个包里没带，
 * 我们会等到它补齐；一般 peer 都会在握手后立刻发。
 */

const METADATA_PIECE_SIZE = 16 * 1024;
/** 对方回一个 metadata 分片最多等多久。 */
const PIECE_TIMEOUT_MS = 20_000;

export type MetadataResult = {
  infoBytes: Uint8Array;
  /** 提供元数据的 peer，之后可以优先复用这条连接下载。 */
  peer: PeerConnection;
};

/** 单条连接上抓取 info 字典。失败抛错。 */
export async function fetchMetadataFromPeer(
  peer: PeerConnection,
  infoHash: Uint8Array,
  options: { timeoutMs?: number; signal?: AbortSignal; onProgress?: (pieces: number, total: number) => void } = {}
): Promise<MetadataResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  const received = new Map<number, Uint8Array>();
  let totalSize = 0;
  let pieceCount = 0;

  /** 我们发请求时用对方宣告的 id；过滤入站消息时认我们自己宣告的 id。 */
  const localId = peer.localUtMetadataId;
  let remoteId = 0;

  /**
   * 监听必须在发出扩展握手**之前**挂上。
   *
   * 对方经常把「扩展握手 + 元数据数据」塞进同一个 TCP 段：
   * #onData 会同步地把这一批帧全部处理完，如果等 waitForExtendedHandshake()
   * 的 Promise 落地后再挂 extended-message，那条数据消息早就 emit 过且丢掉了 ——
   * 表现为「握手成功、扩展握手也收到了，但元数据永远不来」。
   */
  const onMessage = (extId: number, payload: Uint8Array): void => {
    if (process.env.BT_TRACE === '1') console.log(`[meta] onMessage extId=${extId} localId=${localId} len=${payload.length}`);
    if (extId !== localId) return;
    const parsed = parseMetadataMessage(payload);
    if (process.env.BT_TRACE === '1') {
      console.log(
        '[meta] parsed =',
        parsed === null ? 'null' : `msgType=${parsed.msgType} piece=${parsed.piece} totalSize=${parsed.totalSize} data=${parsed.data?.length ?? 'null'}`
      );
    }
    if (!parsed) return;
    if (parsed.msgType !== 1 || !parsed.data) return; // msg_type=2 是拒绝
    if (received.has(parsed.piece)) return;
    if (parsed.totalSize !== null && totalSize > 0 && parsed.totalSize !== totalSize) return;
    received.set(parsed.piece, parsed.data);
    if (process.env.BT_TRACE === '1') console.log(`[meta] 收下分片 ${parsed.piece}，已收 ${received.size}/${pieceCount}`);
    options.onProgress?.(received.size, pieceCount);
  };

  peer.on('extended-message', onMessage);

  try {
    peer.send({ type: 'interested' });
    peer.sendExtendedHandshake(null);

    // 等对方的扩展握手；对方没开扩展协议时这里会超时，交由调用方换下一个 peer
    const remainingMs = Math.max(1_000, Math.min(20_000, deadline - Date.now()));
    const extended = await peer.waitForExtendedHandshake(remainingMs);

    if (extended.utMetadataId === null || extended.metadataSize === null) {
      throw new Error('对方不支持 ut_metadata，无法获取元数据');
    }

    totalSize = extended.metadataSize;
    remoteId = extended.utMetadataId;

    if (totalSize <= 0 || totalSize > 16 * 1024 * 1024) {
      throw new Error(`metadata_size 不合理：${totalSize}`);
    }

    pieceCount = Math.ceil(totalSize / METADATA_PIECE_SIZE);

    for (let piece = 0; piece < pieceCount; piece += 1) {
      const requestedAt = Date.now();
      let sent = false;

      while (!received.has(piece)) {
        if (options.signal?.aborted) throw new Error('已取消');
        if (peer.closed) throw new Error('连接已断开');
        if (Date.now() > deadline) throw new Error('获取元数据超时');
        if (!sent || Date.now() - requestedAt > PIECE_TIMEOUT_MS) {
          peer.send({ type: 'extended', extId: remoteId, payload: buildMetadataRequest(piece) });
          sent = true;
          if (Date.now() - requestedAt > PIECE_TIMEOUT_MS * 3) {
            throw new Error(`分片 ${piece} 重试多次仍无响应`);
          }
        }
        await sleep(120);
      }
    }

    const assembled = assembleMetadata(received, pieceCount, totalSize);
    const hash = createHash('sha1').update(assembled).digest('hex');
    const expected = Buffer.from(infoHash).toString('hex');
    if (hash !== expected) {
      throw new Error(`元数据 SHA1 校验失败（得到 ${hash}，期望 ${expected}）`);
    }

    log.debug(`元数据获取成功：${totalSize} 字节，来自 ${peer.host}:${peer.port}`);
    return { infoBytes: assembled, peer };
  } finally {
    peer.off('extended-message', onMessage);
  }
}

function assembleMetadata(received: Map<number, Uint8Array>, pieceCount: number, totalSize: number): Uint8Array {
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (let piece = 0; piece < pieceCount; piece += 1) {
    const data = received.get(piece);
    if (!data) throw new Error(`缺少元数据分片 ${piece}`);
    const length = Math.min(data.length, totalSize - offset);
    out.set(data.subarray(0, length), offset);
    offset += length;
  }
  return out;
}

/** 传入的 peer 里已经有扩展握手信息时，直接用它提供的 metadata_size。 */
export function metadataSizeOf(peer: PeerConnection): number | null {
  return peer.extended?.metadataSize ?? null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
