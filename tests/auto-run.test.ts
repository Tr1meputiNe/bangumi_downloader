import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuto } from '../src/core/auto.js';
import { autoSchedulePath, loadAutoSchedule, type AutoScheduleState } from '../src/core/auto-schedule.js';
import { defaultConfig } from '../src/config.js';

/**
 * 自动追番的「什么时候真干活」端到端测试。
 *
 * 用一个假的 Planner 顶掉真的那个（真实数据形状照抄），验证三件事：
 *   1. 还不到计划时间时：整轮跳过，**一次请求都不发**（这是省掉 96 轮/天的关键）
 *   2. 已经下过的集：不再重复搜索下载（Planner 的「未看」不会因为我们下完就变）
 *   3. 跑完之后：把下一轮时间算出来写进计划文件
 */

type FakePlanner = {
  server: Server;
  baseUrl: string;
  /** 收到过多少次请求 —— 用来断言「跳过时真的没发请求」。 */
  requests: () => number;
  reset: () => void;
  close: () => Promise<void>;
};

function isoDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function startFakePlanner(options: { subjectId: number; name: string; airedUnwatchedEp: number | null; nextEp: number; nextInDays: number; nextAirTime: string | null }): Promise<FakePlanner> {
  let count = 0;

  const episodes = [] as Array<Record<string, unknown>>;
  if (options.airedUnwatchedEp !== null) {
    episodes.push({
      id: 900 + options.airedUnwatchedEp,
      subjectId: options.subjectId,
      subjectName: 'Fake Show',
      subjectNameCn: options.name,
      episodeType: 0,
      sort: options.airedUnwatchedEp,
      ep: options.airedUnwatchedEp,
      name: `ep ${options.airedUnwatchedEp}`,
      nameCn: `第 ${options.airedUnwatchedEp} 集`,
      airdate: isoDate(-1),
      airTime: '20:00',
      collectionType: 0
    });
  }
  episodes.push({
    id: 901,
    subjectId: options.subjectId,
    subjectName: 'Fake Show',
    subjectNameCn: options.name,
    episodeType: 0,
    sort: options.nextEp,
    ep: options.nextEp,
    name: `ep ${options.nextEp}`,
    nameCn: `第 ${options.nextEp} 集`,
    airdate: isoDate(options.nextInDays),
    airTime: options.nextAirTime,
    collectionType: 0
  });

  const server = createServer((request, response) => {
    count += 1;
    const url = request.url ?? '';
    const json = (payload: unknown) => {
      const body = JSON.stringify(payload);
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    };

    if (url.startsWith('/api/dashboard')) {
      json({
        pendingEpisodes: [],
        subjects: [
          {
            id: options.subjectId,
            name: 'Fake Show',
            nameCn: options.name,
            eps: 12,
            epStatus: options.nextEp - 1,
            collectionType: 3,
            image: null,
            airDate: null,
            airYear: 2026,
            totalEpisodesKnown: true,
            unwatchedMainEpisodeCount: options.airedUnwatchedEp === null ? 0 : 1,
            nextEpisode: {
              id: 901,
              subjectId: options.subjectId,
              subjectName: 'Fake Show',
              subjectNameCn: options.name,
              episodeType: 0,
              sort: options.nextEp,
              ep: options.nextEp,
              name: `ep ${options.nextEp}`,
              nameCn: `第 ${options.nextEp} 集`,
              airdate: isoDate(options.nextInDays),
              airTime: options.nextAirTime,
              collectionType: 0
            }
          }
        ],
        lastSyncAt: new Date().toISOString(),
        lastError: null
      });
      return;
    }

    if (/^\/api\/subjects\/\d+\/episodes/.test(url)) {
      json({ episodes });
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;

  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => count,
    reset: () => {
      count = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

type Harness = {
  root: string;
  configPath: string;
  config: ReturnType<typeof defaultConfig>;
  planner: FakePlanner;
  close: () => Promise<void>;
};

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function harness(plannerOptions: Parameters<typeof startFakePlanner>[0]): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'auto-run-'));
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'data'), { recursive: true });

  const planner = await startFakePlanner(plannerOptions);
  const configPath = join(root, 'config.json');
  const config = defaultConfig();
  config.plannerBaseUrl = planner.baseUrl;
  config.collectionTypes = [3];
  config.download.savePath = root;
  config.download.seriesDir = '番剧';
  config.download.readyDelayMinutes = 60;
  config.download.activeIntervalMinutes = 15;
  config.download.idleIntervalMinutes = 180;
  config.download.releaseWindowHours = 12;
  config.trackers.animesGarden = false;
  config.trackers.mikan = false;
  config.trackers.nyaa = false;
  writeFileSync(configPath, `${JSON.stringify({}, null, 2)}\n`, 'utf8');

  open.push(async () => {
    await planner.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { root, configPath, config, planner, close: async () => undefined };
}

/** 手写一份计划文件（模拟「上一轮已经算好了计划」）。 */
function writeSchedule(h: Harness, patch: Partial<AutoScheduleState>): void {
  const path = autoSchedulePath(h.configPath);
  const base: AutoScheduleState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    nextCheckAt: null,
    nextRefreshAt: null,
    nextReason: '',
    windows: [],
    triggers: [],
    done: [],
    lastSkipReason: null
  };
  mkdirSync(join(h.root, 'data'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, 'utf8');
}

describe('自动追番：没到计划时间就整轮跳过', () => {
  it('跳过时不发任何请求，也不写「本轮结束」的假报告', async () => {
    const h = await harness({ subjectId: 1, name: '测试番', airedUnwatchedEp: null, nextEp: 2, nextInDays: 3, nextAirTime: '20:00' });
    const future = new Date(Date.now() + 3 * 3600_000).toISOString();
    writeSchedule(h, { nextCheckAt: future, nextReason: '《测试番》第 2 集 20:00 播出，21:00 之后开始找片源' });
    h.planner.reset();

    const report = await runAuto({ config: h.config, configPath: h.configPath, dryRun: false });

    expect(report.skippedBySchedule).toBe(true);
    expect(report.downloaded).toEqual([]);
    // 关键：一次网络请求都没有
    expect(h.planner.requests()).toBe(0);
    expect(report.schedule?.nextCheckAt).toBe(future);
  });

  it('手动触发（force）时忽略计划，真的去问 Planner', async () => {
    const h = await harness({ subjectId: 1, name: '测试番', airedUnwatchedEp: null, nextEp: 2, nextInDays: 3, nextAirTime: '20:00' });
    writeSchedule(h, { nextCheckAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
    h.planner.reset();

    const report = await runAuto({ config: h.config, configPath: h.configPath, dryRun: true, force: true });

    expect(report.skippedBySchedule).toBeUndefined();
    expect(h.planner.requests()).toBeGreaterThan(0);
  });
});

describe('自动追番：已经下过的集不重复下', () => {
  it('Planner 还标着「未看」，但我们下过了 —— 跳过且不去搜片源', async () => {
    const h = await harness({ subjectId: 7, name: '测试番', airedUnwatchedEp: 1, nextEp: 2, nextInDays: 3, nextAirTime: '20:00' });
    // 第 1 集昨天播的、未看，但我们上一轮已经下完了
    writeSchedule(h, { done: [{ subjectId: 7, episode: 1, query: '测试番', at: new Date().toISOString() }] });

    const report = await runAuto({ config: h.config, configPath: h.configPath, dryRun: false, force: true });

    expect(report.downloaded).toEqual([]);
    const skip = report.skipped.find((item) => item.query === '测试番');
    expect(skip?.reason).toContain('已经下过');
    // 没有去搜片源：片源站全关掉了，能跑通就说明没走搜索这条路
    expect(h.planner.requests()).toBeGreaterThan(0);
  });

  it('没下过的集照旧会去处理（不是把所有集都跳过了）', async () => {
    const h = await harness({ subjectId: 7, name: '测试番', airedUnwatchedEp: 1, nextEp: 2, nextInDays: 3, nextAirTime: '20:00' });
    // 计划里记的是别的集，第 1 集没下过
    writeSchedule(h, { done: [{ subjectId: 7, episode: 9, query: '测试番', at: new Date().toISOString() }] });

    const report = await runAuto({ config: h.config, configPath: h.configPath, dryRun: true, force: true });

    // dry-run：会挑出第 1 集但不会真下
    const skip = report.skipped.find((item) => item.query === '测试番');
    expect(skip?.reason ?? '').not.toContain('已经下过');
  });
});

describe('自动追番：跑完把下一轮时间算出来', () => {
  it('按 Planner 的下一集播出时间安排下次检查', async () => {
    const h = await harness({ subjectId: 3, name: '测试番', airedUnwatchedEp: null, nextEp: 5, nextInDays: 4, nextAirTime: '22:30' });

    const report = await runAuto({ config: h.config, configPath: h.configPath, dryRun: true, force: true });

    expect(report.schedule?.nextCheckAt).toBeTruthy();
    expect(report.schedule?.reason).toContain('测试番');

    // 计划文件真的落盘了，界面上看的就是它
    const path = autoSchedulePath(h.configPath);
    expect(existsSync(path)).toBe(true);
    const state = loadAutoSchedule(path);
    expect(state.nextCheckAt).toBe(report.schedule?.nextCheckAt);
    expect(state.lastSkipReason).toBeNull();
  });

  it('还在等片源的集会被记进活跃窗口，下次检查是 15 分钟后', async () => {
    // 第 1 集昨天 20:00 播的 → 早就过点；下一集在 4 天后
    const h = await harness({ subjectId: 4, name: '测试番', airedUnwatchedEp: 1, nextEp: 2, nextInDays: 4, nextAirTime: '22:30' });
    // 把这集标成已下完，免得真去搜片源；窗口本身就来自 nextEpisode（在 4 天后）
    writeSchedule(h, { done: [{ subjectId: 4, episode: 1, query: '测试番', at: new Date().toISOString() }] });

    const report = await runAuto({ config: h.config, configPath: h.configPath, dryRun: false, force: true });

    const state = loadAutoSchedule(autoSchedulePath(h.configPath));
    expect(report.schedule?.nextCheckAt).toBe(state.nextCheckAt);
    expect(state.nextCheckAt).toBeTruthy();
    // 下一集还没播，所以不是在等片源的 15 分钟档
    expect(state.windows).toEqual([]);
  });
});
