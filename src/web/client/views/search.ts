import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html } from '../html.js';
import { api, type AddResponse, type ResultItem, type SearchResponse } from '../api.js';
import { Badge, Card, Empty } from '../components.js';
import { formatSize, relativeTime, shortTracker } from '../format.js';
import { notify, refreshNow, useStore } from '../store.js';

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

/** 把 "1-13,15" 这种写法解析成集号数组；空串表示不限制（整包）。 */
export function parseEpisodeSpec(spec: string): number[] {
  const result = new Set<number>();
  for (const part of spec.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const from = Number.parseInt(range[1] as string, 10);
      const to = Number.parseInt(range[2] as string, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 2000) continue;
      for (let episode = Math.min(from, to); episode <= Math.max(from, to); episode += 1) result.add(episode);
      continue;
    }
    const single = Number.parseInt(token, 10);
    if (Number.isFinite(single) && single > 0) result.add(single);
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * 下载页：搜索片源 → 勾选 → 交给后台下载队列。
 *
 * 这是「自动化」之外的第二个入口：自动化负责无人值守地追新番，
 * 这里负责你自己想找点什么的时候手动搜、手动挑。
 * 两者共用同一套片源、解析与打分代码，只是触发方式不同。
 */
export function SearchView() {
  const store = useStore();
  const [query, setQuery] = useState('');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [onlyPreferred, setOnlyPreferred] = useState(false);
  const [trackerFilter, setTrackerFilter] = useState('all');
  const [episodeSpec, setEpisodeSpec] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(async (keyword: string, refresh = false) => {
    const trimmed = keyword.trim();
    if (trimmed === '') return;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const response = await api.search(trimmed, refresh);
      setData(response);
      setTrackerFilter('all');
      if (response.results.length === 0) notify('err', '没有搜到结果，换个关键词试试');
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
      const episodes = parseEpisodeSpec(episodeSpec);
      const response: AddResponse = await api.add(
        selectedItems.map((item) => ({
          title: item.title,
          magnet: item.magnet,
          torrentUrl: item.torrentUrl,
          tracker: item.tracker,
          sizeBytes: item.sizeBytes,
          episodes
        }))
      );
      const failed = response.results.filter((entry) => !entry.ok);
      if (failed.length === 0) {
        notify('ok', `已开始下载 ${response.queued ?? response.results.length} 个${episodes.length > 0 ? `（只下第 ${episodes.join('/')} 集）` : ''}，进度见「任务」`);
        setSelected(new Set());
        await refreshNow();
      } else {
        notify('err', `${failed.length} 个失败：${failed[0]?.error ?? ''}`);
      }
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }, [selectedItems, episodeSpec]);

  const activeCount = store.counts.running + store.counts.queued;

  return html`
    <div class="view">
      <${Card}
        title="搜索片源"
        hint="勾选后点「开始下载」；下载在后台进行，可以随时去「任务」页看进度或暂停"
        actions=${activeCount > 0 ? html`<a class="button ghost small" href="#/jobs">${activeCount} 个任务进行中</a>` : null}
      >
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
          ${data &&
          html`<button
            type="button"
            class="ghost"
            disabled=${loading}
            title="忽略 5 分钟缓存，重新打一遍片源"
            onClick=${() => void runSearch(data.query, true)}
          >
            重新搜索
          </button>`}
        </form>
        <div class="dim small">
          手动搜索不按集号淘汰 —— 想下第几集由你在下面指定，或者整包下回来自己挑。
        </div>
      </${Card}>

      ${error && html`<div class="banner err">${error}</div>`}

      ${data &&
      html`
        <${Card}>
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
            ${data.season
              ? html`<div class="notice small">
                  认出你在找
                  <b>第 ${data.season} 季</b>，已按季过滤（标题里写了别季的排除了，没写季数的保留）
                  ${data.seasonFiltered ? html` · <span class="warn">过滤后一条不剩，已退回未过滤的结果</span>` : null}
                </div>`
              : null}
            <div class="meta dim small">
              关键词
              ${(data.queryPlan ?? data.queries.map((text) => ({ text, origin: '' }))).map(
                (item) => html`<span class="kw" title=${item.origin ? `来自：${item.origin}` : ''}>${item.text}</span>`
              )}
              · 去重后 ${data.results.length} 条 ·
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
            html`<${Empty}
              text="当前筛选下没有结果"
              hint=${onlyPreferred ? '取消「只看符合偏好」试试' : undefined}
            />
            ${data.results.length === 0 &&
            html`
              <div class="empty-hints">
                <div class="dim small">
                  一条都没搜到。tracker 只做字面匹配，中文简称（比如「京吹」）基本搜不到东西，
                  而且同一部番的中文名/日文名/罗马音命中率差别很大。试试这些：
                </div>
                <div class="hint-chips">
                  ${(data.queryPlan ?? [])
                    .filter((item) => item.text !== data.query)
                    .map(
                      (item) => html`<button type="button" class="chip" onClick=${() => {
                        setQuery(item.text);
                        void runSearch(item.text);
                      }}>
                        ${item.text}
                      </button>`
                    )}
                  ${suggestionsFor(data.query).map(
                    (text) => html`<button type="button" class="chip" onClick=${() => {
                      setQuery(text);
                      void runSearch(text);
                    }}>${text}</button>`
                  )}
                </div>
              </div>
            `}`}
            ${visible.map(
              (item) => html`
                <${ResultRow} key=${item.key} item=${item} checked=${selected.has(item.key)} onToggle=${() => toggle(item.key)} />
              `
            )}
          </div>
        </${Card}>
      `}

      ${selectedItems.length > 0 &&
      html`
        <div class="actionbar">
          <div>
            已选 <strong>${selectedItems.length}</strong> 个种子
            ${totalSize > 0 && html`<span class="dim"> · 共 ${formatSize(totalSize)}</span>`}
          </div>
          <div class="actions">
            <label class="inline-field" title="留空表示整包下载；填了就只下这些集">
              <span class="dim small">只下第</span>
              <input
                type="text"
                class="narrow"
                placeholder="全部"
                value=${episodeSpec}
                onInput=${(event: Event) => setEpisodeSpec((event.target as HTMLInputElement).value)}
              />
              <span class="dim small">集</span>
            </label>
            <button type="button" class="ghost" onClick=${() => setSelected(new Set())}>清空</button>
            <button type="button" onClick=${addSelected} disabled=${adding}>
              ${adding ? '提交中…' : '开始下载'}
            </button>
          </div>
        </div>
      `}
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
          ${tags.map((tag) => html`<${Badge} kind=${tag.kind}>${tag.text}</${Badge}>`)}
          ${item.rejected &&
          html`<${Badge} kind="bad" title=${item.rejectReason ?? ''}>✕ ${item.rejectReason ?? '不符合偏好'}</${Badge}>`}
        </div>
      </div>
    </label>
  `;
}

/**
 * 搜不到时的建议关键词。
 *
 * 只做很轻的启发：中文简称（2~6 个字、没有空格和括号）大概率在 tracker 里搜不到，
 * 提醒用户换成官方全名或罗马音。不做自动翻译 —— 猜错了更浪费时间。
 */
function suggestionsFor(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  const looksLikeNickname = trimmed.length <= 6 && !/[\s（）()[\]]/.test(trimmed) && /[\u4e00-\u9fff]/.test(trimmed);
  if (!looksLikeNickname) return [];
  return [`${trimmed} 第一季`, `${trimmed} 第二季`];
}
