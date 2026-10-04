import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html } from '../html.js';
import { api, type LogLine, type LogsResponse } from '../api.js';
import { Card, Empty, Spinner } from '../components.js';
import { formatSize } from '../format.js';
import { notify } from '../store.js';

/**
 * 日志页。
 *
 * 这套程序大多时候没人看着（计划任务里跑），出问题时唯一的线索就是
 * data/bangumi.log。以前要远程登录到那台机器上翻文件，现在打开页面就能看，
 * 还能按级别和关键词过滤 —— 「为什么昨天没下下来」通常就是一行 WARN。
 */
export function LogsView() {
  const [which, setWhich] = useState<'current' | 'previous'>('current');
  const [level, setLevel] = useState<'all' | LogLine['level']>('all');
  const [keyword, setKeyword] = useState('');
  const [data, setData] = useState<LogsResponse | null>(null);
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.logs(which, 800));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [which]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [auto, load]);

  const lines = useMemo(() => {
    if (!data) return [];
    const needle = keyword.trim().toLowerCase();
    return data.lines.filter((line) => {
      if (level !== 'all' && line.level !== level) return false;
      if (needle !== '' && !`${line.scope ?? ''} ${line.text}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [data, level, keyword]);

  useEffect(() => {
    if (!tail) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines, tail]);

  const openLogFile = useCallback(async () => {
    if (!data?.file) return;
    try {
      const result = await api.open(data.file);
      notify('ok', result.message);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    }
  }, [data]);

  const counts = useMemo(() => {
    const result = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    for (const line of data?.lines ?? []) if (line.level) result[line.level] += 1;
    return result;
  }, [data]);

  return html`
    <div class="view">
      <${Card}
        title="日志"
        hint=${data?.file
          ? html`<span class="mono">${data.file}</span> · ${formatSize(data.size)}${data.truncated ? '（只读了末尾一块）' : ''}`
          : '还没有日志文件'}
        actions=${html`
          <button type="button" class="ghost small" onClick=${() => void load()}>刷新</button>
          <button type="button" class="ghost small" disabled=${!data?.file} onClick=${() => void openLogFile()}>打开日志文件</button>
        `}
      >
        <div class="toolbar">
          <div class="filters">
            <label class="pref">
              <input type="checkbox" checked=${auto} onChange=${(e: Event) => setAuto((e.target as HTMLInputElement).checked)} />
              自动刷新（5 秒）
            </label>
            <label class="pref">
              <input type="checkbox" checked=${tail} onChange=${(e: Event) => setTail((e.target as HTMLInputElement).checked)} />
              自动滚到最新
            </label>
            <div class="chips">
              ${(['all', 'DEBUG', 'INFO', 'WARN', 'ERROR'] as const).map(
                (value) => html`
                  <button type="button" class=${`chip ${level === value ? 'active' : ''}`} onClick=${() => setLevel(value)}>
                    ${value === 'all' ? '全部' : value}
                    ${value !== 'all' ? html`<span class="dim"> ${counts[value]}</span>` : null}
                  </button>
                `
              )}
            </div>
          </div>
          <div class="filters">
            <input
              type="search"
              placeholder="过滤关键词，例如 失败 / bittorrent"
              value=${keyword}
              onInput=${(e: Event) => setKeyword((e.target as HTMLInputElement).value)}
            />
            <select value=${which} onChange=${(e: Event) => setWhich((e.target as HTMLSelectElement).value as 'current' | 'previous')}>
              <option value="current">当前日志</option>
              <option value="previous">上一次轮转的日志（.1）</option>
            </select>
          </div>
        </div>

        ${error && html`<div class="banner err">${error}</div>`}
        ${!data && !error ? html`<${Spinner} label="读取日志…" />` : null}
        ${data && !data.exists
          ? html`<${Empty}
              text="还没有日志文件"
              hint="日志在程序启动时写入 data/bangumi.log；如果一直没跑过自动追番，这里就是空的"
            />`
          : data &&
            html`
              <div class="log-view mono small" ref=${scrollRef}>
                ${lines.length === 0
                  ? html`<div class="dim">当前筛选下没有日志</div>`
                  : lines.map(
                      (line) => html`
                        <div class=${`log-line ${(line.level ?? '').toLowerCase()}`}>
                          <span class="log-time">${line.time ?? ''}</span>
                          <span class="log-level">${line.level ?? ''}</span>
                          <span class="log-scope">${line.scope ?? ''}</span>
                          <span class="log-text">${line.text}</span>
                        </div>
                      `
                    )}
              </div>
              <div class="dim small">共 ${data.lines.length} 行，显示 ${lines.length} 行</div>
            `}
      <//>
    </div>
  `;
}
