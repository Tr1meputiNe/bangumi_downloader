export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function emit(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
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
