import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { exec } from 'node:child_process';
import { once } from 'node:events';
import type { AppConfig } from '../config.js';
import { QbittorrentClient } from '../qbittorrent/client.js';
import { searchAndRank } from '../core/search.js';
import { resolveBackend } from '../core/dispatch.js';
import { JobQueue } from '../core/jobs.js';
import { collectLibrary } from '../core/summary.js';
import { toDisplayResult } from './serialize.js';
import { SearchCache } from '../util/cache.js';
import { clientCss, clientJs } from './assets.js';
import { logger } from '../util/log.js';
import { VERSION } from '../version.js';

const log = logger('web');

/**
 * 本地 Web 界面。只用 Node 内置的 http 模块，不引入 Web 框架 ——
 * 整个项目要保持零运行时依赖，才能打成单文件 exe。
 *
 * 只监听 127.0.0.1：这是一个能往你 qBittorrent 推种子的接口，
 * 不应该暴露到局域网。需要局域网访问时改 config.web.host，风险自负。
 */

export type WebDeps = {
  /** 下载任务队列。不传时内部自建一个（测试用）。 */
  jobs?: JobQueue;
  config: AppConfig;
  qbittorrent?: QbittorrentClient;
};

const MAX_BODY_BYTES = 1024 * 1024;

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
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handle(deps: WebDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
    return sendIndex(response);
  }
  if (request.method === 'GET' && path === '/api/status') {
    return sendJson(response, 200, await buildStatus(deps));
  }
  if (request.method === 'GET' && path === '/api/search') {
    return handleSearch(deps, url, response);
  }
  if (request.method === 'POST' && path === '/api/add') {
    return handleAdd(deps, request, response);
  }
  if (request.method === 'GET' && path === '/api/library') {
    const savePath = deps.config.download.savePath || deps.config.qbittorrent.savePath;
    if (!savePath) return sendJson(response, 200, { root: '', entries: [], totalBytes: 0, totalVideos: 0 });
    const summary = collectLibrary({
      savePath,
      seriesDir: deps.config.download.seriesDir,
      ignoreDirs: deps.config.download.ignoreDirs ?? []
    });
    return sendJson(response, 200, {
      root: summary.root,
      seriesRoot: summary.seriesRoot,
      totalBytes: summary.totalBytes,
      totalVideos: summary.totalVideos,
      entries: summary.entries
        .sort((a, b) => b.bytes - a.bytes)
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          bytes: entry.bytes,
          videoCount: entry.videoCount,
          otherCount: entry.otherCount,
          kind: entry.kind
        }))
    });
  }
  if (request.method === 'GET' && path === '/api/jobs') {
    const jobs = ensureJobs(deps).list();
    return sendJson(response, 200, { jobs: jobs.map(toJobView), running: ensureJobs(deps).running });
  }
  if (request.method === 'POST' && path === '/api/jobs/act') {
    return handleJobAction(deps, request, response);
  }
  if (request.method === 'GET' && path === '/healthz') {
    return sendJson(response, 200, { ok: true });
  }

  sendJson(response, 404, { error: 'Not found' });
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
  const base = {
    version: VERSION,
    planner: deps.config.plannerBaseUrl,
    backend: resolveBackend(deps.config)
  };

  if (resolveBackend(deps.config) === 'builtin') {
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

async function handleSearch(deps: WebDeps, url: URL, response: ServerResponse): Promise<void> {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (query === '') {
    return sendJson(response, 400, { error: '缺少查询参数 q' });
  }

  const limit = Number(url.searchParams.get('limit') ?? '0');
  const cacheKey = `manual:${query.toLowerCase()}`;

  const { value: outcome, cached } = await searchCache.getOrLoad(cacheKey, () =>
    searchAndRank({
      query,
      config: deps.config,
      mode: 'manual',
      resolveMikanMagnet: true
    })
  );

  const max = Number.isFinite(limit) && limit > 0 ? limit : 0;
  const ranked = max > 0 ? outcome.ranked.slice(0, max) : outcome.ranked;

  sendJson(response, 200, {
    query,
    queries: outcome.queries,
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
    messages: job.messages.slice(-8),
    files: job.files,
    error: job.error,
    backend: job.backend,
    // 前端据此决定显示哪些按钮，省得它自己推状态机
    canPause: job.status === 'running' || job.status === 'queued',
    canResume: job.status === 'paused',
    canCancel: job.status === 'running' || job.status === 'queued' || job.status === 'paused'
  };
}

/** 惰性创建队列：测试里可以不传，直接用一个内部实例。 */
function ensureJobs(deps: WebDeps): JobQueue {
  deps.jobs ??= new JobQueue({ config: deps.config, qbittorrent: deps.qbittorrent });
  return deps.jobs;
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
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>番剧资源搜索</title>
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
<title>番剧资源搜索</title>
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

/** 启动 Web 界面并返回实际监听地址。端口传 0 时可以拿到系统分配的端口（测试用）。 */
export async function startWebServer(deps: WebDeps): Promise<StartedServer> {
  const server = createWebServer(deps);
  const { port, host } = deps.config.web;

  server.listen(port, host);
  await once(server, 'listening');

  const address = server.address();
  const actualPort = address !== null && typeof address === 'object' ? address.port : port;
  const url = `http://${host}:${actualPort}/`;
  log.info(`Web 界面已启动：${url}`);

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

function openBrowser(url: string): void {
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
