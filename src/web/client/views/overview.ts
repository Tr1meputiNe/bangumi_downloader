import { useCallback, useEffect, useState } from 'preact/hooks';
import { html } from '../html.js';
import { api, type OverviewResponse } from '../api.js';
import { Badge, Card, Empty, ProgressBar, Spinner, StatusDot } from '../components.js';
import { formatClock, formatElapsed, formatSize, formatSpeed, relativeTime, shortenPath } from '../format.js';
import { notify, refreshNow, useStore } from '../store.js';

/**
 * 概览页。
 *
 * 回答的是「现在什么情况」：后端能不能下、库里有什么、追番追到哪、
 * 计划任务还活着吗、有没有正在跑的东西。以前这些信息分散在
 * 命令行、日志文件、Windows 任务计划程序三个地方，现在一屏看完。
 */
export function OverviewView() {
  const store = useStore();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview(await api.overview());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 概览里的数字跟着任务状态变，所以任务结束时重拉一次
  }, [store.jobsRunning, store.tasksRunning, store.jobs.length]);

  const runAuto = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      try {
        await api.autoRun(dryRun);
        notify('ok', dryRun ? '已经开始试跑，进度见下方' : '已开始追番，进度见下方');
        await refreshNow();
        setTimeout(() => void load(), 1500);
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const active = store.jobs.find((job) => job.status === 'running') ?? null;
  const runningTask = store.tasks.find((task) => task.status === 'running') ?? null;
  const schedule = overview?.schedule;
  const planner = overview?.planner;

  return html`
    <div class="view">
      <div class="cards">
        <${Card} title="运行状态" className="stat">
          <div class="stat-line">
            <${StatusDot} ok=${store.online && (store.status?.qbittorrent ?? '') === 'ok'} />
            <strong>${store.status?.backendLabel ?? '…'}</strong>
            <span class="dim">v${store.status?.version ?? '…'}</span>
          </div>
          <div class="dim small">${store.status?.message ?? '正在检查…'}</div>
          <div class="dim small mono">${shortenPath(store.status?.savePath ?? '', 3)}</div>
        <//>

        <${Card} title="片库" className="stat">
          ${overview
            ? html`
                <div class="stat-line">
                  <strong>${overview.library.entries}</strong><span class="dim">部</span>
                  <strong>${overview.library.videos}</strong><span class="dim">个视频</span>
                </div>
                <div class="stat-line big">${formatSize(overview.library.bytes)}</div>
                <div class="dim small mono">${shortenPath(overview.library.root, 2)}</div>
              `
            : html`<${Spinner} />`}
        <//>

        <${Card} title="追番清单" className="stat">
          ${overview
            ? html`
                <div class="stat-line">
                  <strong>${overview.watchlist.total}</strong><span class="dim">条</span>
                  <span class="dim">· 启用 ${overview.watchlist.enabled}</span>
                </div>
                <div class="dim small">
                  ${overview.watchlist.entries.length === 0
                    ? '还没有追番条目'
                    : overview.watchlist.entries
                        .slice(0, 3)
                        .map((entry) => `${entry.query} → 第 ${entry.nextEpisode} 集`)
                        .join('、')}
                </div>
                ${overview.autoSchedule.running
                  ? html`<div class="small">
                      正在下载 ${(overview.autoSchedule.running.ratio * 100).toFixed(0)}%
                      ${overview.autoSchedule.running.speed > 0 ? ` · ${formatSpeed(overview.autoSchedule.running.speed)}` : ''}
                    </div>`
                  : html`<div class="dim small" title=${overview.autoSchedule.nextReason}>
                      下次检查：${overview.autoSchedule.nextCheckText}
                      ${overview.autoSchedule.windows > 0 ? ` · 正在等片源 ${overview.autoSchedule.windows} 集` : ''}
                    </div>`}
              `
            : html`<${Spinner} />`}
          <div class="stat-actions">
            <button type="button" class="ghost small" disabled=${busy} onClick=${() => void runAuto(false)}>立即追番</button>
            <button type="button" class="ghost small" disabled=${busy} onClick=${() => void runAuto(true)}>试跑</button>
          </div>
        <//>

        <${Card} title="计划任务" className="stat">
          ${schedule === undefined
            ? html`<${Spinner} />`
            : schedule.ok
              ? html`
                  ${schedule.tasks.map(
                    (task) => html`
                      <div class="stat-line">
                        <${StatusDot} ok=${task.state === 'Ready' || task.state === 'Running'} />
                        <strong class="small">${task.name}</strong>
                        <${Badge} kind=${task.state === 'Running' ? 'ok' : ''}>${task.state}</${Badge}>
                      </div>
                      <div class="dim small">
                        下次 ${task.nextRun ? formatClock(task.nextRun.replace(' ', 'T')) : '—'} ·
                        ${task.interval ?? '无重复'} · ${task.lastResultText}
                      </div>
                    `
                  )}
                `
              : html`<div class="dim small">${schedule.message}</div>`}
        <//>
      </div>

      ${active &&
      html`
        <${Card}
          title="正在下载"
          hint=${`开始于 ${formatClock(active.startedAt)} · 已跑 ${formatElapsed(active.startedAt)}`}
          actions=${html`<a class="button ghost small" href="#/jobs">看任务详情</a>`}
        >
          <div class="job-title-line">${active.title}</div>
          <${ProgressBar} percent=${active.percent} indeterminate=${active.percent === null} />
          <div class="dim small">
            ${active.percent !== null ? `${active.percent.toFixed(1)}% · ` : ''}
            ${formatSize(active.downloadedBytes)}${active.totalBytes ? ` / ${formatSize(active.totalBytes)}` : ''}
            ${active.speed > 0 ? ` · ${formatSpeed(active.speed)}` : ''}
            ${active.peers > 0 ? ` · ${active.peers} 个 peer` : ''}
          </div>
        <//>
      `}

      ${runningTask &&
      html`
        <${Card} title=${runningTask.title} hint=${runningTask.progress ?? '正在处理…'}>
          <${ProgressBar} percent=${runningTask.ratio === null ? null : runningTask.ratio * 100} indeterminate=${runningTask.ratio === null} />
        <//>
      `}

      ${error && html`<div class="banner err">读取总览失败：${error}</div>`}
      ${loading && !overview && html`<${Card}>${html`<${Spinner} label="正在汇总…" />`}<//>`}

      ${planner &&
      html`
        <${Card}
          title="Bangumi Watch Planner"
          hint=${planner.ok ? `${planner.subjects.length} 部未看完的番剧 · 数据来自 ${planner.baseUrl}` : planner.message}
        >
          ${planner.ok
            ? planner.subjects.length === 0
              ? html`<${Empty} text="Planner 里没有「未看完」的番剧" />`
              : html`
                  <div class="mini-list">
                    ${planner.subjects.slice(0, 8).map(
                      (subject) => html`
                        <div class="mini-row">
                          <span class="mini-name">${subject.display}</span>
                          <${Badge} kind=${subject.unwatched > 0 ? 'warn' : ''}>${subject.collectionLabel}</${Badge}>
                          <span class="dim small">未看 ${subject.unwatched} 集</span>
                          <span class="dim small">
                            ${subject.nextEpisode
                              ? `下一集 ${subject.nextEpisode.ep ?? '?'} · ${subject.nextEpisode.airdate} ${subject.nextEpisode.airTime ?? ''}`
                              : ''}
                          </span>
                        </div>
                      `
                    )}
                  </div>
                `
            : html`<div class="dim small">连不上时自动追番会退回本地清单（watchlist.json），不会什么都不做。</div>`}
        <//>
      `}

      ${store.tasks.some((task) => task.status !== 'running') &&
      html`
        <${Card} title="最近的后台任务" actions=${html`<a class="button ghost small" href="#/jobs">全部</a>`}>
          <div class="mini-list">
            ${store.tasks
              .filter((task) => task.status !== 'running')
              .slice(0, 5)
              .map(
                (task) => html`
                  <div class="mini-row">
                    <${Badge} kind=${task.status === 'done' ? 'ok' : task.status === 'failed' ? 'bad' : ''}>${task.status}</${Badge}>
                    <span class="mini-name">${task.title}</span>
                    <span class="dim small">${relativeTime(task.finishedAt ?? task.startedAt)}</span>
                  </div>
                `
              )}
          </div>
        <//>
      `}
    </div>
  `;
}
