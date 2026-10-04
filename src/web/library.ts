import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { logger } from '../util/log.js';

const log = logger('library');

/**
 * 片库的「点进去看」能力：列出一个番剧文件夹里的文件、在文件管理器里定位它。
 *
 * 为什么值得做：归纳列表只能看到「某某番 8.8GB 15 集」，
 * 但真正会出问题的是「这一集到底下没下完」「字幕在哪个子目录」——
 * 那必须能看到文件层面。而这个程序跑在另一台机器上（Windows），
 * 从浏览器里没法直接开它的资源管理器，所以这里给一个服务端代劳的入口。
 */

export type LibraryFile = {
  /** 相对条目根目录的路径。 */
  name: string;
  bytes: number;
  video: boolean;
};

export type LibraryEntryDetail = {
  name: string;
  path: string;
  bytes: number;
  videoCount: number;
  otherCount: number;
  fileCount: number;
  /** 文件太多时只返回前若干个。 */
  truncated: boolean;
  files: LibraryFile[];
};

const VIDEO_PATTERN = /\.(mkv|mp4|avi|webm|m4v|mov|ts)$/i;
const MAX_FILES = 500;

/**
 * 把用户传来的相对路径限制在下载目录里。
 *
 * 这个接口会读磁盘并在文件管理器里打开目录，绝不能让 `../../` 或绝对路径
 * 指到下载目录之外去。返回 null 表示越界。
 */
export function resolveInside(savePath: string, target: string): string | null {
  const root = resolve(savePath);
  const full = isAbsolute(target) ? resolve(target) : resolve(root, target);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

export function readEntryDetail(savePath: string, relPath: string, options: { maxFiles?: number } = {}): LibraryEntryDetail | null {
  const full = resolveInside(savePath, relPath);
  if (full === null) return null;

  const maxFiles = options.maxFiles ?? MAX_FILES;
  const files: LibraryFile[] = [];
  let bytes = 0;
  let videos = 0;
  let total = 0;

  const walk = (dir: string, prefix: string): void => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = join(dir, child.name);
      const rel = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (child.isDirectory()) {
        walk(childPath, rel);
        continue;
      }
      let size = 0;
      try {
        size = statSync(childPath).size;
      } catch {
        continue;
      }
      total += 1;
      bytes += size;
      const video = VIDEO_PATTERN.test(child.name);
      if (video) videos += 1;
      if (files.length < maxFiles) files.push({ name: rel, bytes: size, video });
    }
  };

  const stats = statSync(full, { throwIfNoEntry: false });
  if (!stats) return null;

  if (stats.isDirectory()) {
    walk(full, '');
  } else {
    bytes = stats.size;
    total = 1;
    if (VIDEO_PATTERN.test(basename(full))) videos = 1;
    files.push({ name: basename(full), bytes: stats.size, video: videos === 1 });
  }

  return {
    name: basename(full),
    path: relative(resolve(savePath), full).split(sep).join('/'),
    bytes,
    videoCount: videos,
    otherCount: total - videos,
    fileCount: total,
    truncated: total > files.length,
    files
  };
}

export type OpenResult = { ok: boolean; message: string };

/**
 * 在服务器所在机器的文件管理器里打开一个路径。
 *
 * Windows 上用 explorer：目录直接打开，文件用 /select, 高亮它。
 * 注意 explorer 成功时也可能返回非 0 退出码（历史遗留行为），
 * 所以这里不看退出码，只看有没有启动失败。
 */
export function openInFileManager(target: string): Promise<OpenResult> {
  return new Promise((resolvePromise) => {
    const isFile = statSync(target, { throwIfNoEntry: false })?.isFile() === true;

    const [command, args] =
      process.platform === 'win32'
        ? isFile
          ? ['explorer.exe', [`/select,${target}`]]
          : ['explorer.exe', [target]]
        : process.platform === 'darwin'
          ? ['open', isFile ? ['-R', target] : [target]]
          : // Linux 桌面没有统一的「定位到文件」，退而求其次打开它所在的目录
            ['xdg-open', [isFile ? dirname(target) : target]];

    execFile(command, args, { windowsHide: true }, (error) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.warn(`打开文件管理器失败：找不到 ${command}`);
        resolvePromise({ ok: false, message: `这台机器上没有 ${command}，无法打开文件管理器` });
        return;
      }
      if (error) log.debug(`打开 ${target} 时 ${command} 返回：${error.message}`);
      resolvePromise({ ok: true, message: `已在文件管理器中打开：${target}` });
    });
  });
}
