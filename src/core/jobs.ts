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

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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

  /** 取消：排队中的直接标掉；正在跑的只能标状态（下载器没有对外暴露取消）。 */
  cancel(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.messages.push('已取消（还没开始下载）');
      this.#pending = this.#pending.filter((item) => item !== id);
      return true;
    }
    if (job.status === 'running') {
      job.messages.push('已请求取消（等当前候选结束）');
      return true;
    }
    return false;
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
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.#note(job, `开始下载：${job.title.slice(0, 70)}`);

    try {
      const hooks = jobHooks(job);
      const result = await dispatchDownload(
        {
          config: this.#deps.config,
          qbittorrent: this.#deps.qbittorrent,
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

      job.status = 'completed';
      job.files = result.files ?? [];
      job.ratio = 1;
      this.#note(
        job,
        `完成：${job.files.length} 个文件` + (result.fileCount !== null ? `（${result.fileCount}）` : '')
      );
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      this.#note(job, `失败：${job.error}`);
      log.warn(`任务 ${job.id} 失败：${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
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
      .filter((job) => job.status !== 'queued' && job.status !== 'running')
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
export function jobHooks(job: DownloadJob): {
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
