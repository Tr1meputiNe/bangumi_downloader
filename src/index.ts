import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import { PlannerClient, displayName } from './planner/client.js';
import { QbittorrentClient } from './qbittorrent/client.js';
import { StateStore } from './state/store.js';
import { runSync, type DownloadMode, type SyncReport } from './core/sync.js';
import { searchAndRank } from './core/search.js';
import { dispatchDownload, resolveBackend } from './core/dispatch.js';
import { runAuto } from './core/auto.js';
import { downloadUntilComplete } from './core/retry.js';
import { acquireLock } from './core/lock.js';
import { printVerifyReport, verifyAll } from './core/verify.js';
import { ensureWatchlistExample, watchlistPath } from './core/watchlist.js';
import { searchAll } from './trackers/index.js';
import { startWebServer } from './web/server.js';
import { notify } from './notify/index.js';

import type { ScoredCandidate } from './anime/rank.js';
import { formatSize, today } from './util/text.js';
import { log, logger, setLogFile, setLogLevel } from './util/log.js';
import { VERSION } from './version.js';

const logRun = logger('run');

const HELP = `bangumi-downloader —— 番剧资源搜索 + 自动追番，推送到 qBittorrent

用法：
  bangumi-downloader <命令> [选项]

命令：
  serve         启动本地 Web 界面，手动搜索资源、挑选后下载
  search        在命令行里搜索并打印候选（不下载）
  sync          执行一轮自动追番：抓取未看集数 → 搜种 → 选种 → 推送
  run           守护模式，按 intervalMinutes 定时执行 sync（Ctrl+C 退出）
  check         检查配置、Planner、片源与 qBittorrent 的连通性
  download      搜索某个关键词，挑出最合适的资源并真正下载（默认下全集）
  auto          按 watchlist.json 自动追番：有新集就下（适合放计划任务里长期跑）
  verify        用种子分片哈希核对磁盘，报告「真实」下载进度（文件大小会骗人）
  preview       只搜索并打印某部番剧的候选排名（排错用）
  config        打印当前生效的配置

选项：
  --config <路径>     指定配置文件，默认 ./config.json
  --query <关键词>    serve/search/preview/download 使用的搜索关键词
  --episodes <集号>   download 只下这些集，例如 "1-13" 或 "3,5,7"；默认尽量下全集
  --save-path <目录>  download 的保存目录，覆盖 config.json 里的设置
  --watchlist <文件>  auto 使用的追番清单，默认与 config.json 同目录的 watchlist.json
  --interval <分钟>   auto --daemon 的轮询间隔，默认取 config.intervalMinutes
  --retry <轮数>      download/auto 最多重试几轮（每轮从磁盘进度继续），默认取配置
  --no-retry          只跑一轮，不自动重试
  --clean-empty       verify 时把「一个有效分片都没有」的空壳目录删掉
  --add-local         verify 时把下载目录里没记录过的内容（例如自己用别的工具下的）加进本地清单
  --no-playable       verify 时跳过「文件能不能播」抽检（文件多时更快）
  --no-planner        auto 时只读 watchlist.json，不去问 3777 的 Watch Planner
  --port <端口>       覆盖 Web 界面端口，默认取 config.json 的 web.port
  --no-open           启动 Web 界面时不自动打开浏览器
  --dry-run           只挑选并打印结果，不推送到 qBittorrent、不写状态
  --once              与 sync 等价
  --verbose           输出 debug 日志
  --help              显示本帮助

示例：
  bangumi-downloader serve                     启动 Web 界面（推荐）
  bangumi-downloader search --query "芙莉莲"    命令行搜索
  bangumi-downloader download --query "芙莉莲"  直接下载整季
  bangumi-downloader check
  bangumi-downloader sync --dry-run
  bangumi-downloader run
`;

type Command =
  | 'serve'
  | 'search'
  | 'sync'
  | 'run'
  | 'check'
  | 'preview'
  | 'config'
  | 'download'
  | 'auto'
  | 'verify'
  | 'help';

export function resolveCommand(raw: string | undefined): Command {
  switch (raw) {
    case 'sync':
    case 'once':
      return 'sync';
    case 'run':
    case 'watch':
      return 'run';
    case 'check':
      return 'check';
    case 'serve':
    case 'web':
    case 'ui':
      return 'serve';
    case 'search':
    case 'find':
      return 'search';
    case 'preview':
      return 'preview';
    case 'config':
      return 'config';
    case 'download':
    case 'get':
    case 'dl':
      return 'download';
    case 'auto':
    case 'daemon':
      return 'auto';
    case 'verify':
    case 'status':
      return 'verify';
    default:
      return 'help';
  }
}

function createClients(config: AppConfig, mode: DownloadMode) {
  const planner = new PlannerClient({
    baseUrl: config.plannerBaseUrl,
    timeoutMs: config.trackers.timeoutMs ?? 15000,
    retries: config.trackers.retries ?? 2
  });
  const state = new StateStore(config.state.file, config.state.retentionDays ?? 180);
  const qbittorrent =
    mode === 'enabled' && config.download.enabled !== false
      ? new QbittorrentClient(config.qbittorrent, { timeoutMs: config.trackers.timeoutMs ?? 15000 })
      : undefined;
  return { planner, state, qbittorrent };
}

/** 一次完整执行，返回是否成功。 */
export async function runOnce(config: AppConfig, mode: DownloadMode): Promise<SyncReport | null> {
  const { planner, state, qbittorrent } = createClients(config, mode);

  // 提前登录一次，好让「qBittorrent 没开 / 密码不对」这类问题在开跑前就报出来。
  // 分类的创建交给 runSync 内部处理 —— 只有真的要推送时才需要分类。
  if (qbittorrent) await qbittorrent.login();

  const report = await runSync({ planner, state, qbittorrent, config, today: today() }, mode);
  printSummary(report);
  await notify(config.notify, {
    title: `追番下载：新增 ${report.added.length} 个种子`,
    body: buildNotifyBody(report)
  });
  return report;
}

export function printSummary(report: SyncReport): void {
  const { stats } = report;
  logRun.info(
    `本轮结束（${report.mode === 'dry-run' ? 'dry-run' : '实际下载'}）：` +
      `番剧 ${stats.subjects} 部，未看 ${stats.missingEpisodes} 集，` +
      `计划 ${stats.planned} 集，已推送 ${stats.downloaded} 集，` +
      `历史跳过 ${stats.skippedHistory} 集，无片源 ${stats.noRelease} 集`
  );
  for (const item of report.added) {
    logRun.info(`  + 《${item.subjectName}》第${item.episodes.join('/')}集 ← ${item.tracker} | ${formatSize(item.sizeBytes)}`);
  }
  for (const failure of report.failures) {
    logRun.warn(`  ! ${failure.subjectName}：${failure.reason}`);
  }
}

function buildNotifyBody(report: SyncReport): string {
  const lines = [
    `计划 ${report.stats.planned} 集，已推送 ${report.stats.downloaded} 集`,
    `未看合计 ${report.stats.missingEpisodes} 集，无片源 ${report.stats.noRelease} 集`
  ];
  for (const item of report.added.slice(0, 20)) {
    lines.push(`\n《${item.subjectName}》第${item.episodes.join('/')}集 (${formatSize(item.sizeBytes)})`);
  }
  return lines.join('\n');
}

async function cmdCheck(config: AppConfig, configPath: string, created: boolean): Promise<number> {
  let ok = true;
  log.info(`配置文件：${configPath}${created ? '（已自动生成，请按需修改）' : ''}`);

  // 1) Planner
  try {
    const planner = new PlannerClient({
      baseUrl: config.plannerBaseUrl,
      timeoutMs: config.trackers.timeoutMs ?? 15000,
      retries: 1
    });
    const dashboard = await planner.dashboard();
    const watching = dashboard.subjects.filter((subject) => config.collectionTypes.includes(subject.collectionType));
    log.info(`✓ Bangumi Watch Planner 可访问：${config.plannerBaseUrl}`);
    log.info(`  收藏状态 ${config.collectionTypes.join('/')} 的番剧 ${watching.length} 部`);
    for (const subject of watching.slice(0, 10)) {
      log.info(`    · 《${displayName(subject)}》未看 ${subject.unwatchedMainEpisodeCount} 集`);
    }
    if (watching.length === 0) {
      log.warn('  没有「在看」的番剧，请先在 3777 页面把番剧标记为在看');
    }
  } catch (error) {
    ok = false;
    log.error(`✗ ${(error as Error).message}`);
  }

  // 2) 种子源
  const probes: Array<[string, () => Promise<number>]> = [
    [
      'animes.garden',
      async () =>
        (await searchAll({ queries: ['frieren'], config: { ...config.trackers, mikan: false, nyaa: false } })).length
    ],
    [
      'mikan',
      async () =>
        (
          await searchAll({
            queries: ['frieren'],
            config: { ...config.trackers, animesGarden: false, nyaa: false },
            resolveMikanMagnet: false
          })
        ).length
    ],
    [
      'nyaa',
      async () =>
        (await searchAll({ queries: ['frieren'], config: { ...config.trackers, animesGarden: false, mikan: false } })).length
    ]
  ];
  for (const [name, probe] of probes) {
    if (name === 'animes.garden' && !config.trackers.animesGarden) continue;
    if (name === 'mikan' && !config.trackers.mikan) continue;
    if (name === 'nyaa' && !config.trackers.nyaa) continue;
    try {
      const count = await probe();
      if (count > 0) log.info(`✓ 片源 ${name} 可用，测试搜索返回 ${count} 条`);
      else {
        log.warn(`! 片源 ${name} 没有返回结果（可能被墙或限流）`);
      }
    } catch (error) {
      log.warn(`! 片源 ${name} 测试失败：${(error as Error).message}`);
    }
  }

  // 3) qBittorrent
  try {
    const client = new QbittorrentClient(config.qbittorrent);
    const version = await client.version();
    log.info(`✓ qBittorrent 可连接：${config.qbittorrent.url}（应用 ${version.app}，WebAPI ${version.api}）`);
    if (config.download.enabled === false) {
      log.warn('  注意：config.json 里 download.enabled = false，当前不会真正下载');
    }
  } catch (error) {
    ok = false;
    log.error(`✗ ${(error as Error).message}`);
  }

  return ok ? 0 : 1;
}

/**
 * 命令行搜索。与 Web 界面走同一条 searchAndRank 路径，
 * 区别只是输出到终端。
 */
async function cmdSearch(config: AppConfig, query: string, limit = 30): Promise<number> {
  if (!query) {
    log.error('search 需要 --query 指定搜索关键词');
    return 2;
  }

  const outcome = await searchAndRank({ query, config, mode: 'manual', resolveMikanMagnet: false });
  log.info(`关键词：${outcome.queries.join(' / ')}`);
  log.info(`去重后 ${outcome.ranked.length} 条候选，耗时 ${outcome.elapsedMs}ms`);
  for (const item of outcome.errors) {
    log.warn(`片源 ${item.tracker} 失败：${item.reason}`);
  }

  printRanked(outcome.ranked.slice(0, limit), outcome.ranked.length);
  return 0;
}

/** preview 与 search 的区别：preview 聚焦「自动化会怎么选」，按集号严格淘汰。 */
async function cmdPreview(config: AppConfig, query: string): Promise<number> {
  if (!query) {
    log.error('preview 需要 --query 指定搜索关键词');
    return 2;
  }

  const outcome = await searchAndRank({
    query,
    config,
    mode: 'automation',
    targets: [
      {
        subjectId: 0,
        subjectName: query,
        subjectNameCn: query,
        episode: 1,
        season: null,
        airDate: null
      }
    ],
    targetSeason: null,
    resolveMikanMagnet: false
  });

  log.info(`关键词：${outcome.queries.join(' / ')}`);
  log.info(`按「第 1 集」严格匹配，去重后 ${outcome.ranked.length} 条候选`);
  printRanked(outcome.ranked.slice(0, 25), outcome.ranked.length);
  return 0;
}

export type DownloadCommandOptions = {
  query: string;
  /** 只要这些集；留空表示「尽量拿全集」。 */
  episodes: number[];
  /** 覆盖下载目录。 */
  savePath?: string;
  dryRun: boolean;
  /** 最多重试几轮；0 表示只跑一轮。 */
  retryRounds: number;
};

/**
 * 手动下载一个关键词对应的资源。
 *
 * 「全集」的判定：优先挑发布名里写明是合集（kind === 'batch'）且覆盖集数最多的一条；
 * 没有合集就退回分数最高的单集。这跟自动追番的「按缺失集号严格匹配」是两回事 ——
 * 这里用户要的是「把这一季拉下来」。
 */
async function cmdDownload(config: AppConfig, configPath: string, options: DownloadCommandOptions): Promise<number> {
  if (!options.query) {
    log.error('download 需要 --query 指定搜索关键词');
    return 2;
  }

  const outcome = await searchAndRank({
    query: options.query,
    config,
    mode: 'manual',
    resolveMikanMagnet: false
  });

  log.info(`关键词：${outcome.queries.join(' / ')}`);
  log.info(`去重后 ${outcome.ranked.length} 条候选`);
  for (const item of outcome.errors) {
    log.warn(`片源 ${item.tracker} 失败：${item.reason}`);
  }

  const backend = resolveBackend(config);
  const savePath = options.savePath || config.download.savePath || config.qbittorrent.savePath;

  if (options.dryRun || config.download.enabled === false) {
    log.info(`下载后端：${backend}${savePath ? `｜保存到 ${savePath}` : ''}`);
    log.info('[dry-run] 只挑选不下载。去掉 --dry-run（并把 download.enabled 设为 true）才会真正下载。');
    return 0;
  }

  if (!savePath) {
    log.error('没有配置下载目录：请在 config.json 里设置 download.savePath');
    return 2;
  }

  // qBittorrent 后端是「推送」语义，不适合试跑降级；这里仍走原来的一次性推送
  if (backend === 'qbittorrent') {
    const candidate = outcome.ranked.find((item) => !item.rejected && (item.result.magnet || item.result.torrentUrl));
    if (!candidate) {
      log.error('没有找到可下载的候选');
      return 1;
    }
    log.info(`推送到 qBittorrent：${candidate.result.title}`);
    const pushed = await dispatchDownload(
      { config, qbittorrent: new QbittorrentClient(config.qbittorrent) },
      {
        title: candidate.result.title,
        magnet: candidate.result.magnet,
        torrentUrl: candidate.result.torrentUrl,
        sizeBytes: candidate.result.sizeBytes,
        tracker: candidate.result.tracker,
        episodes: options.episodes
      }
    );
    log.info(`已推送：${pushed.infoHash}`);
    return 0;
  }

  /*
   * 内置引擎：打分高不等于下得动，所以不锁定单条候选，而是按
   * 「整季 → 无集号整季 → 单集」的顺序逐条实测，谁有速度就下谁。
   */
  log.info(`下载后端：builtin｜保存到 ${savePath}`);

  // 单实例锁：计划任务可能在上一次还没跑完时就又触发一次
  const lock = acquireLock(join(dirname(configPath), 'data', '.bangumi.lock'), `download ${options.query}`);
  if (!lock) return 0;

  try {
    const result = await downloadUntilComplete({
      candidates: outcome.ranked,
      config,
      episodes: options.episodes,
      savePath,
      rounds: Math.max(1, options.retryRounds),
      backoffMs: (config.download.retryBackoffMinutes ?? 10) * 60_000,
      maxBackoffMs: (config.download.retryMaxBackoffMinutes ?? 120) * 60_000,
      onLog: (message) => log.debug(message)
    });

    log.info(
      `${result.completed ? '下载完成' : '本轮未下完'}：${result.files.length} 个文件，` +
        `共 ${formatSize(result.bytesWritten)}（尝试 ${result.rounds} 轮）`
    );
    for (const file of result.files.slice(0, 40)) log.info(`  · ${file}`);
    if (!result.completed) {
      log.warn('已保留全部进度，下次运行会自动从这里继续（不会重下已有数据）。');
    }
    return result.completed ? 0 : 1;
  } finally {
    lock.release();
  }
}

/**
 * 核对磁盘上的真实下载进度。
 *
 * 存在的意义：存储层会预分配文件到完整长度，所以「文件大小」完全不能反映进度。
 * 这一步用种子里的分片哈希逐片校验，回答的是「哪些是真的下好了」。
 */
async function cmdVerify(
  config: AppConfig,
  options: { infoHash?: string; cleanEmpty: boolean; addLocal: boolean; checkPlayable: boolean }
): Promise<number> {
  const savePath = config.download.savePath || config.qbittorrent.savePath;
  if (!savePath) {
    log.error('没有配置下载目录：请在 config.json 里设置 download.savePath');
    return 2;
  }

  log.info(`核对目录：${savePath}`);
  const result = await verifyAll({
    savePath,
    infoHash: options.infoHash,
    cleanEmpty: options.cleanEmpty,
    addLocal: options.addLocal,
    checkPlayable: options.checkPlayable,
    ignoreDirs: config.download.ignoreDirs ?? []
  });

  if (result.reports.length === 0) {
    log.warn('没有可核对的记录（元数据缓存是空的）。先跑一次 download 或 auto 再来。');
    return 0;
  }

  for (const report of result.reports) printVerifyReport(report);

  if (result.added.length > 0) {
    log.info(`新加入本地清单 ${result.added.length} 项（这些不是本项目下的，只列体积不做校验）`);
  }

  const torrents = result.reports.filter((report) => report.source === 'torrent');
  const locals = result.reports.filter((report) => report.source === 'local');
  const done = torrents.filter((report) => report.complete).length;
  const empty = torrents.filter((report) => report.empty).length;

  const videosChecked = result.reports.reduce((sum, report) => sum + report.videosChecked, 0);
  const videosUnplayable = result.reports.reduce((sum, report) => sum + report.videosUnplayable, 0);

  log.info(
    `共 ${result.reports.length} 项：本项目下载 ${torrents.length} 个（已下完 ${done}，空壳 ${empty}）` +
      `｜本地内容 ${locals.length} 个`
  );
  if (options.checkPlayable && videosChecked > 0) {
    if (videosUnplayable === 0) {
      log.info(`抽检 ${videosChecked} 个视频文件，头部结构与数据分布均正常`);
    } else {
      log.warn(`抽检 ${videosChecked} 个视频文件，其中 ${videosUnplayable} 个播不了（详见上面标注）`);
    }
  }

  if (result.removed.length > 0) {
    log.info(`已清理 ${result.removed.length} 个空壳目录，下次运行会重新下载`);
  } else if (empty > 0 && !options.cleanEmpty) {
    log.info('想清掉这些空壳目录可以加 --clean-empty（只有 0 个有效分片的才会被删）');
  }

  return 0;
}

/** --retry / --no-retry 与配置的优先级。 */
function resolveRetryRounds(config: AppConfig, retryFlag: string | undefined, noRetry: boolean): number {
  if (noRetry) return 1;
  if (retryFlag !== undefined) {
    const parsed = Number.parseInt(retryFlag, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return config.download.retryRounds ?? 6;
}

function printRanked(ranked: readonly ScoredCandidate[], total: number): void {
  if (ranked.length === 0) {
    log.warn('没有搜到任何结果');
    return;
  }
  if (total > ranked.length) {
    log.info(`（只显示前 ${ranked.length} 条，共 ${total} 条）`);
  }

  for (const item of ranked) {
    const flag = item.rejected ? '✗' : '✓';
    const size = formatSize(item.result.sizeBytes);
    log.info(`${flag} ${item.score.toFixed(1).padStart(6)}  [${item.result.tracker}] ${size.padStart(9)}  ${item.result.title}`);
    const parsed = item.parsed;
    const episodes = parsed.episodes.length > 0
      ? `第${parsed.episodes[0]}${parsed.episodes.length > 1 ? `-${parsed.episodes[parsed.episodes.length - 1]}` : ''}集`
      : parsed.kind === 'batch' ? '合集' : '集号未知';
    log.info(
      `        ${episodes} · ${parsed.resolution ?? '分辨率未知'} · ${parsed.container ?? '容器未知'} · ` +
        `字幕 ${parsed.subtitle ?? '未知'}${parsed.group ? ` · ${parsed.group}` : ''}`
    );
    if (item.rejected) {
      log.info(`        淘汰：${item.rejectReason}`);
    }
  }
}

async function cmdServe(config: AppConfig, options: { port?: number; open?: boolean }): Promise<number> {
  const effective: AppConfig = {
    ...config,
    web: {
      ...config.web,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.open !== undefined ? { openBrowser: options.open } : {})
    }
  };

  // 只有真的能下载时才需要连 qBittorrent；连不上也让界面能用来搜索
  let qbittorrent: QbittorrentClient | undefined;
  if (effective.download.enabled !== false) {
    qbittorrent = new QbittorrentClient(effective.qbittorrent, {
      timeoutMs: effective.trackers.timeoutMs ?? 15000
    });
    try {
      await qbittorrent.login();
      log.info(`已连接 qBittorrent：${effective.qbittorrent.url}`);
    } catch (error) {
      log.warn(`${(error as Error).message}`);
      log.warn('界面仍可使用搜索功能，但下载会失败；修好配置后重启本命令即可。');
    }
  } else {
    log.warn('config.json 里 download.enabled = false，界面只能搜索、不能下载');
  }

  const started = await startWebServer({ config: effective, qbittorrent });
  log.info('按 Ctrl+C 退出');

  await new Promise<void>((resolve) => {
    const stop = () => {
      log.info('正在关闭…');
      void started.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return 0;
}

async function cmdRun(config: AppConfig, mode: DownloadMode): Promise<number> {
  const intervalMs = Math.max(5, config.intervalMinutes) * 60 * 1000;
  let running = true;
  let stopped = false;

  const stop = (signal: string) => {
    if (stopped) return;
    stopped = true;
    log.info(`收到 ${signal}，当前轮结束后退出…`);
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  log.info(`守护模式启动，每 ${config.intervalMinutes} 分钟执行一轮`);

  let consecutiveFailures = 0;
  while (running) {
    try {
      await runOnce(config, mode);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      log.error(`本轮失败（连续第 ${consecutiveFailures} 次）：${(error as Error).message}`);
      if (consecutiveFailures === 5) {
        await notify(config.notify, {
          title: '追番下载连续失败',
          body: `已连续 ${consecutiveFailures} 轮执行失败：${(error as Error).message}`
        });
      }
    }

    if (!running) break;
    log.info(`下一轮在 ${config.intervalMinutes} 分钟后`);
    // 拆成小段等待，保证 Ctrl+C 能及时响应
    const deadline = Date.now() + intervalMs;
    while (running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }
  }

  log.info('已退出守护模式');
  return 0;
}

/**
 * 基于本机清单的自动追番。
 *
 * 与 sync/run 的区别：那两条路依赖本机 Watch Planner 服务，
 * 这条只看同目录的 watchlist.json，不需要任何外部服务，适合放计划任务长期跑。
 */
async function cmdAuto(
  config: AppConfig,
  configPath: string,
  options: {
    watchlistFile?: string;
    daemon: boolean;
    intervalMinutes?: number;
    dryRun: boolean;
    retryRounds: number;
    preferPlanner: boolean;
  }
): Promise<number> {
  const path = options.watchlistFile ?? watchlistPath(configPath);
  if (ensureWatchlistExample(path)) {
    log.info(`已生成追番清单模板：${path}`);
    log.info('把要追的番名填进 entries 后重新运行本命令。');
    return 0;
  }

  const intervalMinutes = options.intervalMinutes ?? config.intervalMinutes ?? 30;

  const runOnceAuto = async (): Promise<number> => {
    // 单实例锁：计划任务和守护模式可能同时被触发
    const lock = acquireLock(join(dirname(configPath), 'data', '.bangumi.lock'), 'auto');
    if (!lock) return 0;

    try {
      return await runAutoOnce();
    } finally {
      lock.release();
    }
  };

  const runAutoOnce = async (): Promise<number> => {
    try {
      return await runAutoInner();
    } catch (error) {
      // 无人值守时不要把异常抛给计划任务：日志里有完整记录就够了，
      // 任务历史里一堆「失败」反而会掩盖真正需要处理的问题。
      log.error(`本轮自动追番异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return 0;
    }
  };

  const runAutoInner = async (): Promise<number> => {
    const report = await runAuto({
      config,
      configPath,
      dryRun: options.dryRun,
      watchlistFile: options.watchlistFile,
      retryRounds: options.retryRounds,
      preferPlanner: options.preferPlanner
    });
    log.info(
      `本轮结束：清单 ${report.subjects} 条，检查 ${report.checked} 条，` +
        `新下载 ${report.downloaded.length} 条，跳过 ${report.skipped.length} 条`
    );
    for (const item of report.downloaded) {
      log.info(
        `  + 《${item.query}》第${item.episodes.join('/')}集 → ${item.files} 个文件` +
          `，${formatSize(item.bytesWritten)}${item.completed ? '' : '（未下完，进度已保留）'}`
      );
    }
    return 0;
  };

  if (!options.daemon) return await runOnceAuto();

  log.info(`自动追番守护模式：每 ${intervalMinutes} 分钟检查一次（Ctrl+C 退出）`);
  let running = true;
  const stop = () => {
    running = false;
    log.info('收到退出信号，本轮到结束就停');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    await runOnceAuto();
    if (!running) break;
    log.info(`下一轮在 ${intervalMinutes} 分钟后`);
    const deadline = Date.now() + intervalMinutes * 60_000;
    while (running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }
  }

  log.info('已退出守护模式');
  return 0;
}

/**
 * 解析 --episodes 的取值，支持 "1-13"、"3,5,7"、"1-3,7,9-11" 三种写法。
 * 空字符串返回空数组，表示「不限制、尽量下全集」。
 */
export function parseEpisodeSpec(spec: string | undefined): number[] {
  if (!spec) return [];
  const result = new Set<number>();

  for (const part of spec.split(',')) {
    const token = part.trim();
    if (token === '') continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const from = Number.parseInt(range[1] as string, 10);
      const to = Number.parseInt(range[2] as string, 10);
      // 上限兜底，避免写出 "1-100000" 这种把内存吃掉的输入
      if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 5000) continue;
      for (let episode = Math.min(from, to); episode <= Math.max(from, to); episode += 1) result.add(episode);
      continue;
    }

    const single = Number.parseInt(token, 10);
    if (Number.isFinite(single) && single > 0) result.add(single);
  }

  return [...result].sort((a, b) => a - b);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      query: { type: 'string' },
      episodes: { type: 'string' },
      'save-path': { type: 'string' },
      watchlist: { type: 'string' },
      daemon: { type: 'boolean', default: false },
      interval: { type: 'string' },
      retry: { type: 'string' },
      'no-retry': { type: 'boolean', default: false },
      'clean-empty': { type: 'boolean', default: false },
      'add-local': { type: 'boolean', default: false },
      'no-playable': { type: 'boolean', default: false },
      'no-planner': { type: 'boolean', default: false },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false }
    }
  });

  if (values.version) {
    log.info(`bangumi-downloader ${VERSION}`);
    return 0;
  }

  const command = resolveCommand(values.once ? 'sync' : positionals[0]);
  if (values.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const { config, configPath, created } = loadConfig({ configPath: values.config });
  setLogLevel(values.verbose || config.logLevel === 'debug' ? 'debug' : config.logLevel ?? 'info');

  /*
   * 自动模式（auto）会挂在计划任务里无人值守地跑，所以固定写一份文件日志。
   * 其他命令是交互式的，屏幕输出就够了，不额外落盘。
   */
  if (command === 'auto' || values.verbose || config.logFile) {
    setLogFile(config.logFile ?? join(dirname(configPath), 'data', 'bangumi.log'));
  }

  if (created) {
    log.info(`已生成默认配置文件：${configPath}`);
    log.info('请先填写 qbittorrent 的账号密码，再运行 bangumi-downloader check');
  }

  const mode: DownloadMode = values['dry-run'] || config.download.enabled === false ? 'dry-run' : 'enabled';

  switch (command) {
    case 'check':
      return cmdCheck(config, configPath, created);
    case 'config':
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return 0;
    case 'serve':
      return cmdServe(config, {
        port: values.port !== undefined ? Number(values.port) : undefined,
        open: values['no-open'] ? false : undefined
      });
    case 'search':
      return cmdSearch(config, values.query ?? positionals[1] ?? '');
    case 'preview':
      return cmdPreview(config, values.query ?? positionals[1] ?? '');
    case 'download':
      return cmdDownload(config, configPath, {
        query: values.query ?? positionals[1] ?? '',
        episodes: parseEpisodeSpec(values.episodes),
        savePath: values['save-path'],
        dryRun: values['dry-run'],
        retryRounds: resolveRetryRounds(config, values.retry, values['no-retry'])
      });
    case 'verify':
      return cmdVerify(config, {
        infoHash: values.query ?? positionals[1],
        cleanEmpty: values['clean-empty'],
        addLocal: values['add-local'],
        checkPlayable: !values['no-playable']
      });
    case 'auto':
      return cmdAuto(config, configPath, {
        watchlistFile: values.watchlist,
        daemon: values.daemon,
        intervalMinutes: values.interval !== undefined ? Number(values.interval) : undefined,
        dryRun: values['dry-run'] || config.download.enabled === false,
        retryRounds: resolveRetryRounds(config, values.retry, values['no-retry']),
        preferPlanner: !values['no-planner']
      });
    case 'run':
      return cmdRun(config, mode);
    case 'sync':
    default:
      await runOnce(config, mode);
      return 0;
  }
}

