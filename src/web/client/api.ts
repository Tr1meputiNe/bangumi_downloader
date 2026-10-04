/** 与后端 /api/* 一一对应的类型与请求封装。 */

export type ParsedInfo = {
  episodes: number[];
  episodeFrom: number | null;
  episodeTo: number | null;
  kind: 'single' | 'batch' | 'unknown';
  season: number | null;
  isSpecial: boolean;
  resolution: string | null;
  container: string | null;
  subtitle: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitDepth: number | null;
  source: string | null;
  group: string | null;
};

export type ResultItem = {
  key: string;
  title: string;
  magnet: string;
  torrentUrl: string | null;
  sizeBytes: number | null;
  publishedAt: string | null;
  seederCount: number | null;
  leecherCount: number | null;
  tracker: string;
  provider: string;
  pageUrl: string | null;
  parsed: ParsedInfo;
  score: number;
  reasons: string[];
  rejected: boolean;
  rejectReason: string | null;
};

export type SearchResponse = {
  query: string;
  queries: string[];
  /** 试过的关键词及来历（原样/别名/去季数…）。 */
  queryPlan?: Array<{ text: string; origin: string }>;
  /** 从查询里认出来的季数。 */
  season?: number | null;
  /** 因为按季过滤后一条不剩、已退回未过滤结果。 */
  seasonFiltered?: boolean;
  results: ResultItem[];
  errors: Array<{ tracker: string; reason: string }>;
  elapsedMs: number;
  /** 是否命中服务端缓存。 */
  cached: boolean;
};

export type AddResponse = {
  results: Array<{ title: string; ok: boolean; error?: string; infoHash?: string; jobId?: string }>;
  /** 本次入队的任务数。下载在后台跑，不阻塞这个响应。 */
  queued?: number;
};

/* ------------------------------ 下载任务 ------------------------------ */

export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type JobView = {
  id: string;
  title: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 完成百分比（0~100），未知时 null。 */
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  speed: number;
  peers: number;
  episodes: number[];
  messages: string[];
  files: string[];
  error: string | null;
  backend: string;
  /** 服务端算好的「这个状态下能做哪些操作」。 */
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
};

export type JobCounts = {
  running: number;
  queued: number;
  paused: number;
  completed: number;
  failed: number;
  cancelled: number;
};

export type JobsResponse = {
  jobs: JobView[];
  running: boolean;
  counts: JobCounts;
};

/* ------------------------------ 后台任务 ------------------------------ */

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type TaskKind = 'verify' | 'auto';

export type TaskView = {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string | null;
  progress: string | null;
  ratio: number | null;
  lines: string[];
  error: string | null;
  result: unknown;
};

export type TasksResponse = { tasks: TaskView[]; running: boolean };

/* ------------------------------- 片库 ------------------------------- */

export type LibraryEntry = {
  name: string;
  path: string;
  bytes: number;
  videoCount: number;
  otherCount: number;
  kind: 'series' | 'single' | 'unknown';
  suspectEmpty: boolean;
};

export type LibraryResponse = {
  root: string;
  seriesRoot: string | null;
  totalBytes: number;
  totalVideos: number;
  totalFiles: number;
  others: Array<{ name: string; bytes: number; files: number }>;
  entries: LibraryEntry[];
};

export type LibraryFile = { name: string; bytes: number; video: boolean };

export type LibraryEntryDetail = {
  name: string;
  path: string;
  bytes: number;
  videoCount: number;
  otherCount: number;
  fileCount: number;
  truncated: boolean;
  files: LibraryFile[];
};

export type VerifyReportView = {
  name: string;
  path: string;
  /** 实际去找的绝对路径。 */
  dir: string;
  /** 那个目录在不在。不在 = 还没下过；在但 empty = 下过但一个分片都没成。 */
  dirExists: boolean;
  source: 'torrent' | 'local';
  infoHash: string;
  ratio: number;
  pieceDone: number;
  pieceTotal: number;
  bytesDone: number;
  bytesTotal: number;
  nominalBytes: number;
  complete: boolean;
  empty: boolean;
  presentFiles: number;
  expectedFiles: number;
  videosChecked: number;
  videosUnplayable: number;
  videoIssues: Array<{ file: string; issues: string[] }>;
};

export type VerifyTaskResult = {
  target: string | null;
  reports: VerifyReportView[];
  removed: string[];
  cleanEmpty: boolean;
  scannedAt: string;
  totalBytes: number;
  completeCount: number;
  emptyCount: number;
  /** 目录不存在的项数（元数据还在、内容已被清理）。 */
  missingCount: number;
  unplayableCount: number;
};

/* ---------------------------- 追番计划 ---------------------------- */

export type PlannerEpisodeView = {
  ep: number | null;
  sort: number;
  title: string;
  airdate: string;
  airTime: string | null;
  watched: boolean;
  aired: boolean;
  dismissed: boolean;
};

export type PlannerSubjectView = {
  id: number;
  name: string;
  nameCn: string;
  display: string;
  collectionType: number;
  collectionLabel: string;
  unwatched: number;
  totalEpisodes: number;
  watchedEpisodes: number;
  /** 总集数是否已经确定。 */
  totalEpisodesKnown: boolean;
  airDate: string | null;
  url: string | null;
  image: string | null;
  nextEpisode: { ep: number | null; airdate: string; airTime: string | null; title: string } | null;
};

export type PlannerView = {
  ok: boolean;
  message: string;
  baseUrl: string;
  checkedAt: string;
  lastSyncAt: string | null;
  subjects: PlannerSubjectView[];
};

export type WatchEntryView = {
  query: string;
  lastEpisode: number | null;
  /** 没有下一集时为 null（已知总集数且已追满）。 */
  nextEpisode: number | null;
  /** 总集数（留空表示不知道）。 */
  totalEpisodes?: number | null;
  /** 全部集数都已下完。 */
  complete?: boolean;
  completedEpisodes: number[];
  startFrom: number | null;
  note: string;
  enabled: boolean;
};

export type PlanRowStatus = 'done' | 'waiting' | 'upcoming' | 'stale' | 'unknown';

/** 计划表的一行：某部番的下一集，按播出时间排。 */
export type PlanRow = {
  subjectId: number;
  name: string;
  episode: number | null;
  totalEpisodes: number;
  watchedEpisodes: number;
  unwatchedEpisodes: number;
  totalEpisodesKnown: boolean;
  airdate: string;
  airTime: string | null;
  broadcastAt: string | null;
  readyAt: string | null;
  until: string | null;
  status: PlanRowStatus;
  statusText: string;
};

export type RunningDownloadView = {
  title: string;
  ratio: number;
  downloadedBytes: number;
  totalBytes: number;
  speed: number;
  peers: number;
  startedAt: string;
  updatedAt: string;
};

export type AutoScheduleView = {
  file: string | null;
  /** 正在下载的那一条（下载跑在另一个进程里，靠计划文件传递进度）。 */
  running: RunningDownloadView | null;
  nextCheckAt: string | null;
  nextRefreshAt: string | null;
  nextReason: string;
  /** 服务端算好的「多久之后」说法，例如「3 小时后（10-04 19:00）」。 */
  nextCheckText: string;
  updatedAt: string | null;
  windows: Array<{ query: string; episode: number | null; readyAt: string; until: string }>;
  doneCount: number;
  activeIntervalMinutes: number;
  idleIntervalMinutes: number;
  releaseWindowHours: number;
  /** 按播出时间升序排好的计划表。 */
  rows: PlanRow[];
  /** 服务端算这张表时的时间。 */
  now: string;
};

export type WatchlistResponse = {
  file: string | null;
  entries: WatchEntryView[];
  planner: PlannerView;
  schedule: AutoScheduleView;
  download: {
    savePath: string;
    readyDelayMinutes: number;
    retryRounds: number;
    maxEpisodesPerSubjectPerRun: number;
  };
};

export type ScheduledTaskInfo = {
  name: string;
  state: string;
  lastRun: string | null;
  nextRun: string | null;
  lastResult: number | null;
  lastResultText: string;
  interval: string | null;
};

export type ScheduleResponse = {
  ok: boolean;
  message: string;
  tasks: ScheduledTaskInfo[];
  checkedAt: string;
};

export type AutoTaskResult = {
  subjects: number;
  checked: number;
  source: 'planner' | 'watchlist';
  dryRun: boolean;
  downloaded: Array<{ query: string; episodes: number[]; files: number; completed: boolean; bytesWritten: number }>;
  skipped: Array<{ query: string; reason: string }>;
  finishedAt: string;
};

/* ------------------------------- 状态 ------------------------------- */

export type StatusResponse = {
  /** ok | error | not-configured */
  qbittorrent: string;
  /** 应用版本号，始终存在。 */
  version: string;
  /** 人类可读的连接状态描述。 */
  message: string;
  planner: string;
  backend: string;
  backendLabel: string;
  savePath: string;
  seriesDir: string;
  configPath: string | null;
  logFile: string | null;
  watchlistFile: string | null;
  webapi?: string;
};

export type OverviewResponse = {
  status: StatusResponse;
  version: string;
  serverTime: string;
  library: {
    root: string;
    seriesRoot: string | null;
    entries: number;
    videos: number;
    files: number;
    bytes: number;
  };
  watchlist: {
    file: string | null;
    total: number;
    enabled: number;
    entries: Array<{ query: string; nextEpisode: number; lastEpisode: number | null; enabled: boolean }>;
  };
  jobs: {
    counts: JobCounts;
    active: JobView | null;
    recent: JobView[];
  };
  tasks: TaskView[];
  planner: PlannerView;
  /** 自动追番的「下次什么时候检查」。 */
  autoSchedule: {
    nextCheckAt: string | null;
    nextReason: string;
    nextCheckText: string;
    windows: number;
    running: RunningDownloadView | null;
  };
  schedule: ScheduleResponse;
};

/* ---------------------------- 设置与日志 ---------------------------- */

export type ConfigResponse = {
  path: string | null;
  config: Record<string, unknown>;
  editable: string[];
};

export type ConfigSaveResponse = {
  ok: boolean;
  path: string;
  changed: Array<{ path: string; value: unknown }>;
  restartRequired: string[];
  warnings?: string[];
  config: Record<string, unknown>;
};

export type LogLine = {
  time: string | null;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | null;
  scope: string | null;
  text: string;
};

export type LogsResponse = {
  file: string | null;
  which: 'current' | 'previous';
  exists: boolean;
  size: number;
  truncated: boolean;
  lines: LogLine[];
  currentFile?: string;
};

/* ------------------------------ 请求封装 ------------------------------ */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    throw new Error(`服务端返回了非 JSON 内容（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  overview: () => request<OverviewResponse>('/api/overview'),
  schedule: () => request<ScheduleResponse>('/api/schedule'),
  scheduleSync: () => post<{ ok: boolean; message: string; count?: number; nextRun?: string | null }>('/api/schedule/sync', {}),
  search: (query: string, refresh = false) =>
    request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}${refresh ? '&refresh=1' : ''}`),
  add: (items: unknown[]) => post<AddResponse>('/api/add', { items }),

  jobs: () => request<JobsResponse>('/api/jobs'),
  jobAction: (id: string, action: 'pause' | 'resume' | 'cancel') => post<{ ok: boolean; status?: string }>('/api/jobs/act', { id, action }),
  jobsClear: () => post<{ ok: boolean; removed: number }>('/api/jobs/clear'),

  tasks: () => request<TasksResponse>('/api/tasks'),
  taskCancel: (id: string) => post<{ ok: boolean }>('/api/tasks/act', { id, action: 'cancel' }),
  autoRun: (dryRun: boolean) => post<{ taskId: string }>('/api/auto/run', { dryRun }),

  library: () => request<LibraryResponse>('/api/library'),
  libraryEntry: (path: string) => request<LibraryEntryDetail>(`/api/library/entry?path=${encodeURIComponent(path)}`),
  libraryVerify: (options: { path?: string; cleanEmpty?: boolean; checkPlayable?: boolean; addLocal?: boolean }) =>
    post<{ taskId: string }>('/api/library/verify', options),
  /** 在服务器那台机器的文件管理器里打开一个路径（下载目录或程序自己的配置文件）。 */
  open: (path: string) => post<{ ok: boolean; message: string }>('/api/open', { path }),

  watchlist: () => request<WatchlistResponse>('/api/watchlist'),
  watchlistSync: () => post<WatchlistResponse & { added: string[] }>('/api/watchlist/sync', {}),
  plannerSubject: (id: number) =>
    request<{ subjectId: number; episodes: PlannerEpisodeView[] }>(`/api/planner/subject?id=${id}`),
  watchlistAdd: (entry: Record<string, unknown>) => post<WatchlistResponse>('/api/watchlist', { action: 'add', entry }),
  watchlistUpdate: (originalQuery: string, entry: Record<string, unknown>) =>
    post<WatchlistResponse>('/api/watchlist', { action: 'update', originalQuery, entry }),
  watchlistRemove: (query: string) => post<WatchlistResponse>('/api/watchlist', { action: 'remove', entry: { query }, originalQuery: query }),
  watchlistToggle: (query: string) => post<WatchlistResponse>('/api/watchlist', { action: 'toggle', entry: { query }, originalQuery: query }),

  config: () => request<ConfigResponse>('/api/config'),
  configSave: (patch: Record<string, unknown>) => post<ConfigSaveResponse>('/api/config', { patch }),
  configRaw: (text: string) => post<ConfigSaveResponse>('/api/config/raw', { text }),

  logs: (which: 'current' | 'previous' = 'current', lines = 500) =>
    request<LogsResponse>(`/api/logs?which=${which}&lines=${lines}`)
};
