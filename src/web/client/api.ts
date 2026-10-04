/** 与后端 /api/search 返回结构对应的类型。 */

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

export type JobView = {
  id: string;
  title: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 完成百分比（0~100），未知时 null。 */
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  speed: number;
  peers: number;
  messages: string[];
  files: string[];
  error: string | null;
  backend: string;
  /** 服务端算好的「这个状态下能做哪些操作」。 */
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
};

export type JobsResponse = {
  jobs: JobView[];
  running: boolean;
};

export type LibraryEntry = {
  name: string;
  path: string;
  bytes: number;
  videoCount: number;
  otherCount: number;
  kind: 'series' | 'single' | 'unknown';
};

export type LibraryResponse = {
  root: string;
  seriesRoot?: string | null;
  totalBytes: number;
  totalVideos: number;
  entries: LibraryEntry[];
};

export type StatusResponse = {
  /** ok | error | not-configured */
  qbittorrent: string;
  /** 应用版本号，始终存在。 */
  version: string;
  /** 人类可读的连接状态描述。 */
  message: string;
  planner: string;
  webapi?: string;
};

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

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  search: (query: string) => request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`),
  add: (items: unknown[]) =>
    request<AddResponse>('/api/add', { method: 'POST', body: JSON.stringify({ items }) }),
  jobs: () => request<JobsResponse>('/api/jobs'),
  library: () => request<LibraryResponse>('/api/library'),
  jobAction: (id: string, action: 'pause' | 'resume' | 'cancel') =>
    request<{ ok: boolean; status?: string }>('/api/jobs/act', {
      method: 'POST',
      body: JSON.stringify({ id, action })
    })
};
