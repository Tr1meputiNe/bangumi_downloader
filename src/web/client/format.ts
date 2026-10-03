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

const TRACKER_NAMES: Record<string, string> = {
  'animes.garden': 'AnimeGarden',
  mikan: 'Mikan',
  nyaa: 'Nyaa'
};

export function shortTracker(tracker: string): string {
  return TRACKER_NAMES[tracker] ?? tracker;
}
