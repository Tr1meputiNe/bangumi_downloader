import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

/**
 * 读日志文件的末尾若干行。
 *
 * 为什么需要：这套东西挂在计划任务里无人值守地跑，出问题时唯一的证据就是
 * data/bangumi.log。以前只能远程登录到那台机器上翻文件；
 * 界面里能直接看，问题就变成「打开页面看一眼」。
 *
 * 只读文件末尾一块（默认 1MB）而不是整个文件：日志写满会轮转，
 * 但也可能攒到 8MB，每次都整个读进内存没有意义。
 */

export type LogLine = {
  /** 时间戳，解析不出来时为 null。 */
  time: string | null;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | null;
  /** 模块标签，例如 web / job / bittorrent。 */
  scope: string | null;
  text: string;
};

export type LogTail = {
  /** 实际读的文件路径；没有日志文件时为 null。 */
  file: string | null;
  which: 'current' | 'previous';
  exists: boolean;
  /** 文件总大小（字节）。 */
  size: number;
  /** 文件太大时只读了末尾一块。 */
  truncated: boolean;
  lines: LogLine[];
};

const LINE_PATTERN = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/;

/** 把一行日志拆成结构化字段；不是标准格式时整行作为 text。 */
export function parseLogLine(raw: string): LogLine {
  const match = LINE_PATTERN.exec(raw);
  if (!match) return { time: null, level: null, scope: null, text: raw };

  const rest = match[3] ?? '';
  const scope = /^\[([^\]]+)\]\s*(.*)$/.exec(rest);
  return {
    time: match[1] ?? null,
    level: (match[2] as LogLine['level']) ?? null,
    scope: scope?.[1] ?? null,
    text: scope ? (scope[2] ?? '') : rest
  };
}

export function readLogTail(file: string, options: { lines?: number; maxBytes?: number } = {}): LogTail {
  const wantLines = Math.min(Math.max(options.lines ?? 400, 1), 5000);
  const maxBytes = options.maxBytes ?? 1024 * 1024;

  const base: LogTail = { file, which: 'current', exists: false, size: 0, truncated: false, lines: [] };
  if (!existsSync(file)) return base;

  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return base;
  }

  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);

  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, start);
  } catch {
    return { ...base, size };
  } finally {
    if (fd !== null) closeSync(fd);
  }

  let text = buffer.toString('utf8');
  // 从文件中间开始读时，第一行多半是被截断的半个行，丢掉
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }

  const all = text.split('\n').filter((line) => line.trim() !== '');
  const tail = all.slice(-wantLines);

  return {
    file,
    which: 'current',
    exists: true,
    size,
    truncated: start > 0,
    lines: tail.map(parseLogLine)
  };
}
