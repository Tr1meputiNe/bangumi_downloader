import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { exec } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, type AppConfig } from '../config.js';
import { QbittorrentClient } from '../qbittorrent/client.js';
import { searchAndRank } from '../core/search.js';
import { resolveBackend } from '../core/dispatch.js';
import { JobQueue } from '../core/jobs.js';
import { collectLibrary } from '../core/summary.js';
import { displayName, PlannerClient, type PlannerSubject } from '../planner/client.js';
import { dedupeByTitle, expandQueries, filterBySeason, loadAliases, orderBySeason } from '../core/alias.js';
import {
  isEntryComplete,
  loadWatchlist,
  nextEpisodeOf,
  removeWatchEntry,
  syncFromPlanner,
  upsertWatchEntry,
  watchlistPath,
  type WatchEntry
} from '../core/watchlist.js';
import { buildTaskSchedule, syncTaskSchedule } from '../core/task-schedule.js';
import {
  autoSchedulePath,
  buildPlanRows,
  effectiveRunning,
  describeNextCheck,
  doneKeys,
  loadAutoSchedule,
  type AutoScheduleState
} from '../core/auto-schedule.js';
import { toDisplayResult } from './serialize.js';
import { SearchCache } from '../util/cache.js';
import { clientCss, clientJs } from './assets.js';
import { logger } from '../util/log.js';
import { VERSION } from '../version.js';
import { TaskRunner, runAutoTask, runVerifyTask, type AutoTaskResult, type VerifyTaskResult } from './tasks.js';
import { probeScheduledTasks } from './schedule.js';
import { readLogTail } from './logfile.js';
import {
  applyEntries,
  readRawConfig,
  redactConfig,
  redactPatch,
  restartEntries,
  SETTINGS_SCHEMA,
  unknownTopLevelKeys,
  validatePatch,
  writeRawConfig
} from './settings.js';
import { openInFileManager, readEntryDetail, resolveInside } from './library.js';

const log = logger('web');

/**
 * 本地 Web 界面：搜索、下载、任务、计划、片库、设置、日志。
 *
 * 只用 Node 内置的 http 模块，不引入 Web 框架 —— 整个项目要保持零运行时依赖，
 * 才能打成单文件 exe。
 *
 * 默认只监听 127.0.0.1：这是一个能改配置、能往磁盘写东西的接口，
 * 不应该暴露到局域网。需要远程访问时改 config.web.host（例如 Tailscale 地址），
 * 风险自负。
 */

export type WebDeps = {
  /** 下载任务队列。不传时内部自建一个（测试用）。 */
  jobs?: JobQueue;
  /** 非下载类的长任务（核对片库、立刻追番）。不传时内部自建。 */
  tasks?: TaskRunner;
  config: AppConfig;
  /** config.json 的路径：设置页要写它，日志页要据此找 data/bangumi.log。 */
  configPath?: string;
  qbittorrent?: QbittorrentClient;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/*
 * 两个长任务的执行体。
 *
 * 之所以留一层可替换的间接引用：测试里不能真的去联网搜种、下载、读几十 GB 磁盘，
 * 但又必须验证「请求进来 → 立刻回任务号 → 轮询拿到进度和结果」这条链路。
 */
let autoRunner: typeof runAutoTask = runAutoTask;
let verifyRunner: typeof runVerifyTask = runVerifyTask;

/** 测试用：替换「立刻跑一轮追番」的执行体。 */
export function setAutoRunner(runner: typeof runAutoTask): void {
  autoRunner = runner;
}

/** 测试用：替换「核对片库」的执行体。 */
export function setVerifyRunner(runner: typeof runVerifyTask): void {
  verifyRunner = runner;
}

/**
 * 搜索结果缓存：一次搜索要打三个片源（还要为 mikan 下载种子算 infohash），
 * 实测要十几秒。手动搜索时切筛选、来回看很常见，缓存能把重复搜索降到毫秒级，
 * 同时也减轻了片源站的压力。
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new SearchCache<Awaited<ReturnType<typeof searchAndRank>>>({
  ttlMs: CACHE_TTL_MS,
  maxEntries: 30
});

export function createWebServer(deps: WebDeps): Server {
  return createServer((request, response) => {
    handle(deps, request, response).catch((error: unknown) => {
      log.error(`请求处理失败：${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        response.end();
      }
    });
  });
}

async function handle(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';

  /* ---------------- 页面 ---------------- */
  if (method === 'GET' && (path === '/' || path === '/index.html')) return sendIndex(response);

  /* ---------------- 状态与总览 ---------------- */
  if (method === 'GET' && path === '/api/status') return sendJson(response, 200, await buildStatus(deps));
  if (method === 'GET' && path === '/api/overview') return sendJson(response, 200, await buildOverview(deps));
  if (method === 'GET' && path === '/api/schedule') return sendJson(response, 200, await probeScheduledTasks());
  if (method === 'POST' && path === '/api/schedule/sync') return handleScheduleSync(deps, request, response);

  /* ---------------- 搜索与下载 ---------------- */
  if (method === 'GET' && path === '/api/search') return handleSearch(deps, url, response);
  if (method === 'POST' && path === '/api/add') return handleAdd(deps, request, response);

  /* ---------------- 下载任务 ---------------- */
  if (method === 'GET' && path === '/api/jobs') return handleJobs(deps, response);
  if (method === 'POST' && path === '/api/jobs/act') return handleJobAction(deps, request, response);
  if (method === 'POST' && path === '/api/jobs/clear') return handleJobsClear(deps, response);

  /* ---------------- 后台任务（核对 / 追番） ---------------- */
  if (method === 'GET' && path === '/api/tasks') {
    const runner = ensureTasks(deps);
    return sendJson(response, 200, { tasks: runner.list(), running: runner.running });
  }
  if (method === 'POST' && path === '/api/tasks/act') return handleTaskAction(deps, request, response);
  if (method === 'POST' && path === '/api/auto/run') return handleAutoRun(deps, request, response);

  /* ---------------- 片库 ---------------- */
  if (method === 'GET' && path === '/api/library') return handleLibrary(deps, response);
  if (method === 'GET' && path === '/api/library/entry') return handleLibraryEntry(deps, url, response);
  if (method === 'POST' && path === '/api/library/verify') return handleLibraryVerify(deps, request, response);
  if (method === 'POST' && path === '/api/open') return handleOpen(deps, request, response);

  /* ---------------- 追番计划 ---------------- */
  if (method === 'GET' && path === '/api/watchlist') return sendJson(response, 200, await buildWatchlist(deps));
  if (method === 'POST' && path === '/api/watchlist') return handleWatchlistEdit(deps, request, response);
  if (method === 'POST' && path === '/api/watchlist/sync') return handleWatchlistSync(deps, response);
  if (method === 'GET' && path === '/api/planner/subject') return handlePlannerSubject(deps, url, response);

  /* ---------------- 设置与日志 ---------------- */
  if (method === 'GET' && path === '/api/config') {
    return sendJson(response, 200, {
      path: deps.configPath ?? null,
      config: redactConfig(deps.config),
      editable: Object.keys(SETTINGS_SCHEMA).sort()
    });
  }
  if (method === 'POST' && path === '/api/config') return handleConfigPatch(deps, request, response);
  if (method === 'POST' && path === '/api/config/raw') return handleConfigRaw(deps, request, response);
  if (method === 'GET' && path === '/api/logs') return handleLogs(deps, url, response);

  if (method === 'GET' && path === '/healthz') return sendJson(response, 200, { ok: true });

  sendJson(response, 404, { error: 'Not found' });
}

/* ================================================================== *
 * 状态 / 总览
 * ================================================================== */

function backendLabel(backend: string): string {
  return backend === 'qbittorrent' ? 'qBittorrent' : '内置引擎';
}

async function buildStatus(deps: WebDeps) {
  /*
   * 状态里的 qbittorrent 字段是历史包袱：它原本表示「下载能力可用吗」。
   * 现在默认后端是内置引擎（不需要任何外部程序），所以：
   *   - builtin 后端：直接报 ok，并且说明用的是自带引擎；
   *   - qbittorrent 后端：仍然去 ping 它，连不上就报错。
   * 否则用内置引擎时界面会一直显示「未配置 qBittorrent，只能搜索不能下载」，
   * 而实际上点下载是能用的 —— 这种假警告会让人以为功能坏了。
   */
  const backend = resolveBackend(deps.config);
  const base = {
    version: VERSION,
    planner: deps.config.plannerBaseUrl,
    backend,
    backendLabel: backendLabel(backend),
    savePath: deps.config.download.savePath || deps.config.qbittorrent.savePath || '',
    seriesDir: deps.config.download.seriesDir ?? '',
    configPath: deps.configPath ?? null,
    logFile: logFileOf(deps),
    watchlistFile: deps.configPath ? watchlistPath(deps.configPath) : null
  };

  if (backend === 'builtin') {
    return { ...base, qbittorrent: 'ok', message: '内置下载引擎（无需 qBittorrent）' };
  }

  if (!deps.qbittorrent) {
    return { ...base, qbittorrent: 'not-configured', message: '后端配置为 qBittorrent，但客户端未初始化' };
  }

  try {
    const info = await deps.qbittorrent.version();
    return { ...base, qbittorrent: 'ok', message: `qBittorrent ${info.app}`, webapi: info.api };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // 只取第一行作为提示，完整原因写进日志
    const firstLine = raw.split('\n')[0] ?? raw;
    log.warn(`qBittorrent 连接失败：${raw}`);
    return { ...base, qbittorrent: 'error', message: firstLine };
  }
}

/**
 * 首页要显示的一堆汇总信息。
 *
 * 单独一个接口而不是让前端拼十几个请求：界面一打开就要显示这些，
 * 逐个请求既慢又容易半路失败（有的卡片有数据、有的空白）。
 */
async function buildOverview(deps: WebDeps) {
  const status = await buildStatus(deps);
  const jobs = ensureJobs(deps).list();
  const tasks = ensureTasks(deps).list();
  const library = currentLibrary(deps);
  const watch = currentWatchlist(deps);

  const planner = await probePlanner(deps);
  const schedule = await probeScheduledTasks();

  const counts = {
    running: jobs.filter((job) => job.status === 'running').length,
    queued: jobs.filter((job) => job.status === 'queued').length,
    paused: jobs.filter((job) => job.status === 'paused').length,
    completed: jobs.filter((job) => job.status === 'completed').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
    cancelled: jobs.filter((job) => job.status === 'cancelled').length
  };

  const now = new Date();
  const active = jobs.find((job) => job.status === 'running') ?? null;

  return {
    status,
    version: VERSION,
    serverTime: now.toISOString(),
    library: {
      root: library.root,
      seriesRoot: library.seriesRoot,
      entries: library.entries.length,
      videos: library.totalVideos,
      files: library.totalFiles,
      bytes: library.totalBytes
    },
    watchlist: {
      file: watch.file,
      total: watch.entries.length,
      enabled: watch.entries.filter((entry) => entry.enabled !== false).length,
      entries: watch.entries.slice(0, 12).map((entry) => ({
        query: entry.query,
        nextEpisode: nextEpisodeOf(entry),
        totalEpisodes: entry.totalEpisodes ?? null,
        complete: isEntryComplete(entry),
        lastEpisode: entry.lastEpisode ?? null,
        enabled: entry.enabled !== false
      }))
    },
    jobs: {
      counts,
      active: active ? toJobView(active) : null,
      recent: jobs.slice(0, 5).map(toJobView)
    },
    tasks: tasks.slice(0, 5),
    planner,
    autoSchedule: (() => {
      const current = currentAutoSchedule(deps);
      return {
        nextCheckAt: current.state?.nextCheckAt ?? null,
        nextReason: current.state?.nextReason ?? '',
        nextCheckText: current.nextCheckText,
        windows: current.state?.windows.length ?? 0,
        running: effectiveRunning(current.state)
      };
    })(),
    schedule
  };
}

/**
 * 按最新计划重排计划任务的触发器。
 *
 * 界面上给一个按钮：改完 Planner、或者在设置里调了间隔之后，
 * 想让任务计划程序立刻按新安排来，不用等下一轮跑完。
 */
async function handleScheduleSync(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: { taskName?: unknown } = {};
  try {
    const text = await readBody(request);
    if (text.trim() !== '') body = JSON.parse(text) as { taskName?: unknown };
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const current = currentAutoSchedule(deps);
  if (!current.state || current.state.triggers.length === 0) {
    return sendJson(response, 409, {
      error: '计划里还没有播出安排（先让自动追番跑一轮；或者 Planner 里没有「在看」的番）'
    });
  }

  const now = new Date();
  const taskPlan = buildTaskSchedule(
    {
      triggers: current.state.triggers.map((item) => ({
        start: new Date(item.start),
        until: new Date(item.until),
        label: item.label
      }))
    },
    now,
    {
      activeIntervalMinutes: deps.config.download.activeIntervalMinutes ?? 15,
      idleIntervalMinutes: deps.config.download.idleIntervalMinutes ?? 180
    }
  );

  const result = await syncTaskSchedule({
    taskName: typeof body.taskName === 'string' && body.taskName !== '' ? body.taskName : 'BangumiDownloader',
    plan: taskPlan,
    apply: true
  });

  sendJson(response, result.ok ? 200 : 500, result);
}

/* ================================================================== *
 * 搜索 / 添加下载
 * ================================================================== */

async function handleSearch(deps: WebDeps, url: URL, response: ServerResponse): Promise<void> {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (query === '') {
    return sendJson(response, 400, { error: '缺少查询参数 q' });
  }

  // 强制刷新：切到「下载」页重新搜同一个词时，用户想要的是最新结果
  if (url.searchParams.get('refresh') === '1') searchCache.delete(`manual:${query.toLowerCase()}`);

  const limit = Number(url.searchParams.get('limit') ?? '0');

  /*
   * 关键词扩展：简称 → 官方名，并认出「第几季」。
   *
   * 起因：「京吹2」一条都搜不到、「京吹 第一季」搜出来全是第三季 ——
   * tracker 只做字面匹配，不认识中文圈简称；而且不带季数过滤时，
   * 新一季会把老季挤到后面（实测搜「吹响吧！上低音号」60 条全是第三季）。
   */
  const aliases = loadAliases(deps.configPath ? join(dirname(deps.configPath), 'data', 'aliases.json') : undefined);
  const expansion = expandQueries(query, aliases);
  const queries = expansion.queries.map((item) => item.text);
  const cacheKey = `manual:${queries.join('|').toLowerCase()}`;

  const { value: outcome, cached } = await searchCache.getOrLoad(cacheKey, () =>
    searchAndRank({
      query: queries[0] ?? query,
      // 别名/去季数的变体一起搜，合并结果
      altQuery: queries[1],
      extraQueries: queries.slice(2),
      config: deps.config,
      mode: 'manual',
      resolveMikanMagnet: true
    })
  );

  /*
   * 按季过滤。
   *
   * 「标题里写了别的季」的直接丢掉；没写季数的保留（不少第一季发布根本不标季数）。
   * 过滤后一条不剩时**退回未过滤的结果**并在提示里说明 —— 宁可给用户看到东西
   * 让他自己判断，也不要因为规则太严交出一片空白。
   */
  const all = dedupeByTitle(outcome.ranked, (item) => item.result.title);
  const filtered = expansion.season === null ? all : filterBySeason(all, expansion.season, (item) => item.result.title);
  // 过滤后一条不剩就退回未过滤的结果：宁可给用户看到东西让他自己判断，也别交白卷
  const base = filtered.length > 0 ? filtered : all;
  const usable = orderBySeason(base, expansion.season, (item) => item.result.title);
  const max = Number.isFinite(limit) && limit > 0 ? limit : 0;
  const ranked = max > 0 ? usable.slice(0, max) : usable;

  sendJson(response, 200, {
    query,
    queries: outcome.queries,
    /** 试过的关键词及其来历（界面上展示，别让搜索是个黑盒）。 */
    queryPlan: expansion.queries,
    season: expansion.season,
    seasonFiltered: expansion.season !== null && filtered.length === 0 && all.length > 0,
    results: ranked.map(toDisplayResult),
    errors: outcome.errors,
    elapsedMs: outcome.elapsedMs,
    cached
  });
}

type AddBody = {
  items?: Array<{
    title?: unknown;
    magnet?: unknown;
    torrentUrl?: unknown;
    tracker?: unknown;
    sizeBytes?: unknown;
    episodes?: unknown;
  }>;
};

async function handleAdd(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  // 用内置引擎时不需要 qBittorrent；只有真的选了 qbittorrent 后端才要求它可用
  if (resolveBackend(deps.config) === 'qbittorrent' && !deps.qbittorrent) {
    return sendJson(response, 503, { error: '后端配置为 qBittorrent，但客户端未初始化' });
  }

  let body: AddBody;
  try {
    body = JSON.parse(await readBody(request)) as AddBody;
  } catch (error) {
    return sendJson(response, 400, { error: `请求体不是合法 JSON：${(error as Error).message}` });
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return sendJson(response, 400, { error: '没有要添加的种子' });
  if (items.length > 50) return sendJson(response, 400, { error: '一次最多添加 50 个种子' });

  /*
   * 这里只入队，不等下载完成。
   *
   * 以前是同步等 dispatchDownload 返回 —— 而下载要试多条候选、可能持续几十分钟，
   * 于是表现为浏览器一直转圈、没有任何进度、最后客户端超时。
   * 现在立刻回任务号，前端轮询 /api/jobs 看进度。
   */
  const jobs = ensureJobs(deps);
  const results = items.map((raw) => {
    const title = typeof raw.title === 'string' ? raw.title : '';
    const magnet = typeof raw.magnet === 'string' ? raw.magnet : '';
    const torrentUrl = typeof raw.torrentUrl === 'string' ? raw.torrentUrl : '';
    const tracker = typeof raw.tracker === 'string' ? raw.tracker : undefined;
    const sizeBytes = typeof raw.sizeBytes === 'number' ? raw.sizeBytes : null;
    const episodes = Array.isArray(raw.episodes)
      ? raw.episodes.filter((value): value is number => typeof value === 'number')
      : [];

    if (title === '' || (magnet === '' && torrentUrl === '')) {
      return { title: title || '(无标题)', ok: false, error: '缺少标题或下载链接' };
    }

    const job = jobs.enqueue({ title, magnet, torrentUrl, sizeBytes, tracker, episodes });
    log.info(`已入队：${title.slice(0, 60)}（任务 ${job.id}）`);
    return { title, ok: true, jobId: job.id };
  });

  sendJson(response, 200, { results, queued: results.filter((item) => item.ok).length });
}

/* ================================================================== *
 * 下载任务
 * ================================================================== */

function handleJobs(deps: WebDeps, response: ServerResponse): void {
  const queue = ensureJobs(deps);
  const jobs = queue.list();
  sendJson(response, 200, {
    jobs: jobs.map(toJobView),
    running: queue.running,
    counts: {
      running: jobs.filter((job) => job.status === 'running').length,
      queued: jobs.filter((job) => job.status === 'queued').length,
      paused: jobs.filter((job) => job.status === 'paused').length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
      cancelled: jobs.filter((job) => job.status === 'cancelled').length
    }
  });
}

/** 任务的对外视图（去掉内部字段，进度换算成百分比）。 */
function toJobView(job: ReturnType<JobQueue['list']>[number]) {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    percent: job.ratio === null ? null : Math.round(job.ratio * 1000) / 10,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    peers: job.peers,
    episodes: job.episodes,
    messages: job.messages.slice(-40),
    files: job.files,
    error: job.error,
    backend: job.backend,
    /*
     * 种子来源。'none' = 既没有磁力也没有直链 —— 这种任务必然失败，
     * 但要等轮到它才报错，所以直接暴露出来，排查时一眼能看到
     * （实测：从 mikan 加的任务只有直链，而 mikan 会清理老链接，过期就是 404）。
     */
    source: job.magnet ? 'magnet' : job.torrentUrl ? 'torrent' : 'none',
    // 前端据此决定显示哪些按钮，省得它自己推状态机
    canPause: job.status === 'running' || job.status === 'queued',
    canResume: job.status === 'paused',
    canCancel: job.status === 'running' || job.status === 'queued' || job.status === 'paused'
  };
}

/**
 * 对任务执行 pause / resume / cancel。
 *
 * 暂停是真的停下载（abort 掉引擎），不是只改状态 ——
 * 已校验通过的分片会留在磁盘上，继续时引擎会跳过它们接着下。
 */
async function handleJobAction(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: { id?: unknown; action?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as { id?: unknown; action?: unknown };
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const action = typeof body.action === 'string' ? body.action : '';
  if (id === '') return sendJson(response, 400, { error: '缺少任务号 id' });
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    return sendJson(response, 400, { error: 'action 只能是 pause / resume / cancel' });
  }

  const result = ensureJobs(deps).act(id, action);
  if (!result.ok) return sendJson(response, 409, { error: result.reason ?? '操作失败' });
  sendJson(response, 200, { ok: true, status: result.status });
}

function handleJobsClear(deps: WebDeps, response: ServerResponse): void {
  const removed = ensureJobs(deps).clearFinished();
  sendJson(response, 200, { ok: true, removed });
}

/* ================================================================== *
 * 后台任务
 * ================================================================== */

async function handleTaskAction(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: { id?: unknown; action?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as { id?: unknown; action?: unknown };
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (id === '') return sendJson(response, 400, { error: '缺少任务号 id' });
  if (body.action !== 'cancel') return sendJson(response, 400, { error: 'action 只能是 cancel' });

  const result = ensureTasks(deps).cancel(id);
  if (!result.ok) return sendJson(response, 409, { error: result.reason ?? '操作失败' });
  sendJson(response, 200, { ok: true, status: 'cancelled' });
}

/** 立刻跑一轮自动追番（与计划任务里跑的是同一条路径）。 */
async function handleAutoRun(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: { dryRun?: unknown } = {};
  try {
    const text = await readBody(request);
    if (text.trim() !== '') body = JSON.parse(text) as { dryRun?: unknown };
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const runner = ensureTasks(deps);
  if (runner.isRunning('auto')) {
    return sendJson(response, 409, { error: '已经有一轮追番在跑了，等它结束再点' });
  }

  const dryRun = body.dryRun === true;
  const task = runner.start({
    kind: 'auto',
    title: dryRun ? '试跑一轮自动追番（不下载）' : '立刻跑一轮自动追番',
    run: (context): Promise<AutoTaskResult> => autoRunner(deps, { dryRun }, context)
  });

  sendJson(response, 200, { taskId: task.id });
}

/* ================================================================== *
 * 片库
 * ================================================================== */

/** 片库要遍历磁盘，界面又会轮询，所以缓存几秒。 */
const LIBRARY_TTL_MS = 8000;
let libraryCache: { at: number; key: string; value: ReturnType<typeof collectLibrary> } | null = null;

function currentLibrary(deps: WebDeps): ReturnType<typeof collectLibrary> {
  const savePath = deps.config.download.savePath || deps.config.qbittorrent.savePath;
  if (!savePath) {
    return { root: '', seriesRoot: null, entries: [], totalBytes: 0, totalVideos: 0, totalFiles: 0, others: [] };
  }

  const key = `${savePath}|${deps.config.download.seriesDir ?? ''}|${(deps.config.download.ignoreDirs ?? []).join(',')}`;
  const now = Date.now();
  if (libraryCache && libraryCache.key === key && now - libraryCache.at < LIBRARY_TTL_MS) return libraryCache.value;

  const value = collectLibrary({
    savePath,
    seriesDir: deps.config.download.seriesDir,
    ignoreDirs: deps.config.download.ignoreDirs ?? []
  });
  libraryCache = { at: now, key, value };
  return value;
}

/** 设置页改了下载目录之后要让缓存失效。 */
function invalidateLibrary(): void {
  libraryCache = null;
}

function handleLibrary(deps: WebDeps, response: ServerResponse): void {
  const summary = currentLibrary(deps);
  sendJson(response, 200, {
    root: summary.root,
    seriesRoot: summary.seriesRoot,
    totalBytes: summary.totalBytes,
    totalVideos: summary.totalVideos,
    totalFiles: summary.totalFiles,
    others: summary.others,
    entries: summary.entries
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        bytes: entry.bytes,
        videoCount: entry.videoCount,
        otherCount: entry.otherCount,
        kind: entry.kind,
        suspectEmpty: entry.suspectEmpty
      }))
  });
}

function handleLibraryEntry(deps: WebDeps, url: URL, response: ServerResponse): void {
  const savePath = deps.config.download.savePath || deps.config.qbittorrent.savePath;
  if (!savePath) return sendJson(response, 400, { error: '没有配置下载目录' });

  const target = url.searchParams.get('path') ?? '';
  if (target === '') return sendJson(response, 400, { error: '缺少参数 path' });

  const detail = readEntryDetail(savePath, target, { maxFiles: Number(url.searchParams.get('max') ?? '500') || 500 });
  if (!detail) return sendJson(response, 404, { error: `找不到这一项：${target}` });
  sendJson(response, 200, detail);
}

async function handleLibraryVerify(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: { path?: unknown; cleanEmpty?: unknown; checkPlayable?: unknown; addLocal?: unknown } = {};
  try {
    const text = await readBody(request);
    if (text.trim() !== '') body = JSON.parse(text) as typeof body;
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const runner = ensureTasks(deps);
  if (runner.isRunning('verify')) {
    return sendJson(response, 409, { error: '已经有一次核对在跑了，等它结束再点' });
  }

  const target = typeof body.path === 'string' && body.path !== '' ? body.path : null;
  const cleanEmpty = body.cleanEmpty === true;
  const checkPlayable = body.checkPlayable !== false;
  const addLocal = body.addLocal === true;

  const task = runner.start({
    kind: 'verify',
    title: target ? `核对：${target}` : '核对整个片库',
    run: (context): Promise<VerifyTaskResult> =>
      verifyRunner(deps, { path: target, cleanEmpty, checkPlayable, addLocal }, context)
  });

  sendJson(response, 200, { taskId: task.id });
}

/**
 * 在服务器那台机器的文件管理器里打开一个路径。
 *
 * 只允许两类目标：
 *   1. 下载目录里的东西（相对或绝对路径都行，但必须落在 savePath 里）
 *   2. 程序自己的几个文件（config.json / watchlist.json / 日志）
 * 这是一个「能在别人机器上弹窗口」的接口，绝不能变成任意路径打开。
 */
async function handleOpen(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const savePath = deps.config.download.savePath || deps.config.qbittorrent.savePath;
  if (!savePath) return sendJson(response, 400, { error: '没有配置下载目录' });

  let body: { path?: unknown };
  try {
    const text = await readBody(request);
    body = text.trim() === '' ? {} : (JSON.parse(text) as { path?: unknown });
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const target = typeof body.path === 'string' ? body.path : '';

  const insideLibrary = resolveInside(savePath, target === '' ? '.' : target);
  const allowedFiles = [deps.configPath, logFileOf(deps), deps.configPath ? watchlistPath(deps.configPath) : null]
    .filter((item): item is string => typeof item === 'string' && item !== '')
    .map((item) => resolve(item));

  const absolute = target === '' ? resolve(savePath) : resolve(savePath, target);
  const isAllowed = insideLibrary !== null || allowedFiles.includes(absolute);
  if (!isAllowed) {
    return sendJson(response, 400, { error: '只能打开下载目录或程序自己的配置文件' });
  }

  const result = await openInFileManager(absolute);
  sendJson(response, result.ok ? 200 : 500, result);
}

/* ================================================================== *
 * 追番计划
 * ================================================================== */

export type PlannerSubjectView = {
  id: number;
  name: string;
  nameCn: string;
  display: string;
  collectionType: number;
  collectionLabel: string;
  unwatched: number;
  totalEpisodes: number;
  watchedEpisodes: number;
  /** 总集数是否已经确定（连载中的新番常常还不知道一共几集）。 */
  totalEpisodesKnown: boolean;
  airDate: string | null;
  url: string | null;
  image: string | null;
  nextEpisode: { ep: number | null; airdate: string; airTime: string | null; title: string } | null;
};

const COLLECTION_LABELS: Record<number, string> = {
  1: '想看',
  2: '看过',
  3: '在看',
  4: '搁置',
  5: '抛弃'
};

/** Planner 探测会走网络，界面又轮询，所以缓存 60 秒。 */
const PLANNER_TTL_MS = 60_000;
let plannerCache: { at: number; key: string; value: PlannerView } | null = null;

export type PlannerView = {
  ok: boolean;
  message: string;
  baseUrl: string;
  checkedAt: string;
  lastSyncAt: string | null;
  subjects: PlannerSubjectView[];
};

async function probePlanner(deps: WebDeps, options: { force?: boolean } = {}): Promise<PlannerView> {
  const baseUrl = deps.config.plannerBaseUrl;
  const now = Date.now();
  if (!options.force && plannerCache && plannerCache.key === baseUrl && now - plannerCache.at < PLANNER_TTL_MS) {
    return plannerCache.value;
  }

  const client = new PlannerClient({
    baseUrl,
    timeoutMs: Math.min(deps.config.trackers.timeoutMs ?? 15_000, 8000),
    retries: 0
  });

  let value: PlannerView;
  try {
    const dashboard = await client.dashboard();
    const subjects: PlannerSubjectView[] = dashboard.subjects
      .filter((subject) => subject.collectionType !== 2)
      .sort((a, b) => (b.unwatchedMainEpisodeCount ?? 0) - (a.unwatchedMainEpisodeCount ?? 0))
      .map(toPlannerSubjectView);

    value = {
      ok: true,
      message: `已连接 ${baseUrl}`,
      baseUrl,
      checkedAt: new Date().toISOString(),
      lastSyncAt: dashboard.lastSyncAt ?? null,
      subjects
    };
  } catch (error) {
    value = {
      ok: false,
      message: error instanceof Error ? error.message.split('\n')[0] ?? String(error) : String(error),
      baseUrl,
      checkedAt: new Date().toISOString(),
      lastSyncAt: null,
      subjects: []
    };
  }

  plannerCache = { at: now, key: baseUrl, value };
  return value;
}

function toPlannerSubjectView(subject: PlannerSubject): PlannerSubjectView {
  const next = subject.nextEpisode ?? null;
  return {
    id: subject.id,
    name: subject.name,
    nameCn: subject.nameCn,
    display: displayName(subject),
    collectionType: subject.collectionType,
    collectionLabel: COLLECTION_LABELS[subject.collectionType] ?? String(subject.collectionType),
    unwatched: subject.unwatchedMainEpisodeCount ?? 0,
    totalEpisodes: subject.eps ?? 0,
    watchedEpisodes: subject.epStatus ?? 0,
    totalEpisodesKnown: subject.totalEpisodesKnown !== false,
    airDate: subject.airDate ?? null,
    url: subject.url ?? null,
    image: subject.image ?? null,
    nextEpisode: next
      ? { ep: next.ep, airdate: next.airdate, airTime: next.airTime ?? null, title: next.nameCn || next.name }
      : null
  };
}

/**
 * 自动追番的「下次什么时候检查」计划。
 *
 * 计划任务每 15 分钟触发一次，但真正干活只在播出前后 ——
 * 界面上必须能看见这个安排，否则「为什么现在没动静」没人答得上来。
 */
function currentAutoSchedule(deps: WebDeps): { file: string | null; state: AutoScheduleState | null; nextCheckText: string } {
  if (!deps.configPath) return { file: null, state: null, nextCheckText: '未知' };
  const file = autoSchedulePath(deps.configPath);
  const state = loadAutoSchedule(file);
  return { file, state, nextCheckText: describeNextCheck(state) };
}

function currentWatchlist(deps: WebDeps): { file: string | null; entries: WatchEntry[] } {
  const file = deps.configPath ? watchlistPath(deps.configPath) : null;
  if (!file) return { file: null, entries: [] };
  return { file, entries: loadWatchlist(file).entries };
}

async function buildWatchlist(deps: WebDeps) {
  const { file, entries } = currentWatchlist(deps);
  const planner = await probePlanner(deps);

  return {
    file,
    entries: entries.map((entry) => ({
      query: entry.query,
      lastEpisode: entry.lastEpisode ?? null,
      nextEpisode: nextEpisodeOf(entry),
      completedEpisodes: entry.completedEpisodes ?? [],
      startFrom: entry.startFrom ?? null,
      /** 总集数（留空表示不知道；知道已下满时 nextEpisode 会是 null）。 */
      totalEpisodes: entry.totalEpisodes ?? null,
      /** 全部集数都已下完。 */
      complete: isEntryComplete(entry),
      note: entry.note ?? '',
      enabled: entry.enabled !== false
    })),
    planner,
    schedule: (() => {
      const current = currentAutoSchedule(deps);
      const now = new Date();
      const rows = buildPlanRows(
        planner.subjects.map((subject) => ({
          subjectId: subject.id,
          name: subject.display,
          eps: subject.totalEpisodes,
          epStatus: subject.watchedEpisodes,
          unwatched: subject.unwatched,
          totalEpisodesKnown: subject.totalEpisodesKnown,
          next: subject.nextEpisode
            ? { ep: subject.nextEpisode.ep, airdate: subject.nextEpisode.airdate, airTime: subject.nextEpisode.airTime ?? null }
            : null
        })),
        now,
        {
          readyDelayMinutes: deps.config.download.readyDelayMinutes ?? 60,
          releaseWindowHours: deps.config.download.releaseWindowHours ?? 12
        },
        doneKeys(current.state)
      );

      return {
        file: current.file,
        /** 正在下载的那一条（另一个进程写的，界面靠它显示进度）。 */
        running: effectiveRunning(current.state),
        nextCheckAt: current.state?.nextCheckAt ?? null,
        nextRefreshAt: current.state?.nextRefreshAt ?? null,
        nextReason: current.state?.nextReason ?? '',
        nextCheckText: current.nextCheckText,
        updatedAt: current.state?.updatedAt ?? null,
        windows: current.state?.windows ?? [],
        doneCount: current.state?.done.length ?? 0,
        activeIntervalMinutes: deps.config.download.activeIntervalMinutes ?? 15,
        idleIntervalMinutes: deps.config.download.idleIntervalMinutes ?? 180,
        releaseWindowHours: deps.config.download.releaseWindowHours ?? 12,
        /** 按播出时间升序排好的计划表。 */
        rows,
        now: now.toISOString()
      };
    })(),
    download: {
      savePath: deps.config.download.savePath || deps.config.qbittorrent.savePath || '',
      readyDelayMinutes: deps.config.download.readyDelayMinutes ?? 60,
      retryRounds: deps.config.download.retryRounds ?? 6,
      maxEpisodesPerSubjectPerRun: deps.config.download.maxEpisodesPerSubjectPerRun ?? 999
    }
  };
}

/**
 * 把 Planner 里「在看」的番补进本地清单（只补缺，不动已有的条目）。
 *
 * 本地清单是 Planner 连不上时的兜底数据源 —— 不同步的话，
 * Planner 一挂就只剩清单里手工填的那几条在追。
 */
async function handleWatchlistSync(deps: WebDeps, response: ServerResponse): Promise<void> {
  if (!deps.configPath) return sendJson(response, 400, { error: '服务启动时没有指定 config.json，无法定位追番清单' });

  const planner = await probePlanner(deps, { force: true });
  if (!planner.ok) {
    return sendJson(response, 409, { error: `连不上 Watch Planner（${planner.message}），先确认它在运行` });
  }

  const synced = syncFromPlanner(
    watchlistPath(deps.configPath),
    planner.subjects.map((subject) => ({
      name: subject.display,
      eps: subject.totalEpisodes,
      epStatus: subject.watchedEpisodes,
      unwatched: subject.unwatched
    }))
  );

  if (synced.added.length > 0) log.info(`从 Planner 补进清单 ${synced.added.length} 部：${synced.added.join('、')}`);
  sendJson(response, 200, { added: synced.added, ...(await buildWatchlist(deps)) });
}

/** 某部番的逐集状态（计划页展开时按需取，不用每次轮询都拉）。 */
async function handlePlannerSubject(deps: WebDeps, url: URL, response: ServerResponse): Promise<void> {
  const id = Number(url.searchParams.get('id') ?? '0');
  if (!Number.isFinite(id) || id <= 0) return sendJson(response, 400, { error: '缺少参数 id' });

  const client = new PlannerClient({
    baseUrl: deps.config.plannerBaseUrl,
    timeoutMs: Math.min(deps.config.trackers.timeoutMs ?? 15_000, 8000),
    retries: 0
  });

  try {
    const episodes = await client.subjectEpisodes(id);
    const today = new Date().toISOString().slice(0, 10);
    sendJson(response, 200, {
      subjectId: id,
      episodes: episodes
        .filter((episode) => episode.episodeType === 0)
        .map((episode) => ({
          ep: episode.ep,
          sort: episode.sort,
          title: episode.nameCn || episode.name,
          airdate: episode.airdate,
          airTime: episode.airTime ?? null,
          watched: episode.collectionType === 2,
          aired: (episode.airdate ?? '').slice(0, 10) <= today,
          dismissed: Boolean(episode.dismissedAt),
          snoozedUntil: episode.snoozedUntil ?? null
        }))
        .sort((a, b) => a.sort - b.sort)
    });
  } catch (error) {
    sendJson(response, 502, { error: `读取分集失败：${(error as Error).message.split('\n')[0]}` });
  }
}

type WatchlistBody = {
  action?: unknown;
  originalQuery?: unknown;
  entry?: {
    query?: unknown;
    lastEpisode?: unknown;
    startFrom?: unknown;
    totalEpisodes?: unknown;
    note?: unknown;
    enabled?: unknown;
  };
};

async function handleWatchlistEdit(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!deps.configPath) return sendJson(response, 400, { error: '服务启动时没有指定 config.json，无法定位追番清单' });

  let body: WatchlistBody;
  try {
    body = JSON.parse(await readBody(request)) as WatchlistBody;
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const path = watchlistPath(deps.configPath);
  const action = typeof body.action === 'string' ? body.action : '';
  const query = typeof body.entry?.query === 'string' ? body.entry.query.trim() : '';
  const originalQuery = typeof body.originalQuery === 'string' ? body.originalQuery : undefined;

  if (action !== 'remove' && query === '') {
    return sendJson(response, 400, { error: '番名不能为空' });
  }

  try {
    if (action === 'remove') {
      removeWatchEntry(path, originalQuery ?? query);
    } else if (action === 'toggle') {
      const current = loadWatchlist(path).entries.find((item) => item.query === (originalQuery ?? query));
      if (!current) return sendJson(response, 404, { error: `清单里没有《${query}》` });
      upsertWatchEntry(path, { ...current, enabled: current.enabled === false }, current.query);
    } else if (action === 'add' || action === 'update') {
      const lastEpisode = toOptionalPositiveInt(body.entry?.lastEpisode);
      const startFrom = toOptionalPositiveInt(body.entry?.startFrom);
      const totalEpisodes = toOptionalPositiveInt(body.entry?.totalEpisodes);
      const entry: WatchEntry = {
        query,
        lastEpisode,
        startFrom,
        totalEpisodes,
        note: typeof body.entry?.note === 'string' && body.entry.note.trim() !== '' ? body.entry.note.trim() : undefined,
        enabled: body.entry?.enabled !== false
      };
      upsertWatchEntry(path, entry, originalQuery);
    } else {
      return sendJson(response, 400, { error: 'action 只能是 add / update / remove / toggle' });
    }
  } catch (error) {
    return sendJson(response, 500, { error: `写入追番清单失败：${(error as Error).message}` });
  }

  sendJson(response, 200, await buildWatchlist(deps));
}

function toOptionalPositiveInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

/* ================================================================== *
 * 设置
 * ================================================================== */

async function handleConfigPatch(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!deps.configPath) return sendJson(response, 400, { error: '服务启动时没有指定 config.json，无法保存设置' });

  let body: { patch?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as { patch?: unknown };
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  const validated = validatePatch(body.patch);
  if (!validated.ok) return sendJson(response, 400, { error: validated.error });

  try {
    const raw = readRawConfig(deps.configPath);
    applyEntries(raw, validated.entries);
    writeRawConfig(deps.configPath, raw);
    reloadInto(deps);
    invalidateLibrary();
  } catch (error) {
    return sendJson(response, 500, { error: `保存 config.json 失败：${(error as Error).message}` });
  }

  log.info(`设置已更新：${validated.entries.map((entry) => entry.path).join('、')}`);
  sendJson(response, 200, {
    ok: true,
    path: deps.configPath,
    changed: redactPatch(validated.entries),
    restartRequired: restartEntries(validated.entries),
    config: redactConfig(deps.config)
  });
}

/** 直接编辑整份 config.json（高级用法）。 */
async function handleConfigRaw(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!deps.configPath) return sendJson(response, 400, { error: '服务启动时没有指定 config.json，无法保存设置' });

  let body: { text?: unknown };
  try {
    body = JSON.parse(await readBody(request)) as { text?: unknown };
  } catch {
    return sendJson(response, 400, { error: '请求体不是合法 JSON' });
  }

  if (typeof body.text !== 'string') return sendJson(response, 400, { error: '缺少 text 字段' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch (error) {
    return sendJson(response, 400, { error: `不是合法 JSON：${(error as Error).message}` });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return sendJson(response, 400, { error: 'config.json 的顶层必须是一个对象' });
  }

  // 已知字段仍然按白名单校验，避免手滑把端口写成字符串之类
  const validated = validatePatch(parsed);
  if (!validated.ok) return sendJson(response, 400, { error: validated.error });

  const raw = parsed as Record<string, unknown>;
  const warnings = unknownTopLevelKeys(raw, [
    'plannerBaseUrl',
    'intervalMinutes',
    'collectionTypes',
    'includeBacklog',
    'preference',
    'download',
    'qbittorrent',
    'trackers',
    'state',
    'notify',
    'web',
    'logLevel',
    'logFile'
  ]).map((key) => `未知字段 ${key}（会保留，但程序不认它）`);

  try {
    writeRawConfig(deps.configPath, raw);
    reloadInto(deps);
    invalidateLibrary();
  } catch (error) {
    return sendJson(response, 500, { error: `保存 config.json 失败：${(error as Error).message}` });
  }

  sendJson(response, 200, {
    ok: true,
    path: deps.configPath,
    restartRequired: restartEntries(validated.entries),
    warnings,
    config: redactConfig(deps.config)
  });
}

/**
 * 把磁盘上的配置重新读进来，并**就地**更新现有对象。
 *
 * 就地更新是关键：下载队列、Web 依赖都持有 deps.config 这个引用，
 * 换成新对象的话，改完设置得重启才生效。
 */
function reloadInto(deps: WebDeps): void {
  if (!deps.configPath) return;
  const reloaded = loadConfig({ configPath: deps.configPath }).config;
  Object.assign(deps.config, reloaded);
}

/* ================================================================== *
 * 日志
 * ================================================================== */

function logFileOf(deps: WebDeps): string | null {
  if (deps.config.logFile) return deps.config.logFile;
  if (deps.configPath) return join(dirname(deps.configPath), 'data', 'bangumi.log');
  return null;
}

function handleLogs(deps: WebDeps, url: URL, response: ServerResponse): void {
  const base = logFileOf(deps);
  if (!base) return sendJson(response, 200, { file: null, which: 'current', exists: false, size: 0, truncated: false, lines: [] });

  const which = url.searchParams.get('which') === 'previous' ? 'previous' : 'current';
  const file = which === 'previous' ? `${base}.1` : base;
  const lines = Number(url.searchParams.get('lines') ?? '400');

  const tail = readLogTail(file, { lines: Number.isFinite(lines) && lines > 0 ? lines : 400 });
  sendJson(response, 200, { ...tail, which, currentFile: base });
}

/* ================================================================== *
 * 依赖与工具
 * ================================================================== */

/** 惰性创建队列：测试里可以不传，直接用一个内部实例。 */
function ensureJobs(deps: WebDeps): JobQueue {
  if (!deps.jobs) {
    /*
     * 队列落盘：程序重启（更新、崩溃、计划任务重启）后，没下完的任务自动接着下。
     * 实测被用户连着抓到两次「我添加的任务怎么没了」——数据其实都在磁盘上，
     * 丢的只是「待办」这件事本身。
     */
    const queueFile = deps.configPath ? join(dirname(deps.configPath), 'data', 'queue.json') : undefined;
    deps.jobs = new JobQueue({
      config: deps.config,
      configPath: deps.configPath,
      qbittorrent: deps.qbittorrent,
      statePath: queueFile
    });
    /*
     * 让路：自动追番（另一个进程）正在下新播出的剧集时，队列里的补番暂停。
     * 用户的要求是「优先下载新播出的」—— 新番刚出种正需要抢速度，
     * 补番晚几分钟没有损失。判断依据是计划文件里那份实时进度（10 秒写一次）。
     */
    deps.jobs.setYieldProbe?.(() => {
      if (!deps.configPath) return null;
      let state;
      try {
        state = loadAutoSchedule(autoSchedulePath(deps.configPath));
      } catch {
        return null;
      }
      const running = effectiveRunning(state);
      if (!running) return null;
      // 记录超过 90 秒没更新 = 那个进程多半已经没了，别一直让路
      const age = Date.now() - new Date(running.updatedAt).getTime();
      if (!Number.isFinite(age) || age > 90_000) return null;
      return running.title.length > 42 ? `${running.title.slice(0, 42)}…` : running.title;
    });

    const restored = deps.jobs.restore();
    if (restored > 0) log.info(`启动时恢复了 ${restored} 个没下完的下载任务`);
  }
  return deps.jobs;
}

function ensureTasks(deps: WebDeps): TaskRunner {
  deps.tasks ??= new TaskRunner();
  return deps.tasks;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sendIndex(response: ServerResponse): void {
  const js = clientJs();
  const css = clientCss();

  if (js === null || css === null) {
    const message = '前端资源未构建。开发时请运行 npm run build:client，或直接用 npm run build 打包。';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>番剧下载器</title>
       <body style="font-family:-apple-system,'PingFang SC',sans-serif;background:#0f1115;color:#e6e8ec;padding:40px">
       <h1 style="font-size:18px">${message}</h1></body></html>`
    );
    return;
  }

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>番剧下载器</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script type="module">${js}</script>
</body>
</html>`;

  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html)
  });
  response.end(html);
}

export type StartedServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

/**
 * 「服务已经在跑」——不是故障，只是重复启动。
 *
 * 单独一个错误类型，好让调用方把它当成正常情况处理（提示 + 退出码 0），
 * 而不是当成启动失败报红。
 */
export class AlreadyRunningError extends Error {
  readonly host: string;
  readonly port: number;
  readonly existing: { version: string; backend?: string };

  constructor(host: string, port: number, existing: { version: string; backend?: string }) {
    super(
      `${host}:${port} 上已经有本程序在运行（版本 ${existing.version}，后端 ${existing.backend ?? '未知'}）。\n` +
        `直接打开 http://${host}:${port}/ 即可，不需要重复启动。\n` +
        '要重启的话：先结束那个进程（或跑 uninstall-startup.cmd 停掉常驻任务）再启动。'
    );
    this.name = 'AlreadyRunningError';
    this.host = host;
    this.port = port;
    this.existing = existing;
  }
}

/** 探测某个地址上是不是已经有本程序在跑（读它的 /api/status）。 */
async function probeExistingServer(
  host: string,
  port: number
): Promise<{ version: string; backend?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`http://${host}:${port}/api/status`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown; backend?: unknown };
    if (typeof body.version !== 'string') return null;
    return { version: body.version, backend: typeof body.backend === 'string' ? body.backend : undefined };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 启动 Web 界面并返回实际监听地址。端口传 0 时可以拿到系统分配的端口（测试用）。 */
/** 本机所有可用的访问地址（监听全部网卡时用）。 */
function localUrls(port: number): string[] {
  const urls = [`http://127.0.0.1:${port}/`];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.internal || item.family !== 'IPv4') continue;
      urls.push(`http://${item.address}:${port}/${name === 'Tailscale' ? '（Tailscale）' : ''}`);
    }
  }
  return urls;
}

export async function startWebServer(deps: WebDeps): Promise<StartedServer> {
  const server = createWebServer(deps);
  const { port, host } = deps.config.web;

  /*
   * 监听失败要给一句人话。
   *
   * 最常见的情况是端口被占 —— 而这个项目的 Web 界面是常驻后台的
   * （计划任务 BangumiDownloader-GUI），用户再双击一次启动脚本就会撞上。
   * 裸抛 EADDRINUSE 会让人以为是程序坏了，所以这里先探测一下：
   * 如果占用者就是我们自己的服务，直接告诉他「已经在跑了，打开这个地址」。
   */
  await new Promise<void>((resolve, reject) => {
    const onError = async (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (error.code !== 'EADDRINUSE') {
        reject(error);
        return;
      }
      const existing = await probeExistingServer(host, port);
      if (existing) {
        // 这不是错误：服务本来就在跑（常驻任务），用户只是又启动了一次
        reject(new AlreadyRunningError(host, port, existing));
        return;
      }
      reject(
        new Error(
          `端口 ${port} 已被别的程序占用。\n` +
            '改 config.json 里的 web.port 换个端口，或结束占用它的进程。'
        )
      );
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = address !== null && typeof address === 'object' ? address.port : port;

  /*
   * 监听 0.0.0.0 / :: 时，日志里打 "http://0.0.0.0:3778/" 是没法点的 ——
   * 用户复制这个地址到浏览器必然打不开（实测被问过「重启后打不开 webui」，
   * 原因就是地址不对）。所以这里把本机真实可用的地址列出来。
   */
  const listenAll = host === '0.0.0.0' || host === '::' || host === '';
  const urls = listenAll ? localUrls(actualPort) : [`http://${host}:${actualPort}/`];
  // 对外报的地址：监听全部网卡时优先给 Tailscale 那个（异地也能访问），否则给 127.0.0.1
  const url = urls.find((item) => item.includes('Tailscale')) ?? urls[0] ?? `http://${host}:${actualPort}/`;
  log.info(`Web 界面已启动：${urls.join('　')}`);

  if (deps.config.web.openBrowser) openBrowser(url);

  return {
    server,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

export function openBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, (error) => {
    if (error) log.debug(`自动打开浏览器失败（可手动访问 ${url}）：${error.message}`);
  });
}
