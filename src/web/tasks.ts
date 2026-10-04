import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config.js';
import { runAuto, type AutoReport } from '../core/auto.js';
import { acquireLock } from '../core/lock.js';
import { loadCachedMetas, loadInventory, locateTorrent, relativePathOf, saveInventory, scanForLocalItems, verifyLocal, verifyTorrent, type TorrentVerifyReport } from '../core/verify.js';
import { sanitizeSegment } from '../bittorrent/storage.js';
import type { TorrentMeta } from '../bittorrent/metainfo.js';
import { describeIssue } from '../core/video-check.js';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('task');

/**
 * 后台任务（非下载类）。
 *
 * 为什么单独做一套：下载有 JobQueue，因为下载要显示进度条、能暂停续传。
 * 但「核对片库」和「立刻跑一轮追番」同样是很慢的操作 ——
 * 核对要逐个分片读盘，追番要搜种+下载，都可能是几分钟到几十分钟。
 * 如果 HTTP 请求同步等它们，界面就会像以前那样一直转圈。
 *
 * 所以这里给它们同一套「入队 → 立刻返回任务号 → 前端轮询」的模型。
 * 与 JobQueue 的区别是这些任务没有暂停续传语义，只需要进度和结果。
 */

export type TaskKind = 'verify' | 'auto';
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type BackgroundTask = {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string | null;
  /** 现在正在做什么（一行给人看的描述）。 */
  progress: string | null;
  /** 0~1；不知道总进度时为 null（界面显示不确定进度条）。 */
  ratio: number | null;
  /** 过程记录，最新的在后。 */
  lines: string[];
  error: string | null;
  /** 结果摘要，形状由各任务自己决定。 */
  result: unknown;
};

export type TaskContext = {
  signal: AbortSignal;
  /** 记一行过程日志（会显示在界面上）。 */
  note: (message: string) => void;
  /** 更新当前进度描述与百分比。 */
  step: (progress: string, ratio?: number | null) => void;
};

export type TaskInput = {
  kind: TaskKind;
  title: string;
  run: (context: TaskContext) => Promise<unknown>;
};

const MAX_TASKS = 20;
const MAX_LINES = 120;

export class TaskRunner {
  #tasks = new Map<string, BackgroundTask>();
  #controllers = new Map<string, AbortController>();
  #counter = 0;

  /** 新的在前。 */
  list(): BackgroundTask[] {
    return [...this.#tasks.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  get(id: string): BackgroundTask | undefined {
    return this.#tasks.get(id);
  }

  get running(): boolean {
    return [...this.#tasks.values()].some((task) => task.status === 'running');
  }

  /** 同类任务是否已经在跑（用于挡住重复点击）。 */
  isRunning(kind: TaskKind): boolean {
    return [...this.#tasks.values()].some((task) => task.kind === kind && task.status === 'running');
  }

  start(input: TaskInput): BackgroundTask {
    const task: BackgroundTask = {
      id: `task-${++this.#counter}-${Date.now().toString(36)}`,
      kind: input.kind,
      title: input.title,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: null,
      ratio: null,
      lines: [],
      error: null,
      result: null
    };

    this.#tasks.set(task.id, task);
    this.#trim();
    const controller = new AbortController();
    this.#controllers.set(task.id, controller);

    const context: TaskContext = {
      signal: controller.signal,
      note: (message) => this.#note(task, message),
      step: (progress, ratio = null) => {
        task.progress = progress;
        task.ratio = ratio;
      }
    };

    log.info(`任务开始：${task.id}（${task.title}）`);
    void (async () => {
      try {
        task.result = await input.run(context);
        task.status = controller.signal.aborted ? 'cancelled' : 'done';
        if (task.status === 'cancelled') this.#note(task, '已取消');
      } catch (error) {
        if (controller.signal.aborted) {
          task.status = 'cancelled';
          this.#note(task, '已取消');
        } else {
          task.status = 'failed';
          task.error = error instanceof Error ? error.message : String(error);
          this.#note(task, `失败：${task.error}`);
          log.warn(`任务 ${task.id} 失败：${task.error}`);
        }
      } finally {
        task.finishedAt = new Date().toISOString();
        this.#controllers.delete(task.id);
        log.info(`任务结束：${task.id}（${task.status}）`);
        this.#trim();
      }
    })();

    return task;
  }

  cancel(id: string): { ok: boolean; reason?: string } {
    const task = this.#tasks.get(id);
    if (!task) return { ok: false, reason: '任务不存在' };
    if (task.status !== 'running') return { ok: false, reason: '任务已经结束了' };
    this.#controllers.get(id)?.abort();
    return { ok: true };
  }

  #note(task: BackgroundTask, message: string): void {
    task.lines.push(message);
    if (task.lines.length > MAX_LINES) task.lines.splice(0, task.lines.length - MAX_LINES);
  }

  #trim(): void {
    const finished = [...this.#tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => ((a.finishedAt ?? a.startedAt) < (b.finishedAt ?? b.startedAt) ? 1 : -1));
    while (finished.length > MAX_TASKS) {
      const oldest = finished.pop();
      if (oldest) this.#tasks.delete(oldest.id);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 核对片库
 * ------------------------------------------------------------------ */

/** 核对结果里的一条，字段与前端展示一一对应。 */
export type VerifyReportView = {
  name: string;
  /** 相对下载目录的路径。 */
  path: string;
  /** 实际去找的绝对路径（找不到时就是「本该在哪」）。 */
  dir: string;
  /** 那个目录在不在。不在 = 还没下过；在但 empty = 下过但一个分片都没成。 */
  dirExists: boolean;
  source: 'torrent' | 'local';
  infoHash: string;
  ratio: number;
  pieceDone: number;
  pieceTotal: number;
  bytesDone: number;
  bytesTotal: number;
  nominalBytes: number;
  complete: boolean;
  empty: boolean;
  presentFiles: number;
  expectedFiles: number;
  videosChecked: number;
  videosUnplayable: number;
  videoIssues: Array<{ file: string; issues: string[] }>;
};

export type VerifyTaskResult = {
  /** 只核对了某一条时给出它的相对路径。 */
  target: string | null;
  reports: VerifyReportView[];
  removed: string[];
  cleanEmpty: boolean;
  scannedAt: string;
  totalBytes: number;
  completeCount: number;
  emptyCount: number;
  /** 目录不存在的项数（元数据还在、内容已被清理）。 */
  missingCount: number;
  unplayableCount: number;
};

export type VerifyTaskOptions = {
  /** 只核对这一条（相对下载目录的路径）。 */
  path?: string | null;
  /** 删掉「一个有效分片都没有」的空壳目录。 */
  cleanEmpty?: boolean;
  /** 是否做可播性抽检，默认做。 */
  checkPlayable?: boolean;
  /** 把下载目录里没记录过的内容（自己用别的工具下的）登记为本地内容。 */
  addLocal?: boolean;
};

function toVerifyView(report: TorrentVerifyReport): VerifyReportView {
  return {
    name: report.name,
    // 用核对时实际定位到的路径：清单里的老记录可能还指着旧位置
    path: report.relativePath === '' ? report.name : report.relativePath,
    dir: report.dir,
    dirExists: report.dirExists,
    source: report.source,
    infoHash: report.infoHash,
    ratio: Math.round(report.ratio * 1000) / 1000,
    pieceDone: report.pieceDone,
    pieceTotal: report.pieceTotal,
    bytesDone: report.bytesDone,
    bytesTotal: report.bytesTotal,
    nominalBytes: report.nominalBytes,
    complete: report.complete,
    empty: report.empty,
    presentFiles: report.presentFiles,
    expectedFiles: report.expectedFiles,
    videosChecked: report.videosChecked,
    videosUnplayable: report.videosUnplayable,
    videoIssues: report.videoIssues.map((item) => ({
      file: item.file,
      issues: item.issues.map((issue) => describeIssue(issue))
    }))
  };
}

/**
 * 跑一次片库核对。
 *
 * 这里没有直接调用 verifyAll：那个实现是「一口气跑完再返回」，
 * 界面上只能看到一个转圈的按钮、不知道进行到哪一条。这里逐条跑，
 * 每完成一条就汇报一次进度；顺带也支持「只核对选中的这一条」。
 */
export async function runVerifyTask(
  deps: { config: AppConfig },
  options: VerifyTaskOptions,
  context: TaskContext
): Promise<VerifyTaskResult> {
  const savePath = deps.config.download.savePath || deps.config.qbittorrent.savePath;
  if (!savePath) throw new Error('没有配置下载目录：请在设置里填写 download.savePath');

  const seriesDir = deps.config.download.seriesDir?.trim() || '';
  const target = options.path?.trim() || null;
  const checkPlayable = options.checkPlayable !== false;

  /** 落盘目录相对下载根目录的路径，用来和界面上的条目对上。 */
  const relOf = (dir: string): string => relativePathOf(savePath, dir);

  /*
   * 只核对选中的那一条。
   *
   * 匹配用的是「定位之后的真实路径」，不是按规则拼出来的路径 ——
   * 单文件种子的目录名是发布标题，跟种子名对不上，按名字猜会匹配不到。
   * 同时也接受只给目录名（不带「番剧/」前缀）的写法，界面上两种都可能传。
   */
  const matches = (meta: TorrentMeta): boolean => {
    if (!target) return true;
    const rel = relOf(locateTorrent(meta, savePath, seriesDir).dir);
    const name = sanitizeSegment(meta.name);
    return rel === target || rel.endsWith(`/${target}`) || name === target || target.endsWith(`/${name}`);
  };

  const metas = loadCachedMetas(savePath).filter(matches);

  // 顺手登记本地内容：这样界面上「片库里有、核对报告里没有」的东西能一起纳入统计
  if (options.addLocal) {
    const scan = scanForLocalItems(savePath, undefined, deps.config.download.ignoreDirs ?? [], seriesDir);
    if (scan.added.length > 0) {
      saveInventory(savePath, scan.entries);
      context.note(`新登记本地内容 ${scan.added.length} 项：${scan.added.map((entry) => entry.name).join('、')}`);
    }
  }

  /*
   * 本地清单：整个读进来（写回时不能把没核对到的条目弄丢），
   * 只有被这次核对覆盖到的才参与。
   */
  const allInventory = loadInventory(savePath);
  const inventory = allInventory.filter((entry) => !target || entry.path === target || entry.name === target);

  const total = metas.length + inventory.length;
  context.note(`核对目录：${savePath}`);
  context.step(`准备核对 ${total} 项`, 0);

  const reports: VerifyReportView[] = [];
  const removed: string[] = [];

  for (const [index, meta] of metas.entries()) {
    if (context.signal.aborted) throw new Error('已取消');
    const name = sanitizeSegment(meta.name);
    context.step(`核对 ${index + 1}/${total}：${name}`, total === 0 ? null : index / total);
    const report = verifyTorrent(meta, savePath, { checkPlayable, seriesDir });
    const view = toVerifyView(report);
    reports.push(view);

    if (options.cleanEmpty && report.empty && report.presentFiles > 0) {
      // 删的必须是实际找到的那个目录，不能是按规则猜出来的路径
      const dir = report.dir;
      context.note(`删除空壳目录（0 个有效分片，名义 ${formatSize(report.nominalBytes)}）：${dir}`);
      rmSync(dir, { recursive: true, force: true });
      removed.push(view.path);
    }
  }

  let relocated = 0;
  for (const [index, entry] of inventory.entries()) {
    if (context.signal.aborted) throw new Error('已取消');
    context.step(`核对本地内容 ${index + 1}/${inventory.length}：${entry.name}`, (metas.length + index) / Math.max(1, total));
    const report = verifyLocal(entry, savePath, { checkPlayable, seriesDir });
    reports.push(toVerifyView(report));

    /*
     * 内容挪过地方就把清单改过来。
     *
     * 例子：内容原先在下载根目录，后来归纳进了「番剧」子目录，
     * 清单里还记着老位置 —— 不修正的话每次核对都得靠兜底查找，
     * 界面上看到的路径也跟实际对不上。
     */
    if (report.dirExists && report.relativePath !== entry.path) {
      context.note(`修正本地内容位置：${entry.path} → ${report.relativePath}`);
      entry.path = report.relativePath;
      relocated += 1;
    }
  }
  if (relocated > 0) saveInventory(savePath, allInventory);

  const completeCount = reports.filter((item) => item.source === 'torrent' && item.complete).length;
  /*
   * 「空壳」和「目录不存在」是两回事，别混成一个数。
   *
   * 元数据缓存里可能留着早就删掉的种子记录（下过、后来清理了，或者试着下过但
   * 目录从没建起来）。那些条目 `dirExists=false`，报成「空壳」会让人以为
   * 磁盘上有空目录占着地方 —— 实测就被这么问过。
   */
  const emptyCount = reports.filter((item) => item.empty && item.dirExists).length;
  const missingCount = reports.filter((item) => !item.dirExists).length;
  const unplayableCount = reports.reduce((sum, item) => sum + item.videosUnplayable, 0);
  const totalBytes = reports.reduce((sum, item) => sum + item.bytesDone, 0);

  context.step(`核对完成：${reports.length} 项`, 1);
  context.note(
    `共 ${reports.length} 项，已下完 ${completeCount}，空壳 ${emptyCount}` +
      (missingCount > 0 ? `，另有 ${missingCount} 项目录不存在（没下过或已删除）` : '') +
      (checkPlayable ? `，抽检发现 ${unplayableCount} 个视频有问题` : '')
  );

  return {
    target,
    reports,
    removed,
    cleanEmpty: options.cleanEmpty === true,
    scannedAt: new Date().toISOString(),
    totalBytes,
    completeCount,
    emptyCount,
    missingCount,
    unplayableCount
  };
}

/* ------------------------------------------------------------------ *
 * 立刻跑一轮自动追番
 * ------------------------------------------------------------------ */

export type AutoTaskResult = AutoReport & {
  dryRun: boolean;
  /** 实际用的数据来源。 */
  source: 'planner' | 'watchlist';
  finishedAt: string;
};

/**
 * 手动触发一轮自动追番。
 *
 * 与计划任务里跑的是同一条代码路径（runAuto），所以结果一致；
 * 唯一的额外动作是抢同一把单实例锁 —— 否则计划任务正好在跑时，
 * 手动再点一次会变成两个进程同时下同一个种子，互相抢带宽还写同一个文件。
 */
export async function runAutoTask(
  deps: { config: AppConfig; configPath?: string },
  options: { dryRun?: boolean },
  context: TaskContext
): Promise<AutoTaskResult> {
  const configPath = deps.configPath;
  const lockPath = join(configPath ? dirname(configPath) : process.cwd(), 'data', '.bangumi.lock');
  const lock = acquireLock(lockPath, 'auto (web)');
  if (!lock) {
    throw new Error('已经有一轮追番在跑（多半是计划任务触发的），本次不再重复启动。稍等一轮再看。');
  }

  try {
    const dryRun = options.dryRun === true;
    context.step('正在检查追番清单与 Planner…', 0.05);
    context.note(dryRun ? '本轮是「只看看会下什么」，不会真的下载' : '开始追番，下载在后台进行');

    const report = await runAuto({
      config: deps.config,
      configPath: deps.configPath,
      dryRun,
      retryRounds: deps.config.download.retryRounds ?? 6,
      preferPlanner: true,
      // 手动点的按钮就忽略播出计划：用户是明确要看「现在会下什么」
      force: true,
      /*
       * 手动触发也重排计划任务触发器。
       *
       * 不这么做的话会出现这种情况：手动跑一轮把某一集下完了 → 计划里那段
       * 「等着取片源」的窗口被收走 → 但计划任务的触发器没跟着更新，
       * 于是它继续每 15 分钟空跑一次，直到下一次带 --sync-task 的运行
       * （实测被用户抓到「每15分钟的那个为什么还在跑」）。
       */
      syncTask: process.platform === 'win32'
    });

    // runAuto 连不上 Planner 时会自动退回清单；这里照实说明本轮用的是哪一份
    context.note(
      report.source === 'planner'
        ? `数据来源：Bangumi Watch Planner（${deps.config.plannerBaseUrl}）`
        : '数据来源：本地追番清单（Planner 不可用或未启用）'
    );
    for (const item of report.downloaded) {
      context.note(`《${item.query}》第 ${item.episodes.join('/')} 集 → ${item.files} 个文件，${formatSize(item.bytesWritten)}`);
    }
    for (const item of report.skipped) {
      context.note(`跳过《${item.query}》：${item.reason}`);
    }
    if (report.schedule?.nextCheckAt) {
      context.note(`下次自动检查：${report.schedule.reason}`);
    }
    context.step(`本轮结束：检查 ${report.checked} 条，新下载 ${report.downloaded.length} 条`, 1);

    return { ...report, dryRun, source: report.source, finishedAt: new Date().toISOString() };
  } finally {
    lock.release();
  }
}
