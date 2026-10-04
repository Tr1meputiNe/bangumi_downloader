import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config.js';
import type { QbittorrentClient } from '../qbittorrent/client.js';
import { dispatchDownload } from './dispatch.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('jobs');

/**
 * 下载任务队列。
 *
 * 为什么需要：Web 界面原本是「点一下 → 同步等下载完成 → 才返回 HTTP 响应」。
 * 而下载可能试很多条候选、持续几十分钟甚至几小时（跨境 peer 慢的时候更久），
 * 于是表现是：浏览器转圈、没有任何进度、最后超时，用户完全不知道发生了什么。
 * 实测用一条无效磁力就能把请求挂到客户端超时。
 *
 * 现在改成：请求进来立刻入队并返回任务号，前端轮询 /api/jobs 看进度。
 */

export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** 用户能对任务做的操作。 */
export type JobAction = 'pause' | 'resume' | 'cancel';

export type ActionResult = {
  ok: boolean;
  /** 操作后任务的状态。 */
  status?: JobStatus;
  /** 不能操作时说明原因，前端可直接提示。 */
  reason?: string;
};

export type DownloadJob = {
  id: string;
  title: string;
  status: JobStatus;
  /** 下载用的链接（磁力优先，其次种子直链）。 */
  magnet: string;
  torrentUrl: string;
  /** 只下这些集；留空整包。 */
  episodes: number[];
  /** 入队时间（ISO）。 */
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 0~1，未知时为 null。 */
  ratio: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  /** 字节/秒。 */
  speed: number;
  peers: number;
  /** 最近若干条日志，最新的在后。 */
  messages: string[];
  /** 落盘的文件，完成后才有。 */
  files: string[];
  /** 失败原因。 */
  error: string | null;
  /** 这条任务由哪个后端处理。 */
  backend: string;
  /**
   * 上次为什么停下（暂停/取消）。
   *
   * 需要它是因为「用户主动暂停」和「下载器自己超时」都会走到同一个 catch，
   * 不记下来就会把暂停显示成失败。
   */
  lastStop?: 'paused' | 'cancelled' | null;
};

export type EnqueueInput = {
  title: string;
  magnet?: string;
  torrentUrl?: string;
  sizeBytes?: number | null;
  tracker?: string;
  episodes?: number[];
};

type JobDeps = {
  config: AppConfig;
  /** qbittorrent 后端才需要。 */
  qbittorrent?: QbittorrentClient;
};

const MAX_MESSAGES = 40;
const MAX_FINISHED_JOBS = 50;

export class JobQueue extends EventEmitter {
  #jobs = new Map<string, DownloadJob>();
  #pending: string[] = [];
  #running = false;
  #deps: JobDeps;
  #counter = 0;
  /** 每个运行中任务一个控制器：暂停/取消就是 abort 它。 */
  #controllers = new Map<string, AbortController>();
  /** 每个任务的下载进度，暂停续传时用来判断「有没有真的接着下」。 */
  #progress = new Map<string, number>();

  constructor(deps: JobDeps) {
    super();
    this.#deps = deps;
  }

  /** 入队一条下载任务，立刻返回任务对象（不等待下载）。 */
  enqueue(input: EnqueueInput): DownloadJob {
    const job: DownloadJob = {
      id: `job-${++this.#counter}-${Date.now().toString(36)}`,
      title: input.title,
      status: 'queued',
      magnet: input.magnet ?? '',
      torrentUrl: input.torrentUrl ?? '',
      episodes: input.episodes ?? [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      ratio: null,
      downloadedBytes: 0,
      totalBytes: input.sizeBytes ?? null,
      speed: 0,
      peers: 0,
      messages: [],
      files: [],
      error: null,
      backend: String(this.#deps.config.download.backend ?? 'builtin')
    };

    this.#jobs.set(job.id, job);
    this.#pending.push(job.id);
    this.#trimFinished();
    log.info(`任务入队：${job.id}（${input.title.slice(0, 60)}）`);

    // 不 await：立即把控制权还给 HTTP 处理
    void this.#drain();
    return job;
  }

  list(): DownloadJob[] {
    // 新的在前，前端好显示
    return [...this.#jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  get(id: string): DownloadJob | undefined {
    return this.#jobs.get(id);
  }

  /**
   * 暂停 / 继续 / 取消。
   *
   * 三个操作都作用在同一个 AbortController 上：
   *   - pause：abort 掉当前这次下载（引擎会关连接、保留已校验的分片），并记住「是用户暂停的」
   *   - resume：重新入队；引擎启动时会 resumeScan，跳过已下好的分片接着下
   *   - cancel：abort 并标记结束，不再重排
   * 因为 abort 和「超时」在引擎里走的是同一条路，所以必须显式记下 lastStop，
   * 否则用户暂停会被显示成下载失败。
   */
  act(id: string, action: JobAction): ActionResult {
    const job = this.#jobs.get(id);
    if (!job) return { ok: false, reason: '任务不存在' };

    if (action === 'pause') {
      if (job.status === 'paused') return { ok: false, reason: '已经是暂停状态' };
      if (job.status === 'queued') {
        this.#pending = this.#pending.filter((item) => item !== id);
        job.lastStop = 'paused';
        this.#setStatus(job, 'paused');
        this.#note(job, '已暂停（还没开始下载）');
        return { ok: true, status: 'paused' };
      }
      if (job.status !== 'running') return { ok: false, reason: '任务已经结束了' };

      job.lastStop = 'paused';
      /*
       * 立刻置为 paused，不等引擎真的退出。
       *
       * 引擎可能在「获取元数据」这种阶段要等几十秒到两分钟才响应 abort，
       * 如果状态等它，用户点了暂停会看到按钮没反应、状态还是「下载中」。
       * 后台的 #run 收尾时会看到 lastStop === 'paused'，不会覆盖成失败。
       */
      this.#setStatus(job, 'paused');
      this.#note(job, '已暂停（已下好的分片会保留，点继续接着下）');
      this.#controllers.get(id)?.abort();
      return { ok: true, status: 'paused' };
    }

    if (action === 'resume') {
      if (job.status !== 'paused') return { ok: false, reason: '只有暂停中的任务可以继续' };
      job.lastStop = null;
      job.error = null;
      this.#note(job, '已继续，正在从已有进度接着下…');
      this.#setStatus(job, 'queued');
      this.#pending.push(id);
      void this.#drain();
      return { ok: true, status: 'queued' };
    }

    // cancel
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false, reason: '任务已经结束了' };
    }
    this.#pending = this.#pending.filter((item) => item !== id);
    job.lastStop = 'cancelled';
    // 同上：状态立刻生效，后台收尾时不会把它改成 failed
    this.#setStatus(job, 'cancelled');
    this.#note(job, '已取消');
    job.finishedAt = new Date().toISOString();
    this.#controllers.get(id)?.abort();
    return { ok: true, status: 'cancelled' };
  }

  /** 兼容旧调用点。 */
  cancel(id: string): boolean {
    return this.act(id, 'cancel').ok;
  }

  /**
   * 清掉已经结束的任务记录，返回清掉几条。
   *
   * 只删 completed / failed / cancelled —— 暂停中的任务还留着进度，
   * 删掉记录会让用户以为下好的东西没了。
   */
  clearFinished(): number {
    let removed = 0;
    for (const [id, job] of [...this.#jobs]) {
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        this.#jobs.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) log.info(`已清理 ${removed} 条结束的任务记录`);
    return removed;
  }

  #setStatus(job: DownloadJob, status: JobStatus): void {
    job.status = status;
    this.emit('update', job);
  }

  get running(): boolean {
    return this.#running;
  }

  get size(): number {
    return this.#jobs.size;
  }

  /** 顺序处理队列。一次只跑一个：同时跑多个会互相抢带宽，也让进度难以理解。 */
  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    try {
      while (this.#pending.length > 0) {
        const id = this.#pending.shift();
        if (!id) continue;
        const job = this.#jobs.get(id);
        if (!job || job.status !== 'queued') continue;
        await this.#run(job);
      }
    } finally {
      this.#running = false;
      this.emit('idle');
    }
  }

  async #run(job: DownloadJob): Promise<void> {
    this.#setStatus(job, 'running');
    if (!job.startedAt) job.startedAt = new Date().toISOString();
    this.#note(job, `开始下载：${job.title.slice(0, 70)}`);

    const controller = new AbortController();
    this.#controllers.set(job.id, controller);
    // 续传时要能分辨「这次真的又下到了东西」还是「一上来就被暂停/取消」
    const bytesAtStart = job.downloadedBytes;

    try {
      const hooks = jobHooks(job, (bytes) => this.#progress.set(job.id, bytes));
      const result = await dispatchDownload(
        {
          config: this.#deps.config,
          qbittorrent: this.#deps.qbittorrent,
          signal: controller.signal,
          onLog: hooks.onLog,
          onProgress: hooks.onProgress
        },
        {
          title: job.title,
          magnet: job.magnet,
          torrentUrl: job.torrentUrl,
          sizeBytes: job.totalBytes,
          episodes: job.episodes
        }
      );

      this.#setStatus(job, 'completed');
      job.files = result.files ?? [];
      job.ratio = 1;
      this.#note(
        job,
        `完成：${job.files.length} 个文件` + (result.fileCount !== null ? `（${result.fileCount}）` : '')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const gained = Math.max(0, job.downloadedBytes - bytesAtStart);

      if (job.lastStop === 'paused') {
        this.#setStatus(job, 'paused');
        this.#note(job, '已暂停，点继续会从这里接着下');
      } else if (job.lastStop === 'cancelled') {
        this.#setStatus(job, 'cancelled');
      } else {
        this.#setStatus(job, 'failed');
        job.error = message;
        this.#note(job, `失败：${message}`);
        log.warn(`任务 ${job.id} 失败：${message}`);
      }
      if (gained > 0) this.#note(job, `本轮新增 ${(gained / 1048576).toFixed(1)} MB（会保留）`);
    } finally {
      this.#controllers.delete(job.id);
      this.#progress.delete(job.id);
      if (job.status !== 'paused' && job.status !== 'queued') {
        job.finishedAt = new Date().toISOString();
      }
      this.#trimFinished();
    }
  }

  #note(job: DownloadJob, message: string): void {
    job.messages.push(message);
    if (job.messages.length > MAX_MESSAGES) job.messages.splice(0, job.messages.length - MAX_MESSAGES);
    this.emit('update', job);
  }

  /** 只保留最近若干个已结束的任务，避免长时间运行后内存里堆一堆。 */
  #trimFinished(): void {
    const finished = [...this.#jobs.values()]
      .filter((job) => job.status !== 'queued' && job.status !== 'running' && job.status !== 'paused')
      .sort((a, b) => {
        const left = a.finishedAt ?? a.createdAt;
        const right = b.finishedAt ?? b.createdAt;
        return left < right ? 1 : -1;
      });

    while (finished.length > MAX_FINISHED_JOBS) {
      const oldest = finished.pop();
      if (oldest) this.#jobs.delete(oldest.id);
    }
  }
}

/** 给任务挂上下载器回调用的辅助（把引擎的 onProgress/onLog 接到任务上）。 */
export function jobHooks(
  job: DownloadJob,
  onBytes?: (downloadedBytes: number) => void
): {
  onLog: (message: string) => void;
  onProgress: (progress: { ratio: number; downloadedBytes: number; totalBytes: number; speed: number; peers: number }) => void;
} {
  let lastNote = 0;
  return {
    onLog: (message: string) => {
      job.messages.push(message);
      if (job.messages.length > MAX_MESSAGES) job.messages.splice(0, job.messages.length - MAX_MESSAGES);
    },
    onProgress: (progress) => {
      job.ratio = progress.ratio;
      job.downloadedBytes = progress.downloadedBytes;
      onBytes?.(progress.downloadedBytes);
      job.totalBytes = progress.totalBytes;
      job.speed = progress.speed;
      job.peers = progress.peers;
      // 进度太频繁就不写日志了，只更新数值
      const now = Date.now();
      if (now - lastNote > 60_000) {
        lastNote = now;
        job.messages.push(
          `进度 ${(progress.ratio * 100).toFixed(1)}%（${formatSize(progress.downloadedBytes)}/${formatSize(progress.totalBytes)}）`
        );
      }
    }
  };
}
