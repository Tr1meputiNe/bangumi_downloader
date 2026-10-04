import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { AlreadyRunningError, startWebServer, type StartedServer } from '../src/web/server.js';
import { clientCss, clientJs } from '../src/web/assets.js';
import { SearchCache } from '../src/util/cache.js';
import { selectFileIndexes } from '../src/core/push.js';
import { toDisplayResult } from '../src/web/serialize.js';
import { rankCandidates } from '../src/anime/rank.js';
import { JobQueue } from '../src/core/jobs.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchResult } from '../src/anime/rank.js';

function result(overrides: Partial<SearchResult> & { title: string }): SearchResult {
  return {
    magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
    sizeBytes: 1024 ** 3,
    publishedAt: null,
    seederCount: 10,
    leecherCount: null,
    tracker: 'test',
    provider: 'test',
    ...overrides
  };
}

describe('SearchCache', () => {
  it('命中缓存时不重复执行 loader', async () => {
    const cache = new SearchCache<string>({ ttlMs: 10_000, maxEntries: 5 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return `value-${calls}`;
    };

    const first = await cache.getOrLoad('k', loader);
    const second = await cache.getOrLoad('k', loader);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('并发请求同一个 key 只执行一次 loader', async () => {
    const cache = new SearchCache<number>({ ttlMs: 10_000, maxEntries: 5 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return calls;
    };

    const all = await Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)]);
    expect(calls).toBe(1);
    expect(all.map((item) => item.value)).toEqual([1, 1, 1]);
  });

  it('过期后重新执行 loader', async () => {
    const cache = new SearchCache<string>({ ttlMs: 20, maxEntries: 5 });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return `v${calls}`;
    };
    await cache.getOrLoad('k', loader);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const after = await cache.getOrLoad('k', loader);
    expect(after.cached).toBe(false);
    expect(calls).toBe(2);
  });

  it('超过容量时淘汰最久未使用的条目', async () => {
    const cache = new SearchCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 让 a 变成最近使用
    cache.set('c', 3); // 应该淘汰 b
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });
});

describe('手动搜索不按集号淘汰', () => {
  const config = defaultConfig();

  it('matchesEpisode=false 时保留下载集号不匹配的结果', () => {
    const results = [
      result({ title: '[A] Frieren S02 - 05 [1080p][简体].mkv' }),
      result({ title: '[B] Frieren S02 - 09 [1080p][简体].mkv' })
    ];
    const targets = [
      { subjectId: 0, subjectName: 'x', subjectNameCn: 'x', episode: 5, season: 2, airDate: null }
    ];

    const automation = rankCandidates(results, {
      preference: config.preference,
      targets,
      targetSeason: 2,
      matchesEpisode: true
    });
    const manual = rankCandidates(results, {
      preference: config.preference,
      targets,
      targetSeason: 2,
      matchesEpisode: false
    });

    // 自动化只留下第 5 集那一条
    expect(automation.filter((item) => !item.rejected).length).toBe(1);
    // 手动搜索两条都留着，集号仍然被解析出来但不再作为淘汰依据
    expect(manual.filter((item) => !item.rejected).length).toBe(2);
    expect(manual[1]?.parsed.episodes).toEqual([9]);
  });

  it('手动搜索仍然保留排除词淘汰', () => {
    const results = [result({ title: '[A] Frieren S02 - 05 预告 [1080p]' })];
    const manual = rankCandidates(results, {
      preference: config.preference,
      targets: [],
      targetSeason: null,
      matchesEpisode: false
    });
    expect(manual[0]?.rejected).toBe(true);
    expect(manual[0]?.rejectReason).toContain('排除词');
  });
});

describe('toDisplayResult', () => {
  it('用 infohash 做前端 key，便于跨源去重', () => {
    const hash = 'd'.repeat(40);
    const ranked = rankCandidates([result({ title: '[A] Frieren - 05 [1080p].mkv', magnet: `magnet:?xt=urn:btih:${hash}` })], {
      preference: defaultConfig().preference,
      targets: [],
      targetSeason: null,
      matchesEpisode: false
    });
    const display = toDisplayResult(ranked[0]!);
    expect(display.key).toBe(hash);
    expect(display.parsed.episodes).toEqual([5]);
    expect(display.rejectReason).toBeNull();
  });

  it('没有磁力时退回标题做 key', () => {
    const ranked = rankCandidates([result({ title: '[A] Frieren - 05 [1080p].mkv', magnet: '' })], {
      preference: defaultConfig().preference,
      targets: [],
      targetSeason: null,
      matchesEpisode: false
    });
    const display = toDisplayResult(ranked[0]!);
    expect(display.key.startsWith('t:')).toBe(true);
  });
});

describe('Web 服务', () => {
  let started: StartedServer;

  beforeAll(async () => {
    const config = defaultConfig();
    // 端口 0 让系统分配，避免和真实服务或并行测试抢端口
    config.web = { ...config.web, port: 0, host: '127.0.0.1', openBrowser: false };
    started = await startWebServer({ config, qbittorrent: undefined });
  });

  afterAll(async () => {
    await started?.close();
  });

  it('首页始终返回 200，并根据前端是否构建给出对应内容', async () => {
    const response = await fetch(started.url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>番剧下载器</title>');

    if (clientJs() === null || clientCss() === null) {
      // 未构建前端时应当给出明确提示，而不是白屏
      expect(html).toContain('前端资源未构建');
    } else {
      // 已构建时 CSS 与 JS 必须内联在 HTML 里（单文件 exe 没有静态资源目录）
      expect(html).toContain('<style>');
      expect(html).toContain('type="module"');
      expect(html).toContain('id="app"');
    }
  });

  it('/api/status 分开返回版本与连接状态（默认内置引擎时下载可用）', async () => {
    const response = await fetch(`${started.url}api/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // 版本号必须始终是纯版本号，不能混进错误信息
    expect(typeof body.version).toBe('string');
    expect(body.version as string).toMatch(/^\d+\.\d+\.\d+$/);
    /*
     * 这里以前断言 not-configured —— 那是「下载只能靠 qBittorrent」时代的语义。
     * 现在默认后端是内置引擎（零外部依赖），没有 qBittorrent 也照样能下载，
     * 所以状态必须是 ok。否则界面会一直挂着「未配置 qBittorrent，只能搜索不能下载」
     * 这种假警告，让人以为下载坏了。
     */
    expect(body.backend).toBe('builtin');
    expect(body.qbittorrent).toBe('ok');
    // message 是给人看的一句话，不应包含换行
    expect(body.message as string).not.toContain('\n');
  });

  it('/healthz 返回 ok', async () => {
    const response = await fetch(`${started.url}healthz`);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('缺少 q 参数时返回 400', async () => {
    const response = await fetch(`${started.url}api/search`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('q') });
  });

  it('内置引擎后端下 /api/add 不再因为「没有 qBittorrent」被拒', async () => {
    const response = await fetch(`${started.url}api/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ title: 'x', magnet: 'magnet:?xt=urn:btih:abc' }] })
    });
    /*
     * 以前这里断言 503（未配置 qBittorrent）。现在默认走内置引擎，
     * 请求会被正常受理；测试环境没有真实种子，因此允许它因为
     * 下载失败而返回带 results 的 200，只要不是 503 挡在门口。
     */
    expect(response.status).not.toBe(503);
    if (response.status === 200) {
      const body = (await response.json()) as { results?: unknown[] };
      expect(Array.isArray(body.results)).toBe(true);
    }
  });

  it('未知路径返回 404', async () => {
    const response = await fetch(`${started.url}nope`);
    expect(response.status).toBe(404);
  });

  it('请求体不是 JSON 时返回 400', async () => {
    const response = await fetch(`${started.url}api/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json'
    });
    // 必须被判为「请求体有问题」，而不是被后端配置挡掉
    expect(response.status).toBe(400);
  });

});

describe('selectFileIndexes（push 模块）', () => {
  it('只挑目标集对应的文件', () => {
    const files = [
      { index: 0, path: 'Frieren/01.mkv' },
      { index: 1, path: 'Frieren/02.mkv' },
      { index: 2, path: 'Frieren/03.mkv' }
    ];
    const selected = selectFileIndexes(files, [2]);
    expect(selected.indexes).toEqual([1]);
    expect(selected.matchedEpisodes).toEqual([2]);
  });

  it('跳过字体与 NC 文件', () => {
    const files = [
      { index: 0, path: 'Frieren/01.mkv' },
      { index: 1, path: 'Frieren/NCOP.mkv' },
      { index: 2, path: 'Frieren/fonts.zip' }
    ];
    expect(selectFileIndexes(files, [1]).indexes).toEqual([0]);
  });
});

describe('下载任务队列（/api/add 不再阻塞等待）', () => {
  let started: StartedServer;

  beforeAll(async () => {
    const config = defaultConfig();
    config.web = { ...config.web, port: 0, host: '127.0.0.1', openBrowser: false };
    config.download = { ...config.download, backend: 'builtin', savePath: '/tmp/dsh-jobs-test' };
    // 显式给一个队列实例，方便断言任务确实进了队列
    started = await startWebServer({ config, qbittorrent: undefined, jobs: new JobQueue({ config }) });
  });

  afterAll(async () => {
    await started?.close();
  });

  it('入队后立刻返回任务号，而不是等到下载结束', async () => {
    const begin = Date.now();
    const response = await fetch(`${started.url}api/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            title: '任务队列测试',
            // 故意用无效 infohash：下载必然找不到 peer，但**入队必须立刻返回**
            magnet: `magnet:?xt=urn:btih:${'0'.repeat(40)}&dn=x`
          }
        ]
      })
    });
    const elapsed = Date.now() - begin;

    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<{ ok: boolean; jobId?: string }>; queued?: number };
    expect(body.queued).toBe(1);
    expect(body.results[0]?.ok).toBe(true);
    expect(body.results[0]?.jobId).toBeTruthy();
    // 关键：必须立刻返回。以前这里会同步等下载完成，几十分钟都有可能
    expect(elapsed).toBeLessThan(3000);

    const jobs = (await (await fetch(`${started.url}api/jobs`)).json()) as {
      jobs: Array<{ id: string; status: string }>;
    };
    expect(jobs.jobs.some((job) => job.id === body.results[0]?.jobId)).toBe(true);
  });

  it('/api/jobs 返回前端画进度条需要的字段', async () => {
    const response = await fetch(`${started.url}api/jobs`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: Array<Record<string, unknown>>; running: boolean };
    expect(typeof body.running).toBe('boolean');
    expect(Array.isArray(body.jobs)).toBe(true);
    const job = body.jobs[0];
    if (job) {
      for (const field of ['id', 'title', 'status', 'percent', 'downloadedBytes', 'messages']) {
        expect(job).toHaveProperty(field);
      }
    }
  });
});

describe('任务操作：暂停 / 继续 / 取消', () => {
  let started: StartedServer;
  let queue: JobQueue;
  let config: ReturnType<typeof defaultConfig>;

  beforeAll(async () => {
    config = defaultConfig();
    config.web = { ...config.web, port: 0, host: '127.0.0.1', openBrowser: false };
    config.download = { ...config.download, backend: 'builtin', savePath: '/tmp/dsh-jobs-test' };
    queue = new JobQueue({ config });
    started = await startWebServer({ config, qbittorrent: undefined, jobs: queue });
  });

  afterAll(async () => {
    await started?.close();
  });

  const act = async (id: string, action: string) =>
    fetch(`${started.url}api/jobs/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action })
    });

  const enqueue = async (): Promise<string> => {
    const response = await fetch(`${started.url}api/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ title: `暂停测试 ${Date.now()}`, magnet: `magnet:?xt=urn:btih:${'1'.repeat(40)}&dn=x` }]
      })
    });
    const body = (await response.json()) as { results: Array<{ jobId?: string }> };
    return body.results[0]?.jobId as string;
  };

  it('暂停一个运行中的任务，状态变成 paused 而不是 failed', async () => {
    const id = await enqueue();
    await act(id, 'pause');

    // 等 abort 生效（引擎要么很快抛，要么在下一个检查点退出）
    let job = queue.get(id);
    for (let i = 0; i < 40 && job?.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = queue.get(id);
    }

    expect(job?.status).toBe('paused');
    // 关键：不能显示成失败 —— 用户主动暂停和引擎超时走的是同一条代码路径
    expect(job?.error).toBeNull();
    await act(id, 'cancel');
  });

  it('继续一个暂停的任务：重新排队并且不再带着错误信息', async () => {
    const id = await enqueue();
    await act(id, 'pause');
    let job = queue.get(id);
    for (let i = 0; i < 40 && job?.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = queue.get(id);
    }
    expect(job?.status).toBe('paused');

    const response = await act(id, 'resume');
    expect(response.status).toBe(200);
    expect(queue.get(id)?.status === 'queued' || queue.get(id)?.status === 'running').toBe(true);
    expect(queue.get(id)?.error).toBeNull();

    await act(id, 'cancel');
  });

  it('取消后的任务不会再跑', async () => {
    const id = await enqueue();
    await act(id, 'cancel');
    let job = queue.get(id);
    for (let i = 0; i < 30 && (job?.status === 'running' || job?.status === 'queued'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      job = queue.get(id);
    }
    expect(['cancelled', 'paused']).toContain(job?.status);
    // 取消之后不应该再变成 completed/failed
    expect(job?.status).toBe('cancelled');
  });

  it('对已结束的任务操作会被拒绝（409），而不是静默成功', async () => {
    const id = await enqueue();
    await act(id, 'cancel');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const response = await act(id, 'resume');
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: string };
    expect(typeof body.error).toBe('string');
  });

  it('非法 action 返回 400', async () => {
    const id = await enqueue();
    const response = await act(id, 'explode');
    expect(response.status).toBe(400);
    await act(id, 'cancel');
  });

  it('/api/jobs 带上 canPause / canResume / canCancel，前端据此显示图标按钮', async () => {
    const id = await enqueue();
    const body = (await (await fetch(`${started.url}api/jobs`)).json()) as {
      jobs: Array<{ id: string; canPause: boolean; canResume: boolean; canCancel: boolean }>;
    };
    const job = body.jobs.find((item) => item.id === id);
    expect(job).toBeDefined();
    expect(typeof job?.canPause).toBe('boolean');
    expect(typeof job?.canResume).toBe('boolean');
    expect(typeof job?.canCancel).toBe('boolean');
    await act(id, 'cancel');
  });
});

describe('下载库归纳（/api/library）', () => {
  it('返回按体积排序的条目，供界面显示「已有内容」', async () => {
    const config = defaultConfig();
    config.web = { ...config.web, port: 0, host: '127.0.0.1', openBrowser: false };
    // 指到一个临时目录，里面造两部「番剧」
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    const seriesRoot = join(root, '番剧');
    mkdirSync(join(seriesRoot, 'A 番'), { recursive: true });
    mkdirSync(join(seriesRoot, 'B 番'), { recursive: true });
    writeFileSync(join(seriesRoot, 'A 番', '01.mkv'), Buffer.alloc(400 * 1024));
    writeFileSync(join(seriesRoot, 'A 番', '02.mkv'), Buffer.alloc(400 * 1024));
    writeFileSync(join(seriesRoot, 'B 番', 'movie.mp4'), Buffer.alloc(100 * 1024));
    config.download = { ...config.download, savePath: root, seriesDir: '番剧' };

    const started = await startWebServer({ config, qbittorrent: undefined });
    try {
      const response = await fetch(`${started.url}api/library`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        entries: Array<{ name: string; bytes: number; videoCount: number; kind: string }>;
        totalVideos: number;
        seriesRoot?: string | null;
      };

      expect(body.entries).toHaveLength(2);
      // 按体积降序：A 番（两个文件）在前
      expect(body.entries[0]?.name).toBe('A 番');
      expect(body.entries[0]?.videoCount).toBe(2);
      expect(body.entries[0]?.kind).toBe('series');
      expect(body.entries[1]?.kind).toBe('single');
      expect(body.totalVideos).toBe(3);
      expect(body.seriesRoot).toContain('番剧');
    } finally {
      await started.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('重复启动的处理', () => {
  it('服务已在跑时抛 AlreadyRunningError，而不是裸的 EADDRINUSE', async () => {
    const config = defaultConfig();
    config.web = { ...config.web, port: 0, host: '127.0.0.1', openBrowser: false };

    // 先占一个固定端口（模拟「常驻服务已经在跑」）
    const first = await startWebServer({ config: { ...config, web: { ...config.web, port: 34567 } }, qbittorrent: undefined });
    try {
      const second = { ...config, web: { ...config.web, port: 34567 } };
      await expect(startWebServer({ config: second, qbittorrent: undefined })).rejects.toThrow(AlreadyRunningError);

      // 报错信息要能直接照着做：给出地址，而不是堆栈
      await startWebServer({ config: second, qbittorrent: undefined }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(AlreadyRunningError);
        if (error instanceof AlreadyRunningError) {
          expect(error.port).toBe(34567);
          expect(error.message).toContain('http://');
          expect(error.message).toContain('已经有本程序在运行');
        }
      });
    } finally {
      await first.close();
    }
  });
});
