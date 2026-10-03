import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { exec } from 'node:child_process';
import { once } from 'node:events';
import type { AppConfig } from '../config.js';
import { QbittorrentClient } from '../qbittorrent/client.js';
import { searchAndRank } from '../core/search.js';
import { pushRelease } from '../core/push.js';
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
  if (request.method === 'GET' && path === '/healthz') {
    return sendJson(response, 200, { ok: true });
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function buildStatus(deps: WebDeps) {
  const version = VERSION;
  if (!deps.qbittorrent) {
    return { qbittorrent: 'not-configured', version, planner: deps.config.plannerBaseUrl };
  }
  try {
    const info = await deps.qbittorrent.version();
    return { qbittorrent: 'ok', version: `${info.app} (WebAPI ${info.api})`, planner: deps.config.plannerBaseUrl };
  } catch (error) {
    return {
      qbittorrent: 'error',
      version: error instanceof Error ? error.message : String(error),
      planner: deps.config.plannerBaseUrl
    };
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
  if (!deps.qbittorrent) {
    return sendJson(response, 503, { error: '未配置 qBittorrent（config.json 的 download.enabled 可能为 false）' });
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

  const results: Array<{ title: string; ok: boolean; error?: string; infoHash?: string; fileCount?: number | null }> = [];
  for (const raw of items) {
    const title = typeof raw.title === 'string' ? raw.title : '';
    const magnet = typeof raw.magnet === 'string' ? raw.magnet : '';
    const torrentUrl = typeof raw.torrentUrl === 'string' ? raw.torrentUrl : '';
    const tracker = typeof raw.tracker === 'string' ? raw.tracker : undefined;
    const sizeBytes = typeof raw.sizeBytes === 'number' ? raw.sizeBytes : null;
    const episodes = Array.isArray(raw.episodes)
      ? raw.episodes.filter((value): value is number => typeof value === 'number')
      : [];

    if (title === '' || (magnet === '' && torrentUrl === '')) {
      results.push({ title: title || '(无标题)', ok: false, error: '缺少标题或下载链接' });
      continue;
    }

    try {
      const pushed = await pushRelease(deps.qbittorrent, deps.config, {
        title,
        magnet,
        torrentUrl,
        sizeBytes,
        tracker,
        episodes
      });
      results.push({ title, ok: true, infoHash: pushed.infoHash, fileCount: pushed.fileCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`推送失败：${title.slice(0, 60)} → ${message}`);
      results.push({ title, ok: false, error: message });
    }
  }

  sendJson(response, 200, { results });
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
