import { useCallback, useMemo, useState } from 'preact/hooks';
import { html } from '../html.js';
import { api, type AutoTaskResult, type JobStatus, type JobView, type TaskView, type VerifyTaskResult } from '../api.js';
import { Badge, Card, Empty, ProgressBar } from '../components.js';
import {
  compactEpisodes,
  formatClock,
  formatElapsed,
  formatEta,
  formatSize,
  formatSpeed,
  relativeTime
} from '../format.js';
import { notify, refreshNow, useStore } from '../store.js';

const JOB_LABELS: Record<JobStatus, string> = {
  queued: '排队中',
  running: '下载中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

const JOB_BADGE: Record<JobStatus, string> = {
  queued: '',
  running: 'ok',
  paused: 'warn',
  completed: 'ok',
  failed: 'bad',
  cancelled: ''
};

type Filter = 'all' | 'active' | 'finished' | 'failed';

/**
 * 任务页。
 *
 * 两类东西放在一起，因为它们都是「点了之后要等」的操作：
 *   - 下载任务：有进度条、peer 数、能暂停续传（JobQueue）
 *   - 后台任务：核对片库、跑一轮追番（TaskRunner）
 * 以前这些只存在于终端输出里，关掉窗口就什么都不知道了。
 */
export function JobsView() {
  const store = useStore();
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onJobAction = useCallback(async (job: JobView, action: 'pause' | 'resume' | 'cancel') => {
    try {
      await api.jobAction(job.id, action);
      notify('info', `${JOB_LABELS[job.status]} → ${action === 'pause' ? '已暂停' : action === 'resume' ? '已继续' : '已取消'}`);
      await refreshNow();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const clearFinished = useCallback(async () => {
    setBusy(true);
    try {
      const result = await api.jobsClear();
      notify(result.removed > 0 ? 'ok' : 'info', result.removed > 0 ? `已清理 ${result.removed} 条记录` : '没有已结束的任务');
      await refreshNow();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const cancelTask = useCallback(async (task: TaskView) => {
    try {
      await api.taskCancel(task.id);
      notify('info', '已请求取消，会在下一个检查点停下');
      await refreshNow();
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const jobs = useMemo(() => {
    return store.jobs.filter((job) => {
      if (filter === 'active') return job.status === 'running' || job.status === 'queued' || job.status === 'paused';
      if (filter === 'finished') return job.status === 'completed';
      if (filter === 'failed') return job.status === 'failed' || job.status === 'cancelled';
      return true;
    });
  }, [store.jobs, filter]);

  const finishedCount = store.counts.completed + store.counts.failed + store.counts.cancelled;

  return html`
    <div class="view">
      ${store.auto && (store.auto.running || store.auto.activity)
        ? html`
            <div class=${`job auto-banner ${store.auto.running ? 'running' : ''}`}>
              <div class="job-line">
                <${Badge} kind=${store.auto.running ? 'ok' : ''}>自动追番</${Badge}>
                <span class="job-title">${store.auto.activity ?? '正在下载'}</span>
                ${store.auto.running ? html`<span class="job-eta">（计划任务进程，进度见下面的条目）</span>` : null}
              </div>
              <div class="job-detail">
                计划任务触发的那个进程在跑，下载走的是它自己的候选回退逻辑，不经过这个队列 ——
                所以这里只能看，暂停/取消请到「计划」页操作。
              </div>
            </div>
          `
        : null}

      <${Card}
        title="下载任务"
        hint="同一时间只跑一个：同时下多个会互相抢带宽，进度也更难看懂"
        actions=${html`
          <div class="chips">
            ${(
              [
                ['all', `全部 ${store.jobs.length}`],
                ['active', `进行中 ${store.counts.running + store.counts.queued + store.counts.paused}`],
                ['finished', `已完成 ${store.counts.completed}`],
                ['failed', `失败/取消 ${store.counts.failed + store.counts.cancelled}`]
              ] as Array<[Filter, string]>
            ).map(
              ([value, label]) => html`
                <button type="button" class=${`chip ${filter === value ? 'active' : ''}`} onClick=${() => setFilter(value)}>${label}</button>
              `
            )}
          </div>
          <button type="button" class="ghost small" disabled=${busy || finishedCount === 0} onClick=${clearFinished}>
            清理已结束
          </button>
        `}
      >
        ${store.jobs.length === 0
          ? html`<${Empty} text="还没有下载任务" hint="去「下载」页搜一部番试试" />`
          : jobs.length === 0
            ? html`<${Empty} text="当前筛选下没有任务" />`
            : html`
                <div class="job-list">
                  ${jobs.map(
                    (job) => html`
                      <${JobRow}
                        key=${job.id}
                        job=${job}
                        expanded=${expanded.has(job.id)}
                        onToggle=${() => toggle(job.id)}
                        onAction=${onJobAction}
                      />
                    `
                  )}
                </div>
              `}
      <//>

      ${store.tasks.length > 0 &&
      html`
        <${Card} title="后台任务" hint="核对片库、立即追番这类操作；它们不做断点续传，但同样可以取消">
          <div class="job-list">
            ${store.tasks.map(
              (task) => html`
                <${TaskRow}
                  key=${task.id}
                  task=${task}
                  expanded=${expanded.has(task.id)}
                  onToggle=${() => toggle(task.id)}
                  onCancel=${() => void cancelTask(task)}
                />
              `
            )}
          </div>
        <//>
      `}
    </div>
  `;
}

function JobRow({
  job,
  expanded,
  onToggle,
  onAction
}: {
  job: JobView;
  expanded: boolean;
  onToggle: () => void;
  onAction: (job: JobView, action: 'pause' | 'resume' | 'cancel') => void;
}) {
  const detail: string[] = [];
  if (job.downloadedBytes > 0) {
    detail.push(
      job.totalBytes !== null && job.totalBytes > 0
        ? `${formatSize(job.downloadedBytes)} / ${formatSize(job.totalBytes)}`
        : formatSize(job.downloadedBytes)
    );
  }
  detail.push(...[formatSpeed(job.speed), job.peers > 0 ? `${job.peers} 个 peer` : ''].filter((item) => item !== ''));
  if (job.episodes.length > 0) detail.push(`只下第 ${compactEpisodes(job.episodes)} 集`);
  if (job.source === 'auto') detail.push('自动追番');

  /*
   * 「还要多久」：进度过半、有速度、总大小已知时才算。
   * 速度是 0（比如刚连上、或者 peer 都不给数据）时明说估不出来，
   * 不显示一个凭空的数字。
   */
  const remaining =
    job.totalBytes !== null && job.totalBytes > 0 ? job.totalBytes - job.downloadedBytes : null;
  const eta = job.status === 'running' ? formatEta(remaining, job.speed) : null;
  const etaText =
    job.status !== 'running' || remaining === null || remaining <= 0
      ? null
      : eta ?? (job.downloadedBytes > 0 ? '暂时没速度，估不出还要多久' : null);

  return html`
    <div class=${`job ${job.status}`}>
      <div class="job-line">
        <${Badge} kind=${JOB_BADGE[job.status]}>${JOB_LABELS[job.status]}</${Badge}>
        ${job.source === 'auto' ? html`<${Badge}>自动</${Badge}>` : null}
        <span class="job-title" title=${job.title}>${job.title}</span>
        ${job.percent !== null && (job.status === 'running' || job.status === 'paused') &&
        html`<span class="job-percent">${job.percent.toFixed(1)}%</span>`}
        ${etaText ? html`<span class="job-eta" title="按当前速度估算">还要 ${etaText.replace(/^约 /, '').replace(/^暂时没速度.*$/, '暂时没速度')}</span>` : null}
        <span class="job-actions">
          <button type="button" class="icon" title="详情" aria-label="详情" onClick=${onToggle}>${expanded ? '▾' : '▸'}</button>
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

      ${(job.status === 'running' || job.status === 'paused') &&
      html`<${ProgressBar} percent=${job.percent} indeterminate=${job.percent === null && job.status === 'running'} />`}

      <div class="job-detail dim small">
        ${detail.join(' · ')}
        ${job.startedAt ? ` · 开始 ${formatClock(job.startedAt)}` : ''}
        ${job.status === 'running' && job.startedAt ? ` · 已跑 ${formatElapsed(job.startedAt)}` : ''}
        ${job.finishedAt ? ` · 结束 ${formatClock(job.finishedAt)}（${formatElapsed(job.startedAt, job.finishedAt)}）` : ''}
      </div>

      ${job.error && html`<div class="job-error">${job.error}</div>`}

      ${expanded &&
      html`
        <div class="job-extra">
          ${job.files.length > 0 &&
          html`
            <div class="sub-head">落盘文件（${job.files.length}）</div>
            <ul class="file-list mono small">${job.files.slice(0, 60).map((file) => html`<li>${file}</li>`)}</ul>
          `}
          <div class="sub-head">过程记录</div>
          ${job.messages.length === 0
            ? html`<div class="dim small">暂无记录</div>`
            : html`<ul class="log-list small mono">${job.messages.slice(-30).map((line) => html`<li>${line}</li>`)}</ul>`}
          <div class="dim small">任务号 ${job.id} · 后端 ${job.backend}</div>
        </div>
      `}
    </div>
  `;
}

function TaskRow({
  task,
  expanded,
  onToggle,
  onCancel
}: {
  task: TaskView;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const statusBadge = task.status === 'done' ? 'ok' : task.status === 'failed' ? 'bad' : task.status === 'running' ? 'ok' : '';
  const statusLabel =
    task.status === 'done' ? '已完成' : task.status === 'failed' ? '失败' : task.status === 'running' ? '进行中' : '已取消';

  return html`
    <div class=${`job task ${task.status}`}>
      <div class="job-line">
        <${Badge} kind=${statusBadge}>${statusLabel}</${Badge}>
        <span class="job-title">${task.title}</span>
        ${task.ratio !== null && task.status === 'running' && html`<span class="job-percent">${(task.ratio * 100).toFixed(0)}%</span>`}
        <span class="job-actions">
          <button type="button" class="icon" title="详情" aria-label="详情" onClick=${onToggle}>${expanded ? '▾' : '▸'}</button>
          ${task.status === 'running' &&
          html`<button type="button" class="icon danger" title="取消" aria-label="取消" onClick=${onCancel}>✕</button>`}
        </span>
      </div>

      ${task.status === 'running' &&
      html`<${ProgressBar} percent=${task.ratio === null ? null : task.ratio * 100} indeterminate=${task.ratio === null} />`}

      <div class="job-detail dim small">
        ${task.progress ?? ''}
        ${task.startedAt ? ` · 开始 ${formatClock(task.startedAt)}` : ''}
        ${task.finishedAt ? ` · 结束 ${formatClock(task.finishedAt)}（${formatElapsed(task.startedAt, task.finishedAt)}）` : ''}
      </div>

      ${task.error && html`<div class="job-error">${task.error}</div>`}

      ${!expanded && task.result !== null ? html`<div class="job-detail small">${summarizeResult(task)}</div>` : null}

      ${expanded &&
      html`
        <div class="job-extra">
          ${task.result !== null && html`<div class="sub-head">结果</div>`}
          ${task.result !== null && html`<div class="small">${summarizeResult(task)}</div>`}
          <div class="sub-head">过程记录</div>
          ${task.lines.length === 0
            ? html`<div class="dim small">暂无记录</div>`
            : html`<ul class="log-list small mono">${task.lines.map((line) => html`<li>${line}</li>`)}</ul>`}
        </div>
      `}
    </div>
  `;
}

function isVerifyResult(value: unknown): value is VerifyTaskResult {
  return typeof value === 'object' && value !== null && 'reports' in value && 'completeCount' in value;
}

function isAutoResult(value: unknown): value is AutoTaskResult {
  return typeof value === 'object' && value !== null && 'downloaded' in value && 'source' in value;
}

function summarizeResult(task: TaskView) {
  if (task.kind === 'verify' && isVerifyResult(task.result)) {
    const result = task.result;
    return html`
      核对 ${result.reports.length} 项：已下完 ${result.completeCount}，空壳 ${result.emptyCount}，
      可播性抽检有问题 ${result.unplayableCount} 个
      ${result.removed.length > 0 ? html` · 已清理 ${result.removed.length} 个空壳目录` : null}
      <a class="linklike" href="#/library">去片库看明细</a>
    `;
  }

  if (task.kind === 'auto' && isAutoResult(task.result)) {
    const result = task.result;
    return html`
      数据来源 ${result.source === 'planner' ? 'Planner' : '本地清单'}：检查 ${result.checked} 条，
      新下载 ${result.downloaded.length} 条${result.dryRun ? '（试跑，未真正下载）' : ''}
      ${result.downloaded.length > 0
        ? html` · ${result.downloaded.map((item) => `${item.query}(${item.files} 文件)`).join('、')}`
        : null}
      ${result.skipped.length > 0 ? html` · 跳过 ${result.skipped.length} 条` : null}
    `;
  }

  if (task.result === null) return null;
  return html`<span class="mono small">${JSON.stringify(task.result).slice(0, 240)}</span>`;
}

/** 给「最近完成的任务」用的相对时间文案。 */
export function taskWhen(task: TaskView): string {
  return relativeTime(task.finishedAt ?? task.startedAt);
}
