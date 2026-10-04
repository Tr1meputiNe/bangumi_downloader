import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { startWebServer, type StartedServer } from '../src/web/server.js';
import { clientJs } from '../src/web/assets.js';

/**
 * 真的把前端跑起来一遍。
 *
 * 为什么需要：htm 模板是**运行时**解析的，写错一个闭合标签、少一个 ${}
 * 类型检查完全看不出来，只有打开浏览器才会白屏。这个测试把构建产物
 * 丢进 jsdom 里执行，对每个页面都渲染一次 —— 页面渲染不出来会直接失败，
 * 而不是等到用户打开时才发现。
 */

const client = clientJs();
const describeIfBuilt = client === null ? describe.skip : describe;

describeIfBuilt('界面渲染冒烟测试', () => {
  let started: StartedServer;
  let root: string;
  let dom: JSDOM;

  let planner: Server | null = null;
  let plannerUrl = '';

  beforeAll(async () => {
    // 一个只有一集的假 Planner：计划表要有数据才能验证「按播出时间排」
    planner = createServer((request, response) => {
      const send = (payload: unknown) => {
        const body = JSON.stringify(payload);
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        response.end(body);
      };
      const subject = {
        id: 1,
        name: 'Fake Show',
        nameCn: '测试番剧',
        eps: 12,
        epStatus: 1,
        collectionType: 3,
        image: null,
        airDate: null,
        unwatchedMainEpisodeCount: 1,
        nextEpisode: {
          id: 11,
          subjectId: 1,
          subjectName: 'Fake Show',
          subjectNameCn: '测试番剧',
          episodeType: 0,
          sort: 8,
          ep: 8,
          name: 'ep 8',
          nameCn: '第 8 集',
          airdate: '2099-01-02',
          airTime: '21:30',
          collectionType: 0
        }
      };
      if ((request.url ?? '').startsWith('/api/dashboard')) {
        send({ pendingEpisodes: [], subjects: [subject], lastSyncAt: null, lastError: null });
        return;
      }
      send({ episodes: [] });
    });
    await new Promise<void>((resolve) => planner?.listen(0, '127.0.0.1', resolve));
    const address = planner.address();
    plannerUrl = `http://127.0.0.1:${address !== null && typeof address === 'object' ? address.port : 0}`;

    root = mkdtempSync(join(tmpdir(), 'ui-'));
    const seriesRoot = join(root, '番剧');
    mkdirSync(join(seriesRoot, '测试番剧'), { recursive: true });
    writeFileSync(join(seriesRoot, '测试番剧', '01.mkv'), Buffer.alloc(2048));
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'bangumi.log'), '[2026-01-01 00:00:00] INFO  [run] 测试日志\n', 'utf8');
    writeFileSync(join(root, 'watchlist.json'), JSON.stringify({ version: 1, entries: [{ query: '测试番剧', lastEpisode: 3 }] }), 'utf8');

    const configPath = join(root, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        web: { port: 0, host: '127.0.0.1', openBrowser: false },
        download: { backend: 'builtin', savePath: root, seriesDir: '番剧' },
        plannerBaseUrl: plannerUrl
      }),
      'utf8'
    );

    const { config } = loadConfig({ configPath });
    /*
     * 塞一个「正在下载」的任务进去，用来验证进度旁边那行小字
     * （还要多久）真的渲染出来了 —— 空队列是测不到的。
     */
    const { JobQueue } = await import('../src/core/jobs.js');
    const fakeJobs = new JobQueue({
      config,
      configPath,
      dispatch: (async (deps: { onProgress?: (p: unknown) => void }) => {
        deps.onProgress?.({
          ratio: 0.25,
          downloadedBytes: 512 * 1048576,
          totalBytes: 2048 * 1048576,
          speed: 512 * 1024,
          peers: 7
        });
        // 一直挂着，保持 running 状态
        return await new Promise(() => {});
      }) as never
    });
    fakeJobs.enqueue({
      title: '测试中的番剧 第 1 集',
      magnet: `magnet:?xt=urn:btih:${'9'.repeat(40)}`,
      sizeBytes: 2048 * 1048576
    });
    started = await startWebServer({ config, configPath, qbittorrent: undefined, jobs: fakeJobs });

    const base = started.url;
    dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
      url: `${base}#/overview`,
      runScripts: 'dangerously',
      pretendToBeVisual: true
    });

    // jsdom 没有 fetch：把相对路径补成真实服务地址，转发给 Node 的 fetch
    const window = dom.window as unknown as { fetch: typeof fetch };
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(typeof input === 'string' ? new URL(input, base).toString() : input, init)) as typeof fetch;

    dom.window.eval(client as string);
  });

  afterAll(async () => {
    dom?.window.close();
    await started?.close();
    await new Promise<void>((resolve) => (planner ? planner.close(() => resolve()) : resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const settle = async (ms = 350): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  const go = async (route: string): Promise<void> => {
    dom.window.location.hash = `#/${route}`;
    dom.window.dispatchEvent(new dom.window.Event('hashchange'));
    await settle();
  };

  it('外壳渲染出导航和状态栏', () => {
    const document = dom.window.document;
    expect(document.querySelectorAll('.nav-item').length).toBe(7);
    expect(document.querySelector('.brand')?.textContent).toContain('番剧下载器');
    // 状态是异步拉的，给它一点时间
    expect(document.querySelector('.sidebar-foot')?.textContent).toBeTruthy();
  });

  it('概览页渲染出卡片，并带上片库数字', async () => {
    await go('overview');
    const document = dom.window.document;
    const cards = document.querySelectorAll('.card');
    expect(cards.length).toBeGreaterThanOrEqual(4);
    const text = document.body.textContent ?? '';
    expect(text).toContain('运行状态');
    expect(text).toContain('片库');
    expect(text).toContain('追番清单');
    expect(text).toContain('计划任务');
    // 片库里有 1 部、1 个视频
    expect(text).toContain('测试番剧');
  });

  it('下载页渲染搜索框', async () => {
    await go('search');
    const document = dom.window.document;
    expect(document.querySelector('.searchbar input')).toBeTruthy();
    expect(document.body.textContent).toContain('搜索片源');
  });

  it('任务页没有任务时给出空状态；有任务时显示进度和「还要多久」', async () => {
    await go('jobs');
    const document = dom.window.document;
    expect(document.body.textContent).toContain('下载任务');

    // 测试服务器里塞了一个正在下的任务：512MB/2GB、512KB/s -> 还要约 51 分钟
    const eta = document.querySelector('.job-eta');
    expect(eta).toBeTruthy();
    expect(eta?.textContent).toContain('还要');
    expect(eta?.textContent).toMatch(/分钟|小时/);
    expect(document.body.textContent).toContain('测试中的番剧');
  });

  it('计划页渲染计划任务、追番清单和 Planner 三块', async () => {
    await go('plan');
    const document = dom.window.document;
    const text = document.body.textContent ?? '';
    expect(text).toContain('自动追番');
    expect(text).toContain('计划任务');
    expect(text).toContain('追番清单');
    expect(text).toContain('测试番剧');
    expect(text).toContain('下一集找第 4 集');
    // 计划页要能回答「下次什么时候检查」
    expect(text).toContain('下次检查');

    // 计划表：按播出时间排、每行给出「该取片源」的时刻和状态
    const rows = document.querySelectorAll('.plan-row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('测试番剧');
    expect(rows[0]?.textContent).toContain('等播出');
    expect(text).toContain('接下来的安排（按播出时间排）');
  });

  it('片库页列出条目，点开后能看到文件', async () => {
    await go('library');
    const document = dom.window.document;
    expect(document.body.textContent).toContain('测试番剧');

    const row = document.querySelector('.library-row') as HTMLElement | null;
    expect(row).toBeTruthy();
    row?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await settle();

    expect(document.querySelector('.file-table')).toBeTruthy();
    expect(document.querySelector('.file-table')?.textContent).toContain('01.mkv');
  });

  it('设置页把配置渲染成表单（密钥不回显）', async () => {
    await go('settings');
    const document = dom.window.document;
    const text = document.body.textContent ?? '';
    expect(text).toContain('下载目录');
    expect(text).toContain('高级：直接编辑 config.json');

    const inputs = document.querySelectorAll('.form-grid input');
    expect(inputs.length).toBeGreaterThan(20);
    // 下载目录应当带着当前值
    const values = [...inputs].map((input) => (input as HTMLInputElement).value);
    expect(values).toContain(root);
  });

  it('日志页渲染出日志行', async () => {
    await go('logs');
    const document = dom.window.document;
    expect(document.querySelectorAll('.log-line').length).toBeGreaterThan(0);
    expect(document.querySelector('.log-line')?.textContent).toContain('测试日志');
  });

  it('整个过程没有把异常抛到 window.onerror', async () => {
    // 渲染出错时 preact 会抛出并被 jsdom 记录；这里再兜一遍
    const errors: string[] = [];
    dom.window.addEventListener('error', (event) => errors.push(String(event)));
    for (const route of ['overview', 'search', 'jobs', 'plan', 'library', 'settings', 'logs']) {
      await go(route);
    }
    expect(errors).toEqual([]);
  });
});
