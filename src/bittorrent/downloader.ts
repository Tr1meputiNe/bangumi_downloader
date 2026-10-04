import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BLOCK_SIZE, PeerConnection, generatePeerId, hexToBytes, type PeerMessage } from './peer.js';
import { fetchMetadataFromPeer, sleep } from './metadata.js';
import { DhtClient } from './dht.js';
import { announce, type PeerAddress } from './tracker.js';
import { PUBLIC_TRACKERS } from './public-trackers.js';
import { hasContent, metaFromInfoBytes, parseMagnet, parseTorrentFile, pieceSize, type TorrentMeta } from './metainfo.js';
import { TorrentStorage } from './storage.js';
import { logger } from '../util/log.js';

const log = logger('bt');

/**
 * 下载引擎。
 *
 * 一次 download() 的完整流程：
 *   1. 元数据：给了 .torrent 就解析；只有磁力就先从 peer 那里用 BEP 9 抓 info 字典
 *   2. 找 peer：tracker（HTTP/UDP）+ DHT 并行，先到先用
 *   3. 调度：按「拥有者最少优先」给 peer 派 block，收齐一个 piece 就校验，过了才落盘
 *   4. 收尾：全部需要的 piece 都校验通过才算成功（endgame 阶段会把同一 block 派给多个 peer）
 *
 * 起一个本地监听端口用于接收别人主动连进来的 peer（只需要解析握手，不做上传）。
 */

export type DownloadOptions = {
  /** 磁力链接或 .torrent 文件内容，二选一。 */
  magnet?: string;
  torrentFile?: Uint8Array;
  savePath: string;
  /** 只下载这些文件序号；为空表示全部。 */
  selectedFiles?: number[];
  /** 所有番剧文件夹的统一父目录（例如「番剧」）。 */
  seriesRoot?: string;
  /** 单文件种子用的番剧目录名（通常传发布名），避免单集散在根目录。 */
  singleFileDir?: string;
  /** 整体超时（毫秒），超时抛错。默认 30 分钟。 */
  timeoutMs?: number;
  /** 多长时间没有任何新 piece 完成就认为卡住，默认 90 秒。 */
  stallTimeoutMs?: number;
  signal?: AbortSignal;
  /** 进度回调，节流后调用。 */
  onProgress?: (progress: DownloadProgress) => void;
  /** 拿到元数据后回调一次（此时才知道文件清单）。 */
  onMetadata?: (meta: TorrentMeta) => void;
  /** 日志行回调（用于把进度写进任务日志）。 */
  onLog?: (message: string) => void;
  /** 是否使用 DHT，默认 true。 */
  useDht?: boolean;
  /** 监听端口，0 表示随机。 */
  listenPort?: number;
  /** 单个 block 多久没回来就重排（毫秒），默认 45 秒。慢速 swarm 需要放宽。 */
  blockTimeoutMs?: number;
  /** 每条连接允许的在途 block 数，默认 64。 */
  pipelineDepth?: number;
  /**
   * 元数据缓存目录。
   *
   * 拿到 info 字典后存一份到 <cacheDir>/<infohash>.bin，下次要判断
   * 「这个候选是不是已经下过一半」时就不用再联网找一遍 peer 了 ——
   * 磁力链接本身不含文件名，没有这份缓存就无法在离线状态下定位下载目录。
   */
  metadataCacheDir?: string;
};

export type DownloadProgress = {
  /** 0~1。 */
  ratio: number;
  /** 已校验通过的字节数（真实进度，预分配不算）。 */
  downloadedBytes: number;
  /**
   * 累计**收到**的字节数（含还没凑成分片的 block）。
   *
   * 判断「这条链路有没有速度」必须用它，不能用 downloadedBytes ——
   * 分片动辄 2MB，慢链路 75 秒一个分片都凑不齐，按分片算永远是 0 KB/s，
   * 于是候选被判成「下不动」扔掉，下一轮再来一遍，永远下不完。
   */
  receivedBytes: number;
  totalBytes: number;
  /** 已校验通过的 piece 数。 */
  piecesDone: number;
  piecesTotal: number;
  /** 当前连上的 peer 数。 */
  peers: number;
  /** 瞬时速度（字节/秒）。 */
  speed: number;
  etaSeconds: number | null;
};

export type DownloadResult = {
  infoHash: string;
  name: string;
  savePath: string;
  files: string[];
  totalBytes: number;
  bytesWritten: number;
  elapsedMs: number;
};

type PendingBlock = {
  piece: number;
  begin: number;
  length: number;
};

type PeerState = {
  connection: PeerConnection;
  /** 已派出去、还没回来的 block。 */
  inFlight: Set<string>;
  /** 是否已经对这条连接发过 interested。 */
  interestedSent: boolean;
  /** 连接建立时间，用来给「迟迟不宣告 piece 的 peer」一个宽限期。 */
  connectedAt: number;
  /** 本连接累计的有效下载字节。 */
  goodBytes: number;
  /** 校验失败的次数，用来决定是否踢掉。 */
  badPieces: number;
  lastUsefulAt: number;
};

export class TorrentDownloader extends EventEmitter {
  #options: DownloadOptions;
  #meta: TorrentMeta | null = null;
  #storage: TorrentStorage | null = null;
  /** 「还没下完」标记文件的路径（下完要删掉）。 */
  #markerPath: string | null = null;
  /**
   * 每个分片已经收到的 block（begin -> 数据）。
   *
   * **必须按分片存，不能按 peer 存** —— 这是踩过的一个大坑：
   * 同一个分片的 block 经常来自多个 peer（多连接并行、endgame 重复请求），
   * 原来把缓冲挂在 peer 上，于是凑齐时只用「最后一个 peer 自己那份」去拼，
   * 其余 peer 收到的 block 全是空的 → SHA1 必然不匹配 → 重新排队 → 再失败，
   * 表现就是「一直在收数据（几百 MB），已完成分片却几乎不涨」。
   */
  #pieceBuffers = new Map<number, Map<number, Uint8Array>>();
  #peers = new Map<string, PeerState>();
  #peerPool = new Map<string, PeerAddress>();
  #dht: DhtClient | null = null;
  #server: Server | null = null;
  #listenPort = 0;
  #peerId = generatePeerId();
  #aborted = false;
  #pieceQueues = new Map<number, PendingBlock[]>();
  #inflight = new Map<string, { peerKey: string; queuedAt: number }>();
  #queued = new Set<string>();
  #rarity = new Map<number, number>();
  #lastProgressAt = Date.now();
  #bytesSinceSample = 0;
  /** 整个过程累计收到的字节数（心跳里展示）。 */
  #receivedBytes = 0;
  #lastSampleAt = Date.now();
  #speed = 0;
  #lastHeartbeatAt = 0;
  /** 诊断计数：收到的 block 数、校验失败数、写盘失败数。 */
  #blocksReceived = 0;
  #verifyFailures = 0;
  #writeFailures = 0;
  /** 单个 block 多久没回来就重排（毫秒）。 */
  #blockTimeoutMs = 45_000;
  /** 每条连接允许的在途 block 数。 */
  #pipelineDepth = 64;
  /** 整次 download() 的截止时间，由 download() 设置，供各阶段共同遵守。 */
  #deadline = Number.POSITIVE_INFINITY;

  constructor(options: DownloadOptions) {
    super();
    this.#options = options;
    if (options.blockTimeoutMs && options.blockTimeoutMs > 0) this.#blockTimeoutMs = options.blockTimeoutMs;
    if (options.pipelineDepth && options.pipelineDepth > 0) this.#pipelineDepth = options.pipelineDepth;
  }

  get meta(): TorrentMeta | null {
    return this.#meta;
  }

  /**
   * 执行一次完整下载。
   *
   * timeoutMs 是**整件事**的上限，包含找 peer、取元数据这些前期阶段。
   * 早期版本只在数据下载的循环里检查 deadline，导致「元数据阶段卡住」时
   * 总耗时能远超调用方给的上限（实测一个 100 秒的探测跑了十几分钟不停）。
   */
  async download(): Promise<DownloadResult> {
    const startedAt = Date.now();
    const timeoutMs = this.#options.timeoutMs ?? 30 * 60_000;
    const deadline = startedAt + timeoutMs;
    this.#deadline = deadline;

    const abort = () => this.abort();
    this.#options.signal?.addEventListener('abort', abort, { once: true });

    // 一个到点就触发取消的定时器，兜住任何阶段（元数据、找 peer、调度）的长阻塞
    const hardTimer = setTimeout(() => this.abort(), timeoutMs);

    try {
      await this.#startListener();
      this.#meta = await this.#raceDeadline(this.#loadMetadata(), deadline, '获取种子元数据超时');
      const meta = this.#meta;
      if (!meta) throw new Error('无法获取种子元数据');
      if (!hasContent(meta)) throw new Error('种子内没有任何文件');

      this.#options.onMetadata?.(meta);
      this.#cacheMetadata(meta);

      /*
       * 默认排除「填充文件」。
       *
       * BitComet 之类的客户端会在种子里塞 _____padding_file_* 来对齐分片边界，
       * 内容全是 0，下了纯属浪费带宽和磁盘。qBittorrent 默认也是跳过的。
       * 用户显式指定了 selectedFiles 时以用户的为准，不覆盖他的选择。
       */
      const paddingIndexes = new Set(
        meta.files.filter((file) => isPaddingFile(file.path)).map((file) => file.index)
      );
      const explicit = this.#options.selectedFiles;
      const selectedFiles: number[] =
        explicit && explicit.length > 0
          ? explicit
          : meta.files.map((file) => file.index).filter((index) => !paddingIndexes.has(index));

      if (paddingIndexes.size > 0) {
        this.#log(`种子内含 ${paddingIndexes.size} 个填充文件（BitComet 对齐用），已自动跳过`);
      }

      this.#storage = new TorrentStorage(meta, {
        savePath: this.#options.savePath,
        selectedFiles: selectedFiles.length === meta.files.length ? undefined : selectedFiles,
        seriesRoot: this.#options.seriesRoot,
        singleFileDir: this.#options.singleFileDir
      });

      const wanted = this.#storage.wantedPieces();
      if (wanted.length === 0) throw new Error('选中的文件没有对应的分片，无法下载');

      /*
       * 落一个「还没下完」的标记文件。
       *
       * 为什么需要：存储层为了让断点续传能把文件预分配到完整长度，
       * 所以没下完的文件在资源管理器里**大小是满的** —— 双击播放必然报错，
       * 而人看到的只是「文件在、大小对、播不了」，很像文件损坏。
       * 实测就是这样的误会。留个明显的标记，打开目录一眼就知道原因；
       * 下完了就删掉。
       */
      this.#writeProgressMarker();

      const reused = this.#storage.resumeScan();
      if (reused > 0) {
        this.#log(`已有 ${reused} 个分片在磁盘上通过校验，跳过重下`);
      }

      this.#log(
        `开始下载《${meta.name}》：${meta.files.length} 个文件，` +
          `选中 ${this.#storage.files.filter((file) => file.selected).length} 个，` +
          `共 ${wanted.length} 个分片`
      );

      this.#buildPieceQueues(wanted);
      await this.#startDht(meta);
      void this.#announceAll(meta, 'started');
      void this.#collectPeers(meta);

      const stallTimeout = this.#options.stallTimeoutMs ?? 90_000;

      while (!this.#aborted) {
        if (this.#storage.verified.size >= wanted.length) break;

        if (Date.now() > deadline) throw new Error(`下载超时（${Math.round(timeoutMs / 1000)} 秒）`);
        if (Date.now() - this.#lastProgressAt > stallTimeout && this.#inflight.size === 0) {
          throw new Error(`下载停滞：${Math.round(stallTimeout / 1000)} 秒没有任何分片完成`);
        }

        this.#sampleSpeed();
        this.#dispatch();
        this.#reapStalledBlocks();
        this.#reportProgress(wanted.length);
        this.#heartbeat();
        await sleep(250);
      }

      if (this.#aborted) throw new Error(`下载超时或已取消（上限 ${Math.round(timeoutMs / 1000)} 秒）`);

      const elapsedMs = Date.now() - startedAt;
      const files = this.#storage.selectedPaths();
      const bytesWritten = this.#storage.bytesWritten;

      this.#clearProgressMarker();
      this.#log(`下载完成：${files.length} 个文件，用时 ${formatDuration(elapsedMs)}`);

      return {
        infoHash: meta.infoHash,
        name: meta.name,
        savePath: this.#storage.savePath,
        files,
        totalBytes: this.#storage.selectedBytes,
        bytesWritten,
        elapsedMs
      };
    } finally {
      clearTimeout(hardTimer);
      this.#options.signal?.removeEventListener('abort', abort);
      await this.#cleanup();
    }
  }

  /**
   * 写「还没下完」标记：直接放在内容目录里，用中文文件名，肉眼可见。
   *
   * 标记文件带实时进度，用户打开目录看到的第一眼就能明白为什么播不了。
   */
  #writeProgressMarker(): void {
    const storage = this.#storage;
    if (!storage || storage.files.length === 0) return;

    const first = storage.files.find((file) => file.selected) ?? storage.files[0];
    if (!first) return;
    const dir = dirname(first.absolutePath);

    try {
      mkdirSync(dir, { recursive: true });
      const marker = join(dir, '⚠ 还没下完，现在播放会失败.txt');
      const percent = ((storage.verified.size / Math.max(1, storage.wantedPieces().length)) * 100).toFixed(1);
      writeFileSync(
        marker,
        [
          '这个目录里的文件**还没下完**。',
          '',
          '文件大小看着是满的（存储层为了断点续传会预分配到完整长度），',
          '但里面大部分还是空的 —— 现在用播放器打开会报错，这不是文件损坏。',
          '',
          `进度：${storage.verified.size}/${storage.wantedPieces().length} 个分片（${percent}%）`,
          `更新时间：${new Date().toLocaleString()}`,
          '',
          '下完之后这个标记文件会自动消失。想确认真实进度，',
          '也可以在网页界面的「片库」页点「核对」（分片哈希校验，文件大小骗不了它）。'
        ].join('\n'),
        'utf8'
      );
      this.#markerPath = marker;
    } catch {
      /* 标记写不进去不影响下载 */
    }
  }

  #clearProgressMarker(): void {
    if (this.#markerPath === null) return;
    try {
      rmSync(this.#markerPath, { force: true });
    } catch {
      /* 删不掉也无所谓 */
    }
    this.#markerPath = null;
  }

  /** 把 info 字典存到缓存目录，供下次离线判断「是否已有进度」。 */
  #cacheMetadata(meta: TorrentMeta): void {
    const dir = this.#options.metadataCacheDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${meta.infoHash}.bin`), meta.infoBytes);
    } catch (error) {
      log.debug(`写元数据缓存失败（不影响下载）：${(error as Error).message}`);
    }
  }

  /** 让某个阶段也受总 deadline 约束：到点就抛错，不再无限等下去。 */
  async #raceDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(message);

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), remaining);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  abort(): void {
    if (this.#aborted) return;
    this.#aborted = true;
    for (const state of this.#peers.values()) state.connection.destroy();
    this.#peers.clear();
  }

  // ---------------------------------------------------------------- 元数据

  async #loadMetadata(): Promise<TorrentMeta | null> {
    if (this.#options.torrentFile) {
      const meta = parseTorrentFile(this.#options.torrentFile);
      if (meta) {
        this.#log(`读取种子文件成功：《${meta.name}》`);
        return meta;
      }
      this.#log('种子文件解析失败，改用磁力链接');
    }

    const magnetUri = this.#options.magnet;
    if (!magnetUri) throw new Error('既没有有效的种子文件，也没有磁力链接');

    const magnet = parseMagnet(magnetUri);
    if (!magnet) throw new Error('磁力链接格式不正确');

    this.#log(`磁力链接：${magnet.infoHash}`);

    return await this.#fetchMetadataFromPeers(magnet);
  }

  async #fetchMetadataFromPeers(magnet: NonNullable<ReturnType<typeof parseMagnet>>): Promise<TorrentMeta | null> {
    const infoHashBytes = hexToBytes(magnet.infoHash);
    this.#log('正在从 peer 获取种子元数据…');

    const trackerCandidates = new Map<string, PeerAddress>();
    const dhtCandidates = new Map<string, PeerAddress>();
    const addCandidate = (address: PeerAddress, source: 'tracker' | 'dht') => {
      if (address.port <= 0 || address.host === '0.0.0.0') return;
      const key = `${address.host}:${address.port}`;
      if (source === 'tracker') trackerCandidates.set(key, address);
      else if (!trackerCandidates.has(key)) dhtCandidates.set(key, address);
    };

    /**
     * tracker 先 announce，DHT 同时并行跑。
     *
     * 关键点：DHT 在公共网络里返回的地址绝大多数是连不上的（实测 40 个里能连上 2~3 个），
     * 而 tracker 返回的 peer 质量高得多。所以这里绝不能让 DHT 的查找「先跑完」，
     * 否则批次会被死 peer 占满，把真正能用的 peer 挤到很后面。
     */
    const trackerDone = this.#announceAllForMetadata(magnet, infoHashBytes, (address) => addCandidate(address, 'tracker'));

    if (this.#options.useDht !== false) {
      this.#dht = new DhtClient();
      void this.#dht
        .lookupPeers(infoHashBytes, {
          onPeers: (batch) => batch.forEach((address) => addCandidate(address, 'dht')),
          signal: this.#options.signal
        })
        .then((peers) => peers.forEach((address) => addCandidate(address, 'dht')))
        .catch((error: unknown) => log.debug(`DHT 查找失败：${(error as Error).message}`));
    }

    // 给 tracker 一点时间出结果，别一上来就拿 DHT 的死地址去撞
    await Promise.race([trackerDone, sleep(15_000)]);
    this.#log(`候选 peer：tracker ${trackerCandidates.size} 个，DHT ${dhtCandidates.size} 个`);

    // 元数据阶段同样是整件事的一部分，不能超出剩余的总额度
    const metadataDeadline = Math.min(Date.now() + 150_000, this.#deadline);
    const attempted = new Set<string>();
    let attemptCount = 0;
    let succeeded = 0;
    let connected = 0;
    let extHandshake = 0;

    while (Date.now() < metadataDeadline && !this.#aborted) {
      const all = [...trackerCandidates.values(), ...dhtCandidates.values()];
      const batch = all.filter((address) => !attempted.has(`${address.host}:${address.port}`)).slice(0, 6);
      if (batch.length === 0) {
        if (trackerCandidates.size === 0 && dhtCandidates.size === 0) {
          await Promise.race([trackerDone, sleep(2_000)]);
          await sleep(1_000);
          continue;
        }
        await sleep(500);
        continue;
      }

      for (const address of batch) attempted.add(`${address.host}:${address.port}`);

      // 抢答式：谁先成功用谁。按批等齐会被单个慢 peer 拖死（公共种子里死 peer 极多）。
      const attempts = batch.map(async (address) => {
        attemptCount += 1;
        const connection = await PeerConnection.connect({
          host: address.host,
          port: address.port,
          infoHash: infoHashBytes,
          peerId: this.#peerId,
          connectTimeoutMs: 8_000,
          listenPort: this.#listenPort,
          setup: (pending) => {
            // 元数据阶段用不到 piece/bitfield，挂个空监听即可
            pending.on('error', () => undefined);
            pending.on('extended', () => {
              extHandshake += 1;
            });
          }
        });
        connected += 1;

        try {
          const result = await fetchMetadataFromPeer(connection, infoHashBytes, {
            timeoutMs: 15_000,
            signal: this.#options.signal
          });
          succeeded += 1;
          return result;
        } catch (error) {
          log.debug(`peer ${address.host}:${address.port} 元数据失败：${(error as Error).message}`);
          connection.destroy();
          throw error;
        }
      });

      // 只要有一个 peer 给出元数据就走人，剩下的连接在后台自行超时销毁
      const winner = await Promise.any(attempts).catch(() => null);
      if (winner) {
        const meta = metaFromInfoBytes(winner.infoBytes, magnet.trackers, magnet.webSeeds);
        if (meta) {
          // 提供元数据的这条连接留着继续用
          this.#adoptPeer(winner.peer, meta);
          return meta;
        }
        winner.peer.destroy();
      }

      this.#log(
        `已尝试 ${attemptCount} 个 peer：TCP 握手成功 ${connected}，收到扩展握手 ${extHandshake}，元数据成功 ${succeeded}`
      );
    }

    throw new Error(`无法从 peer 获取元数据（尝试了 ${attemptCount} 个 peer）`);
  }

  // ---------------------------------------------------------------- peer 池

  async #startListener(): Promise<void> {
    await new Promise<void>((resolve) => {
      const server = createServer((socket) => {
        // 入站连接只用于可能的数据交换；握手由 PeerConnection 处理
        socket.setTimeout(0);
      });
      server.once('error', () => resolve());
      server.listen(this.#options.listenPort ?? 0, () => {
        const address = server.address();
        if (address && typeof address === 'object') this.#listenPort = address.port;
        server.close();
        // 关闭后端口就没了，这里只是探测可用端口；真正监听交给 PeerConnection 的出站连接
        resolve();
      });
      this.#server = server;
    });
  }

  async #startDht(meta: TorrentMeta): Promise<void> {
    if (this.#options.useDht === false) return;
    if (!this.#dht) this.#dht = new DhtClient();

    try {
      const infoHashBytes = hexToBytes(meta.infoHash);
      void this.#dht
        .lookupPeers(infoHashBytes, {
          rounds: 8,
          onPeers: (batch) => {
            for (const address of batch) this.#addPeer(address);
          },
          signal: this.#options.signal
        })
        .then((peers) => {
          for (const address of peers) this.#addPeer(address);
          this.#log(`DHT 累计提供 ${this.#peerPool.size} 个 peer 地址`);
        });
      void this.#dht.announcePeer(infoHashBytes, this.#listenPort);
    } catch (error) {
      log.debug(`DHT 启动失败：${(error as Error).message}`);
    }
  }

  async #announceAll(meta: TorrentMeta, event: 'started' | 'completed'): Promise<void> {
    const infoHashBytes = hexToBytes(meta.infoHash);
    const trackers = meta.trackers;
    if (trackers.length === 0) return;

    const remaining = Math.max(0, (this.#storage?.selectedBytes ?? meta.totalLength) - (this.#storage?.bytesWritten ?? 0));

    await Promise.all(
      trackers.map(async (tracker) => {
        const result = await announce(tracker, {
          infoHash: infoHashBytes,
          peerId: this.#peerId,
          port: this.#listenPort,
          uploaded: 0,
          downloaded: this.#storage?.bytesWritten ?? 0,
          left: remaining,
          event,
          timeoutMs: 12_000,
          signal: this.#options.signal
        });
        if (!result) return;
        for (const address of result.peers) this.#addPeer(address);
        if (event === 'started') {
          this.#log(
            `tracker ${shortTracker(tracker)} 返回 ${result.peers.length} 个 peer` +
              (result.seeders !== null ? `（做种 ${result.seeders}）` : '')
          );
        }
      })
    );
  }

  /**
   * 元数据阶段的 tracker announce。
   *
   * 除了磁力链接自带的 tracker，还要补一组公共 tracker：
   * animes.garden 给的磁力经常只带一两个 tracker，碰上它们没响应时
   * 「候选 peer 0 个」就会卡到超时 —— 而同一 infohash 在公共 tracker 上
   * 往往有一堆做种。（实测 Windows 上就是这个原因一直拿不到元数据。）
   */
  async #announceAllForMetadata(
    magnet: NonNullable<ReturnType<typeof parseMagnet>>,
    infoHashBytes: Uint8Array,
    onPeer: (address: PeerAddress) => void
  ): Promise<void> {
    const trackers = [...new Set([...magnet.trackers, ...PUBLIC_TRACKERS])];
    await Promise.all(
      trackers.map(async (tracker) => {
        const result = await announce(tracker, {
          infoHash: infoHashBytes,
          peerId: this.#peerId,
          port: this.#listenPort,
          uploaded: 0,
          downloaded: 0,
          left: 0,
          event: 'started',
          timeoutMs: 10_000,
          signal: this.#options.signal
        });
        if (!result) {
          this.#log(`tracker ${shortTracker(tracker)} 无返回`);
          return;
        }
        this.#log(`tracker ${shortTracker(tracker)} 提供 ${result.peers.length} 个 peer`);
        for (const address of result.peers) onPeer(address);
      })
    );
  }

  #addPeer(address: PeerAddress): void {
    if (address.port <= 0) return;
    const key = `${address.host}:${address.port}`;
    if (this.#peers.has(key)) return;
    // 地址池有上限，避免长时间运行时无限膨胀
    if (this.#peerPool.size > 2000) this.#peerPool.delete(this.#peerPool.keys().next().value as string);
    this.#peerPool.set(key, address);
  }

  async #collectPeers(meta: TorrentMeta): Promise<void> {
    // 持续补充 peer：每 60 秒再 announce 一轮，直到下载结束
    while (!this.#aborted && this.#storage && this.#storage.verified.size < this.#storage.wantedPieces().length) {
      await sleep(60_000);
      if (this.#aborted) return;
      const wantMore = this.#peers.size < 12;
      if (wantMore) {
        await this.#announceAll(meta, 'started').catch(() => undefined);
        if (this.#dht) {
          void this.#dht
            .lookupPeers(hexToBytes(meta.infoHash), { rounds: 3, onPeers: (batch) => batch.forEach((address) => this.#addPeer(address)) })
            .catch(() => undefined);
        }
      }
    }
  }

  /** 把已经从元数据阶段握好手的连接纳入调度。 */
  #adoptPeer(connection: PeerConnection, meta: TorrentMeta): void {
    const key = `${connection.host}:${connection.port}`;
    this.#peers.set(key, {
      connection,
      inFlight: new Set(),
      interestedSent: false,
      connectedAt: Date.now(),
      goodBytes: 0,
      badPieces: 0,
      lastUsefulAt: Date.now()
    });
    this.#wirePeer(key, connection);
    // 新连接需要重新宣告扩展握手（此时我们已经有 metadata_size 了）
    connection.sendExtendedHandshake(meta.infoBytes.length);
  }

  /** 最多同时维持多少条连接。再多收益很小，反而拖慢调度与内存。 */
  static readonly MAX_CONNECTIONS = 80;

  async #connectPeers(): Promise<void> {
    if (!this.#meta || this.#aborted) return;

    const room = TorrentDownloader.MAX_CONNECTIONS - this.#peers.size - this.#connecting.size;
    if (room <= 0) return;

    const batch = [...this.#peerPool.entries()]
      .filter(([key]) => !this.#peers.has(key) && !this.#connecting.has(key))
      .slice(0, Math.min(room * 2, 40));
    if (batch.length === 0) return;

    const infoHashBytes = hexToBytes(this.#meta.infoHash);

    for (const [key, address] of batch) {
      this.#connecting.add(key);
      void (async () => {
        // setup 在 connect() 返回前同步执行：此时就必须把状态登记好并挂上监听，
        // 否则对端跟 BT 握手挤在一个包里的 bitfield 会被丢掉，导致「连上了但一个 piece 都下不动」
        const state: PeerState = {
          connection: null as unknown as PeerConnection,
          inFlight: new Set(),
          interestedSent: false,
          connectedAt: Date.now(),
          goodBytes: 0,
          badPieces: 0,
          lastUsefulAt: Date.now()
        };

        try {
          const connection = await PeerConnection.connect({
            host: address.host,
            port: address.port,
            infoHash: infoHashBytes,
            peerId: this.#peerId,
            connectTimeoutMs: 10_000,
            listenPort: this.#listenPort,
            setup: (pending) => {
              state.connection = pending;
              this.#peers.set(key, state);
              this.#wirePeer(key, pending);
            }
          });
          if (this.#aborted) {
            connection.destroy();
            return;
          }
          connection.sendExtendedHandshake(this.#meta?.infoBytes.length ?? null);
        } catch {
          if (this.#peers.get(key) === state) this.#peers.delete(key);
        } finally {
          this.#connecting.delete(key);
        }
      })();
    }
  }

  #connecting = new Set<string>();

  #wirePeer(key: string, connection: PeerConnection): void {
    connection.on('unchoke', () => this.#dispatch());
    connection.on('have', (index: number) => {
      if (this.#pieceQueues.has(index)) this.#refreshRarity();
      this.#dispatch();
    });
    connection.on('bitfield', () => {
      this.#refreshRarity();
      this.#dispatch();
    });
    connection.on('choke', () => {
      // 被 choke 后之前发出去的 request 不会再有回应，必须收回重排，否则在途计数会被永久占满
      const state = this.#peers.get(key);
      if (!state) return;
      for (const blockKeyValue of [...state.inFlight]) {
        state.inFlight.delete(blockKeyValue);
        this.#inflight.delete(blockKeyValue);
        this.#requeueBlock(blockKeyValue);
      }
      state.interestedSent = false;
      this.#dispatch();
    });
    connection.on('piece', (message: PeerMessage) => {
      if (message.type === 'piece') this.#onBlock(key, message.index, message.begin, message.block);
    });
    connection.on('error', () => this.#dropPeer(key, '连接错误'));
    connection.on('close', () => this.#dropPeer(key, '连接关闭'));
  }

  #dropPeer(key: string, reason: string): void {
    const state = this.#peers.get(key);
    if (!state) return;
    this.#peers.delete(key);
    for (const blockKey of state.inFlight) {
      const info = this.#inflight.get(blockKey);
      if (info) {
        this.#inflight.delete(blockKey);
        info.peerKey = '';
      }
      this.#requeueBlock(blockKey);
    }
    state.connection.destroy();
    log.debug(`peer ${key} 断开（${reason}），当前 ${this.#peers.size} 条连接`);
  }

  // ---------------------------------------------------------------- 调度

  #buildPieceQueues(wanted: number[]): void {
    if (!this.#storage) return;
    this.#pieceQueues.clear();

    for (const piece of wanted) {
      if (this.#storage.verified.has(piece)) continue;
      const size = pieceSize(this.#storage.meta, piece);
      const blocks: PendingBlock[] = [];
      for (let begin = 0; begin < size; begin += BLOCK_SIZE) {
        blocks.push({ piece, begin, length: Math.min(BLOCK_SIZE, size - begin) });
      }
      this.#pieceQueues.set(piece, blocks);
      for (const block of blocks) this.#queued.add(blockKey(piece, block.begin));
    }
    this.#refreshRarity();
  }

  #refreshRarity(): void {
    this.#rarity.clear();
    for (const piece of this.#pieceQueues.keys()) this.#rarity.set(piece, 0);
    for (const state of this.#peers.values()) {
      for (const index of state.connection.have) {
        const current = this.#rarity.get(index);
        if (current !== undefined) this.#rarity.set(index, current + 1);
      }
    }
  }

  /** 给空闲的 peer 派活。 */
  #dispatch(): void {
    if (!this.#storage || this.#aborted) return;

    const endgame = this.#countRemainingPieces() <= 2;

    for (const [key, state] of this.#peers) {
      const connection = state.connection;
      if (!connection.handshakeDone) continue;

      /*
       * 必须先宣告 interested 再等 unchoke。
       *
       * 之前的写法是「派到 block 之后才发 interested」，但被 choke 的 peer 根本派不到
       * block —— 于是永远不发 interested，peer 也就永远不 unchoke，双方互锁。
       * 实测表现：连上 152 个 peer、在途 block 恒为 0、一个分片都下不来。
       */
      if (connection.choked) {
        if (!state.interestedSent && state.connection.have.size > 0) {
          connection.send({ type: 'interested' });
          state.interestedSent = true;
        }
        continue;
      }

      // 有些客户端不会主动 unchoke 也不回 bitfield，这里补一次 interested 兜底
      if (!state.interestedSent) {
        connection.send({ type: 'interested' });
        state.interestedSent = true;
      }

      /*
       * 只给「明确告诉我们它有哪些 piece」的 peer 派活。
       *
       * 否则请求会被派给手里啥都没有、也不回应的连接（公共种子里这类极多），
       * 在途计数被它们占满，真正有数据的 peer 反而没活干 ——
       * 实测表现：在途 block 恒为 416、速度 0。
       * 对迟迟不宣告的 peer 只给很小的试探额度，避免连接完全闲置。
       */
      const knownPieces = connection.gotBitfield || connection.have.size > 0;
      if (!knownPieces && Date.now() - state.connectedAt < 15_000) continue;
      // 流水线要够深：国内 peer 往返延迟常在 200~400ms，32 个 block 根本喂不满带宽
      const maxInFlight = knownPieces ? (endgame ? 48 : this.#pipelineDepth) : 2;

      while (state.inFlight.size < maxInFlight) {
        const block = this.#nextBlockFor(connection, state, endgame);
        if (!block) break;

        const blockKeyValue = blockKey(block.piece, block.begin);
        state.inFlight.add(blockKeyValue);
        this.#inflight.set(blockKeyValue, { peerKey: key, queuedAt: Date.now() });
        this.#queued.delete(blockKeyValue);

        connection.send({ type: 'request', index: block.piece, begin: block.begin, length: block.length });
      }
    }

    void this.#connectPeers();
  }

  /** 选下一个给该 peer 的 block：拥有者最少优先，同分取序号小的。 */
  #nextBlockFor(connection: PeerConnection, state: PeerState, endgame: boolean): PendingBlock | null {
    let best: PendingBlock | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const [piece, blocks] of this.#pieceQueues) {
      if (!connection.have.has(piece)) continue;
      for (const block of blocks) {
        const key = blockKey(block.piece, block.begin);
        const inFlightBy = this.#inflight.get(key);
        if (inFlightBy) {
          // endgame 阶段允许重复请求同一个 block，谁先回来算谁的
          if (!endgame || inFlightBy.peerKey === '' || state.inFlight.has(key)) continue;
        } else if (!this.#queued.has(key)) {
          continue;
        }

        const score = (this.#rarity.get(piece) ?? 99) * 1000 + piece;
        if (score < bestScore) {
          bestScore = score;
          best = block;
        }
        break;
      }
    }

    return best;
  }

  #countRemainingPieces(): number {
    let remaining = 0;
    for (const [piece, blocks] of this.#pieceQueues) {
      if (blocks.length > 0) remaining += 1;
      void piece;
    }
    return remaining;
  }

  /**
   * 收到一个 block。
   *
   * 这里的状态机要小心：同一个分片的 block 可能同时被派给多个 peer
   * （endgame，或分片校验失败后重新排队），所以必须能容忍重复与迟到：
   *   - 分片已经校验通过 -> 直接丢弃；
   *   - 该 block 当前没人要（不在队列里）-> 丢弃；
   *   - 长度不符 -> 重新排队，不算 peer 的错。
   * 早先的实现没做这些判断，重复到达的 block 会和正在拼的缓冲串在一起，
   * 导致「刚拼好的分片又校验失败」，白下很多数据。
   */
  #onBlock(key: string, index: number, begin: number, block: Uint8Array): void {
    const state = this.#peers.get(key);
    if (!state || !this.#storage) return;

    const keyValue = blockKey(index, begin);
    this.#inflight.delete(keyValue);
    state.inFlight.delete(keyValue);

    if (this.#storage.verified.has(index)) return;

    const blocks = this.#pieceQueues.get(index);
    if (!blocks) return;

    const position = blocks.findIndex((item) => item.begin === begin);
    if (position < 0) return;

    const expected = blocks[position] as PendingBlock;
    if (expected.length !== block.length) {
      this.#queued.add(keyValue);
      return;
    }

    state.goodBytes += block.length;
    this.#blocksReceived += 1;
    /*
     * 速度按「收到的字节」算，不按「完成的分片」算。
     *
     * 踩过的坑：原来只在分片整块校验通过时累加，而分片动辄 2MB ——
     * 链路只有几十 KB/s 时一个分片要几十秒才完成，2 秒一次的采样永远读到 0，
     * 于是日志里一直是「速度 0.00 MB/s」，明明在下载却看着像死的。
     */
    this.#bytesSinceSample += block.length;
    this.#receivedBytes += block.length;
    blocks.splice(position, 1);

    let pieceBuffer = this.#pieceBuffers.get(index);
    if (!pieceBuffer) {
      pieceBuffer = new Map<number, Uint8Array>();
      this.#pieceBuffers.set(index, pieceBuffer);
    }
    pieceBuffer.set(begin, block);

    if (blocks.length > 0) return;

    // 全局队列空了 = 这个分片的 block 都到齐了（可能来自不同 peer）
    const assembled = this.#assemblePiece(index, pieceBuffer);
    this.#pieceBuffers.delete(index);

    if (assembled === null) {
      this.#verifyFailures += 1;
      this.#requeuePiece(index);
      return;
    }

    // 先落盘再登记 verified：写失败就退回队列重来
    try {
      this.#storage.writePiece(index, assembled);
    } catch (error) {
      this.#writeFailures += 1;
      this.#log(`分片 ${index} 写盘失败：${(error as Error).message}`);
      this.#requeuePiece(index);
      return;
    }

    this.#pieceQueues.delete(index);
    this.#rarity.delete(index);
    this.#lastProgressAt = Date.now();

    // 告诉别人我们有了这个 piece
    for (const other of this.#peers.values()) other.connection.send({ type: 'have', index });
  }

  /** 把收到的 block 拼成分片；缺失或长度不符时返回 null。 */
  #assemblePiece(index: number, pieceBuffer: Map<number, Uint8Array>): Uint8Array | null {
    if (!this.#storage) return null;
    const size = pieceSize(this.#storage.meta, index);
    const assembled = new Uint8Array(size);

    let cursor = 0;
    const ordered = [...pieceBuffer.entries()].sort((a, b) => a[0] - b[0]);
    for (const [blockBegin, data] of ordered) {
      if (blockBegin !== cursor) return null;
      if (cursor + data.length > size) return null;
      assembled.set(data, cursor);
      cursor += data.length;
    }

    if (cursor !== size) return null;
    return this.#storage.verify(index, assembled) ? assembled : null;
  }

  #requeuePiece(piece: number): void {
    if (!this.#storage) return;
    if (this.#storage.verified.has(piece)) return;
    // 校验失败说明收到的 block 有问题（或拼错了），整片缓冲一起丢掉重来
    this.#pieceBuffers.delete(piece);
    const size = pieceSize(this.#storage.meta, piece);
    const blocks: PendingBlock[] = [];
    for (let begin = 0; begin < size; begin += BLOCK_SIZE) {
      blocks.push({ piece, begin, length: Math.min(BLOCK_SIZE, size - begin) });
      this.#queued.add(blockKey(piece, begin));
    }
    this.#pieceQueues.set(piece, blocks);
  }

  #requeueBlock(keyValue: string): void {
    const [pieceText, beginText] = keyValue.split(':');
    const piece = Number(pieceText);
    const begin = Number(beginText);
    if (!Number.isFinite(piece) || !Number.isFinite(begin)) return;
    const blocks = this.#pieceQueues.get(piece);
    if (!blocks) return;
    if (!blocks.some((block) => block.begin === begin)) {
      const size = pieceSize((this.#storage as TorrentStorage).meta, piece);
      blocks.push({ piece, begin, length: Math.min(BLOCK_SIZE, size - begin) });
      blocks.sort((a, b) => a.begin - b.begin);
    }
    this.#queued.add(keyValue);
  }

  /**
   * 超时没回来的 block 收回重排。
   *
   * 公共种子里大量 peer 会「unchoke 但一个 block 都不给」，如果只等不催，
   * 在途计数会被它们占满，整条下载就停在那里。15 秒没动静就当作丢失。
   */
  #reapStalledBlocks(): void {
    const now = Date.now();
    const stalledPeers = new Map<string, number>();

    for (const [keyValue, info] of this.#inflight) {
      if (now - info.queuedAt < this.#blockTimeoutMs) continue;
      this.#inflight.delete(keyValue);
      const state = info.peerKey ? this.#peers.get(info.peerKey) : undefined;
      if (state) {
        state.inFlight.delete(keyValue);
        if (info.peerKey) stalledPeers.set(info.peerKey, (stalledPeers.get(info.peerKey) ?? 0) + 1);
      }
      this.#requeueBlock(keyValue);
    }

    // 连续多次只收不回、且一个 piece 都没给过的连接直接断掉，给有数据的 peer 腾位置
    for (const [key, count] of stalledPeers) {
      if (count < 16) continue;
      const state = this.#peers.get(key);
      if (!state) continue;
      if (state.goodBytes > 0) continue;
      this.#dropPeer(key, '多次请求无响应');
    }
  }

  #sampleSpeed(): void {
    const now = Date.now();
    const elapsed = now - this.#lastSampleAt;
    if (elapsed < 2_000) return;
    this.#speed = (this.#bytesSinceSample / elapsed) * 1000;
    this.#bytesSinceSample = 0;
    this.#lastSampleAt = now;
  }

  #reportProgress(totalPieces: number): void {
    if (!this.#storage || !this.#options.onProgress) return;
    const done = this.#storage.verified.size;
    const total = this.#storage.selectedBytes;
    const downloaded = this.#progressBytes();
    const eta = this.#speed > 0 ? Math.max(0, (total - downloaded) / this.#speed) : null;

    this.#options.onProgress({
      ratio: totalPieces === 0 ? 1 : done / totalPieces,
      downloadedBytes: downloaded,
      receivedBytes: this.#receivedBytes,
      totalBytes: total,
      piecesDone: done,
      piecesTotal: totalPieces,
      peers: this.#peers.size,
      speed: this.#speed,
      etaSeconds: eta
    });
  }

  #progressBytes(): number {
    if (!this.#storage) return 0;
    let bytes = 0;
    for (const piece of this.#storage.verified) {
      bytes += pieceSize(this.#storage.meta, piece);
    }
    return bytes;
  }

  #log(message: string): void {
    log.info(message);
    this.#options.onLog?.(message);
  }

  /** 每 10 秒打一次内部状态，排查「连上了但下不动」用。 */
  #heartbeat(): void {
    const now = Date.now();
    if (now - this.#lastHeartbeatAt < 10_000) return;
    this.#lastHeartbeatAt = now;

    let unchoked = 0;
    let inFlight = 0;
    let withBitfield = 0;
    for (const state of this.#peers.values()) {
      if (!state.connection.choked) unchoked += 1;
      inFlight += state.inFlight.size;
      if (state.connection.gotBitfield) withBitfield += 1;
    }

    // 正在拼的分片分布 + 具体缺哪些 block（能看出是不是固定位置永远收不到）
    const topPieces = [...this.#pieceQueues.entries()]
      .map(([piece, blocks]) => ({ piece, blocks }))
      .sort((a, b) => a.blocks.length - b.blocks.length)
      .slice(0, 4)
      .map((item) => {
        const missing = item.blocks.map((block) => block.begin).slice(0, 6).join(',');
        const inflightCount = item.blocks.filter((block) => this.#inflight.has(blockKey(item.piece, block.begin))).length;
        return `#${item.piece}差${item.blocks.length}(在途${inflightCount}:${missing})`;
      })
      .join(' ');

    this.#log(
      `状态：连接 ${this.#peers.size}（未阻塞 ${unchoked}，有 bitfield ${withBitfield}）｜` +
        `在途 block ${inFlight}｜待发 ${this.#queued.size}｜已完成分片 ${this.#storage?.verified.size ?? 0}｜` +
        `累计收到 ${(this.#receivedBytes / 1024 / 1024).toFixed(1)} MB / ${this.#blocksReceived} 个 block` +
        `（拼装失败 ${this.#verifyFailures}，写盘失败 ${this.#writeFailures}）｜` +
        `最接近完成：${topPieces || '（无）'}｜速度 ${(this.#speed / 1024 / 1024).toFixed(2)} MB/s`
    );
  }

  async #cleanup(): Promise<void> {
    for (const state of this.#peers.values()) state.connection.destroy();
    this.#peers.clear();
    this.#dht?.close();
    this.#dht = null;
    this.#storage?.close();
    if (this.#server) {
      try {
        this.#server.close();
      } catch {
        // 忽略
      }
      this.#server = null;
    }
  }
}

function blockKey(piece: number, begin: number): string {
  return `${piece}:${begin}`;
}

/** 是否是 BitComet 的对齐填充文件。 */
export function isPaddingFile(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return /^_*padding_file_/i.test(name) || /_____padding_file_/i.test(name);
}

function shortTracker(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}
