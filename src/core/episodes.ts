import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseReleaseName } from '../anime/parse.js';
import { monthFolder } from '../util/text.js';

/**
 * 下载前的「这一集是不是已经在磁盘上了」检查。
 *
 * 起因：用户报「会有重复下载的情况」。实测抓到的现场是 `番剧/2026_10/` 里
 * 同一个第 1 集有两份：
 *   [ANi] 偵探已經，死了。Season 2 - 01 …        （已下完，手动下的）
 *   [Dynamis One] Tantei wa Mou, Shindeiru. S2 - 01 （自动追番又下了一遍）
 *
 * 根因：自动追番的「已下过」账本只记它自己下的集（key 是 subjectId+集号），
 * 手动下的那一集它根本不知道，于是又找了一条别的发布重下。
 *
 * 做法：**下载前直接看磁盘**，而不是查「谁下过」的账本 —— 文件就在那儿，
 * 不管是谁、用什么工具下的。同一个目录里已经有「同一部番 + 同一个集号」的视频，
 * 自动追番就跳过它，手动下载则明确提示（但不拦，用户可能特意要更好的版本）。
 */

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.webm']);

/**
 * 常用繁体 → 简体对照（动漫标题里高频出现的那些）。
 *
 * 为什么需要：同一个番，Planner 里是简体名（侦探已经死了），字幕组发布用的是繁体
 * （偵探已經，死了）。不换算的话「偵探已經死了」和「侦探已经死了」只有 50% 的字重合，
 * 判不出是同一部番 —— 实测就是这么漏掉重复下载的。
 *
 * 刻意用**对照表 + 严格相等**，而不是放松相似度阈值：后者会让
 * 「魔法少女小圆」和「魔法少女奈叶」这种同前缀的番互相误判（67% 重合），
 * 一旦误判就会把该下的集当成「已经有了」跳过。
 */
const T2S_PAIRS =
  '偵侦經经這这個个們们為为與与動动學学國国会会來来時时話话說说對对開开關关麼么樣样過过還还兒儿劇剧場场聲声樂乐園园圓圆緣缘遠远醫医戰战擊击靈灵異异變变體体龍龙鳳凤飛飞馬马鳥鸟魚鱼貓猫車车軍军農农业业產产電电語语讀读書书寫写紙纸筆笔記记認认識识讓让請请謝谢誰谁無无愛爱戀恋夢梦願愿憶忆懷怀懼惧驚惊鬧闹鬥斗爭争輸输贏赢賞赏賜赐錢钱銀银鐵铁銅铜鋼钢鍊炼錄录鐘钟鏡镜陽阳陰阴雲云霧雾靜静響响頁页頭头顏颜類类風风飄飘飯饭館馆點点黨党齊齐齡龄齒齿宮宫島岛嶺岭帥帅師师帶带幫帮庫库廠厂廳厅張张彈弹強强歸归當当徹彻徑径從从復复徵征態态憲宪應应戶户執执擴扩攝摄敗败敵敌數数斷断於于曆历殺杀氣气決决沒没準准滅灭滿满潛潜澤泽濱滨災灾烏乌燈灯營营爾尔牆墙獨独獻献現现環环畢毕發发盜盗盤盘監监盡尽眾众確确祕秘禍祸禪禅積积稱称穩稳窮穷竊窃節节範范築筑簡简籌筹綻绽網网緊紧緒绪練练編编緩缓縣县總总績绩織织繪绘繼继續续罷罢羅罗聖圣聞闻聯联聰聪職职聽听肅肃腦脑臉脸臺台舊旧華华萬万著着藥药處处號号蟲虫術术衛卫裝装複复見见覺觉觀观規规視视訪访許许設设訴诉評评詞词試试詩诗詳详誌志談谈論论諦谛諾诺謀谋講讲證证譜谱議议護护貝贝貞贞負负財财責责貴贵買买費费賀贺資资賓宾賢贤賣卖質质賴赖贊赞趙赵躍跃輕轻輪轮轉转邊边邏逻郵邮鄉乡釋释釀酿錯错長长門门閉闭問问陣阵陳陈階阶際际險险隱隐雙双雜杂雞鸡離离難难韓韩順顺須须預预頌颂領领頗颇題题額额顧顾顯显驅驱驗验髮发鳴鸣鴉鸦鵝鹅鷹鹰鹽盐麥麦黃黄龜龟';

const T2S = new Map<string, string>();
for (let index = 0; index < T2S_PAIRS.length; index += 2) {
  T2S.set(T2S_PAIRS[index] as string, T2S_PAIRS[index + 1] as string);
}

/** 繁体转简体（只覆盖上表里的字，其余原样保留）。 */
function toSimplified(text: string): string {
  let out = '';
  for (const char of text) out += T2S.get(char) ?? char;
  return out;
}

/** 归一化番剧名：去掉括号/标点/空白与常见噪声词，全角转半角，转小写。 */
export function normalizeShowName(raw: string): string {
  let text = toSimplified(
    raw
      // 全角字符转半角（！？（）等标点也要转，否则两边对不上）
      .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ')
      .toLowerCase()
  );

  // 常见的季/画质/字幕噪声词：不参与「是不是同一部番」的判断
  text = text
    .replace(/\b(?:season|s)\s*\d{1,2}\b/g, ' ')
    .replace(/第\s*[0-9一二三四五六七八九十]+\s*[季期部]/g, ' ')
    .replace(/\b(?:1080p?|720p?|2160p?|bdrip|bd|web-?dl|webrip|hevc|avc|x264|x265|aac|flac|mkv|mp4)\b/g, ' ')
    .replace(/[简繁日双语内封内嵌外挂合集全集招募新番]/g, ' ');

  return text.replace(/[^0-9a-z\u3040-\u30ff\u4e00-\u9fff]+/g, '');
}

/**
 * 两个名字是不是同一部番。
 *
 * 判定（从严到宽）：完全相同 → 一个包含另一个（长度 ≥4）→
 * 短的那个有 ≥70% 的字符出现在长的那个里。
 * 最后一条是为了对付繁简/译名差异，例如
 * 「偵探已經，死了。season2」与「侦探已经死了。season2」——
 * 归一小写后字形不同但共用大量字符，能对上；而两部不同的番通常对不上。
 */
export function sameShowName(a: string, b: string): boolean {
  const left = normalizeShowName(a);
  const right = normalizeShowName(b);
  if (left.length < 2 || right.length < 2) return false;
  if (left === right) return true;

  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short.length >= 4 && long.includes(short)) return true;

  const pool = new Map<string, number>();
  for (const char of long) pool.set(char, (pool.get(char) ?? 0) + 1);
  let hit = 0;
  for (const char of short) {
    const left = pool.get(char) ?? 0;
    if (left > 0) {
      hit += 1;
      pool.set(char, left - 1);
    }
  }
  return hit / short.length >= 0.7;
}

/** 目录里已有的这一集的视频文件（只看这一层，跟下载落盘的层级一致）。 */
export function findEpisodeOnDisk(
  dir: string,
  episode: number,
  aliases: readonly string[]
): string | null {
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => {
      if (!VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) return false;
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }

  for (const name of names) {
    const parsed = parseReleaseName(name);
    if (!parsed.episodes.includes(episode)) continue;
    if (aliases.some((alias) => sameShowName(alias, name))) return name;
  }
  return null;
}

/**
 * 下载前查重：这一集是不是已经在目标目录里了。
 *
 * 会同时看「按月归档的目录」（这一集播出月份的、以及当月的）和调用方给的其它候选目录，
 * 因为归档规则改过、历史内容可能落在不同地方。
 */
export function findEpisodeAlreadyDownloaded(options: {
  savePath: string;
  seriesDir?: string;
  episode: number;
  /** 番剧的若干种叫法（Planner 的中文名、原名、清单关键词…）。 */
  aliases: readonly string[];
  /** 额外要看的目录（相对于 savePath），例如按番剧名建的目录。 */
  extraDirs?: readonly string[];
  /** 播出日期，用来算归档月份。 */
  airDate?: string | null;
}): { file: string; dir: string } | null {
  const root = options.seriesDir?.trim() ? join(options.savePath, options.seriesDir.trim()) : options.savePath;
  const dirs = new Set<string>([
    monthFolder(options.airDate ?? null),
    monthFolder(null),
    ...(options.extraDirs ?? [])
  ]);

  for (const dir of dirs) {
    const target = join(root, dir);
    const file = findEpisodeOnDisk(target, options.episode, options.aliases);
    if (file) return { file, dir: target };
  }
  return null;
}
