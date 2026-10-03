import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** 发布筛选偏好。全部可选，未给出时用 DEFAULT_* 里的值。 */
export type ReleasePreference = {
  /** 必须命中的关键词（大小写不敏感）。留空表示不限制。 */
  requireKeywords?: string[];
  /** 命中任意一个即直接淘汰。 */
  excludeKeywords?: string[];
  /** 优先容器格式，越靠前分越高。 */
  containerPreference?: string[];
  /** 优先分辨率，越靠前分越高。 */
  resolutionPreference?: string[];
  /** 优先字幕语言，越靠前分越高。 */
  subtitlePreference?: string[];
  /** 字幕组加分（越靠前分越高）。 */
  preferGroups?: string[];
  /** 字幕组降分（越靠前扣得越多）。 */
  avoidGroups?: string[];
  /** 做种数达到该值即拿满分。 */
  seederSaturation?: number;
  /** 缺多集时是否优先选合集。 */
  preferBatch?: boolean;
  /** 每个分项权重。 */
  weights?: Partial<ScoreWeights>;
};

export type ScoreWeights = {
  container: number;
  resolution: number;
  subtitle: number;
  group: number;
  seeders: number;
  batch: number;
};

export type DownloadPreference = {
  /** false 时只挑选并记录，不推送到 qBittorrent。 */
  enabled?: boolean;
  /** 单个番剧单轮最多推送多少集。 */
  maxEpisodesPerSubjectPerRun?: number;
  /** 单轮总共最多推送多少个种子。 */
  maxTorrentsPerRun?: number;
  /** 只下载在这个日期（含）之后播出的集数，用于避免开跑时全量回填。 */
  onlyAiredAfter?: string | null;
  /** 每集最多回看多少天，null 表示不限制。 */
  lookbackDays?: number | null;
};

export type QbittorrentConfig = {
  url: string;
  username: string;
  password: string;
  /** 保存路径，留空使用 qBittorrent 默认路径。 */
  savePath: string;
  category: string;
  tags: string[];
  /** 推送给 qBittorrent 后是否留在暂停状态。 */
  paused: boolean;
};

export type TrackerConfig = {
  /** animes.garden 聚合搜索（dmhy/mikan/nyaa 镜像），dmhy 通过它获取。 */
  animesGarden: boolean;
  /** mikan 官方 RSS 搜索。 */
  mikan: boolean;
  /** nyaa 站点。.land 被墙时自动回退 .si。 */
  nyaa: boolean;
  nyaaHosts?: string[];
  /** mikan / nyaa 使用的 RSS 基址与搜索基址。 */
  mikanBase?: string;
  /** 每次搜索每个源最多取多少条。 */
  maxResultsPerTracker?: number;
  /** 网络超时（毫秒）。 */
  timeoutMs?: number;
  /** 失败重试次数。 */
  retries?: number;
};

export type StateConfig = {
  file: string;
  /** 记录保留天数。 */
  retentionDays?: number;
};

export type NotifyConfig = {
  console?: boolean;
  /** Server 酱 SendKey。 */
  serverChanKey?: string;
  telegram?: {
    botToken: string;
    chatId: string;
  };
};

export type WebConfig = {
  /** Web 界面监听端口。刻意避开 Planner 的 3777。 */
  port: number;
  host: string;
  /** 启动 serve 时自动打开浏览器。 */
  openBrowser?: boolean;
  /** 单次搜索每个源最多取多少条（越大越慢）。 */
  maxResultsPerTracker?: number;
};

export type AppConfig = {
  /** 本机 Bangumi Watch Planner 地址。 */
  plannerBaseUrl: string;
  /** 轮询间隔（分钟），run 模式生效。 */
  intervalMinutes: number;
  /** 抓取哪些收藏状态，默认只看「在看」。 */
  collectionTypes: number[];
  /** 是否连同补番计划（backlog）一起下载。 */
  includeBacklog?: boolean;
  preference: ReleasePreference;
  download: DownloadPreference;
  qbittorrent: QbittorrentConfig;
  trackers: TrackerConfig;
  state: StateConfig;
  notify: NotifyConfig;
  web: WebConfig;
  /** 日志级别。 */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
};

export const DEFAULT_WEIGHTS: ScoreWeights = {
  container: 30,
  resolution: 40,
  subtitle: 50,
  group: 20,
  seeders: 15,
  batch: 10
};

const DEFAULTS: Omit<AppConfig, 'qbittorrent'> & { qbittorrent: QbittorrentConfig } = {
  plannerBaseUrl: 'http://127.0.0.1:3777',
  intervalMinutes: 30,
  collectionTypes: [3],
  includeBacklog: false,
  preference: {
    requireKeywords: [],
    excludeKeywords: ['预告', 'pv', 'cm', 'menu', 'ncop', 'nced', 'sample', 'sample2'],
    containerPreference: ['mkv', 'mp4', 'avi'],
    resolutionPreference: ['1080p', '2160p', '720p'],
    subtitlePreference: ['简日', '简繁', '简体', '简中', 'chs', 'cht', '繁体', '繁中'],
    preferGroups: [],
    avoidGroups: [],
    seederSaturation: 20,
    preferBatch: true,
    weights: { ...DEFAULT_WEIGHTS }
  },
  download: {
    enabled: true,
    maxEpisodesPerSubjectPerRun: 3,
    maxTorrentsPerRun: 10,
    onlyAiredAfter: null,
    lookbackDays: null
  },
  qbittorrent: {
    url: 'http://127.0.0.1:8080',
    username: 'admin',
    password: 'adminadmin',
    savePath: '',
    category: 'Bangumi',
    tags: ['bangumi-downloader'],
    paused: false
  },
  trackers: {
    animesGarden: true,
    mikan: true,
    nyaa: true,
    nyaaHosts: ['https://nyaa.land', 'https://nyaa.si'],
    mikanBase: 'https://mikanani.me',
    maxResultsPerTracker: 60,
    timeoutMs: 15000,
    retries: 2
  },
  state: {
    file: './data/state.json',
    retentionDays: 180
  },
  notify: {
    console: true
  },
  web: {
    port: 3778,
    host: '127.0.0.1',
    openBrowser: true,
    maxResultsPerTracker: 60
  },
  logLevel: 'info'
};

export const CONFIG_FILENAME = 'config.json';

/** 递归合并：只覆盖用户显式给出的字段，数组整体替换。 */
function merge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base)) return (Array.isArray(override) ? override : base) as T;
  if (typeof base === 'object' && base !== null && typeof override === 'object' && !Array.isArray(override)) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      if (value === undefined) continue;
      const current = result[key];
      result[key] = current === undefined ? value : merge(current, value);
    }
    return result as T;
  }
  return override as T;
}

export function defaultConfig(): AppConfig {
  return structuredClone(DEFAULTS) as AppConfig;
}

/** 相对路径按配置文件所在目录解析，便于便携包整体挪动。 */
export function resolveConfigPaths(config: AppConfig, baseDir: string): AppConfig {
  const stateFile = config.state.file;
  return {
    ...config,
    state: {
      ...config.state,
      file: isAbsolute(stateFile) ? stateFile : resolve(baseDir, stateFile)
    }
  };
}

export function configTemplate(): AppConfig {
  return defaultConfig();
}

/**
 * 读取配置。找不到文件时用默认值，并在 needWrite 为真时落盘一份带注释的模板，
 * 方便用户第一次运行后直接编辑。
 */
export function loadConfig(options: { configPath?: string; cwd?: string } = {}): {
  config: AppConfig;
  configPath: string;
  created: boolean;
} {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath
    ? resolve(cwd, options.configPath)
    : join(cwd, CONFIG_FILENAME);
  const baseDir = dirname(configPath);

  if (!existsSync(configPath)) {
    const config = resolveConfigPaths(defaultConfig(), baseDir);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(configTemplate(), null, 2)}\n`, 'utf8');
    return { config, configPath, created: true };
  }

  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${configPath}\n${(error as Error).message}`);
  }
  const merged = merge(defaultConfig(), parsed);
  return { config: resolveConfigPaths(merged, baseDir), configPath, created: false };
}
