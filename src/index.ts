import { parseArgs } from 'node:util';
import { loadConfig, type AppConfig } from './config.js';
import { PlannerClient, displayName } from './planner/client.js';
import { QbittorrentClient } from './qbittorrent/client.js';
import { StateStore } from './state/store.js';
import { runSync, type DownloadMode, type SyncReport } from './core/sync.js';
import { notify } from './notify/index.js';
import { buildQueries } from './util/text.js';
import { searchAll } from './trackers/index.js';
import { rankCandidates } from './anime/rank.js';
import { formatSize, today } from './util/text.js';
import { log, logger, setLogLevel } from './util/log.js';

const logRun = logger('run');

const HELP = `bangumi-downloader —— 从 Bangumi Watch Planner 自动搜番并推送到 qBittorrent

用法：
  bangumi-downloader <命令> [选项]

命令：
  sync          执行一轮：抓取未看集数 → 搜种 → 选种 → 推送到 qBittorrent
  run           守护模式，按 intervalMinutes 定时执行 sync（Ctrl+C 退出）
  check         检查配置、Planner 与 qBittorrent 的连通性
  preview       只搜索并打印某部番剧的候选排名，不下载（排错用）
  config        打印当前生效的配置

选项：
  --config <路径>     指定配置文件，默认 ./config.json
  --dry-run           只挑选并打印结果，不推送到 qBittorrent、不写状态
  --once              与 sync 等价
  --query <关键词>    preview 命令使用的搜索关键词
  --verbose           输出 debug 日志
  --help              显示本帮助

示例：
  bangumi-downloader check
  bangumi-downloader sync --dry-run
  bangumi-downloader run
  bangumi-downloader preview --query "葬送的芙莉莲"
`;

type Command = 'sync' | 'run' | 'check' | 'preview' | 'config' | 'help';

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
    case 'preview':
      return 'preview';
    case 'config':
      return 'config';
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

async function cmdPreview(config: AppConfig, query: string): Promise<number> {
  if (!query) {
    log.error('preview 需要 --query 指定搜索关键词');
    return 2;
  }
  const queries = buildQueries(query, query);
  log.info(`搜索关键词：${queries.join(' / ')}`);
  const results = await searchAll({ queries, config: config.trackers, resolveMikanMagnet: false });
  log.info(`去重后共 ${results.length} 条候选`);

  const ranked = rankCandidates(results, {
    preference: config.preference,
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
    targetSeason: null
  });

  for (const item of ranked.slice(0, 25)) {
    const flag = item.rejected ? '✗' : '✓';
    log.info(`${flag} ${item.score.toFixed(1).padStart(6)} [${item.result.tracker}] ${formatSize(item.result.sizeBytes)} ${item.result.title}`);
    log.info(`        集号=${item.parsed.episodes.slice(0, 3).join(',') || '-'} 类型=${item.parsed.kind} 分辨率=${item.parsed.resolution ?? '-'} 容器=${item.parsed.container ?? '-'} 字幕=${item.parsed.subtitle ?? '-'}`);
    if (item.rejected) log.info(`        淘汰原因：${item.rejectReason}`);
  }
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

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      once: { type: 'boolean', default: false },
      query: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false }
    }
  });

  if (values.version) {
    log.info('bangumi-downloader 1.0.0');
    return 0;
  }

  const command = resolveCommand(values.once ? 'sync' : positionals[0]);
  if (values.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const { config, configPath, created } = loadConfig({ configPath: values.config });
  setLogLevel(values.verbose || config.logLevel === 'debug' ? 'debug' : config.logLevel ?? 'info');

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
    case 'preview':
      return cmdPreview(config, values.query ?? positionals[1] ?? '');
    case 'run':
      return cmdRun(config, mode);
    case 'sync':
    default:
      await runOnce(config, mode);
      return 0;
  }
}

