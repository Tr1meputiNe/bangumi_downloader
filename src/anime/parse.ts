/**
 * 从发布名（种子标题）里解析出集号、季度、分辨率、容器、字幕语言等信息。
 * 这些发布名格式极其混乱（中日英混排、各种括号、合集区间），这里是全流程里
 * 最容易出错的一环，所以独立成模块并配有测试。
 */

export type ReleaseKind = 'single' | 'batch' | 'unknown';

export type ParsedReleaseName = {
  /** 提取到的集号（升序去重）。单个集数长度为 1；合集为区间内所有集号，区间过大时留空。 */
  episodes: number[];
  /** 合集区间下界。 */
  episodeFrom: number | null;
  /** 合集区间上界。 */
  episodeTo: number | null;
  kind: ReleaseKind;
  /** 发布名里显式写出的季度号，例如「第二季」「S02」「2nd Season」。 */
  season: number | null;
  /** 是否为总集篇 / 特别篇 / OVA 等非正片。 */
  isSpecial: boolean;
  resolution: string | null;
  container: string | null;
  subtitle: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitDepth: number | null;
  source: string | null;
  /** 字幕组 / 压制组名（第一个方括号或圆括号里的内容）。 */
  group: string | null;
};

const FULLWIDTH_DIGITS = '０１２３４５６７８９';
const CN_SIMPLE: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};

/** 「十二」「二十」「二十三」「十」等中文数字转成阿拉伯数字，其余原样返回。 */
function cnNumberToArabic(token: string): string {
  const tenIndex = token.indexOf('十');
  if (tenIndex < 0) {
    const value = CN_SIMPLE[token];
    return value === undefined ? token : String(value);
  }
  const head = token.slice(0, tenIndex);
  const tail = token.slice(tenIndex + 1);
  const tens = head === '' ? 1 : CN_SIMPLE[head];
  const ones = tail === '' ? 0 : CN_SIMPLE[tail];
  if (tens === undefined || ones === undefined) return token;
  return String(tens * 10 + ones);
}

/**
 * 把全角数字与中文数字统一成半角阿拉伯数字。
 * 用单次正则完成，避免「先替换一部分、再替换另一部分」时相互污染
 * —— 例如 十一 先被转成 11，随后单独的 十 又被替换，结果变成 1十1。
 * 这里 十 只允许作为量级标记出现在中间或结尾，不会与被转换出的阿拉伯数字冲突。
 */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[０-９]/g, (char) => String(FULLWIDTH_DIGITS.indexOf(char)))
    .replace(
      /[零〇一二两三四五六七八九]?十[零〇一二两三四五六七八九]?|[零〇一二两三四五六七八九]/g,
      (token) => cnNumberToArabic(token)
    );
}

/**
 * 季度识别。
 * 注意：不能给中文模式加 \b —— JS 正则里 \b 的边界定义基于 [A-Za-z0-9_]，
 * 而「季」「期」这类汉字属于非单词字符，`第2季\b` 永远不会匹配成功。
 * 所以中文模式直接用普通分组，英文模式才需要 \b 防止误匹配。
 */
const SEASON_RES: Array<{ re: RegExp; group: number }> = [
  { re: /\bS(\d{1,2})(?![\dA-Za-z])/i, group: 1 },
  { re: /\bSeason\s*(\d{1,2})(?![\dA-Za-z])/i, group: 1 },
  { re: /\b(\d{1,2})(?:st|nd|rd|th)\s*Season/i, group: 1 },
  { re: /(?:^|[\s[【(（])第\s*(\d{1,2})\s*(?:季|期|部|クール)/, group: 1 },
  { re: /(?:^|[\s[【(（])(\d{1,2})\s*(?:季|期|クール)/, group: 1 },
  { re: /\b(\d{1,2})(?:nd|rd|th)(?![\dA-Za-z])/i, group: 1 },
  { re: /\bPart\s*(\d{1,2})(?![\dA-Za-z])/i, group: 1 }
];

export function parseSeason(text: string): number | null {
  const normalized = normalizeDigits(text);
  for (const { re, group } of SEASON_RES) {
    const match = re.exec(normalized);
    const raw = match?.[group];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1 && value <= 20) return value;
  }
  return null;
}

type EpisodeCandidate = { number: number; index: number; specificity: number; rangeEnd?: number };

/**
 * 集号候选。specificity 越大越可信，同一位置取可信度最高的。
 * 位置更靠前的候选优先，因为集号一般出现在标题主体里而不是尾部参数中。
 */
function collectCandidates(text: string): EpisodeCandidate[] {
  const candidates: EpisodeCandidate[] = [];
  const push = (number: number, index: number, specificity: number, rangeEnd?: number) => {
    if (!Number.isFinite(number) || number < 0 || number > 3000) return;
    candidates.push({ number, index, specificity, rangeEnd });
  };

  // 中文「第01话 / 第01集 / 第01話」，最可靠
  for (const match of text.matchAll(/第\s*(\d{1,4})\s*(?:话|話|集|回|話数|话数)/g)) {
    push(Number(match[1]), match.index ?? 0, 100);
  }

  // 方括号包起来的集号： [01] [12] [01v2]
  for (const match of text.matchAll(/[[【]\s*(\d{1,3})(?:\s*[vV]\d)?\s*[\]】]/g)) {
    push(Number(match[1]), match.index ?? 0, 90);
  }

  // E01 / EP01 / #01
  for (const match of text.matchAll(/(?:^|[^A-Za-z])(?:EP?|ep?)\s*[._-]?\s*(\d{1,4})(?![0-9pPiI])/g)) {
    push(Number(match[1]), match.index ?? 0, 85);
  }
  for (const match of text.matchAll(/#(\d{1,4})(?![0-9])/g)) {
    push(Number(match[1]), match.index ?? 0, 80);
  }

  // 空格/点/下划线/短横线分隔的裸数字，要求两边是边界，避免匹配到 1080p、x265 等
  for (const match of text.matchAll(/(?:^|[\s._\-–—~])(\d{1,4})(?=[\s._\-–—~]|$)/g)) {
    const digits = match[1];
    if (!digits) continue;
    const absolute = (match.index ?? 0) + match[0].length - digits.length;
    const before = text.slice(Math.max(0, absolute - 1), absolute);
    if (/[A-Za-z0-9]/.test(before)) continue;
    push(Number(digits), absolute, 50);
  }

  return candidates;
}

/** 收集「01-12」「01~12」「第01-12话」「01-12+SP」这类区间。 */
function collectRanges(text: string): Array<{ from: number; to: number; index: number }> {
  const ranges: Array<{ from: number; to: number; index: number }> = [];
  const push = (from: number, to: number, index: number) => {
    if (from > 0 && to > from && to - from < 500) ranges.push({ from, to, index });
  };

  for (const match of text.matchAll(/第\s*(\d{1,4})\s*(?:话|話|集|回)?\s*[-~–—～]\s*(?:第\s*)?(\d{1,4})\s*(?:话|話|集|回)?/g)) {
    push(Number(match[1]), Number(match[2]), match.index ?? 0);
  }
  for (const match of text.matchAll(/[[【]\s*(\d{1,4})\s*[-~–—～]\s*(\d{1,4})(?:\s*[vV]\d)?\s*[\]】]/g)) {
    push(Number(match[1]), Number(match[2]), match.index ?? 0);
  }
  for (const match of text.matchAll(/(?:^|[\s._\-–—~/])(\d{2,4})\s*[-~–—～]\s*(\d{2,4})(?=[\s._\-–—~/+\]]|$)/g)) {
    push(Number(match[1]), Number(match[2]), match.index ?? 0);
  }
  return ranges;
}

const SPECIAL_PATTERN = /总集篇|總集篇|特别篇|特別篇|SP\b|OVA|OAD|ONA|NCOP|NCED|MENU|PV\b|CM\b|预告|預告|特典|映像特典|Bonus|Recap|総集編/i;

// 容器格式：既可能是文件名后缀（.mkv），也可能是方括号里的标签（[MP4]）
const CONTAINER_PATTERN = /\.(mkv|mp4|avi|rmvb|mov|ts|m2ts|flv|wmv)(?![A-Za-z0-9])|[[【(（]\s*(mkv|mp4|avi|rmvb|mov|flv|wmv)\s*[\]】)）]/i;

const RESOLUTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(2160p|4K|UHD)\b/i, '2160p'],
  [/\b(1440p|2K)\b/i, '1440p'],
  [/\b(1080p|FHD|1920x1080|1080i)\b/i, '1080p'],
  [/\b(720p|1280x720|HD)\b/i, '720p'],
  [/\b(576p|480p|360p|SD)\b/i, '480p']
];

const SUBTITLE_PATTERNS: Array<[RegExp, string]> = [
  [/简繁日内封|简繁内封|简繁字幕|简繁日|简繁|CHS&CHT|CHT&CHS|GB&BIG5|BIG5&GB|简\+繁|繁\+简/i, '简繁'],
  [/简日双语|简日|CHS&JPN|GB&JP/i, '简日'],
  [/繁日双语|繁日|CHT&JPN|BIG5&JP/i, '繁日'],
  [/简体内嵌|简体|简中|简字幕|CHS|GB\b|SC\b|Simplified/i, '简体'],
  [/繁体内嵌|繁体|繁中|繁字幕|CHT|BIG5|TC\b|Traditional/i, '繁体'],
  [/内封|内嵌|字幕|Sub(?:title)?s?\b|Subbed/i, '字幕']
];

const VIDEO_CODEC_PATTERNS: Array<[RegExp, string]> = [
  [/\b(HEVC|x265|H\.?265)\b/i, 'hevc'],
  [/\b(AV1|VP9)\b/i, 'av1'],
  [/\b(AVC|x264|H\.?264)\b/i, 'avc'],
  [/\b(MPEG-?2|XviD|DivX)\b/i, 'mpeg2']
];

const AUDIO_CODEC_PATTERNS: Array<[RegExp, string]> = [
  [/\b(FLAC|TrueHD|DTS-?HD|DTS-?X)\b/i, 'flac'],
  [/\b(AAC|OPUS|AC3|EAC3|DDP?)\b/i, 'aac']
];

const SOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(BDRip|BDRemux|BD|BluRay)\b/i, 'bd'],
  [/\b(WEB-?DL|WEB-?Rip|WebRip|WEB)\b/i, 'web'],
  [/\b(HDTV|TVRip|TV)\b/i, 'tv'],
  [/\b(DVDRip|DVD)\b/i, 'dvd']
];

function firstMatch(text: string, patterns: Array<[RegExp, string]>): string | null {
  for (const [pattern, value] of patterns) {
    if (pattern.test(text)) return value;
  }
  return null;
}

/** 取第一个方括号/圆括号内容当作字幕组名。 */
export function extractGroup(name: string): string | null {
  const bracket = /^\s*[[【]([^\]】]{1,40})[\]】]/.exec(name);
  if (bracket?.[1]) return bracket[1].trim();
  const paren = /^\s*[(（]([^)）]{1,40})[)）]/.exec(name);
  if (paren?.[1]) return paren[1].trim();
  return null;
}

export function parseReleaseName(rawName: string): ParsedReleaseName {
  const name = rawName.normalize('NFKC');
  const text = normalizeDigits(name);
  const ranges = collectRanges(text);
  const candidates = collectCandidates(text);

  const isSpecial = SPECIAL_PATTERN.test(text);
  const containerMatch = CONTAINER_PATTERN.exec(text);

  // 先决定集号：位置最靠前的候选优先，同位置取可信度最高者。
  candidates.sort((a, b) => a.index - b.index || b.specificity - a.specificity);
  const best = candidates[0] ?? null;

  let episodes: number[] = [];
  let episodeFrom: number | null = null;
  let episodeTo: number | null = null;
  let kind: ReleaseKind = 'unknown';

  // 找到覆盖最佳候选位置的区间，或任意一个起止都合理的区间。
  const range =
    ranges.find((item) => best && item.from === best.number) ??
    ranges.find((item) => best && Math.abs(item.index - best.index) <= 4) ??
    ranges[0] ??
    null;

  const batchHint = /合集|全集|Complete|Batch|Season\s*Pack|全話|全话|部全|\d+\s*[-~–—～]\s*\d+/i.test(text);

  if (range) {
    episodeFrom = range.from;
    episodeTo = range.to;
    kind = 'batch';
    if (range.to - range.from <= 60) {
      episodes = Array.from({ length: range.to - range.from + 1 }, (_, index) => range.from + index);
    } else if (range.from <= 3000) {
      episodes = [range.from];
    }
  } else if (best) {
    episodes = [best.number];
    kind = batchHint ? 'batch' : 'single';
  }

  if (isSpecial && kind === 'single' && !batchHint) {
    // 特别篇单独处理，不要拿去匹配正片集号
    episodes = [];
    kind = 'unknown';
  }

  return {
    episodes: episodes.filter((value) => value > 0),
    episodeFrom,
    episodeTo,
    kind,
    season: parseSeason(name),
    isSpecial,
    resolution: firstMatch(text, RESOLUTION_PATTERNS),
    container: (containerMatch?.[1] ?? containerMatch?.[2])?.toLowerCase() ?? null,
    subtitle: firstMatch(text, SUBTITLE_PATTERNS),
    videoCodec: firstMatch(text, VIDEO_CODEC_PATTERNS),
    audioCodec: firstMatch(text, AUDIO_CODEC_PATTERNS),
    bitDepth: /\b10-?bit\b/i.test(text) ? 10 : /\b8-?bit\b/i.test(text) ? 8 : null,
    source: firstMatch(text, SOURCE_PATTERNS),
    group: extractGroup(name)
  };
}

/**
 * 判断一个发布名是否覆盖目标集号。
 * 返回命中的具体集号；合集只要区间覆盖目标集号就算命中。
 */
export function matchesEpisode(parsed: ParsedReleaseName, targetEpisode: number): boolean {
  if (parsed.episodes.includes(targetEpisode)) return true;
  if (parsed.kind === 'batch' && parsed.episodeFrom !== null && parsed.episodeTo !== null) {
    return targetEpisode >= parsed.episodeFrom && targetEpisode <= parsed.episodeTo;
  }
  return false;
}

/**
 * 季度校验：只有发布名明确写了别的季度时才判定不匹配，
 * 没写季度的裸标题一律放行（很多字幕组不写季度）。
 */
export function seasonCompatible(parsed: ParsedReleaseName, targetSeason: number | null): boolean {
  if (targetSeason === null || parsed.season === null) return true;
  return parsed.season === targetSeason;
}
