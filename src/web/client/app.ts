/**
 * Web 界面：搜索资源 → 挑选 → 推送到 qBittorrent。
 *
 * 这是「自动化」之外的第二个入口：自动化负责无人值守地追新番，
 * 这里负责你自己想找点什么的时候手动搜、手动挑。
 * 两者共用同一套片源、解析与打分代码，只是触发方式不同。
 */
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html } from './html.js';
import { api, type AddResponse, type ResultItem, type SearchResponse, type StatusResponse } from './api.js';
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
        setToast({ kind: 'ok', text: `已推送 ${response.results.length} 个种子到 qBittorrent` });
        setSelected(new Set());
      } else {
        setToast({ kind: 'err', text: `${failed.length} 个推送失败：${failed[0]?.error ?? ''}` });
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
            <p class="sub">搜到的结果可以直接推送到 qBittorrent；无人值守追番仍由 sync / run 负责</p>
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
              ${adding ? '推送中…' : '推送到 qBittorrent'}
            </button>
          </div>
        </div>
      `}

      ${toast && html`<div class=${`toast ${toast.kind}`}>${toast.text}</div>`}
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
