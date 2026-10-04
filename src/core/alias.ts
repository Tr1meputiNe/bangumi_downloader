import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../util/log.js';

const log = logger('alias');

/**
 * 搜索用的别名与季数处理。
 *
 * 起因是一个很具体的抱怨：「京吹2 一条都搜不到，京吹1 完全搜不到」。
 * 原因是 tracker 只做字面匹配，而「京吹」是中文圈的简称，几乎不会出现在发布标题里
 * （实测搜「京吹」只命中两条标题里恰好写了「京吹三」的偷跑版）。
 * 同时「吹响吧！上低音号」能搜到 60 条，但**全是第三季**，2016/2017 的一二季
 * 被新季挤到后面 —— 所以「按季过滤」也是必需的。
 *
 * 这个表是人工整理的常见简称，故意保持小而准；用户可以自己加：
 * 在数据目录放一个 aliases.json（{"简称": ["官方名", "罗马音"]}），会与内置表合并。
 */
export const BUILTIN_ALIASES: Record<string, string[]> = {
  京吹: ['吹响吧！上低音号', 'Hibike! Euphonium', '響け！ユーフォニアム'],
  小圆: ['魔法少女小圆', 'Mahou Shoujo Madoka Magica'],
  魔圆: ['魔法少女小圆', 'Mahou Shoujo Madoka Magica'],
  巨人: ['进击的巨人', 'Shingeki no Kyojin'],
  鬼灭: ['鬼灭之刃', 'Kimetsu no Yaiba'],
  咒术: ['咒术回战', 'Jujutsu Kaisen'],
  芙莉莲: ['葬送的芙莉莲', 'Sousou no Frieren'],
  孤独摇滚: ['孤独摇滚', 'Bocchi the Rock'],
  辉夜: ['辉夜大小姐想让我告白', 'Kaguya-sama wa Kokurasetai'],
  春物: ['我的青春恋爱物语果然有问题', 'Yahari Ore no Seishun'],
  推子: ['【推しの子】', 'Oshi no Ko'],
  间谍: ['SPY×FAMILY', '间谍过家家'],
  电锯人: ['链锯人', 'Chainsaw Man'],
  排球: ['排球少年', 'Haikyuu'],
  药屋: ['药屋少女的呢喃', 'Kusuriya no Hitorigoto'],
  无职: ['无职转生', 'Mushoku Tensei'],
  史莱姆: ['关于我转生变成史莱姆这档事', 'Tensei Shitara Slime Datta Ken'],
  美好世界: ['为美好的世界献上祝福', 'Kono Subarashii Sekai ni Shukufuku wo'],
  地错: ['在地下城寻求邂逅是否搞错了什么', 'Danmachi'],
  刀剑: ['刀剑神域', 'Sword Art Online'],
  火影: ['火影忍者', 'Naruto'],
  海贼: ['海贼王', 'One Piece'],
  柯南: ['名侦探柯南', 'Detective Conan'],
  高达: ['机动战士高达', 'Mobile Suit Gundam'],
  石头门: ['命运石之门', 'Steins;Gate'],
  掐脖子: ['辉夜大小姐想让我告白', 'Kaguya-sama wa Kokurasetai'],
  齐木: ['齐木楠雄的灾难', 'Saiki Kusuo no Psi-nan'],
  一拳: ['一拳超人', 'One Punch Man'],
  灵能: ['灵能百分百', 'Mob Psycho 100'],
  小埋: ['干物妹！小埋', 'Himouto! Umaru-chan']
};

/** 用户自定义别名（数据目录里的 aliases.json），与内置表合并，同名时用户优先。 */
export function loadAliases(file?: string): Record<string, string[]> {
  if (!file || !existsSync(file)) return { ...BUILTIN_ALIASES };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const merged: Record<string, string[]> = { ...BUILTIN_ALIASES };
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        merged[key] = value as string[];
      }
    }
    return merged;
  } catch (error) {
    log.warn(`aliases.json 解析失败（忽略）：${(error as Error).message}`);
    return { ...BUILTIN_ALIASES };
  }
}

/** 季数的各种写法。 */
const SEASON_PATTERNS: Array<{ re: RegExp; from: (match: RegExpExecArray) => number }> = [
  { re: /第\s*([0-9一二三四五六七八九十]+)\s*[季期部]/g, from: (m) => cnNumber(m[1] ?? '') },
  { re: /\bS(?:eason)?\s*0?([0-9]{1,2})\b/gi, from: (m) => Number(m[1]) },
  { re: /\b([0-9]{1,2})\s*(?:nd|rd|th|st)\s*season\b/gi, from: (m) => Number(m[1]) },
  { re: /\bseason\s*([0-9]{1,2})\b/gi, from: (m) => Number(m[1]) },
  { re: /([0-9]{1,2})\s*期/g, from: (m) => Number(m[1]) }
];

function cnNumber(text: string): number {
  if (/^[0-9]+$/.test(text)) return Number(text);
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (digits[text.slice(1)] ?? 0);
  if (text.endsWith('十')) return (digits[text[0] ?? ''] ?? 0) * 10;
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    return (digits[tens ?? ''] ?? 0) * 10 + (digits[ones ?? ''] ?? 0);
  }
  return digits[text] ?? 0;
}

/**
 * 从一段文字里认出季数。认不出返回 null。
 *
 * 只认显式写法（第N季/第N期/SNN/Season N/N期），**不**把结尾的裸数字当季数 ——
 * 那个更可能是集号，认错会把「S01E25」当成第 25 季。
 */
export function seasonOf(text: string): number | null {
  let found: number | null = null;
  for (const { re, from } of SEASON_PATTERNS) {
    const regex = new RegExp(re.source, re.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = from(match);
      if (value >= 1 && value <= 20) found = found === null ? value : Math.max(found, value);
    }
  }
  if (found !== null) return found;
  return bareSeason(text);
}

/**
 * 「番剧名 + 裸数字」这种季数写法：`吹响吧！上低音号 3`、`響け！ユーフォニアム 2`。
 *
 * 之所以要单独小心：裸数字也可能是**集号**。所以要求
 *   - 数字前面是「名字 + 空白」，且再前面不是 `-`（`Show - 12` 就是集号）
 *   - 数字后面是结尾或分隔符（`[`、空格、`／`…），不是紧跟着别的数字或字母（`S01E25`、`13TV`）
 *   - 只认 1~9（季度很少超过 9；两位数基本都是集号）
 */
function bareSeason(text: string): number | null {
  const re = /([^\s\-–—#E\d])\s+([1-9])(?=$|[\s[(（【／/~+,;:】)])/g;
  const match = re.exec(text);
  return match ? Number(match[2]) : null;
}

/** 把查询里的季数写法去掉，留下番剧名。 */
export function stripSeason(text: string): string {
  let result = text;
  for (const { re } of SEASON_PATTERNS) {
    result = result.replace(new RegExp(re.source, re.flags), ' ');
  }
  if (bareSeason(result) !== null) {
    result = result.replace(/([^\s\-–—#E\d])\s+([1-9])(?=$|[\s[(（【／/~+,;:】)])/g, '$1');
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * 标题属于第几季。
 *
 * 返回 null 表示「标题里没写季数」—— 这类发布多半是第一季（后续季基本都会标出来），
 * 所以在筛选时对第一季要保留、对第二季及以后要降权而不是直接丢掉。
 */
export function titleSeason(title: string): number | null {
  return seasonOf(title);
}

export type ExpandedQuery = {
  /** 真正发给 tracker 的关键词。 */
  text: string;
  /** 这条关键词是怎么来的（展示给用户看，别让搜索像个黑盒）。 */
  origin: '原样' | '别名' | '去季数' | '去季数+别名';
};

/**
 * 把用户输入的一串关键词扩展成多条。
 *
 * 例：「京吹2」→ 京吹2 / 吹响吧！上低音号 2 / Hibike! Euphonium 2 / 吹响吧！上低音号 …
 * 「吹响吧！上低音号 第二季」→ 原样 / 吹响吧！上低音号（去掉季数，因为很多发布不写季数）
 */
export function expandQueries(
  input: string,
  aliases: Record<string, string[]> = BUILTIN_ALIASES,
  limit = 6
): { queries: ExpandedQuery[]; season: number | null } {
  const trimmed = input.trim();
  if (trimmed === '') return { queries: [], season: null };

  const season = seasonOf(trimmed);
  const withoutSeason = stripSeason(trimmed);
  const seen = new Set<string>();
  const queries: ExpandedQuery[] = [];
  const push = (text: string, origin: ExpandedQuery['origin']): void => {
    const value = text.trim();
    if (value.length < 2 || seen.has(value)) return;
    seen.add(value);
    queries.push({ text: value, origin });
  };

  push(trimmed, '原样');
  // 去掉季数：多数发布标题里不一定写「第N季」
  if (withoutSeason !== trimmed && withoutSeason.length >= 2) push(withoutSeason, '去季数');

  // 别名：查询里出现某个简称就补上它的官方名
  for (const [nickname, official] of Object.entries(aliases)) {
    if (!trimmed.includes(nickname)) continue;
    // 「京吹2」这种把简称和季数拼在一起的，官方名后面也要带上季数
    const nicknameInQuery = new RegExp(`${escapeRegExp(nickname)}\\s*([0-9]{1,2})?`).exec(trimmed);
    const inlineSeason = nicknameInQuery?.[1] ? Number(nicknameInQuery[1]) : null;
    for (const name of official) {
      push(inlineSeason ? `${name} ${inlineSeason}` : name, '别名');
      push(name, '去季数+别名');
    }
  }

  return { queries: queries.slice(0, limit), season };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按季数筛掉明显不是这一季的结果。
 *
 * 规则：
 *   - 标题里的季数和目标一致      -> 保留
 *   - 标题没写季数                -> 保留（第一季基本都不写；后续季也可能省略）
 *   - 标题写的是别的季            -> 丢掉
 * 目标季为 1 时额外把「写了第二季及以后」的清掉，避免搜第一季搜出一堆第三季。
 */
export function filterBySeason<T>(items: readonly T[], season: number | null, titleOf: (item: T) => string): T[] {
  if (season === null) return [...items];
  return items.filter((item) => {
    const found = titleSeason(titleOf(item));
    return found === null || found === season;
  });
}
