import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { JobQueue } from '../src/core/jobs.js';
import { TaskRunner } from '../src/web/tasks.js';
import { runAutoTask, runVerifyTask, type VerifyTaskResult } from '../src/web/tasks.js';
import {
  setAutoRunner,
  setVerifyRunner,
  startWebServer,
  type StartedServer
} from '../src/web/server.js';

/**
 * 完整页面的接口测试。
 *
 * 这一层测的是「请求进来 → 立刻返回 → 轮询拿到结果」这条链路，
 * 以及所有会改磁盘的接口（设置、追番清单、片库打开）的边界：
 * 越界路径必须被挡住，密钥不能回传给浏览器。
 */

type Harness = {
  started: StartedServer;
  root: string;
  configPath: string;
  config: ReturnType<typeof loadConfig>['config'];
  close: () => Promise<void>;
};

async function harness(options: { logLines?: string[] } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'webapi-'));
  const seriesRoot = join(root, '番剧');
  mkdirSync(join(seriesRoot, 'A 番'), { recursive: true });
  writeFileSync(join(seriesRoot, 'A 番', '01.mkv'), Buffer.alloc(2048));
  writeFileSync(join(seriesRoot, 'A 番', '02.mkv'), Buffer.alloc(1024));
  writeFileSync(join(seriesRoot, 'A 番', 'note.txt'), 'x');

  const configPath = join(root, 'config.json');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        web: { port: 0, host: '127.0.0.1', openBrowser: false },
        download: { backend: 'builtin', savePath: root, seriesDir: '番剧' },
        qbittorrent: { password: 'topsecret' },
        notify: { serverChanKey: 'SCT123' }
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  if (options.logLines) {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'bangumi.log'), `${options.logLines.join('\n')}\n`, 'utf8');
  }

  const { config } = loadConfig({ configPath });
  const started = await startWebServer({
    config,
    configPath,
    qbittorrent: undefined,
    jobs: new JobQueue({ config }),
    tasks: new TaskRunner()
  });

  return {
    started,
    root,
    configPath,
    config,
    close: async () => {
      await started.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('概览接口', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('/api/overview 一次给出状态、片库、追番、计划任务', async () => {
    const response = await fetch(`${h.started.url}api/overview`);
    expect(response.status).toBe(200);
    const body = await json<Record<string, any>>(response);

    expect(body.status.backend).toBe('builtin');
    expect(body.library.entries).toBe(1);
    expect(body.library.videos).toBe(2);
    expect(body.watchlist.total).toBe(0);
    expect(body.jobs.counts.running).toBe(0);
    expect(Array.isArray(body.tasks)).toBe(true);
    // 非 Windows 上探测不到计划任务，但字段必须在，界面才不会崩
    expect(typeof body.schedule.ok).toBe('boolean');
    expect(typeof body.planner.ok).toBe('boolean');
  });

  it('/api/status 带上界面需要的路径信息', async () => {
    const body = await json<Record<string, unknown>>(await fetch(`${h.started.url}api/status`));
    expect(body.savePath).toBe(h.root);
    expect(body.configPath).toBe(h.configPath);
    expect(typeof body.backendLabel).toBe('string');
  });
});

describe('设置接口', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('GET /api/config 不回传密钥，只说明有没有设置过', async () => {
    const body = await json<Record<string, any>>(await fetch(`${h.started.url}api/config`));
    expect(body.path).toBe(h.configPath);
    expect(body.config.qbittorrent.password).toBe('');
    expect(body.config.notify.serverChanKey).toBe('');
    expect(body.config.secrets['qbittorrent.password']).toBe(true);
    expect(body.config.secrets['notify.serverChanKey']).toBe(true);
    // 普通字段照常回传
    expect(body.config.download.backend).toBe('builtin');
  });

  it('POST /api/config 只写改过的字段，并立刻对运行中的实例生效', async () => {
    const response = await post(`${h.started.url}api/config`, { patch: { download: { readyDelayMinutes: 25 } } });
    expect(response.status).toBe(200);
    const body = await json<Record<string, any>>(response);
    expect(body.changed.map((item: { path: string }) => item.path)).toContain('download.readyDelayMinutes');

    // 磁盘上确实写了
    const onDisk = JSON.parse(readFileSync(h.configPath, 'utf8')) as Record<string, any>;
    expect(onDisk.download.readyDelayMinutes).toBe(25);
    // 用户自己写的密钥没被冲掉
    expect(onDisk.qbittorrent.password).toBe('topsecret');
    // 运行中的配置对象也改了（不重启就生效）
    expect(h.config.download.readyDelayMinutes).toBe(25);
  });

  it('未列在白名单里的字段被拒绝，而不是悄悄写进去', async () => {
    const response = await post(`${h.started.url}api/config`, { patch: { download: { somethingElse: 1 } } });
    expect(response.status).toBe(400);
    expect((await json<{ error: string }>(response)).error).toContain('不支持修改');
  });

  it('类型不对的值被拒绝', async () => {
    const response = await post(`${h.started.url}api/config`, { patch: { web: { port: 'abc' } } });
    expect(response.status).toBe(400);
    expect((await json<{ error: string }>(response)).error).toContain('必须是数字');
  });

  it('超出范围的端口被拒绝', async () => {
    const response = await post(`${h.started.url}api/config`, { patch: { web: { port: 70000 } } });
    expect(response.status).toBe(400);
  });

  it('改动需要重启的字段会明确告知', async () => {
    const response = await post(`${h.started.url}api/config`, { patch: { web: { host: '0.0.0.0' } } });
    expect(response.status).toBe(200);
    const body = await json<{ restartRequired: string[] }>(response);
    expect(body.restartRequired).toContain('web.host');
  });

  it('直接编辑整份 JSON 时，非法内容被拒绝', async () => {
    const bad = await post(`${h.started.url}api/config/raw`, { text: '{ not json' });
    expect(bad.status).toBe(400);

    const wrongType = await post(`${h.started.url}api/config/raw`, {
      text: JSON.stringify({ download: { trialSeconds: 'soon' } })
    });
    expect(wrongType.status).toBe(400);

    const ok = await post(`${h.started.url}api/config/raw`, {
      text: JSON.stringify({ download: { savePath: h.root, backend: 'builtin', trialSeconds: 30 } })
    });
    expect(ok.status).toBe(200);
    expect(h.config.download.trialSeconds).toBe(30);
  });
});

describe('追番清单接口', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('增删改查走一圈，并且真的写进 watchlist.json', async () => {
    const added = await post(`${h.started.url}api/watchlist`, {
      action: 'add',
      entry: { query: '吹响上低音号 第三季', startFrom: 1, note: '测试' }
    });
    expect(added.status).toBe(200);
    const afterAdd = await json<Record<string, any>>(added);
    expect(afterAdd.entries).toHaveLength(1);
    expect(afterAdd.entries[0].nextEpisode).toBe(1);
    expect(afterAdd.file).toBe(join(h.root, 'watchlist.json'));

    const updated = await json<Record<string, any>>(
      await post(`${h.started.url}api/watchlist`, {
        action: 'update',
        originalQuery: '吹响上低音号 第三季',
        entry: { query: '吹响上低音号 第三季', lastEpisode: 12 }
      })
    );
    expect(updated.entries[0].lastEpisode).toBe(12);
    expect(updated.entries[0].nextEpisode).toBe(13);

    const toggled = await json<Record<string, any>>(
      await post(`${h.started.url}api/watchlist`, { action: 'toggle', entry: { query: '吹响上低音号 第三季' } })
    );
    expect(toggled.entries[0].enabled).toBe(false);

    const removed = await json<Record<string, any>>(
      await post(`${h.started.url}api/watchlist`, { action: 'remove', entry: { query: '吹响上低音号 第三季' } })
    );
    expect(removed.entries).toHaveLength(0);

    const onDisk = JSON.parse(readFileSync(join(h.root, 'watchlist.json'), 'utf8')) as { entries: unknown[] };
    expect(onDisk.entries).toHaveLength(0);
  });

  it('空番名被拒绝', async () => {
    const response = await post(`${h.started.url}api/watchlist`, { action: 'add', entry: { query: '   ' } });
    expect(response.status).toBe(400);
  });

  it('非法 action 被拒绝', async () => {
    const response = await post(`${h.started.url}api/watchlist`, { action: 'explode', entry: { query: 'x' } });
    expect(response.status).toBe(400);
  });
});

describe('片库接口', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('/api/library 归纳出条目与体积', async () => {
    const body = await json<Record<string, any>>(await fetch(`${h.started.url}api/library`));
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].name).toBe('A 番');
    expect(body.entries[0].videoCount).toBe(2);
    expect(body.entries[0].otherCount).toBe(1);
    expect(body.totalVideos).toBe(2);
  });

  it('/api/library/entry 列出文件清单', async () => {
    const body = await json<Record<string, any>>(
      await fetch(`${h.started.url}api/library/entry?path=${encodeURIComponent('番剧/A 番')}`)
    );
    expect(body.fileCount).toBe(3);
    expect(body.files.map((file: { name: string }) => file.name)).toEqual(['01.mkv', '02.mkv', 'note.txt']);
    expect(body.files[0].video).toBe(true);
    expect(body.files[2].video).toBe(false);
  });

  it('越界路径被挡住（不允许读下载目录之外的东西）', async () => {
    const response = await fetch(`${h.started.url}api/library/entry?path=${encodeURIComponent('../../../etc')}`);
    expect([400, 404]).toContain(response.status);
  });

  it('/api/open 只允许下载目录和程序自己的文件', async () => {
    const outside = await post(`${h.started.url}api/open`, { path: '/etc/passwd' });
    expect(outside.status).toBe(400);
    expect((await json<{ error: string }>(outside)).error).toContain('只能打开');
  });
});

describe('日志接口', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({
      logLines: [
        '[2024-05-01 10:00:00] INFO  [run] 本轮结束：新下载 2 条',
        '[2024-05-01 10:00:01] WARN  [bittorrent] peer 连接被重置',
        '[2024-05-01 10:00:02] ERROR [web] 请求处理失败：boom',
        '这行不是标准格式'
      ]
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('按行解析出时间、级别和模块', async () => {
    const body = await json<Record<string, any>>(await fetch(`${h.started.url}api/logs?lines=10`));
    expect(body.exists).toBe(true);
    expect(body.lines).toHaveLength(4);
    expect(body.lines[0].level).toBe('INFO');
    expect(body.lines[0].scope).toBe('run');
    expect(body.lines[1].level).toBe('WARN');
    expect(body.lines[2].text).toContain('boom');
    // 非标准行也要原样保留，不能丢
    expect(body.lines[3].level).toBeNull();
    expect(body.lines[3].text).toContain('不是标准格式');
  });

  it('只取末尾 N 行', async () => {
    const body = await json<Record<string, any>>(await fetch(`${h.started.url}api/logs?lines=2`));
    expect(body.lines).toHaveLength(2);
    // 末尾两行 = ERROR 那行 + 非标准格式那行
    expect(body.lines[0].text).toContain('boom');
    expect(body.lines[1].text).toContain('不是标准格式');
  });
});

describe('后台任务接口（核对 / 追番）', () => {
  let h: Harness;
  let originalVerify: typeof runVerifyTask;
  let originalAuto: typeof runAutoTask;
  let releaseAuto: (() => void) | null = null;

  beforeAll(async () => {
    h = await harness();
    originalVerify = runVerifyTask;
    originalAuto = runAutoTask;
  });

  afterAll(async () => {
    setVerifyRunner(originalVerify);
    setAutoRunner(originalAuto);
    await h.close();
  });

  afterEach(() => {
    setVerifyRunner(originalVerify);
    setAutoRunner(originalAuto);
    releaseAuto = null;
  });

  const waitForTask = async (id: string, timeoutMs = 4000): Promise<Record<string, any>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const body = await json<{ tasks: Array<Record<string, any>> }>(await fetch(`${h.started.url}api/tasks`));
      const task = body.tasks.find((item) => item.id === id);
      if (task && task.status !== 'running') return task;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error('任务没有在预期时间内结束');
  };

  it('核对片库：立刻返回任务号，轮询能拿到进度和结果', async () => {
    setVerifyRunner((async (_deps, _options, context) => {
      context.step('核对 1/2：A 番', 0.5);
      context.note('已核对 A 番');
      return {
        target: null,
        reports: [],
        removed: [],
        cleanEmpty: false,
        scannedAt: new Date().toISOString(),
        totalBytes: 0,
        completeCount: 1,
        emptyCount: 0,
        missingCount: 0,
        unplayableCount: 0
      } satisfies VerifyTaskResult;
    }) as typeof runVerifyTask);

    const response = await post(`${h.started.url}api/library/verify`, { checkPlayable: false });
    expect(response.status).toBe(200);
    const { taskId } = await json<{ taskId: string }>(response);

    const task = await waitForTask(taskId);
    expect(task.status).toBe('done');
    expect(task.result.completeCount).toBe(1);
    expect(task.lines.join('\n')).toContain('已核对 A 番');
  });

  it('同一个任务不允许并发跑两次', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    setVerifyRunner((async (_deps, _options, context) => {
      context.step('慢慢核对', 0.1);
      await gate;
      return {
        target: null,
        reports: [],
        removed: [],
        cleanEmpty: false,
        scannedAt: new Date().toISOString(),
        totalBytes: 0,
        completeCount: 0,
        emptyCount: 0,
        missingCount: 0,
        unplayableCount: 0
      } satisfies VerifyTaskResult;
    }) as typeof runVerifyTask);

    const first = await post(`${h.started.url}api/library/verify`, {});
    expect(first.status).toBe(200);
    const second = await post(`${h.started.url}api/library/verify`, {});
    expect(second.status).toBe(409);
    expect((await json<{ error: string }>(second)).error).toContain('已经有一次核对');

    const { taskId } = await json<{ taskId: string }>(first);
    const cancel = await post(`${h.started.url}api/tasks/act`, { id: taskId, action: 'cancel' });
    expect(cancel.status).toBe(200);
    release();
  });

  it('立刻追番：任务结束后带回结果摘要', async () => {
    setAutoRunner((async () =>
      ({
        subjects: 2,
        checked: 1,
        source: 'watchlist',
        dryRun: true,
        downloaded: [{ query: 'A 番', episodes: [1], files: 2, completed: true, bytesWritten: 1024 }],
        skipped: [],
        finishedAt: new Date().toISOString()
      })) as typeof runAutoTask);

    const response = await post(`${h.started.url}api/auto/run`, { dryRun: true });
    expect(response.status).toBe(200);
    const { taskId } = await json<{ taskId: string }>(response);
    const task = await waitForTask(taskId);
    expect(task.status).toBe('done');
    expect(task.result.downloaded).toHaveLength(1);
    expect(task.kind).toBe('auto');
  });

  it('追番正在跑时重复点击被挡住（409）', async () => {
    setAutoRunner((async () => {
      await new Promise<void>((resolve) => {
        releaseAuto = resolve;
      });
      return {
        subjects: 0,
        checked: 0,
        source: 'watchlist',
        dryRun: false,
        downloaded: [],
        skipped: [],
        finishedAt: new Date().toISOString()
      };
    }) as typeof runAutoTask);

    const first = await post(`${h.started.url}api/auto/run`, {});
    expect(first.status).toBe(200);
    const second = await post(`${h.started.url}api/auto/run`, {});
    expect(second.status).toBe(409);
    expect((await json<{ error: string }>(second)).error).toContain('已经有一轮追番');

    const { taskId } = await json<{ taskId: string }>(first);
    await post(`${h.started.url}api/tasks/act`, { id: taskId, action: 'cancel' });
    releaseAuto?.();
  });
});

describe('下载任务：清理已结束的记录', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('只清掉已结束的任务，暂停中的保留', async () => {
    const added = await post(`${h.started.url}api/add`, {
      items: [{ title: '清理测试', magnet: `magnet:?xt=urn:btih:${'2'.repeat(40)}&dn=x` }]
    });
    const body = await json<{ results: Array<{ jobId: string }> }>(added);
    const id = body.results[0]?.jobId as string;

    await post(`${h.started.url}api/jobs/act`, { id, action: 'cancel' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const cleared = await json<{ removed: number }>(await post(`${h.started.url}api/jobs/clear`, {}));
    expect(cleared.removed).toBeGreaterThanOrEqual(1);

    const after = await json<{ jobs: unknown[] }>(await fetch(`${h.started.url}api/jobs`));
    expect(after.jobs.find((job) => (job as { id: string }).id === id)).toBeUndefined();
  });
});

describe('核对任务：把清单里过时的位置记录改过来', () => {
  it('内容在番剧目录里、清单还记着根目录时，核对后清单被修正', async () => {
    const h = await harness();
    const { saveInventory, loadInventory } = await import('../src/core/verify.js');

    try {
      // 内容实际在 番剧/A 番 下，但清单里只记了名字（迁移前的记录）
      saveInventory(h.root, [{ name: 'A 番', path: 'A 番', kind: 'series' }]);
      // 这条用例要跑真的核对逻辑，所以把执行体换回真实实现
      setVerifyRunner(runVerifyTask);

      const response = await post(`${h.started.url}api/library/verify`, { checkPlayable: false });
      expect(response.status).toBe(200);
      const { taskId } = await json<{ taskId: string }>(response);

      const deadline = Date.now() + 5000;
      let status = 'running';
      while (Date.now() < deadline && status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const body = await json<{ tasks: Array<{ id: string; status: string }> }>(await fetch(`${h.started.url}api/tasks`));
        status = body.tasks.find((task) => task.id === taskId)?.status ?? 'running';
      }

      expect(status).toBe('done');
      expect(loadInventory(h.root).find((entry) => entry.name === 'A 番')?.path).toBe('番剧/A 番');
    } finally {
      setVerifyRunner(runVerifyTask);
      await h.close();
    }
  });
});

describe('有进度的失败会自动重试，而不是判死', () => {
  it('进度过半被中断 -> 回到队列并说明「不会重下已校验的分片」', async () => {
    const { JobQueue } = await import('../src/core/jobs.js');
    const config = {
      download: { backend: 'builtin', savePath: '/tmp/x' },
      qbittorrent: { savePath: '/tmp/x' }
    } as never;

    let calls = 0;
    const queue = new JobQueue({
      config,
      // 第一次下到一半抛「超时」，第二次直接成功
      dispatch: (async (deps: { onProgress?: (p: unknown) => void }) => {
        calls += 1;
        // 进度是通过 deps.onProgress 报回来的（不是 input）
        deps.onProgress?.({ ratio: 0.956, downloadedBytes: 6038 * 1048576, totalBytes: 6316 * 1048576, speed: 0, peers: 0 });
        if (calls === 1) throw new Error('下载超时或已取消（上限 3600 秒）');
        return { files: ['/tmp/x/a.mkv'], fileCount: 1, backend: 'builtin' };
      }) as never
    });

    queue.enqueue({ title: '测试种子', magnet: `magnet:?xt=urn:btih:${'e'.repeat(40)}` });
    // 等第一次尝试失败并进入重试排队
    await new Promise((resolve) => setTimeout(resolve, 200));

    const job = queue.list()[0]!;
    // 不该是 failed —— 用户明确说过速度无所谓，挂了就丢 6GB 是纯浪费
    expect(job.status === 'failed').toBe(false);
    expect(job.messages.some((line) => line.includes('自动重试'))).toBe(true);
    expect(job.messages.some((line) => line.includes('不会重下'))).toBe(true);
  });
});

describe('队列落盘：重启后没下完的任务自动接着下', () => {
  it('入队的任务会写进队列文件，恢复时重新排队', async () => {
    const { JobQueue } = await import('../src/core/jobs.js');
    const dir = mkdtempSync(join(tmpdir(), 'queue-'));
    const statePath = join(dir, 'queue.json');
    const config = { download: { backend: 'builtin', savePath: dir }, qbittorrent: { savePath: dir } } as never;

    try {
      // 一个永远不会自己结束的「下载」，模拟正在下的时候程序被重启
      const stalling = (async () => new Promise(() => {})) as never;
      const first = new JobQueue({ config, statePath, dispatch: stalling });
      first.enqueue({ title: '没下完的番', magnet: `magnet:?xt=urn:btih:${'f'.repeat(40)}`, sizeBytes: 1234 });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 落盘的内容应该包含这条（running 也要记，重启后重新排队）
      const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { jobs: Array<{ title: string; status: string }> };
      expect(saved.jobs).toHaveLength(1);
      expect(saved.jobs[0]?.title).toBe('没下完的番');
      expect(saved.jobs[0]?.status).toBe('queued');

      // 新进程启动：restore 应该把它重新排上
      const second = new JobQueue({ config, statePath, dispatch: stalling });
      expect(second.restore()).toBe(1);
      const job = second.list()[0]!;
      expect(job.title).toBe('没下完的番');
      expect(job.messages.some((line) => line.includes('重启后自动恢复'))).toBe(true);

      // 重复恢复不会加两遍
      expect(second.restore()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('下完的任务不再留在队列文件里', async () => {
    const { JobQueue } = await import('../src/core/jobs.js');
    const dir = mkdtempSync(join(tmpdir(), 'queue-'));
    const statePath = join(dir, 'queue.json');
    const config = { download: { backend: 'builtin', savePath: dir }, qbittorrent: { savePath: dir } } as never;
    try {
      const queue = new JobQueue({
        config,
        statePath,
        dispatch: (async () => ({ files: ['/tmp/a.mkv'], fileCount: 1, backend: 'builtin' })) as never
      });
      queue.enqueue({ title: '下完的番', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { jobs: unknown[] };
      expect(saved.jobs).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
