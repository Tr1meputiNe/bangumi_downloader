import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatSize } from '../util/text.js';
import { logger } from '../util/log.js';

const log = logger('summary');

/**
 * 下载库总览。
 *
 * 为什么单独做这一步：`verify` 是逐条排查用的（某一条到底下完没有、能不能播），
 * 条目一多就淹没在细节里。日常真正想知道的其实是一句话：
 * 「我现在有什么、共多少、哪些还没下完」—— 这就是归纳。
 *
 * 输出按「番剧 → 集数/条数 → 体积 → 状态」聚合，一眼能看完整个库。
 */

export type LibraryEntry = {
  /** 番剧文件夹名（或散落的单集文件名）。 */
  name: string;
  /** 相对下载目录的路径。 */
  path: string;
  /** 视频文件数。 */
  videoCount: number;
  /** 其他文件数（字幕、字体、扫描图等）。 */
  otherCount: number;
  /** 名义总大小。 */
  bytes: number;
  kind: 'series' | 'single' | 'unknown';
  /** 有没有「一个有效分片都没有」的空壳特征（用于提示）。 */
  suspectEmpty: boolean;
};

export type LibrarySummary = {
  root: string;
  /** 番剧文件夹所在的父目录（例如 savePath/番剧）。 */
  seriesRoot: string | null;
  entries: LibraryEntry[];
  totalBytes: number;
  totalVideos: number;
  totalFiles: number;
  /** 其他顶层内容（程序目录、缓存等）。 */
  others: Array<{ name: string; bytes: number; files: number }>;
};

export type SummaryOptions = {
  savePath: string;
  /** 番剧文件夹的父目录名（config.download.seriesDir）。 */
  seriesDir?: string;
  /** 扫描时要跳过的目录名。 */
  ignoreDirs?: readonly string[];
};

export function collectLibrary(options: SummaryOptions): LibrarySummary {
  const root = options.savePath;
  const seriesDirName = options.seriesDir?.trim() || null;
  const ignore = new Set([...(options.ignoreDirs ?? []), '.bangumi-meta']);

  const summary: LibrarySummary = {
    root,
    seriesRoot: seriesDirName && existsSync(join(root, seriesDirName)) ? join(root, seriesDirName) : null,
    entries: [],
    totalBytes: 0,
    totalVideos: 0,
    totalFiles: 0,
    others: []
  };

  if (!existsSync(root)) return summary;

  // 内容从哪扫：优先 seriesDir，其次根目录（兼容没启用归纳的旧布局）
  const contentDirs = summary.seriesRoot
    ? [{ dir: summary.seriesRoot, prefix: '' }]
    : readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !ignore.has(entry.name))
        .map((entry) => ({ dir: join(root, entry.name), prefix: '' }));

  for (const { dir } of contentDirs) {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      if (ignore.has(child.name)) continue;
      const full = join(dir, child.name);

      if (child.isDirectory()) {
        const stats = walk(full);
        if (stats.files === 0) continue;
        summary.entries.push({
          name: child.name,
          path: full.slice(root.length + 1),
          videoCount: stats.videos,
          otherCount: stats.files - stats.videos,
          bytes: stats.bytes,
          kind: stats.videos > 1 ? 'series' : stats.videos === 1 ? 'single' : 'unknown',
          suspectEmpty: stats.videos > 0 && stats.bytes === 0
        });
      } else if (isVideo(child.name)) {
        // 散落在目录里的单集（旧布局或手动放的）
        let bytes = 0;
        try {
          bytes = statSync(full).size;
        } catch {
          /* 忽略 */
        }
        summary.entries.push({
          name: child.name,
          path: full.slice(root.length + 1),
          videoCount: 1,
          otherCount: 0,
          bytes,
          kind: 'single',
          suspectEmpty: false
        });
      }
    }
  }

  for (const entry of summary.entries) {
    summary.totalBytes += entry.bytes;
    summary.totalVideos += entry.videoCount;
    summary.totalFiles += entry.videoCount + entry.otherCount;
  }

  // 根目录下不属于「内容」的东西（程序目录、缓存等），单独列出来
  if (summary.seriesRoot) {
    for (const child of readdirSync(root, { withFileTypes: true })) {
      if (child.name === seriesDirName) continue;
      const full = join(root, child.name);
      const stats = child.isDirectory() ? walk(full) : fileStats(full);
      summary.others.push({ name: child.name, bytes: stats.bytes, files: stats.files });
    }
  }

  return summary;
}

/**
 * 打印归纳结果。
 *
 * 刻意**不做列对齐**：终端里中英混排的显示宽度本来就无法可靠计算
 * （同一个字符在不同字体/终端下可能是 1 格也可能 2 格），
 * 硬凑出来的表格只会错位得更难看。所以改成「每部一行、字段紧凑跟在后面」，
 * 不管什么终端都不会歪。
 */
export function printLibrarySummary(summary: LibrarySummary): void {
  const out = (line: string) => process.stdout.write(`${line}\n`);

  log.info(`下载库：${summary.root}`);
  if (summary.seriesRoot) log.info(`番剧目录：${summary.seriesRoot}`);

  if (summary.entries.length === 0) {
    log.info('（还没有下载内容）');
    return;
  }

  // 按体积从大到小：大的通常也是最近在追的
  const sorted = [...summary.entries].sort((a, b) => b.bytes - a.bytes);

  out('');
  out(`共 ${summary.entries.length} 部 · ${summary.totalVideos} 个视频 · ${formatSize(summary.totalBytes)}`);
  out('');

  for (const entry of sorted) {
    const size = formatSize(entry.bytes).padStart(8);
    const kind = entry.kind === 'series' ? '剧集' : entry.kind === 'single' ? '单片' : '其他';
    const parts: string[] = [];
    if (entry.videoCount > 1) parts.push(`${entry.videoCount} 集`);
    else if (entry.videoCount === 1) parts.push('1 个视频');
    if (entry.otherCount > 0) parts.push(`+${entry.otherCount} 附属`);
    const flag = entry.suspectEmpty ? '⚠ ' : '  ';
    out(`${flag}${size}  ${kind}  ${entry.name}`);
    if (parts.length > 0) out(`              ${parts.join(' ')}`);
  }

  if (summary.others.length > 0) {
    out('');
    out('根目录下的其他内容（不属于番剧）：');
    for (const other of summary.others) {
      out(`  ${formatSize(other.bytes).padStart(8)}  ${other.files} 个文件  ${other.name}`);
    }
  }

  const suspect = sorted.filter((entry) => entry.suspectEmpty);
  if (suspect.length > 0) {
    out('');
    log.warn(`有 ${suspect.length} 项名义大小为空，建议跑 verify 核对`);
  }
}

function isVideo(name: string): boolean {
  return /\.(mkv|mp4|avi|webm|m4v|mov)$/i.test(name);
}

function fileStats(path: string): { files: number; videos: number; bytes: number } {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { files: 0, videos: 0, bytes: 0 };
    return { files: 1, videos: 0, bytes: st.size };
  } catch {
    return { files: 0, videos: 0, bytes: 0 };
  }
}

function walk(dir: string): { files: number; videos: number; bytes: number } {
  let files = 0;
  let videos = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const st = statSync(full);
        files += 1;
        bytes += st.size;
        if (isVideo(entry.name)) videos += 1;
      } catch {
        /* 忽略读不到的 */
      }
    }
  }
  return { files, videos, bytes };
}
