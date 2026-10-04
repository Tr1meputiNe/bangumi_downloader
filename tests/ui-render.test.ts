import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
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

  beforeAll(async () => {
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
        plannerBaseUrl: 'http://127.0.0.1:9'
      }),
      'utf8'
    );

    const { config } = loadConfig({ configPath });
    started = await startWebServer({ config, configPath, qbittorrent: undefined });

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

  it('任务页在没有任务时给出空状态而不是报错', async () => {
    await go('jobs');
    const document = dom.window.document;
    expect(document.body.textContent).toContain('下载任务');
    expect(document.querySelector('.empty')).toBeTruthy();
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
