import { useCallback, useEffect, useState } from 'preact/hooks';
import { html } from '../html.js';
import { api, type PlanRow, type ScheduleResponse, type WatchEntryView, type WatchlistResponse } from '../api.js';
import { Badge, Card, Empty, ProgressBar, Spinner, StatusDot } from '../components.js';
import { compactEpisodes, formatClock, formatSize, formatSpeed, relativeTime, shortenPath } from '../format.js';
import { notify, refreshNow, useStore } from '../store.js';

const PLAN_ROW_BADGE: Record<PlanRow['status'], string> = {
  done: 'ok',
  waiting: 'ok',
  upcoming: '',
  stale: 'warn',
  unknown: ''
};

/** ISO → 「10-08 21:56」。 */
function formatClockText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 每一行再补一句「接下来会怎样」。 */
function plainStatusHint(row: PlanRow, activeIntervalMinutes: number): string {
  switch (row.status) {
    case 'done':
      return '已下过，不再重复搜';
    case 'waiting':
      return `每 ${activeIntervalMinutes} 分钟看一次`;
    case 'upcoming':
      return '还没播，到点自动开始';
    case 'stale':
      return '一直没片源，已降频';
    default:
      return 'Planner 没给播出时刻';
  }
}

/** 180 → 「3 小时」，90 → 「1 小时 30 分」。 */
function formatIdle(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * 计划页：这套程序「自己会做什么」都在这里。
 *
 * 三块内容：
 *   1. Windows 计划任务 —— 定时追番和常驻界面到底还活着没有
 *   2. 追番清单 —— 追哪些番、追到第几集，可以直接编辑
 *   3. Bangumi Watch Planner —— 如果那台服务在跑，它给出的是更权威的
 *      「在看 + 未看 + 已播出」状态，自动追番会优先用它
 */
export function PlanView() {
  const store = useStore();
  const [data, setData] = useState<WatchlistResponse | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ query: '', lastEpisode: '', startFrom: '', note: '' });

  const load = useCallback(async () => {
    try {
      const [watchlist, scheduleResult] = await Promise.all([api.watchlist(), api.schedule()]);
      setData(watchlist);
      setSchedule(scheduleResult);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAuto = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      try {
        await api.autoRun(dryRun);
        notify('ok', dryRun ? '已开始试跑（只挑选不下载）' : '已开始追番，进度见「任务」页');
        await refreshNow();
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const submit = useCallback(
    async (originalQuery: string | null) => {
      if (form.query.trim() === '') {
        notify('err', '番名不能为空');
        return;
      }
      setBusy(true);
      try {
        const entry = {
          query: form.query.trim(),
          lastEpisode: form.lastEpisode.trim() === '' ? undefined : Number(form.lastEpisode),
          startFrom: form.startFrom.trim() === '' ? undefined : Number(form.startFrom),
          note: form.note.trim()
        };
        const response = originalQuery ? await api.watchlistUpdate(originalQuery, entry) : await api.watchlistAdd(entry);
        setData(response);
        setEditing(null);
        setForm({ query: '', lastEpisode: '', startFrom: '', note: '' });
        notify('ok', originalQuery ? '已保存' : `已加入追番：${entry.query}`);
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [form]
  );

  /** 把最新计划写进计划任务的触发器。 */
  const syncTask = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.scheduleSync();
      notify(result.ok ? 'ok' : 'err', `${result.message}${result.nextRun ? `（下次 ${result.nextRun}）` : ''}`);
      await load();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [load]);

  const remove = useCallback(
    async (entry: WatchEntryView) => {
      if (!window.confirm(`从追番清单里删掉《${entry.query}》？（已下载的文件不会被删除）`)) return;
      setBusy(true);
      try {
        setData(await api.watchlistRemove(entry.query));
        notify('ok', `已删除《${entry.query}》`);
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const toggleEnabled = useCallback(async (entry: WatchEntryView) => {
    try {
      setData(await api.watchlistToggle(entry.query));
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const startEdit = useCallback((entry: WatchEntryView) => {
    setEditing(entry.query);
    setForm({
      query: entry.query,
      lastEpisode: entry.lastEpisode === null ? '' : String(entry.lastEpisode),
      startFrom: entry.startFrom === null ? '' : String(entry.startFrom),
      note: entry.note
    });
  }, []);

  const autoTask = store.tasks.find((task) => task.kind === 'auto' && task.status === 'running') ?? null;
  const planner = data?.planner ?? null;

  return html`
    <div class="view">
      <${Card}
        title="自动追番"
        hint="不是每 15 分钟无脑跑：按播出时间安排，只在「该出片源」的时候密集检查"
        actions=${html`
          <button type="button" class="ghost" disabled=${busy} onClick=${() => void runAuto(true)}>试跑一轮</button>
          <button type="button" disabled=${busy} onClick=${() => void runAuto(false)}>立即跑一轮</button>
        `}
      >
        ${data?.schedule?.running
          ? html`
              <div class="running-box">
                <div class="schedule-line">
                  <${Badge} kind="ok">正在下载</${Badge}>
                  <span class="ellipsis" title=${data.schedule.running.title}>${data.schedule.running.title}</span>
                </div>
                <${ProgressBar} percent=${data.schedule.running.ratio * 100} />
                <div class="dim small">
                  ${(data.schedule.running.ratio * 100).toFixed(1)}% ·
                  ${formatSize(data.schedule.running.downloadedBytes)} / ${formatSize(data.schedule.running.totalBytes)}
                  ${data.schedule.running.speed > 0 ? ` · ${formatSpeed(data.schedule.running.speed)}` : ' · 暂时没速度'}
                  ${data.schedule.running.peers > 0 ? ` · ${data.schedule.running.peers} 个 peer` : ''}
                  · 开始于 ${formatClockText(data.schedule.running.startedAt)}
                  ${data.schedule.running.speed > 0
                    ? ` · 预计还要 ${Math.max(1, Math.round((data.schedule.running.totalBytes - data.schedule.running.downloadedBytes) / data.schedule.running.speed / 60))} 分钟`
                    : ''}
                </div>
                <div class="dim small">
                  文件大小看着是满的（断点续传会预分配），但里面还没写满 ——
                  现在打开播放会失败，进度以这里的「已校验」为准；实在着急也可以去「片库」页核对。
                </div>
              </div>
            `
          : autoTask
          ? html`
              <div class="job-detail">${autoTask.progress ?? '正在处理…'}</div>
              <${ProgressBar} percent=${autoTask.ratio === null ? null : autoTask.ratio * 100} indeterminate=${autoTask.ratio === null} />
              <a href="#/jobs" class="linklike">看详细进度</a>
            `
          : html`
              ${data?.schedule
                ? html`
                    <div class="schedule-line">
                      <span class="dim">下次检查</span>
                      <strong>${data.schedule.nextCheckText}</strong>
                      ${data.schedule.windows.length > 0
                        ? html`<${Badge} kind="ok">正在等片源 ${data.schedule.windows.length} 集</${Badge}>`
                        : null}
                    </div>
                    <div class="dim small">${data.schedule.nextReason}</div>
                  `
                : null}
              ${data?.schedule && data.schedule.rows.length > 0
                ? html`
                    <div class="plan-table-wrap">
                      <div class="sub-head">接下来的安排（按播出时间排）</div>
                      <div class="plan-table">
                        <div class="plan-head">
                          <span>播出</span>
                          <span>番剧</span>
                          <span>集</span>
                          <span>该取片源</span>
                          <span>状态</span>
                        </div>
                        ${data.schedule.rows.map(
                          (row: PlanRow) => html`
                            <div class=${`plan-row ${row.status}`}>
                              <span class="mono small">
                                ${row.broadcastAt
                                  ? html`${formatClockText(row.broadcastAt)}`
                                  : html`${row.airdate || '—'}`}
                              </span>
                              <span class="ellipsis" title=${row.name}>${row.name}</span>
                              <span class="mono small">${row.episode ?? '?'}</span>
                              <span class="mono small dim">${row.readyAt ? formatClockText(row.readyAt) : '—'}</span>
                              <span>
                                <${Badge} kind=${PLAN_ROW_BADGE[row.status]}>${row.statusText}</${Badge}>
                                <span class="dim small"> ${plainStatusHint(row, data.schedule.activeIntervalMinutes)}</span>
                              </span>
                            </div>
                          `
                        )}
                      </div>
                      <div class="dim small">
                        这张表就是自动追番的计划：到「该取片源」那一刻才开始搜种，
                        在此之前最多每 ${formatIdle(data.schedule.idleIntervalMinutes)} 重读一遍计划
                        ${data.schedule.nextRefreshAt
                          ? html`（下次 ${formatClockText(data.schedule.nextRefreshAt)}）`
                          : null}。
                      </div>
                    </div>
                  `
                : null}

              <div class="kv-grid">
                <div><span class="dim">下载目录</span><div class="mono small">${data?.download.savePath ?? '—'}</div></div>
                <div><span class="dim">片源就绪延迟</span><div>播出后 ${data?.download.readyDelayMinutes ?? '—'} 分钟才开始找</div></div>
                <div><span class="dim">等片源时间隔</span><div>每 ${data?.schedule?.activeIntervalMinutes ?? 15} 分钟一次</div></div>
                <div><span class="dim">空闲兜底间隔</span><div>每 ${formatIdle(data?.schedule?.idleIntervalMinutes)} 确认一次计划</div></div>
                <div><span class="dim">单集最多盯</span><div>${data?.schedule?.releaseWindowHours ?? 12} 小时</div></div>
                <div><span class="dim">单轮最多下几集</span><div>${data?.download.maxEpisodesPerSubjectPerRun ?? '—'} 集</div></div>
              </div>
              <div class="dim small">
                已经下过的集记在 ${data?.schedule?.file ? html`<span class="mono">${data.schedule.file}</span>` : '计划文件'} 里
                （当前 ${data?.schedule?.doneCount ?? 0} 条），Planner 那边还没标「看过」的集不会被重复下载。
              </div>
            `}
      <//>

      <${Card}
        title="计划任务"
        hint=${schedule?.ok
          ? '由 Windows 任务计划程序触发；「自动追番」那个已经按播出时间重排过，只剩低频的「重读计划」'
          : schedule?.message ?? ''}
        actions=${html`
          <button type="button" class="ghost small" onClick=${() => void load()}>刷新</button>
          <button
            type="button"
            class="ghost small"
            disabled=${busy || !data?.schedule || data.schedule.rows.length === 0}
            title="按最新播出安排重写 BangumiDownloader 的触发器"
            onClick=${() => void syncTask()}
          >
            按播出时间重排
          </button>
        `}
      >
        ${schedule?.ok
          ? html`
              <div class="task-cards">
                ${schedule.tasks.map(
                  (task) => html`
                    <div class="task-card">
                      <div class="stat-line">
                        <${StatusDot} ok=${task.state === 'Ready' || task.state === 'Running'} />
                        <strong>${task.name}</strong>
                        <${Badge} kind=${task.state === 'Running' ? 'ok' : task.state === 'Disabled' ? 'bad' : ''}>${task.state}</${Badge}>
                      </div>
                      <div class="dim small">
                        上次运行 ${task.lastRun ? formatClock(task.lastRun.replace(' ', 'T')) : '—'}
                        ${task.lastRun ? `（${relativeTime(task.lastRun.replace(' ', 'T'))}）` : ''}
                      </div>
                      <div class="dim small">下次运行 ${task.nextRun ? formatClock(task.nextRun.replace(' ', 'T')) : '—'}</div>
                      <div class="dim small">间隔 ${task.interval ?? '无重复触发'} · 上次结果 ${task.lastResultText}</div>
                    </div>
                  `
                )}
              </div>
              <div class="dim small">
                这两个任务由 packaging\\windows\\1-setup.cmd 安装；停掉它们跑 uninstall-startup.cmd。
              </div>
            `
          : html`<${Empty} text="查不到计划任务" hint=${schedule?.message ?? ''} />`}
      <//>

      <${Card}
        title="追番清单"
        hint=${data?.file ? html`文件：<span class="mono">${data.file}</span>` : '还没有追番清单文件'}
        actions=${html`<button type="button" class="ghost small" onClick=${() => void load()}>刷新</button>`}
      >
        <div class="add-row">
          <input
            type="text"
            placeholder="番名（用于搜索），例如：吹响上低音号 第三季"
            value=${editing === null ? form.query : ''}
            onInput=${(event: Event) => setForm({ ...form, query: (event.target as HTMLInputElement).value })}
            disabled=${editing !== null}
          />
          <input
            type="text"
            class="narrow"
            placeholder="从第几集"
            title="只从这一集开始追，留空表示从第 1 集"
            value=${editing === null ? form.startFrom : ''}
            onInput=${(event: Event) => setForm({ ...form, startFrom: (event.target as HTMLInputElement).value })}
            disabled=${editing !== null}
          />
          <input
            type="text"
            class="narrow"
            placeholder="备注"
            value=${editing === null ? form.note : ''}
            onInput=${(event: Event) => setForm({ ...form, note: (event.target as HTMLInputElement).value })}
            disabled=${editing !== null}
          />
          <button type="button" disabled=${busy || editing !== null} onClick=${() => void submit(null)}>加入追番</button>
        </div>

        ${loading && !data ? html`<${Spinner} />` : null}
        ${error && html`<div class="banner err">${error}</div>`}

        ${data && data.entries.length === 0
          ? html`<${Empty}
              text="追番清单是空的"
              hint="加入一条之后，定时任务每 15 分钟检查一次有没有新集"
            />`
          : data &&
            html`
              <div class="table">
                <div class="table-head">
                  <span>番名</span>
                  <span>进度</span>
                  <span>备注</span>
                  <span>状态</span>
                  <span class="right">操作</span>
                </div>
                ${data.entries.map((entry) =>
                  editing === entry.query
                    ? html`
                        <div class="table-row editing">
                          <input
                            type="text"
                            value=${form.query}
                            onInput=${(event: Event) => setForm({ ...form, query: (event.target as HTMLInputElement).value })}
                          />
                          <div class="edit-inline">
                            <span class="dim small">已下到</span>
                            <input
                              type="text"
                              class="narrow"
                              placeholder="0"
                              value=${form.lastEpisode}
                              onInput=${(event: Event) => setForm({ ...form, lastEpisode: (event.target as HTMLInputElement).value })}
                            />
                            <span class="dim small">集，从</span>
                            <input
                              type="text"
                              class="narrow"
                              placeholder="1"
                              value=${form.startFrom}
                              onInput=${(event: Event) => setForm({ ...form, startFrom: (event.target as HTMLInputElement).value })}
                            />
                            <span class="dim small">集开始</span>
                          </div>
                          <input
                            type="text"
                            value=${form.note}
                            onInput=${(event: Event) => setForm({ ...form, note: (event.target as HTMLInputElement).value })}
                          />
                          <span class="dim small">改动会立刻写回 watchlist.json</span>
                          <span class="row-actions">
                            <button type="button" class="small" disabled=${busy} onClick=${() => void submit(entry.query)}>保存</button>
                            <button
                              type="button"
                              class="ghost small"
                              onClick=${() => {
                                setEditing(null);
                                setForm({ query: '', lastEpisode: '', startFrom: '', note: '' });
                              }}
                            >取消</button>
                          </span>
                        </div>
                      `
                    : html`
                        <div class=${`table-row ${entry.enabled ? '' : 'disabled'}`}>
                          <span class="ellipsis" title=${entry.query}>${entry.query}</span>
                          <span>
                            <span class="mono">${entry.lastEpisode ?? 0}</span>
                            <span class="dim small"> 集 · 下一集找第 ${entry.nextEpisode} 集</span>
                            ${entry.completedEpisodes.length > 0
                              ? html`<div class="dim small mono" title="逐集下载记录">已完成 ${compactEpisodes(entry.completedEpisodes)}</div>`
                              : null}
                          </span>
                          <span class="dim small ellipsis">${entry.note || '—'}</span>
                          <span>
                            <label class="toggle" title=${entry.enabled ? '点一下暂停追这一部' : '点一下恢复'}>
                              <input type="checkbox" checked=${entry.enabled} onChange=${() => void toggleEnabled(entry)} />
                              ${entry.enabled ? '追' : '停'}
                            </label>
                          </span>
                          <span class="row-actions">
                            <button type="button" class="ghost small" onClick=${() => startEdit(entry)}>编辑</button>
                            <button type="button" class="ghost small danger" onClick=${() => void remove(entry)}>删除</button>
                          </span>
                        </div>
                      `
                )}
              </div>
              <div class="dim small">
                改「已下到第几集」会把这些集之前逐集记录一起收拢 —— 想重下某几集，把进度往回改即可。
              </div>
            `}
      <//>

      ${planner &&
      html`
        <${Card}
          title="Bangumi Watch Planner"
          hint=${planner.ok
            ? `${planner.subjects.length} 部未看完 · 自动追番优先用它的数据`
            : `${planner.message}（连不上时自动退回上面的清单）`}
          actions=${planner.ok ? html`<a class="button ghost small" href=${planner.baseUrl} target="_blank" rel="noreferrer">打开 Planner</a>` : null}
        >
          ${planner.ok
            ? planner.subjects.length === 0
              ? html`<${Empty} text="Planner 里没有「未看完」的番剧" hint="在 Planner 页面把番剧标记为「在看」" />`
              : html`
                  <div class="table">
                    <div class="table-head">
                      <span>番剧</span>
                      <span>状态</span>
                      <span>未看</span>
                      <span>下一集</span>
                    </div>
                    ${planner.subjects.map(
                      (subject) => html`
                        <div class="table-row">
                          <span class="ellipsis" title=${subject.display}>${subject.display}</span>
                          <span><${Badge}>${subject.collectionLabel}</${Badge}></span>
                          <span class="mono">${subject.unwatched} 集</span>
                          <span class="dim small">
                            ${subject.nextEpisode
                              ? `第 ${subject.nextEpisode.ep ?? '?'} 集 · ${subject.nextEpisode.airdate} ${subject.nextEpisode.airTime ?? ''}`
                              : '—'}
                          </span>
                        </div>
                      `
                    )}
                  </div>
                `
            : html`<div class="dim small">
                检查一下 Planner 是否在那台机器上运行（浏览器打开 <span class="mono">${planner.baseUrl}</span>），
                以及「设置」里的 Planner 地址对不对。断开时追番走本地清单，不会什么都不做。
              </div>`}
        <//>
      `}

      ${data?.download.savePath
        ? html`<div class="dim small">下载落在 <span class="mono">${shortenPath(data.download.savePath, 4)}</span>，可在「设置」里改。</div>`
        : null}
    </div>
  `;
}
