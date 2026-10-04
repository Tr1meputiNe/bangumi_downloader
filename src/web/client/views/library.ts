import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { html } from '../html.js';
import { api, type LibraryEntry, type LibraryEntryDetail, type LibraryResponse, type VerifyReportView, type VerifyTaskResult } from '../api.js';
import { Badge, Card, Empty, ProgressBar, Spinner } from '../components.js';
import { formatClock, formatSize, relativeTime, shortenPath } from '../format.js';
import { notify, refreshNow, useStore } from '../store.js';

/**
 * 片库页：磁盘上到底有什么。
 *
 * 和「概览」的区别是这一页可以点进去：每一部能看文件清单，
 * 能核对「真实下完了没有」。核对这一步很关键 —— 这个下载器按断点续传设计，
 * 文件一开始就预分配到完整长度，所以**光看文件大小完全看不出进度**，
 * 一个 700MB 的 mkv 里面可能全是零。只有分片校验过的结果才算数。
 */
export function LibraryView() {
  const store = useStore();
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<LibraryEntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cleanEmpty, setCleanEmpty] = useState(false);
  const [checkPlayable, setCheckPlayable] = useState(true);
  const [addLocal, setAddLocal] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.library());
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

  // 核对任务结束时自动刷新一次列表（空壳目录可能被清掉、体积也会变）
  const verifyTask = useMemo(
    () => store.tasks.find((task) => task.kind === 'verify' && task.status === 'done' && task.result !== null) ?? null,
    [store.tasks]
  );

  useEffect(() => {
    if (!store.tasksRunning) void load();
  }, [store.tasksRunning]);

  const runningVerify = store.tasks.find((task) => task.kind === 'verify' && task.status === 'running') ?? null;

  const reportOf = useCallback(
    (entry: LibraryEntry): VerifyReportView | null => {
      const result = verifyTask?.result as VerifyTaskResult | undefined;
      if (!result?.reports) return null;
      return result.reports.find((report) => report.path === entry.path || report.name === entry.name) ?? null;
    },
    [verifyTask]
  );

  const verify = useCallback(
    async (path?: string) => {
      setBusy(true);
      try {
        await api.libraryVerify({ path, cleanEmpty, checkPlayable, addLocal });
        notify('ok', path ? `已开始核对 ${path}` : '已开始核对整个片库');
        await refreshNow();
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [cleanEmpty, checkPlayable, addLocal]
  );

  const openFolder = useCallback(async (path: string) => {
    try {
      const result = await api.open(path);
      notify('ok', result.message);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    }
  }, []);

  const toggleEntry = useCallback(
    async (entry: LibraryEntry) => {
      if (expanded === entry.path) {
        setExpanded(null);
        setDetail(null);
        return;
      }
      setExpanded(entry.path);
      setDetail(null);
      setDetailLoading(true);
      try {
        setDetail(await api.libraryEntry(entry.path));
      } catch (err) {
        notify('err', err instanceof Error ? err.message : String(err));
      } finally {
        setDetailLoading(false);
      }
    },
    [expanded]
  );

  const totals = data
    ? `${data.entries.length} 部 · ${data.totalVideos} 个视频 · ${data.totalFiles} 个文件 · ${formatSize(data.totalBytes)}`
    : '';

  return html`
    <div class="view">
      <${Card}
        title="片库"
        hint=${data ? html`<span>${totals}</span> · <span class="mono">${data.root}</span>` : '正在扫描…'}
        actions=${html`
          <button type="button" class="ghost small" onClick=${() => void load()}>刷新</button>
          <button type="button" class="ghost small" onClick=${() => void openFolder('')}>打开下载目录</button>
          <button type="button" class="small" disabled=${busy || runningVerify !== null} onClick=${() => void verify()}>
            ${runningVerify ? '核对中…' : '核对整个片库'}
          </button>
        `}
      >
        <div class="verify-options">
          <label class="pref">
            <input type="checkbox" checked=${checkPlayable} onChange=${(e: Event) => setCheckPlayable((e.target as HTMLInputElement).checked)} />
            抽检视频能不能播（慢一点，但能发现「文件大小对、内容全是零」）
          </label>
          <label class="pref">
            <input type="checkbox" checked=${cleanEmpty} onChange=${(e: Event) => setCleanEmpty((e.target as HTMLInputElement).checked)} />
            顺手删掉空壳目录（只有 0 个有效分片的才会删）
          </label>
          <label class="pref">
            <input type="checkbox" checked=${addLocal} onChange=${(e: Event) => setAddLocal((e.target as HTMLInputElement).checked)} />
            把不认识的内容登记为本地内容（你自己用别的工具下的那些）
          </label>
        </div>

        ${runningVerify &&
        html`
          <div class="verify-progress">
            <div class="job-detail">${runningVerify.progress ?? '正在核对…'}</div>
            <${ProgressBar} percent=${runningVerify.ratio === null ? null : runningVerify.ratio * 100} indeterminate=${runningVerify.ratio === null} />
          </div>
        `}

        ${verifyTask &&
        html`
          <div class="dim small">
            上次核对：${relativeTime(verifyTask.finishedAt ?? verifyTask.startedAt)}
            ${summarizeVerify(verifyTask.result)}
          </div>
        `}

        ${error && html`<div class="banner err">${error}</div>`}
        ${loading && !data ? html`<${Spinner} label="正在扫描下载目录…" />` : null}

        ${data && data.entries.length === 0
          ? html`<${Empty} text="片库里还没有内容" hint="去「下载」页搜一部番，或者在「计划」页加一条追番" />`
          : data &&
            html`
              <div class="library-list">
                ${data.entries.map((entry) => {
                  const report = reportOf(entry);
                  return html`
                    <div class=${`library-item ${expanded === entry.path ? 'open' : ''}`}>
                      <div class="library-row" onClick=${() => void toggleEntry(entry)}>
                        <span class="library-caret">${expanded === entry.path ? '▾' : '▸'}</span>
                        <span class="library-size mono">${formatSize(entry.bytes)}</span>
                        <span class="library-kind">${entry.kind === 'series' ? '剧集' : entry.kind === 'single' ? '单片' : '其他'}</span>
                        <span class="library-name" title=${entry.path}>${entry.name}</span>
                        <span class="dim small">
                          ${entry.videoCount > 1 ? `${entry.videoCount} 集` : entry.videoCount === 1 ? '1 个视频' : ''}
                          ${entry.otherCount > 0 ? ` +${entry.otherCount} 附属` : ''}
                        </span>
                        ${report ? verifyBadge(report) : null}
                        ${entry.suspectEmpty ? html`<${Badge} kind="warn">体积为 0</${Badge}>` : null}
                      </div>

                      ${expanded === entry.path &&
                      html`
                        <div class="library-detail">
                          ${detailLoading && html`<${Spinner} label="读取文件清单…" />`}
                          ${detail &&
                          html`
                            <div class="row-actions">
                              <button type="button" class="ghost small" onClick=${() => void verify(entry.path)}>核对这一项</button>
                              <button type="button" class="ghost small" onClick=${() => void openFolder(entry.path)}>在文件管理器里打开</button>
                              <span class="dim small mono">${shortenPath(entry.path, 3)}</span>
                            </div>
                            ${report && report.videoIssues.length > 0 &&
                            html`
                              <div class="banner warn">
                                <div>抽检发现这些文件可能播不了：</div>
                                <ul class="log-list small">
                                  ${report.videoIssues.map(
                                    (issue) => html`<li class="mono">${issue.file} —— ${issue.issues.join('；')}</li>`
                                  )}
                                </ul>
                              </div>
                            `}
                            <div class="sub-head">文件（${detail.fileCount}${detail.truncated ? '，只显示前 500 个' : ''}）</div>
                            <div class="file-table">
                              ${detail.files.map(
                                (file) => html`
                                  <div class="file-row">
                                    <span class="mono ellipsis" title=${file.name}>${file.name}</span>
                                    <span class="mono dim small">${formatSize(file.bytes)}</span>
                                    ${file.video ? html`<${Badge} kind="res">视频</${Badge}>` : html`<span></span>`}
                                  </div>
                                `
                              )}
                            </div>
                          `}
                        </div>
                      `}
                    </div>
                  `;
                })}
              </div>
            `}

        ${data && data.others.length > 0 &&
        html`
          <details class="others">
            <summary>下载目录下的其他内容（${data.others.length}）</summary>
            <div class="mini-list">
              ${data.others.map(
                (other) => html`
                  <div class="mini-row">
                    <span class="mono">${formatSize(other.bytes)}</span>
                    <span class="mini-name">${other.name}</span>
                    <span class="dim small">${other.files} 个文件</span>
                  </div>
                `
              )}
            </div>
          </details>
        `}
      <//>

      ${verifyTask &&
      html`
        <${Card} title="上次核对结果" hint=${`完成于 ${formatClock(verifyTask.finishedAt)}`}>
          ${verifyTable(verifyTask.result)}
        <//>
      `}
    </div>
  `;
}

function summarizeVerify(result: unknown) {
  if (typeof result !== 'object' || result === null || !('reports' in result)) return null;
  const value = result as VerifyTaskResult;
  return html`
    · 共 ${value.reports.length} 项，已下完 ${value.completeCount}，空壳 ${value.emptyCount}
    ${value.missingCount > 0 ? html` · ${value.missingCount} 项目录不存在（没下过或已清理）` : null}
    ${value.unplayableCount > 0 ? html` · <span class="warn">${value.unplayableCount} 个视频有问题</span>` : null}
    ${value.removed.length > 0 ? html` · 已清理 ${value.removed.length} 个空壳目录` : null}
  `;
}

function verifyBadge(report: VerifyReportView) {
  // 目录都不在，就别报「空壳」—— 那会让人以为下过又坏了
  if (!report.dirExists) return html`<${Badge} title=${`找不到：${report.dir}`}>找不到</${Badge}>`;

  if (report.source === 'local') {
    return report.empty
      ? html`<${Badge} kind="warn" title="目录在，但里面没有能播的内容">无内容</${Badge}>`
      : html`<${Badge} title="本地内容没有分片哈希，只能做文件层面检查">本地</${Badge}>`;
  }
  if (report.complete) return html`<${Badge} kind="ok" title="全部分片校验通过">✓ 已下完</${Badge}>`;
  // 「目录还没有」和「下过但一个分片都没成」是两回事，别混成一句
  if (report.empty) return html`<${Badge} kind="bad" title="目录在，但一个有效分片都没有">空壳</${Badge}>`;
  return html`<${Badge} kind="warn" title=${`${report.pieceDone}/${report.pieceTotal} 个分片`}>
    ${Math.round(report.ratio * 100)}%
  </${Badge}>`;
}

function verifyTable(result: unknown) {
  if (typeof result !== 'object' || result === null || !('reports' in result)) {
    return html`<${Empty} text="这次核对没有留下明细" />`;
  }
  const value = result as VerifyTaskResult;

  return html`
    <div class="table">
      <div class="table-head">
        <span>条目</span>
        <span>进度</span>
        <span>体积</span>
        <span>文件</span>
        <span>可播性</span>
      </div>
      ${value.reports.map(
        (report) => html`
          <div class="table-row">
            <span class="ellipsis" title=${report.dir}>${verifyBadge(report)} ${report.name}</span>
            <span class="mono">
              ${report.source === 'local'
                ? '—'
                : `${report.pieceDone}/${report.pieceTotal} 分片（${Math.round(report.ratio * 100)}%）`}
            </span>
            <span class="mono small">${formatSize(report.bytesDone)}${report.source === 'torrent' ? ` / ${formatSize(report.bytesTotal)}` : ''}</span>
            <span class="dim small">${report.presentFiles}${report.expectedFiles > 0 ? ` / ${report.expectedFiles}` : ''}</span>
            <span>
              ${report.videosChecked === 0
                ? html`<span class="dim small">未抽检</span>`
                : report.videosUnplayable === 0
                  ? html`<${Badge} kind="ok">${report.videosChecked} 个正常</${Badge}>`
                  : html`<${Badge} kind="bad">${report.videosUnplayable}/${report.videosChecked} 有问题</${Badge}>`}
            </span>
          </div>
        `
      )}
    </div>
  `;
}
