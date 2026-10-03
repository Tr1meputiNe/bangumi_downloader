import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { defaultConfig } from '../src/config.js';
import { QbittorrentClient } from '../src/qbittorrent/client.js';
import { PlannerClient } from '../src/planner/client.js';
import { StateStore } from '../src/state/store.js';
import { runSync } from '../src/core/sync.js';
import type { SearchResult } from '../src/anime/rank.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 用一个真实的本地 HTTP 服务器模拟 qBittorrent WebUI，
 * 配合一个假的 Watch Planner，把「抓取 → 搜索 → 打分 → 推送」整条链路跑通。
 * 这样不需要真的安装 qBittorrent，也能验证请求体、cookie、filePrio 等协议细节。
 */

type Captured = {
  path: string;
  method: string;
  body: URLSearchParams;
  cookie: string | null;
  referer: string | null;
};

/** 最小的 bencode 编码器，用来在测试里造一个真实可解析的 .torrent。 */
function bencode(node: unknown): Buffer {
  const parts: Buffer[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'number') {
      parts.push(Buffer.from(`i${value}e`));
      return;
    }
    if (typeof value === 'string') {
      const bytes = Buffer.from(value, 'utf8');
      parts.push(Buffer.from(`${bytes.length}:`), bytes);
      return;
    }
    if (Buffer.isBuffer(value)) {
      parts.push(Buffer.from(`${value.length}:`), value);
      return;
    }
    if (Array.isArray(value)) {
      parts.push(Buffer.from('l'));
      for (const item of value) walk(item);
      parts.push(Buffer.from('e'));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      parts.push(Buffer.from('d'));
      // bencode 要求字典键按字节序升序
      for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )) {
        walk(key);
        walk(item);
      }
      parts.push(Buffer.from('e'));
      return;
    }
    throw new Error(`无法编码的类型：${typeof value}`);
  };
  walk(node);
  return Buffer.concat(parts);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function formBody(raw: string): URLSearchParams {
  // URLSearchParams 会把 '+' 解析成空格，而 base64 里可能出现 '+'，
  // 所以这里先手工还原成 %2B 再交给 URLSearchParams。
  return new URLSearchParams(raw.replace(/\+/g, '%2B'));
}

describe('整链路集成（mock qBittorrent + mock Planner）', () => {
  let server: Server;
  let baseUrl = '';
  const captured: Captured[] = [];

  // 合集内的文件清单：第 5、6 集是目标
  const filePaths = [
    'Frieren/01.mkv',
    'Frieren/04.mkv',
    'Frieren/05.mkv',
    'Frieren/06.mkv',
    'Frieren/12.mkv',
    'Frieren/NCOP.mkv',
    'Frieren/fonts.zip'
  ];
  const torrentFiles = filePaths.map((name, index) => ({
    index,
    name,
    size: 100,
    priority: 0,
    progress: 0
  }));

  // 造一个真的 .torrent，让解析出的 infohash 与磁力链接一致
  const torrentBuffer = bencode({
    announce: 'http://tracker.test/announce',
    info: {
      files: filePaths.map((path) => ({ length: 100, path: path.split('/') })),
      name: 'Frieren',
      'piece length': 16384,
      pieces: Buffer.alloc(20, 0x41)
    }
  });
  const infoStart = torrentBuffer.indexOf(Buffer.from('4:infod')) + '4:info'.length;
  const infoBytes = torrentBuffer.subarray(infoStart, torrentBuffer.length - 1);
  const infohash = createHash('sha1').update(infoBytes).digest('hex');
  const magnet = `magnet:?xt=urn:btih:${infohash}`;

  beforeAll(async () => {
    server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const raw = await readBody(request);
      const body = request.method === 'POST' ? formBody(raw) : new URLSearchParams();
      captured.push({
        path: url.pathname,
        method: request.method ?? 'GET',
        body,
        cookie: (request.headers.cookie as string | undefined) ?? null,
        referer: (request.headers.referer as string | undefined) ?? null
      });

      const json = (payload: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const text = (value: string, status = 200, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'text/plain', ...headers });
        response.end(value);
      };

      switch (url.pathname) {
        case '/api/v2/auth/login': {
          if (body.get('username') !== 'admin' || body.get('password') !== 'secret') {
            return text('Fails.', 200);
          }
          return text('Ok.', 200, { 'set-cookie': 'SID=test-session-id; path=/' });
        }
        case '/api/v2/app/version':
          return text('v5.0.5');
        case '/api/v2/app/webapiVersion':
          return text('2.11');
        case '/api/v2/torrents/createCategory':
          return text('', 200);
        case '/api/v2/torrents/add':
          return text('Ok.', 200);
        case '/api/v2/torrents/info':
          return json([
            {
              hash: infohash,
              name: 'Frieren 01-12',
              state: 'downloading',
              progress: 0,
              size: 5000,
              save_path: '/downloads',
              category: 'Bangumi',
              tags: 'bangumi-downloader'
            }
          ]);
        case '/api/v2/torrents/files':
          return json(torrentFiles);
        case '/fake.torrent': {
          response.writeHead(200, { 'content-type': 'application/x-bittorrent' });
          return response.end(torrentBuffer);
        }
        default:
          return json({ error: 'not found' }, 404);
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('无法启动 mock 服务器');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('登录成功并读取版本', async () => {
    const client = new QbittorrentClient(
      { ...defaultConfig().qbittorrent, url: baseUrl, username: 'admin', password: 'secret' },
      { fetchImpl: (input, init) => fetch(input as string, init) }
    );
    const version = await client.version();
    expect(version.app).toBe('v5.0.5');
    expect(version.api).toBe('2.11');
  });

  it('密码错误时给出可读的报错', async () => {
    const client = new QbittorrentClient(
      { ...defaultConfig().qbittorrent, url: baseUrl, username: 'admin', password: 'wrong' }
    );
    await expect(client.login()).rejects.toThrow(/登录失败/);
  });

  it('整链路：抓取未看集 → 搜索 → 打分 → 只勾选目标分集推送到 qBittorrent', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bangumi-dl-test-'));
    try {
      const config = defaultConfig();
      config.qbittorrent = {
        ...config.qbittorrent,
        url: baseUrl,
        username: 'admin',
        password: 'secret',
        savePath: '',
        category: 'Bangumi'
      };
      config.state.file = join(stateDir, 'state.json');
      config.download.maxEpisodesPerSubjectPerRun = 3;

      const planner = new PlannerClient({ baseUrl: 'http://planner.invalid', timeoutMs: 1000, retries: 0 });
      const state = new StateStore(config.state.file, 30);
      const client = new QbittorrentClient(config.qbittorrent, { timeoutMs: 5000 });

      // stub 掉 Planner 与片源搜索，只验证编排、打分与推送
      planner.collectGaps = async () => [
        {
          subject: {
            id: 638497,
            name: '正反対な君と僕 第2期',
            nameCn: '相反的你和我 第二季',
            eps: 13,
            epStatus: 12,
            collectionType: 3,
            plannerMode: 'seasonal'
          },
          missingEpisodes: [5, 6],
          episodeMeta: new Map([
            [5, { id: 1, subjectId: 638497, subjectName: 'x', subjectNameCn: 'x', episodeType: 0, sort: 5, ep: 5, name: '', nameCn: '', airdate: '2026-08-01', collectionType: 0 }],
            [6, { id: 2, subjectId: 638497, subjectName: 'x', subjectNameCn: 'x', episodeType: 0, sort: 6, ep: 6, name: '', nameCn: '', airdate: '2026-08-08', collectionType: 0 }]
          ]),
          season: 2,
          queries: ['相反的你和我 第二季']
        }
      ];

      const searchResults: SearchResult[] = [
        {
          title: '[A组] 相反的你和我 第二季 - 05 [1080p][繁体][MP4]',
          magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
          sizeBytes: 300 * 1024 ** 2,
          publishedAt: null,
          seederCount: 50,
          leecherCount: null,
          tracker: 'nyaa',
          provider: 'nyaa.si'
        },
        {
          // 合集，应该胜出并且只勾选第 5、6 集
          title: '[喵萌奶茶屋&LoliHouse] 相反的你和我 第二季 01-13 合集 [BDRip 1080p HEVC-10bit FLAC][简繁日内封字幕].mkv',
          magnet,
          torrentUrl: `${baseUrl}/fake.torrent`,
          sizeBytes: 12 * 1024 ** 3,
          publishedAt: null,
          seederCount: 20,
          leecherCount: null,
          tracker: 'mikan',
          provider: 'mikan'
        }
      ];

      const report = await runSync(
        {
          planner,
          state,
          qbittorrent: client,
          config,
          today: '2026-10-03',
          search: async () => searchResults
        },
        'enabled'
      );

      expect(report.failures).toEqual([]);
      expect(report.stats.downloaded).toBe(2);
      expect(report.added.length).toBe(1);
      expect(report.added[0]!.episodes).toEqual([5, 6]);

      // 校验推送给 qBittorrent 的请求体：只勾选第 5、6 集对应的文件索引 2 与 3
      const addCalls = captured.filter((item) => item.path === '/api/v2/torrents/add');
      expect(addCalls.length).toBe(1);
      const addBody = addCalls[0]!.body;
      expect(addBody.get('filePrio')).toBe('2:1|3:1');
      expect(addBody.get('category')).toBe('Bangumi');
      expect(addBody.get('tags')).toBe('bangumi-downloader');
      expect(addBody.get('root_folder')).toBe('true');
      // 没有磁力时用内嵌种子，这里合集走的是 torrentUrl 分支，应带上 torrents 字段
      expect(addBody.get('urls')).toBeNull();
      expect(addBody.get('torrents')).not.toBeNull();

      // 请求必须带 cookie，并且 Referer 与 Host 一致（qBittorrent 的 CSRF 校验）
      expect(addCalls[0]!.cookie).toContain('SID=test-session-id');
      expect(addCalls[0]!.referer).toBe(baseUrl);

      // 分类被创建
      expect(captured.some((item) => item.path === '/api/v2/torrents/createCategory')).toBe(true);

      // 状态被记账，且再跑一轮不会重复推送
      expect(state.hasEpisode(638497, 5)).toBeTruthy();
      expect(state.hasEpisode(638497, 6)).toBeTruthy();

      const secondRun = await runSync(
        { planner, state, qbittorrent: client, config, today: '2026-10-03', search: async () => searchResults },
        'enabled'
      );
      expect(secondRun.stats.downloaded).toBe(0);
      expect(secondRun.stats.skippedHistory).toBe(2);
      expect(captured.filter((item) => item.path === '/api/v2/torrents/add').length).toBe(1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
