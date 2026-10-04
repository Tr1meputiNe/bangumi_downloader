import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  /** 已经自动重试过几次。 */
  retries: number;
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
  /** config.json 的路径（跨进程去重用）。 */
  configPath?: string;
  /** 覆盖下载实现（测试用）。 */
  dispatch?: typeof dispatchDownload;
  /**
   * 队列落盘的位置（例如 data/queue.json）。
   *
   * 为什么要落盘：队列原来只在内存里，程序一重启（更新、崩溃、计划任务重启）
   * 没下完和排队的任务就全没了 —— 实测被用户连着抓到两次
   * 「我添加的任务怎么没了」。数据在磁盘上（已校验的分片会跳过重下），
   * 只要把「待办」记住，重启后自动续上即可。
   */
  statePath?: string;
};

const MAX_MESSAGES = 40;
const MAX_FINISHED_JOBS = 50;
/** 有进度的失败最多自动重试几次（每次都会从已校验的分片接着下）。 */
const MAX_RETRIES = 3;
/** 自动重试前的等待，给 peer 一点轮换的时间。 */
const RETRY_DELAY_MS = 60_000;
/** 队列文件里最多保留多少条待办。 */
const MAX_PERSISTED = 30;

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
  /**
   * 把还没跑完的任务写进磁盘，重启后能接着跑。
   *
   * 只记「待办」：queued / running / paused 三种。已完成、失败、取消的不记。
   */
  #persist(): void {
    const path = this.#deps.statePath;
    if (!path) return;
    const pending = [...this.#jobs.values()]
      .filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'paused')
      .slice(-MAX_PERSISTED)
      .map((job) => ({
        title: job.title,
        magnet: job.magnet,
        torrentUrl: job.torrentUrl,
        episodes: job.episodes,
        sizeBytes: job.totalBytes ?? undefined,
        downloadedBytes: job.downloadedBytes,
        retries: job.retries,
        // 重启后 running 的也要重新排队（原来是哪个进程在跑已经没了）
        status: job.status === 'running' ? 'queued' : job.status
      }));
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ version: 1, jobs: pending }, null, 2)}\n`, 'utf8');
    } catch (error) {
      log.warn(`队列落盘失败：${(error as Error).message}`);
    }
  }

  /**
   * 从磁盘恢复上次没跑完的任务（程序启动时调一次）。
   *
   * 恢复出来的任务会标注「程序重启后自动恢复」，进度从已校验的分片继续。
   */
  restore(): number {
    const path = this.#deps.statePath;
    if (!path || !existsSync(path)) return 0;
    let saved: Array<Partial<EnqueueInput> & { status?: string }> = [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { jobs?: unknown };
      saved = Array.isArray(parsed.jobs) ? (parsed.jobs as typeof saved) : [];
    } catch (error) {
      log.warn(`队列文件解析失败，忽略：${(error as Error).message}`);
      return 0;
    }

    let restored = 0;
    for (const item of saved) {
      if (typeof item.title !== 'string' || item.title === '') continue;
      if (!item.magnet && !item.torrentUrl) continue;
      // 已经在队列里的（同标题同磁力）不重复加
      const exists = [...this.#jobs.values()].some(
        (job) => job.title === item.title && job.magnet === (item.magnet ?? '') && job.status !== 'cancelled'
      );
      if (exists) continue;

      const job = this.enqueue({
        title: item.title,
        magnet: item.magnet,
        torrentUrl: item.torrentUrl,
        episodes: item.episodes,
        sizeBytes: item.sizeBytes
      });
      if (job.status === 'paused') job.status = 'queued';
      this.#note(job, '程序重启后自动恢复（已校验的分片不会重下）');
      restored += 1;
    }
    if (restored > 0) log.info(`从队列文件恢复了 ${restored} 个没下完的任务`);
    return restored;
  }

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
      retries: 0,
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
    this.#persist();
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
    if (job.status !== status) queueMicrotask(() => this.#persist());
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
      const dispatch = this.#deps.dispatch ?? dispatchDownload;
      const result = await dispatch(
        {
          config: this.#deps.config,
          configPath: this.#deps.configPath,
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
      } else if (this.#shouldRetry(job, message)) {
        /*
         * 有进度的失败先自动重试，别直接判死。
         *
         * 实测：6.2GB 的一集下到 95.6% 时因为「单条 1 小时上限」被放弃，
         * 数据都在磁盘上（已校验的分片会跳过重下），只要再来一轮就能接着下完。
         * 用户对速度没有要求，凭「挂了一次」就把 6GB 丢在一边是纯浪费。
         * 重试次数和退避都是有限的，并且要求「这一轮确实拿到了东西」，
         * 免得在一条彻底下不动的种子上无限打转。
         */
        job.retries += 1;
        this.#note(
          job,
          `失败：${message} —— 已经下到 ${((job.ratio ?? 0) * 100).toFixed(1)}%，${RETRY_DELAY_MS / 1000} 秒后自动重试` +
            `（第 ${job.retries}/${MAX_RETRIES} 次，已校验的分片不会重下）`
        );
        log.warn(`任务 ${job.id} 中断（${message}），${RETRY_DELAY_MS / 1000} 秒后自动重试第 ${job.retries} 次`);
        job.error = message;
        this.#setStatus(job, 'queued');
        job.startedAt = null;
        setTimeout(() => {
          if (job.status === 'queued' && job.lastStop !== 'cancelled') void this.#drain();
        }, RETRY_DELAY_MS);
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

  /**
   * 这次失败该不该自动重试。
   *
   * 条件：还有重试次数；这一轮至少拿到过一点数据（说明种子是活的，只是被打断了）；
   * 用户没有主动取消/暂停。
   */
  #shouldRetry(job: DownloadJob, message: string): boolean {
    if (job.retries >= MAX_RETRIES) return false;
    if (job.lastStop === 'cancelled' || job.lastStop === 'paused') return false;
    if (job.downloadedBytes <= 0) return false;
    // 明显的配置/环境错误没必要重试
    if (/没有可下载的候选|不支持|未初始化|savePath/.test(message)) return false;
    return true;
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
