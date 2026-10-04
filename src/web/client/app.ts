/**
 * Web 界面：搜索资源 → 挑选 → 交给后台下载队列。
 *
 * 这是「自动化」之外的第二个入口：自动化负责无人值守地追新番，
 * 这里负责你自己想找点什么的时候手动搜、手动挑。
 * 两者共用同一套片源、解析与打分代码，只是触发方式不同。
 */
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html } from './html.js';
import {
  api,
  type AddResponse,
  type JobView,
  type LibraryResponse,
  type ResultItem,
  type SearchResponse,
  type StatusResponse
} from './api.js';

/** 任务操作。与后端 /api/jobs/act 的 action 对应。 */
type JobAction = 'pause' | 'resume' | 'cancel';
import { formatSize, relativeTime, shortTracker } from './format.js';

const QUALITY_LABELS: Record<string, string> = {
  '2160p': '4K',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p'
};

const SUBTITLE_LABELS: Record<string, string> = {
  简繁: '简繁',
  简日: '简日',
  繁日: '繁日',
  简体: '简中',
  繁体: '繁中',
  字幕: '字幕'
};

function App() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [onlyPreferred, setOnlyPreferred] = useState(false);
  const [trackerFilter, setTrackerFilter] = useState('all');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [jobsRunning, setJobsRunning] = useState(false);
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  /*
   * 轮询下载任务。
   *
   * 下载是在后台队列里跑的（可能几十分钟），所以界面不能等它，
   * 得定期问「现在到哪了」。有任务在跑时问得勤一点，闲时慢一点。
   */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const response = await api.jobs();
        if (!alive) return;
        setJobs(response.jobs);
        setJobsRunning(response.running);
        timer = setTimeout(poll, response.running ? 2000 : 8000);
      } catch {
        if (alive) timer = setTimeout(poll, 8000);
      }
    };

    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  /*
   * 下载库归纳。
   *
   * 任务结束（或刚打开页面）时拉一次就够了 —— 内容是磁盘上的东西，
   * 不像任务进度那样每秒都在变，没必要高频轮询。
   */
  const refreshLibrary = useCallback(() => {
    api
      .library()
      .then(setLibrary)
      .catch(() => setLibrary(null));
  }, []);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    // 有任务刚跑完就刷新，这样下完的东西立刻出现在列表里
    if (!jobsRunning && jobs.some((job) => job.status === 'completed')) refreshLibrary();
  }, [jobsRunning, jobs, refreshLibrary]);

  const runSearch = useCallback(async (keyword: string) => {
    const trimmed = keyword.trim();
    if (trimmed === '') return;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const response = await api.search(trimmed);
      setData(response);
      setTrackerFilter('all');
      if (response.results.length === 0) {
        setToast({ kind: 'err', text: '没有搜到结果，换个关键词试试' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const trackers = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.results.map((item) => item.tracker))].sort();
  }, [data]);

  const visible = useMemo(() => {
    if (!data) return [];
    return data.results.filter((item) => {
      if (trackerFilter !== 'all' && item.tracker !== trackerFilter) return false;
      if (onlyPreferred && item.rejected) return false;
      return true;
    });
  }, [data, trackerFilter, onlyPreferred]);

  const selectedItems = useMemo(
    () => (data ? data.results.filter((item) => selected.has(item.key)) : []),
    [data, selected]
  );

  const totalSize = useMemo(
    () => selectedItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    [selectedItems]
  );

  const onJobAction = useCallback(
    async (job: JobView, action: JobAction) => {
      try {
        await api.jobAction(job.id, action);
        // 立刻刷新一次，别等下一个轮询周期，否则点了没反应
        const response = await api.jobs();
        setJobs(response.jobs);
        setJobsRunning(response.running);
      } catch (err) {
        setToast({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
      }
    },
    []
  );

  const addSelected = useCallback(async () => {
    if (selectedItems.length === 0) return;
    setAdding(true);
    try {
      const response: AddResponse = await api.add(
        selectedItems.map((item) => ({
          title: item.title,
          magnet: item.magnet,
          torrentUrl: item.torrentUrl,
          tracker: item.tracker,
          sizeBytes: item.sizeBytes
        }))
      );
      const failed = response.results.filter((entry) => !entry.ok);
      if (failed.length === 0) {
        // 只是入队，下载在后台跑；进度看下面的任务面板
        setToast({
          kind: 'ok',
          text: `已开始下载 ${response.queued ?? response.results.length} 个（进度见下方「下载任务」）`
        });
        setSelected(new Set());
      } else {
        setToast({ kind: 'err', text: `${failed.length} 个失败：${failed[0]?.error ?? ''}` });
      }
    } catch (err) {
      setToast({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setAdding(false);
    }
  }, [selectedItems]);

  return html`
    <div class="layout">
      <header class="topbar">
        <div class="brand">
          <span class="logo">番</span>
          <div>
            <h1>番剧资源搜索</h1>
            <p class="sub">勾选后点「开始下载」；下载在后台进行，进度见下方任务面板</p>
          </div>
        </div>
        <div class="status">
          <span class=${`dot ${status?.qbittorrent === 'ok' ? 'on' : 'off'}`}></span>
          <span title=${status?.message ?? ''}>${status ? status.message : '正在检查 qBittorrent…'}</span>
          <span class="dim">v${status?.version ?? '…'}</span>
        </div>
      </header>

      <form
        class="searchbar"
        onSubmit=${(event: Event) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <input
          ref=${inputRef}
          type="search"
          value=${query}
          placeholder="输入番剧名，例如：葬送的芙莉莲 / Frieren / 冰之城墙"
          onInput=${(event: Event) => setQuery((event.target as HTMLInputElement).value)}
        />
        <button type="submit" disabled=${loading}>${loading ? '搜索中…' : '搜索'}</button>
      </form>

      ${error && html`<div class="banner err">${error}</div>`}

      ${data &&
      html`
        <div class="toolbar">
          <div class="filters">
            <label class="pref">
              <input
                type="checkbox"
                checked=${onlyPreferred}
                onChange=${(event: Event) => setOnlyPreferred((event.target as HTMLInputElement).checked)}
              />
              只看符合偏好
            </label>
            <div class="chips">
              <button
                type="button"
                class=${trackerFilter === 'all' ? 'chip active' : 'chip'}
                onClick=${() => setTrackerFilter('all')}
              >
                全部 ${data.results.length}
              </button>
              ${trackers.map((tracker) => {
                const count = data.results.filter((item) => item.tracker === tracker).length;
                return html`
                  <button
                    type="button"
                    class=${trackerFilter === tracker ? 'chip active' : 'chip'}
                    onClick=${() => setTrackerFilter(tracker)}
                  >
                    ${shortTracker(tracker)} ${count}
                  </button>
                `;
              })}
            </div>
          </div>
          <div class="meta">
            关键词 ${data.queries.join(' / ')} · 去重后 ${data.results.length} 条 ·
            ${data.cached ? html`<span title="5 分钟内重复搜索会直接用缓存">缓存</span>` : html`${data.elapsedMs}ms`}
            ${data.errors.length > 0 &&
            html`<span
              class="warn"
              title=${data.errors.map((item) => `${item.tracker}: ${item.reason}`).join('\n')}
            >
              · ${data.errors.length} 个源失败
            </span>`}
          </div>
        </div>

        <div class="results">
          ${visible.length === 0 &&
          html`<div class="empty">当前筛选下没有结果${onlyPreferred ? '，取消「只看符合偏好」试试' : ''}</div>`}
          ${visible.map(
            (item) => html`
              <${ResultRow} key=${item.key} item=${item} checked=${selected.has(item.key)} onToggle=${() => toggle(item.key)} />
            `
          )}
        </div>
      `}

      ${selectedItems.length > 0 &&
      html`
        <div class="actionbar">
          <div>
            已选 <strong>${selectedItems.length}</strong> 个种子
            ${totalSize > 0 && html`<span class="dim"> · 共 ${formatSize(totalSize)}</span>`}
          </div>
          <div class="actions">
            <button type="button" class="ghost" onClick=${() => setSelected(new Set())}>清空</button>
            <button type="button" onClick=${addSelected} disabled=${adding}>
              ${adding ? '提交中…' : '开始下载'}
            </button>
          </div>
        </div>
      `}

      ${library && library.entries.length > 0 &&
      html`
        <div class="library">
          <div class="jobs-head">
            <button type="button" class="linklike" onClick=${() => setShowLibrary((value) => !value)}>
              ${showLibrary ? '▾' : '▸'} 已有内容
            </button>
            <span class="dim">
              ${library.entries.length} 部 · ${library.totalVideos} 个视频 · ${formatSize(library.totalBytes)}
            </span>
          </div>
          ${showLibrary &&
          html`
            <div class="library-list">
              ${library.entries.map(
                (entry) => html`
                  <div class="library-row">
                    <span class="library-size">${formatSize(entry.bytes)}</span>
                    <span class="library-kind">${entry.kind === 'series' ? '剧集' : entry.kind === 'single' ? '单片' : '其他'}</span>
                    <span class="library-name" title=${entry.path}>${entry.name}</span>
                    <span class="dim">
                      ${entry.videoCount > 1 ? `${entry.videoCount} 集` : entry.videoCount === 1 ? '1 个视频' : ''}
                    </span>
                  </div>
                `
              )}
            </div>
          `}
        </div>
      `}

      ${jobs.length > 0 &&
      html`
        <div class="jobs">
          <div class="jobs-head">
            下载任务
            <span class="dim">${jobsRunning ? '进行中' : '空闲'}</span>
          </div>
          ${jobs.slice(0, 8).map((job) => html`<${JobRow} key=${job.id} job=${job} onAction=${onJobAction} />`)}
        </div>
      `}

      ${toast && html`<div class=${`toast ${toast.kind}`}>${toast.text}</div>`}
    </div>
  `;
}

const JOB_LABELS: Record<JobView['status'], string> = {
  queued: '排队中',
  running: '下载中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

/**
 * 一条下载任务。
 *
 * 存在的意义：下载在后台队列里跑（可能几十分钟），
 * 没有这个面板用户就只能干等，不知道是卡住了还是在正常进行。
 */
function JobRow({ job, onAction }: { job: JobView; onAction: (job: JobView, action: JobAction) => void }) {
  const percent = job.percent ?? 0;
  const detail: string[] = [];
  if (job.downloadedBytes > 0) {
    detail.push(
      job.totalBytes !== null && job.totalBytes > 0
        ? `${formatSize(job.downloadedBytes)} / ${formatSize(job.totalBytes)}`
        : formatSize(job.downloadedBytes)
    );
  }
  if (job.speed > 0) detail.push(`${formatSize(job.speed)}/s`);
  if (job.peers > 0) detail.push(`${job.peers} 个 peer`);

  return html`
    <div class=${`job ${job.status}`}>
      <div class="job-line">
        <span class=${`job-status ${job.status}`}>${JOB_LABELS[job.status]}</span>
        <span class="job-title" title=${job.title}>${job.title}</span>
        ${job.percent !== null &&
        job.status === 'running' &&
        html`<span class="job-percent">${percent.toFixed(1)}%</span>`}
        <span class="job-actions">
          ${job.canPause &&
          html`<button
            type="button"
            class="icon"
            title="暂停（已下好的分片会保留）"
            aria-label="暂停"
            onClick=${() => onAction(job, 'pause')}
          >⏸</button>`}
          ${job.canResume &&
          html`<button
            type="button"
            class="icon"
            title="继续（从已有进度接着下）"
            aria-label="继续"
            onClick=${() => onAction(job, 'resume')}
          >▶</button>`}
          ${job.canCancel &&
          html`<button
            type="button"
            class="icon danger"
            title="取消任务"
            aria-label="取消"
            onClick=${() => onAction(job, 'cancel')}
          >✕</button>`}
        </span>
      </div>
      ${job.status === 'running' &&
      html`
        <div class="job-bar"><div class="job-bar-fill" style=${`width:${Math.max(percent, 1)}%`}></div></div>
      `}
      ${detail.length > 0 && html`<div class="job-detail dim">${detail.join(' · ')}</div>`}
      ${job.error && html`<div class="job-error">${job.error}</div>`}
      ${job.status === 'completed' &&
      job.files.length > 0 &&
      html`<div class="job-detail dim">落盘 ${job.files.length} 个文件</div>`}
    </div>
  `;
}

function ResultRow({ item, checked, onToggle }: { item: ResultItem; checked: boolean; onToggle: () => void }) {
  const parsed = item.parsed;
  const episodeText =
    parsed.episodes.length > 1
      ? `第 ${parsed.episodes[0]}–${parsed.episodes[parsed.episodes.length - 1]} 集`
      : parsed.episodes.length === 1
        ? `第 ${parsed.episodes[0]} 集`
        : parsed.kind === 'batch'
          ? '合集'
          : '集号未知';

  const tags: Array<{ text: string; kind: string }> = [];
  if (parsed.resolution) tags.push({ text: QUALITY_LABELS[parsed.resolution] ?? parsed.resolution, kind: 'res' });
  if (parsed.container) tags.push({ text: parsed.container.toUpperCase(), kind: parsed.container === 'mkv' ? 'good' : '' });
  if (parsed.subtitle) tags.push({ text: SUBTITLE_LABELS[parsed.subtitle] ?? parsed.subtitle, kind: 'sub' });
  if (parsed.videoCodec) tags.push({ text: parsed.videoCodec.toUpperCase(), kind: '' });
  if (parsed.bitDepth === 10) tags.push({ text: '10bit', kind: '' });
  if (parsed.source) tags.push({ text: parsed.source.toUpperCase(), kind: '' });

  return html`
    <label class=${`row ${checked ? 'checked' : ''} ${item.rejected ? 'rejected' : ''}`}>
      <input type="checkbox" checked=${checked} onChange=${onToggle} />
      <div class="rowbody">
        <div class="rowhead">
          <span class="title">${item.title}</span>
          <span class="score" title=${item.reasons.join('\n')}>${Math.round(item.score)}</span>
        </div>
        <div class="rowmeta">
          <span class="ep">${episodeText}</span>
          ${parsed.group && html`<span class="group">${parsed.group}</span>`}
          <span class="tracker">${shortTracker(item.tracker)}</span>
          ${item.sizeBytes !== null && html`<span>${formatSize(item.sizeBytes)}</span>`}
          ${item.seederCount !== null && html`<span class="seeders" title="做种数">▲${item.seederCount}</span>`}
          ${item.publishedAt && html`<span class="dim">${relativeTime(item.publishedAt)}</span>`}
        </div>
        <div class="rowtags">
          ${tags.map((tag) => html`<span class=${`tag ${tag.kind}`}>${tag.text}</span>`)}
          ${item.rejected &&
          html`<span class="tag bad" title=${item.rejectReason ?? ''}>✕ ${item.rejectReason ?? '不符合偏好'}</span>`}
        </div>
      </div>
    </label>
  `;
}

const root = document.getElementById('app');
if (root) render(html`<${App} />`, root);
