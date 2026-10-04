import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../util/log.js';

const log = logger('watchlist');

/**
 * 追番清单。
 *
 * 为什么需要它：项目原本的自动追番只有一条数据来源 —— 本机 Bangumi Watch Planner
 * （127.0.0.1:3777）。那台服务跑在用户的 Mac 上，Windows 机器上根本没有，
 * 于是 `run` 模式在 Windows 上永远报「无法连接 Planner」，自动化形同虚设。
 *
 * 所以这里补一条不依赖任何外部服务的清单：一个 JSON 文件，写清楚要追哪些番、
 * 每部已经下到第几集。定时任务读它、搜新集、下新集，全在本机闭环。
 */

export type WatchEntry = {
  /** 搜索关键词，例如「吹响上低音号 第三季」。 */
  query: string;
  /** 已经下载到第几集（含）。下一轮从这里 +1 开始找。 */
  lastEpisode?: number;
  /**
   * 逐集的下完记录。
   *
   * 为什么还要这个：合集的下载经常一次下不完（跨境速度有限），
   * 而 lastEpisode 是「连续追到第几集」的语义，只能整体推进。
   * 有了这个集合，即使合集只下完了一部分、顺序还是乱的，
   * 下一轮也能准确知道「哪几集已经有了」，不去重下，也不会漏下。
   */
  completedEpisodes?: number[];
  /** 只从这一集开始追。留空表示从第 1 集开始。 */
  startFrom?: number;
  /**
   * 这部番一共多少集（正片）。
   *
   * 为什么需要：`lastEpisode` 只记「追到第几集」，没有总数时下一集就是 last+1 ——
   * 于是「第三季全 13 集、已经追到 13」会被算成「下一集 = 第 14 集」，
   * 界面上挂着一条根本不存在的第 14 集，Planner 不可用时兜底路径还会一直去找它。
   * Planner 那边的「在看」里有 eps（总集数），同步时会带过来；
   * 已经看完、不在「在看」里的番只能手填。
   */
  totalEpisodes?: number;
  /** 备注，方便自己认。 */
  note?: string;
  /** false 时暂时跳过这一条。 */
  enabled?: boolean;
};

export type Watchlist = {
  version: 1;
  entries: WatchEntry[];
};

export const WATCHLIST_FILENAME = 'watchlist.json';

export function watchlistPath(configPath?: string): string {
  if (!configPath) return resolve(process.cwd(), WATCHLIST_FILENAME);
  return resolve(dirname(configPath), WATCHLIST_FILENAME);
}

/** 读取清单。文件不存在时返回空清单（不报错，让调用方决定要不要提示）。 */
export function loadWatchlist(path: string): Watchlist {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Watchlist> & { entries?: unknown };
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return {
      version: 1,
      entries: entries
        .filter((item): item is WatchEntry => typeof item === 'object' && item !== null && typeof (item as WatchEntry).query === 'string')
        .map((item) => ({
          query: item.query,
          lastEpisode: typeof item.lastEpisode === 'number' ? item.lastEpisode : undefined,
          completedEpisodes: Array.isArray(item.completedEpisodes)
            ? item.completedEpisodes.filter((value): value is number => typeof value === 'number' && value > 0)
            : undefined,
          startFrom: typeof item.startFrom === 'number' ? item.startFrom : undefined,
          totalEpisodes: typeof item.totalEpisodes === 'number' ? item.totalEpisodes : undefined,
          note: typeof item.note === 'string' ? item.note : undefined,
          enabled: item.enabled !== false
        }))
    };
  } catch (error) {
    log.warn(`清单文件解析失败，按空清单处理：${(error as Error).message}`);
    return { version: 1, entries: [] };
  }
}

export function saveWatchlist(path: string, list: Watchlist): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

/**
 * 新增或修改一条追番。
 *
 * 界面上「改」和「加」是同一个动作（改番名相当于换一条），所以合并成一个函数：
 * 先按 originalQuery（没有就用 entry.query）找，找到就更新，找不到就追加。
 *
 * 一个刻意的行为：手工把 lastEpisode 往回改时，会把超过它的逐集记录一起删掉。
 * 否则「进度改成第 3 集」之后，completedEpisodes 里还留着 4~12 集，
 * 下一轮自动追番会认为这些都不用下 —— 用户看到的进度和实际行为就对不上了。
 */
export function upsertWatchEntry(path: string, entry: WatchEntry, originalQuery?: string): Watchlist {
  const list = loadWatchlist(path);
  const key = originalQuery ?? entry.query;
  const index = list.entries.findIndex((item) => item.query === key);

  const previous = index >= 0 ? list.entries[index] : undefined;
  const next: WatchEntry = {
    query: entry.query,
    lastEpisode: entry.lastEpisode,
    completedEpisodes: entry.completedEpisodes,
    startFrom: entry.startFrom,
    // 总集数没填就沿用原来的（别因为改个备注就把总集数抹掉）
    totalEpisodes: entry.totalEpisodes ?? previous?.totalEpisodes,
    note: entry.note,
    enabled: entry.enabled !== false
  };

  if (previous && typeof next.lastEpisode === 'number' && next.completedEpisodes === undefined) {
    const kept = (previous.completedEpisodes ?? []).filter((episode) => episode <= (next.lastEpisode as number));
    next.completedEpisodes = kept.length > 0 ? kept : undefined;
  }

  if (index >= 0) list.entries[index] = next;
  else list.entries.push(next);

  saveWatchlist(path, list);
  return list;
}

/** 删除一条追番，返回删除后的清单。 */
export function removeWatchEntry(path: string, query: string): Watchlist {
  const list = loadWatchlist(path);
  list.entries = list.entries.filter((item) => item.query !== query);
  saveWatchlist(path, list);
  return list;
}

/** 每条追番「下一集该找第几集」。界面用它显示进度。 */
export function nextEpisodeOf(entry: WatchEntry): number | null {
  const start = typeof entry.startFrom === 'number' && entry.startFrom > 0 ? entry.startFrom : 1;
  const last = typeof entry.lastEpisode === 'number' ? entry.lastEpisode : start - 1;
  const next = Math.max(last + 1, start);
  // 已知总集数且已经追满 -> 没有下一集了（别再去找不存在的第 N+1 集）
  if (typeof entry.totalEpisodes === 'number' && entry.totalEpisodes > 0 && next > entry.totalEpisodes) {
    return null;
  }
  return next;
}

/** 这一条是不是已经全部下完了（只在总集数已知时才能判断）。 */
export function isEntryComplete(entry: WatchEntry): boolean {
  if (typeof entry.totalEpisodes !== 'number' || entry.totalEpisodes <= 0) return false;
  const last = typeof entry.lastEpisode === 'number' ? entry.lastEpisode : 0;
  const done = new Set(entry.completedEpisodes ?? []);
  if (done.size > 0) {
    for (let ep = 1; ep <= entry.totalEpisodes; ep += 1) if (!done.has(ep)) return false;
    return true;
  }
  return last >= entry.totalEpisodes;
}

/**
 * 把 Planner 里「在看」的番同步进本地清单。
 *
 * 为什么要做：本地清单是 Planner 连不上时的兜底数据源，但它得靠人手工维护 ——
 * 实测那台机器上清单里只有 1 条，而 Planner 里有 8 部在看。
 * 也就是说 Planner 一挂，自动化就只剩那 1 条在追，其余 7 部静默停摆。
 *
 * 合并规则（保守，不碰用户的东西）：
 *   - 清单里已经有同名的：**原样不动**（用户的进度、备注、禁用状态优先）
 *   - 清单里没有的：补一条，`startFrom` 取「Planner 已看 + 1」，
 *     这样兜底模式追的集数和 Planner 一致（都是没看过的那几集）
 */
export function syncFromPlanner(
  path: string,
  subjects: ReadonlyArray<{ name: string; eps: number; epStatus: number; unwatched: number }>
): { added: string[]; list: Watchlist } {
  const list = loadWatchlist(path);
  const known = new Set(list.entries.map((entry) => entry.query.trim()));
  const added: string[] = [];

  /*
   * 已经存在的条目：不动用户的进度/备注/开关，但把「总集数」这个**事实字段**补上
   * （Planner 说 13 集就是 13 集）。有了它才不会出现「第 14 集」这种幻觉。
   */
  let totalsUpdated = 0;
  for (const entry of list.entries) {
    const match = subjects.find((subject) => subject.name.trim() === entry.query.trim());
    if (match && match.eps > 0 && entry.totalEpisodes !== match.eps) {
      entry.totalEpisodes = match.eps;
      totalsUpdated += 1;
    }
  }

  for (const subject of subjects) {
    const query = subject.name.trim();
    if (query === '' || known.has(query)) continue;

    const startFrom = Math.max(1, (subject.epStatus ?? 0) + 1);
    const total = subject.eps > 0 ? `共 ${subject.eps} 集` : '总集数未知';
    list.entries.push({
      query,
      startFrom,
      totalEpisodes: subject.eps > 0 ? subject.eps : undefined,
      enabled: true,
      note: `由 Watch Planner 同步（已看 ${subject.epStatus}/${total.replace('共 ', '').replace(' 集', '')}，未看 ${subject.unwatched}）`
    });
    known.add(query);
    added.push(query);
  }

  // 只有真的改了东西才写盘（补了新条目，或者给已有条目补上了总集数）
  if (added.length > 0 || totalsUpdated > 0) saveWatchlist(path, list);
  return { added, list };
}

/** 写一份示例清单，方便用户照着改。已存在时不覆盖。 */
export function ensureWatchlistExample(path: string): boolean {
  if (existsSync(path)) return false;
  saveWatchlist(path, {
    version: 1,
    entries: [
      { query: '吹响上低音号 第三季', note: '示例：改成正真在追的番名即可', enabled: false }
    ]
  });
  return true;
}

/** 更新某条目的进度。找不到就新增。 */
export function setLastEpisode(path: string, query: string, lastEpisode: number): void {
  const list = loadWatchlist(path);
  const entry = list.entries.find((item) => item.query === query);
  if (entry) entry.lastEpisode = Math.max(entry.lastEpisode ?? 0, lastEpisode);
  else list.entries.push({ query, lastEpisode });
  saveWatchlist(path, list);
}

/**
 * 记录「哪几集已经下完」，并把 lastEpisode 推进到连续完成的最远位置。
 *
 * 只标记真正下完的集：下到一半的集不记，下一轮自然还会被挑中继续下。
 */
export function markEpisodesCompleted(path: string, query: string, episodes: readonly number[]): void {
  if (episodes.length === 0) return;
  const list = loadWatchlist(path);
  let entry = list.entries.find((item) => item.query === query);
  if (!entry) {
    entry = { query };
    list.entries.push(entry);
  }

  const done = new Set([...(entry.completedEpisodes ?? []), ...episodes]);
  entry.completedEpisodes = [...done].sort((a, b) => a - b);

  // 连续完成到第几集：中间缺集就不往前推，避免把缺的那集当成下过了。
  // startFrom 缺省时必须落到 1：写成 (entry.startFrom ?? 1) > 0 ? entry.startFrom : 1
  // 会让 start 变成 undefined，consecutive 变 NaN，lastEpisode 就永远推不动。
  const startFrom = entry.startFrom;
  const start = typeof startFrom === 'number' && startFrom > 0 ? startFrom : 1;
  let consecutive = start - 1;
  for (const episode of entry.completedEpisodes) {
    if (episode <= consecutive) continue;
    if (episode === consecutive + 1) consecutive = episode;
    else break;
  }
  entry.lastEpisode = Math.max(entry.lastEpisode ?? 0, consecutive);

  saveWatchlist(path, list);
}
