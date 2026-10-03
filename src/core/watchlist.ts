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
  /** 只从这一集开始追。留空表示从第 1 集开始。 */
  startFrom?: number;
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
          startFrom: typeof item.startFrom === 'number' ? item.startFrom : undefined,
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
