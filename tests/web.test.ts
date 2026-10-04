import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { startWebServer, type StartedServer } from '../src/web/server.js';
import { clientCss, clientJs } from '../src/web/assets.js';
import { SearchCache } from '../src/util/cache.js';
import { selectFileIndexes } from '../src/core/push.js';
import { toDisplayResult } from '../src/web/serialize.js';
import { rankCandidates } from '../src/anime/rank.js';
import { JobQueue } from '../src/core/jobs.js';
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
    expect(html).toContain('<title>番剧资源搜索</title>');

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
