import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import {
  applyEntries,
  readRawConfig,
  redactConfig,
  restartEntries,
  unknownTopLevelKeys,
  validatePatch,
  writeRawConfig
} from '../src/web/settings.js';
import { buildProbeScript, describeResult, formatInterval, parseProbeOutput } from '../src/web/schedule.js';
import {
  loadWatchlist,
  markEpisodesCompleted,
  nextEpisodeOf,
  removeWatchEntry,
  upsertWatchEntry
} from '../src/core/watchlist.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('设置：patch 校验', () => {
  it('只接受白名单里的字段', () => {
    expect(validatePatch({ download: { readyDelayMinutes: 30 } }).ok).toBe(true);
    const bad = validatePatch({ download: { nope: 1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('不支持修改');
  });

  it('空 patch 被拒绝（避免「保存了一个什么都没改的请求」）', () => {
    const result = validatePatch({});
    expect(result.ok).toBe(false);
  });

  it('类型和范围都会检查', () => {
    expect(validatePatch({ download: { enabled: 'yes' } }).ok).toBe(false);
    expect(validatePatch({ web: { port: 0 } }).ok).toBe(false);
    expect(validatePatch({ web: { port: 65536 } }).ok).toBe(false);
    expect(validatePatch({ logLevel: 'loud' }).ok).toBe(false);
    expect(validatePatch({ logLevel: 'debug' }).ok).toBe(true);
    expect(validatePatch({ trackers: { animesGarden: true } }).ok).toBe(true);
  });

  it('数组字段必须是字符串数组', () => {
    expect(validatePatch({ preference: { excludeKeywords: ['pv'] } }).ok).toBe(true);
    expect(validatePatch({ preference: { excludeKeywords: [1] } }).ok).toBe(false);
  });

  it('摊平成点分路径，方便只写改过的字段', () => {
    const result = validatePatch({ download: { savePath: '/x' }, web: { port: 4000 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([
        { path: 'download.savePath', value: '/x' },
        { path: 'web.port', value: 4000 }
      ]);
    }
  });

  it('applyEntries 会补出中间层，不覆盖兄弟字段', () => {
    const target: Record<string, unknown> = { download: { savePath: '/keep', enabled: true } };
    applyEntries(target, [{ path: 'download.readyDelayMinutes', value: 15 }]);
    expect(target).toEqual({ download: { savePath: '/keep', enabled: true, readyDelayMinutes: 15 } });

    const empty: Record<string, unknown> = {};
    applyEntries(empty, [{ path: 'notify.telegram.chatId', value: '1' }]);
    expect(empty).toEqual({ notify: { telegram: { chatId: '1' } } });
  });

  it('需要重启的字段会被标出来', () => {
    const result = validatePatch({ web: { host: '0.0.0.0' }, download: { readyDelayMinutes: 5 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(restartEntries(result.entries)).toEqual(['web.host']);
  });
});

describe('设置：读写与脱敏', () => {
  it('密钥不回传，只说明有没有设置过', () => {
    const config = defaultConfig();
    config.qbittorrent.password = 'hunter2';
    config.notify.serverChanKey = 'SCT';
    config.notify.telegram = { botToken: 'tok', chatId: '42' };

    const redacted = redactConfig(config);
    const qb = redacted.qbittorrent as Record<string, unknown>;
    const notify = redacted.notify as Record<string, unknown>;
    expect(qb.password).toBe('');
    expect(notify.serverChanKey).toBe('');
    expect((notify.telegram as Record<string, unknown>).botToken).toBe('');
    // chatId 不是密钥，照常回传
    expect((notify.telegram as Record<string, unknown>).chatId).toBe('42');
    expect((redacted.secrets as Record<string, boolean>)['qbittorrent.password']).toBe(true);
    expect((redacted.secrets as Record<string, boolean>)['notify.telegram.botToken']).toBe(true);
    // 原对象不能被改动
    expect(config.qbittorrent.password).toBe('hunter2');
  });

  it('写回 config.json 时保留用户自己加的键', () => {
    const root = mkdtempSync(join(tmpdir(), 'settings-'));
    roots.push(root);
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ download: { savePath: '/a' }, myOwnNote: 'hello' }), 'utf8');

    const raw = readRawConfig(path);
    expect(raw.myOwnNote).toBe('hello');
    applyEntries(raw, [{ path: 'download.savePath', value: '/b' }]);
    writeRawConfig(path, raw);

    const reread = readRawConfig(path);
    expect(reread.myOwnNote).toBe('hello');
    expect((reread.download as Record<string, unknown>).savePath).toBe('/b');
    expect(unknownTopLevelKeys(reread, ['download', 'web'])).toEqual(['myOwnNote']);
  });

  it('文件坏了也不抛异常，按空配置处理', () => {
    const root = mkdtempSync(join(tmpdir(), 'settings-'));
    roots.push(root);
    const path = join(root, 'config.json');
    writeFileSync(path, '{ 坏掉的 json', 'utf8');
    expect(readRawConfig(path)).toEqual({});
  });
});

describe('计划任务：输出解析', () => {
  it('把 ISO8601 间隔说成人话', () => {
    expect(formatInterval('PT15M')).toBe('每 15 分钟');
    expect(formatInterval('PT1H')).toBe('每 1 小时');
    expect(formatInterval('PT30S')).toBe('每 1 分钟');
    expect(formatInterval('')).toBeNull();
    expect(formatInterval(null)).toBeNull();
  });

  it('退出码翻译成人话', () => {
    expect(describeResult(0)).toContain('成功');
    expect(describeResult(0x41301)).toContain('正在运行');
    expect(describeResult(0x41303)).toContain('还没运行过');
    expect(describeResult(1)).toBe('退出码 1');
    expect(describeResult(null)).toBe('未知');
  });

  it('解析 PowerShell 的 JSON，单个对象也当成一条', () => {
    const one = parseProbeOutput('{"name":"BangumiDownloader","state":"Ready","lastRun":"2024-05-01 10:00:00","nextRun":null,"lastResult":0,"interval":"PT15M"}');
    expect(one).toHaveLength(1);
    expect(one[0]?.name).toBe('BangumiDownloader');
    expect(one[0]?.interval).toBe('每 15 分钟');
    expect(one[0]?.lastResultText).toContain('成功');

    const many = parseProbeOutput(
      JSON.stringify([
        { name: 'A', state: 'Running', lastResult: 0x41301 },
        { name: 'B', state: 'Ready', lastResult: 1 }
      ])
    );
    expect(many).toHaveLength(2);
    expect(many[0]?.state).toBe('Running');
    expect(many[1]?.lastResultText).toBe('退出码 1');
  });

  it('输出不是 JSON 时返回空数组，而不是崩掉', () => {
    expect(parseProbeOutput('powershell 报错了')).toEqual([]);
    expect(parseProbeOutput('')).toEqual([]);
  });

  it('探测脚本里带上了要查的任务名', () => {
    const script = buildProbeScript(['BangumiDownloader', 'BangumiDownloader-GUI']);
    expect(script).toContain('BangumiDownloader-GUI');
    expect(script).toContain('Get-ScheduledTaskInfo');
    // 时间要在 PowerShell 里先格式化，避免 ConvertTo-Json 的日期格式差异
    expect(script).toContain('yyyy-MM-dd HH:mm:ss');
  });
});

describe('追番清单：进度编辑', () => {
  const make = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'watch-'));
    roots.push(root);
    return join(root, 'watchlist.json');
  };

  it('新增与修改', () => {
    const path = make();
    upsertWatchEntry(path, { query: 'A 番', startFrom: 1 });
    upsertWatchEntry(path, { query: 'A 番', lastEpisode: 5, note: '备注' });
    const list = loadWatchlist(path);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.lastEpisode).toBe(5);
    expect(list.entries[0]?.note).toBe('备注');
  });

  it('改番名相当于重命名，不会多出一条', () => {
    const path = make();
    upsertWatchEntry(path, { query: '旧名字', lastEpisode: 3 });
    upsertWatchEntry(path, { query: '新名字', lastEpisode: 3 }, '旧名字');
    const list = loadWatchlist(path);
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.query).toBe('新名字');
  });

  it('进度往回改时，把超过它的逐集记录一起收拢（否则会以为那些集已下过）', () => {
    const path = make();
    markEpisodesCompleted(path, 'A 番', [1, 2, 3, 4, 5]);
    expect(loadWatchlist(path).entries[0]?.completedEpisodes).toEqual([1, 2, 3, 4, 5]);

    upsertWatchEntry(path, { query: 'A 番', lastEpisode: 3 });
    const entry = loadWatchlist(path).entries[0];
    expect(entry?.lastEpisode).toBe(3);
    expect(entry?.completedEpisodes).toEqual([1, 2, 3]);
  });

  it('下一集集号', () => {
    expect(nextEpisodeOf({ query: 'x' })).toBe(1);
    expect(nextEpisodeOf({ query: 'x', startFrom: 5 })).toBe(5);
    expect(nextEpisodeOf({ query: 'x', lastEpisode: 12 })).toBe(13);
    expect(nextEpisodeOf({ query: 'x', startFrom: 5, lastEpisode: 12 })).toBe(13);
  });

  it('删除', () => {
    const path = make();
    upsertWatchEntry(path, { query: 'A 番' });
    upsertWatchEntry(path, { query: 'B 番' });
    removeWatchEntry(path, 'A 番');
    expect(loadWatchlist(path).entries.map((entry) => entry.query)).toEqual(['B 番']);
  });
});

describe('计划任务退出码：不要把人吓一跳', () => {
  it('「上一轮还在跑」是正常情况，不能说成异常退出', () => {
    // 0x800710E0 = ERROR_REQUEST_REFUSED：MultipleInstances=IgnoreNew 拒了这次触发
    const text = describeResult(0x800710e0);
    expect(text).toContain('还在跑');
    expect(text).toContain('正常');
    expect(text).not.toContain('异常');
  });

  it('真正的异常仍然报异常', () => {
    expect(describeResult(0x80070005)).toContain('异常退出');
  });
});

describe('跨进程去重：同一个种子不许被两个进程同时下', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const makeFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'inflight-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'data'), { recursive: true });
    return join(dir, 'data', 'downloading.json');
  };

  it('别的进程占着就认领不到（并给出占位者）', async () => {
    const { claimDownload, releaseDownload, listInflight } = await import('../src/core/inflight.js');
    const file = makeFile();
    const key = 'a'.repeat(40);

    // 模拟「另一个还活着的进程」：用 pid 1（一定存在）
    const other = { key, title: '别的进程在下的种子', pid: 1, startedAt: new Date().toISOString() };
    writeFileSync(file, JSON.stringify({ version: 1, entries: [other] }));

    const result = claimDownload(file, { key, title: '我这条' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.holder.pid).toBe(1);

    // release 只释放自己的认领，不会去动别的进程的记录
    releaseDownload(file, key);
    expect(claimDownload(file, { key, title: '我这条' }).ok).toBe(false);

    // 自己认领：重复认领视为成功（同一轮重试很常见），释放后就能再认领
    const mineFile = makeFile();
    expect(claimDownload(mineFile, { key, title: '我这条' }).ok).toBe(true);
    expect(claimDownload(mineFile, { key, title: '我这条' }).ok).toBe(true);
    expect(listInflight(mineFile)).toHaveLength(1);
    releaseDownload(mineFile, key);
    expect(listInflight(mineFile)).toHaveLength(0);
  });

  it('进程已经不在的僵尸记录会被清掉，不挡路', async () => {
    const { claimDownload, listInflight } = await import('../src/core/inflight.js');
    const file = makeFile();
    const key = 'b'.repeat(40);

    // pid 用一个几乎不可能存在的值
    writeFileSync(
      file,
      JSON.stringify({ version: 1, entries: [{ key, title: '崩溃残留', pid: 999_999_999, startedAt: new Date().toISOString() }] })
    );

    expect(listInflight(file)).toHaveLength(0);
    expect(claimDownload(file, { key, title: '我这条' }).ok).toBe(true);
  });

  it('按 infohash 算 key：同一集的不同磁力参数视为同一个种子', async () => {
    const { downloadKeyOf } = await import('../src/core/inflight.js');
    const hash = 'c'.repeat(40);
    expect(downloadKeyOf({ magnet: `magnet:?xt=urn:btih:${hash}&dn=a`, title: 'A' })).toBe(hash);
    expect(downloadKeyOf({ magnet: `magnet:?xt=urn:btih:${hash}&dn=b`, title: 'B' })).toBe(hash);
    expect(downloadKeyOf({ title: '没有磁力' })).toBe('t:没有磁力');
  });
});

describe('从 Planner 同步本地清单（只补缺，不动已有的）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const makeList = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-'));
    dirs.push(dir);
    return join(dir, 'watchlist.json');
  };

  it('补进缺的番，startFrom 取「已看 + 1」', async () => {
    const { syncFromPlanner, loadWatchlist, saveWatchlist } = await import('../src/core/watchlist.js');
    const path = makeList();
    saveWatchlist(path, { version: 1, entries: [{ query: '吹响上低音号 第三季', lastEpisode: 13 }] });

    const result = syncFromPlanner(path, [
      { name: '吹响上低音号 第三季', eps: 13, epStatus: 13, unwatched: 0 },
      { name: '相反的你和我 第二季', eps: 13, epStatus: 12, unwatched: 1 },
      { name: '魔女', eps: 12, epStatus: 0, unwatched: 12 }
    ]);

    expect(result.added).toEqual(['相反的你和我 第二季', '魔女']);
    const list = loadWatchlist(path);
    expect(list.entries).toHaveLength(3);
    // 已有的那条不动（进度还是 13，没被 epStatus 覆盖）
    expect(list.entries[0]?.lastEpisode).toBe(13);
    // 新补的两条从「已看 + 1」开始，和 Planner 追的集数一致
    expect(list.entries[1]?.startFrom).toBe(13);
    expect(list.entries[2]?.startFrom).toBe(1);
    expect(list.entries[2]?.note).toContain('Watch Planner');
  });

  it('已有条目完全不动（用户的进度、备注、禁用状态优先）', async () => {
    const { syncFromPlanner, loadWatchlist, saveWatchlist } = await import('../src/core/watchlist.js');
    const path = makeList();
    saveWatchlist(path, { version: 1, entries: [{ query: '魔女', startFrom: 5, note: '我自己改的', enabled: false }] });

    const result = syncFromPlanner(path, [{ name: '魔女', eps: 12, epStatus: 3, unwatched: 9 }]);
    expect(result.added).toEqual([]);
    const entry = loadWatchlist(path).entries[0];
    expect(entry?.startFrom).toBe(5);
    expect(entry?.note).toBe('我自己改的');
    expect(entry?.enabled).toBe(false);
  });

  it('总集数未知时备注也说得清楚', async () => {
    const { syncFromPlanner, loadWatchlist } = await import('../src/core/watchlist.js');
    const path = makeList();
    syncFromPlanner(path, [{ name: '新番', eps: 0, epStatus: 0, unwatched: 0 }]);
    expect(loadWatchlist(path).entries[0]?.note).toContain('总集数未知');
  });
});

describe('搜索：简称扩展与季数过滤（「京吹2 搜不到」的正解）', () => {
  it('简称补上官方名，并把拼在简称后面的季数带过去', async () => {
    const { expandQueries, stripSeason } = await import('../src/core/alias.js');
    const plan = expandQueries('京吹2').queries.map((item) => item.text);
    expect(plan[0]).toBe('京吹2');
    expect(plan).toContain('吹响吧！上低音号 2');
    expect(plan).toContain('吹响吧！上低音号');
    expect(plan).toContain('Hibike! Euphonium 2');
    // 季数去掉后应该只剩番剧名
    expect(stripSeason('吹响吧！上低音号 第二季')).toBe('吹响吧！上低音号');
  });

  it('按季过滤：搜第二季时把第三季的结果去掉，没写季数的保留', async () => {
    const { filterBySeason } = await import('../src/core/alias.js');
    const items = [
      { title: '[DBD-Raws][吹响吧！上低音号 第一季][01-13TV全集]' },
      { title: '[UHA-WINGS＆ANK-Raws][吹响吧！上低音号 第二季][01-13]' },
      { title: '[千夏字幕组&VCB-Studio] 吹响吧！上低音号 3 10-bit 1080p' },
      { title: 'Hibike! Euphonium S01E25 [CR WEB-DL]' }
    ];
    const kept = filterBySeason(items, 2, (item) => item.title).map((item) => item.title);
    // 第二季那条留下；第三季那条（写了 3）去掉
    expect(kept.some((t) => t.includes('第二季'))).toBe(true);
    expect(kept.some((t) => t.includes('上低音号 3'))).toBe(false);
    // 没写季数的（单集发布）保留 —— 宁可多给几条让用户自己判断
    expect(kept.some((t) => t.includes('S01E25'))).toBe(true);
  });

  it('没写季数时不过滤（避免把结果清空）', async () => {
    const { filterBySeason } = await import('../src/core/alias.js');
    const items = [{ title: 'A' }, { title: 'B' }];
    expect(filterBySeason(items, null, (item) => item.title)).toHaveLength(2);
  });
});

describe('总集数：不许再出现「不存在的第 14 集」', () => {
  it('追满总集数时没有下一集，并判为已下完', async () => {
    const { nextEpisodeOf, isEntryComplete } = await import('../src/core/watchlist.js');
    const entry = { query: '吹响上低音号 第三季', lastEpisode: 13, totalEpisodes: 13 };
    // 实测的坑：没有总集数时下一集算成 14，界面上挂着一条根本不存在的集数，
    // Planner 不可用时兜底路径还会一直去找它
    expect(nextEpisodeOf(entry)).toBeNull();
    expect(isEntryComplete(entry)).toBe(true);
  });

  it('还没追满时照常给出下一集', async () => {
    const { nextEpisodeOf, isEntryComplete } = await import('../src/core/watchlist.js');
    const entry = { query: '某番', lastEpisode: 5, totalEpisodes: 13 };
    expect(nextEpisodeOf(entry)).toBe(6);
    expect(isEntryComplete(entry)).toBe(false);
  });

  it('总集数未知时保持旧行为（不能凭猜测说人家下完了）', async () => {
    const { nextEpisodeOf, isEntryComplete } = await import('../src/core/watchlist.js');
    const entry = { query: '某番', lastEpisode: 13 };
    expect(nextEpisodeOf(entry)).toBe(14);
    expect(isEntryComplete(entry)).toBe(false);
  });

  it('逐集记录齐全时也算下完（合集下了一半的情况靠它）', async () => {
    const { isEntryComplete } = await import('../src/core/watchlist.js');
    expect(isEntryComplete({ query: '某番', totalEpisodes: 3, completedEpisodes: [1, 2, 3] })).toBe(true);
    expect(isEntryComplete({ query: '某番', totalEpisodes: 3, completedEpisodes: [1, 3] })).toBe(false);
  });

  it('从 Planner 同步时会把总集数补进已有条目', async () => {
    const { syncFromPlanner, loadWatchlist, saveWatchlist } = await import('../src/core/watchlist.js');
    const dir = mkdtempSync(join(tmpdir(), 'wl-'));
    const path = join(dir, 'watchlist.json');
    try {
      saveWatchlist(path, { version: 1, entries: [{ query: '吹响上低音号 第三季', lastEpisode: 13, note: '手写的' }] });
      syncFromPlanner(path, [{ name: '吹响上低音号 第三季', eps: 13, epStatus: 13, unwatched: 0 }]);
      const entry = loadWatchlist(path).entries[0];
      expect(entry?.totalEpisodes).toBe(13);
      expect(entry?.lastEpisode).toBe(13);
      expect(entry?.note).toBe('手写的'); // 用户的东西不动
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('「还要多久」的估算', () => {
  it('按速度和剩余字节算，并说清楚量级', async () => {
    const { formatEta } = await import('../src/web/client/format.js');
    const MB = 1048576;
    expect(formatEta(30 * MB, 1 * MB)).toBe('不到 1 分钟');
    expect(formatEta(600 * MB, 1 * MB)).toBe('约 10 分钟');
    // 34 小时 = 34*3600 MB 按 1 MB/s 下
    expect(formatEta(20 * 3600 * MB, 1 * MB)).toBe('约 20 小时');
    expect(formatEta(34 * 3600 * MB, 1 * MB)).toBe('约 1 天 10 小时');
    expect(formatEta(48 * 3600 * MB, 1 * MB)).toBe('约 2 天');
    // 大文件 + 慢速度：6.2GB 还剩 300MB，按 250KB/s
    expect(formatEta(300 * MB, 250 * 1024)).toBe('约 20 分钟');
  });

  it('没速度时不给数字（宁可说不出来，也不瞎猜）', async () => {
    const { formatEta } = await import('../src/web/client/format.js');
    expect(formatEta(100 * 1048576, 0)).toBeNull();
    expect(formatEta(100 * 1048576, null)).toBeNull();
    // 剩余为 0 或负数（已下完）也不显示
    expect(formatEta(0, 1024)).toBeNull();
    expect(formatEta(-5, 1024)).toBeNull();
    expect(formatEta(null, 1024)).toBeNull();
  });
});

describe('直链失效时的自救：按标题找回磁力', () => {
  it('标题完全一致时直接认它（忽略括号/空白差异）', async () => {
    const { recoverMagnetByTitle } = await import('../src/core/dispatch.js');
    const title = '[DBD-Raws][吹响吧！上低音号 第一季][01-13TV全集+OVA+特典映像][1080P][BDRip]';
    const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
    const config = {
      trackers: { animesGarden: true, mikan: false, nyaa: false, maxResultsPerTracker: 60, timeoutMs: 1000, retries: 0 },
      preference: {},
      download: {}
    } as never;

    const { searchAndRank } = await import('../src/core/search.js');
    const original = searchAndRank;
    // 用一个假的搜索替换（不打网络）
    const search = (await import('../src/core/search.js')) as { searchAndRank: typeof searchAndRank };
    const spy = vi.spyOn(search, 'searchAndRank');
    spy.mockResolvedValue({
      queries: [title],
      rawCount: 1,
      elapsedMs: 1,
      errors: [],
      ranked: [
        {
          result: { title: title.replace(/[[\]]/g, ' '), magnet, sizeBytes: 23300198400, tracker: 'mikan' },
          parsed: { episodes: [], kind: 'batch' },
          score: 80,
          reasons: [],
          rejected: false
        }
      ]
    } as never);

    try {
      const logs: string[] = [];
      const found = await recoverMagnetByTitle(config, title, 23300198400, { onLog: (m) => logs.push(m) });
      expect(found).toBe(magnet);
      expect(logs.join(' ')).toContain('找回同一条发布');
    } finally {
      spy.mockRestore();
      void original;
    }
  });

  it('搜不到时返回 null，不硬凑一个别的版本', async () => {
    const { recoverMagnetByTitle } = await import('../src/core/dispatch.js');
    const config = { trackers: { timeoutMs: 1000 }, download: {} } as never;
    const search = (await import('../src/core/search.js')) as { searchAndRank: typeof import('../src/core/search.js').searchAndRank };
    const spy = vi.spyOn(search, 'searchAndRank');
    spy.mockResolvedValue({ queries: [], rawCount: 0, elapsedMs: 1, errors: [], ranked: [] } as never);
    try {
      expect(await recoverMagnetByTitle(config, '[某组][某番][01-12][1080P]', 1000)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('单集放进「番剧/<番剧名>/」而不是一集一个文件夹', () => {
  it('从发布标题里认出番剧名（去掉字幕组标签/集号/技术标签）', async () => {
    const { showNameFromTitle } = await import('../src/util/text.js');
    // 用户的要求：新番不要每集新建文件夹，视频直接放在番剧文件夹里方便整理观看
    expect(showNameFromTitle('[ANi] Seihantai na Kimi to Boku S02 - 25 [1080P][Baha][WEB-DL]')).toBe(
      'Seihantai na Kimi to Boku S02'
    );
    expect(showNameFromTitle('[黒ネズミたち] 相反的你和我 第二季 - 13 (CR 1920x1080 AVC AAC MKV)')).toBe(
      '相反的你和我 第二季'
    );
    expect(showNameFromTitle('[千夏字幕组&VCB-Studio] 特别篇 吹响！上低音号～合奏比赛～ 10-bit 1080p HEVC BDRip')).toBe(
      '特别篇 吹响！上低音号～合奏比赛～'
    );
  });

  it('认不出来就返回 null（交给调用方用发布标题兜底，不硬造一个怪名字）', async () => {
    const { showNameFromTitle } = await import('../src/util/text.js');
    expect(showNameFromTitle('')).toBeNull();
    expect(showNameFromTitle('[1080p]')).toBeNull();
  });
});
