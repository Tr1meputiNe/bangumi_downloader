/** 从中文、日文、英文混排的标题里提取可用于搜索的关键词。 */

const NOISE_TOKENS = [
  '第', '季', '期', '部', '話', '话', '集', '回',
  '字幕组', '字幕組', '汉化组', '漢化組', '压制组', '壓制組'
];

/** 去掉常见装饰性符号，把标题压成适合搜索的形式。 */
export function cleanTitle(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/[「」『』【】《》〈〉〔〕［］[\]（）()]/g, ' ')
    .replace(/[～~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 生成一个标题的搜索变体，按可信度从高到低排列。
 * 中日文标题会被整串保留；含空格的英文标题额外拆出主体部分。
 */
export function searchVariants(title: string): string[] {
  const cleaned = cleanTitle(title);
  if (cleaned === '') return [];

  const variants = new Set<string>();
  variants.add(cleaned);

  // 去掉季度后缀：「正反対な君と僕 第2期」→「正反対な君と僕」
  const withoutSeason = cleaned
    .replace(/\s*第\s*\d+\s*(?:季|期|部|クール)\s*$/i, '')
    .replace(/\s*(?:Season|Part)\s*\d+\s*$/i, '')
    .replace(/\s*S\d{1,2}\s*$/i, '')
    .trim();
  if (withoutSeason.length >= 2 && withoutSeason !== cleaned) variants.add(withoutSeason);

  // 中文名常带「第二季」后缀，同样去掉
  const withoutCnSeason = withoutSeason.replace(/\s*第[一二三四五六七八九十]+季\s*$/i, '').trim();
  if (withoutCnSeason.length >= 2 && withoutCnSeason !== withoutSeason) variants.add(withoutCnSeason);

  return [...variants].filter((value) => value.length >= 2);
}

/** 判断标题里是否含 CJK 字符（中文/日文）。 */
export function hasCjk(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(value);
}

/**
 * 优先用中文名搜索（中文字幕站命中率高），其次用原名。
 * 两个名字都返回，由调用方决定先后。
 */
export function buildQueries(nameCn: string, name: string): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const source of [nameCn, name]) {
    for (const variant of searchVariants(source)) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      queries.push(variant);
    }
  }
  return queries;
}

/** 去掉标题里可能干扰搜索的噪声词。 */
export function stripNoise(title: string): string {
  let result = title;
  for (const token of NOISE_TOKENS) {
    result = result.split(token).join(' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

/** 人类可读的体积。 */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit <= 1 ? 0 : 1)}${units[unit]}`;
}

/** 把各种输入的日期统一成 YYYY-MM-DD，失败返回 null。 */
export function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/** 当前日期，YYYY-MM-DD（本地时区）。 */
export function today(): string {
  const now = new Date();
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 日期加减天数。 */
export function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + days);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}
