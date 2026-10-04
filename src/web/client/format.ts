/** 前端展示用到的小工具函数。 */

export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit <= 1 ? 0 : 1)}${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  return `${formatSize(bytesPerSecond)}/s`;
}

/** 百分比：0.1234 → 12.3% */
/**
 * 还要多久下完（小字用）。
 *
 * 说清楚几件事：
 *   - 速度是 0 时**不要瞎猜** —— 直接说「暂时没速度，估不出来」，
 *     比显示一个假的「还要 3 小时」诚实得多
 *   - 总大小未知时不估
 *   - 超过一天给「X 天 Y 小时」，别丢一个 26 小时的数字让人自己换算
 */
export function formatEta(
  remainingBytes: number | null,
  speed: number | null | undefined
): string | null {
  if (remainingBytes === null || !Number.isFinite(remainingBytes) || remainingBytes <= 0) return null;
  const rate = speed ?? 0;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const seconds = remainingBytes / rate;
  if (seconds < 60) return '不到 1 分钟';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    // 小时级别只保留整十分钟，避免「约 3 小时 47 分钟」这种假精确
    const rounded = restMinutes >= 30 ? hours + 1 : hours;
    return restMinutes >= 10 && restMinutes < 50 ? `约 ${hours} 小时 ${Math.round(restMinutes / 10) * 10} 分` : `约 ${rounded} 小时`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `约 ${days} 天 ${restHours} 小时` : `约 ${days} 天`;
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 把各种时间格式转成「3 天前」这类相对时间；解析不了就原样返回。 */
export function relativeTime(input: string | null): string {
  if (!input) return '';
  const time = Date.parse(input);
  if (Number.isNaN(time)) return input;

  const diffMs = Date.now() - time;
  const future = diffMs < 0;
  const seconds = Math.abs(diffMs) / 1000;

  const units: Array<[number, string]> = [
    [60, '秒'],
    [60, '分钟'],
    [24, '小时'],
    [30, '天'],
    [12, '个月'],
    [Number.POSITIVE_INFINITY, '年']
  ];

  let value = seconds;
  for (const [step, label] of units) {
    if (value < step) {
      const rounded = Math.max(1, Math.floor(value));
      return future ? `${rounded}${label}后` : `${rounded}${label}前`;
    }
    value /= step;
  }
  return input;
}

/** 绝对时间，紧凑到「01-02 15:04」。用于任务开始/结束时间这种需要精确的地方。 */
export function formatClock(input: string | null | undefined): string {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  const pad = (value: number) => String(value).padStart(2, '0');
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? `今天 ${clock}` : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** 两个时间点之间的耗时，例如「3 分 12 秒」。 */
export function formatElapsed(from: string | null, to: string | null = null): string {
  if (!from) return '';
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '';

  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

const TRACKER_NAMES: Record<string, string> = {
  'animes.garden': 'AnimeGarden',
  mikan: 'Mikan',
  nyaa: 'Nyaa'
};

export function shortTracker(tracker: string): string {
  return TRACKER_NAMES[tracker] ?? tracker;
}

/** 长路径在界面上要能看清是哪一层：保留末尾若干段。 */
export function shortenPath(path: string, keep = 3): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join('/')}`;
}

/** 把数字数组压成「1-13」这种写法。 */
export function compactEpisodes(episodes: readonly number[]): string {
  if (episodes.length === 0) return '';
  const sorted = [...episodes].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0] as number;
  let previous = start;

  for (const episode of sorted.slice(1)) {
    if (episode === previous + 1) {
      previous = episode;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = episode;
    previous = episode;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(',');
}
