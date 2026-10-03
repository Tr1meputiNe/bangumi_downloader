import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = 'info';
let fileTarget: string | null = null;
/** 单个日志文件超过这个大小就轮转，避免无人值守跑几个月把磁盘写满。 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * 把日志同时写一份到文件。
 *
 * 为什么需要：这套东西会挂在计划任务里无人值守地跑，出问题时没有任何人在看窗口。
 * 没有文件日志，「昨天为什么没下下来」就完全无从查起 —— 第一次自动运行
 * 就是这样，跑完一轮什么都没留下。
 */
export function setLogFile(path: string): void {
  fileTarget = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    fileTarget = null;
  }
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function writeToFile(line: string): void {
  if (!fileTarget) return;
  try {
    const size = statSync(fileTarget, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_LOG_BYTES) renameSync(fileTarget, `${fileTarget}.1`);
  } catch {
    /* 轮转失败就继续追加 */
  }
  try {
    appendFileSync(fileTarget, `${line}\n`, 'utf8');
  } catch {
    /* 写不进去也不能影响主流程 */
  }
}

function emit(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
  writeToFile(line);
}

export const log = {
  debug: (message: string) => emit('debug', message),
  info: (message: string) => emit('info', message),
  warn: (message: string) => emit('warn', message),
  error: (message: string) => emit('error', message)
};

/** 带标签的日志，用于区分不同模块。 */
export function logger(scope: string) {
  return {
    debug: (message: string) => emit('debug', `[${scope}] ${message}`),
    info: (message: string) => emit('info', `[${scope}] ${message}`),
    warn: (message: string) => emit('warn', `[${scope}] ${message}`),
    error: (message: string) => emit('error', `[${scope}] ${message}`)
  };
}
