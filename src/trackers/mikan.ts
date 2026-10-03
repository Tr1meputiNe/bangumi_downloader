import { fetchText } from './http.js';
import type { SearchResult } from '../anime/rank.js';
import { buildMagnet, torrentInfoHash } from '../util/bencode.js';
import { logger } from '../util/log.js';

const log = logger('mikan');

/**
 * Mikan Project 官方 RSS 搜索。
 * 它只提供 .torrent 下载直链，没有磁力链接，所以对候选结果需要下载种子文件
 * 反算出 infohash，才能和其他源统一去重。为避免每个关键词都下载几十个种子，
 * 这里限制解析数量，剩下的交给 qBittorrent 直接用 .torrent 直链下载。
 */

export type MikanRawItem = {
  title: string;
  torrentUrl: string;
  sizeBytes: number | null;
  publishedAt: string | null;
  pageUrl: string | null;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cdata(value: string): string {
  const match = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(value);
  return decodeEntities((match?.[1] ?? value).trim());
}

/** 解析 Mikan RSS。导出以便单测。 */
export function parseMikanRss(xml: string): MikanRawItem[] {
  const items: MikanRawItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1] ?? '';
    const title = cdata(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '');
    const enclosure = /<enclosure[^>]*url="([^"]+)"/.exec(block);
    const length = /<enclosure[^>]*length="(\d+)"/.exec(block);
    const guid = /<guid[^>]*>([\s\S]*?)<\/guid>/.exec(block);
    const link = /<link>([\s\S]*?)<\/link>/.exec(block);
    const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
    if (!title || !enclosure?.[1]) continue;

    const parsedLength = length?.[1] ? Number(length[1]) : Number.NaN;
    items.push({
      title,
      torrentUrl: decodeEntities(enclosure[1]),
      sizeBytes: Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : null,
      publishedAt: pubDate?.[1] ? decodeEntities(pubDate[1].trim()) : null,
      pageUrl: link?.[1] ? decodeEntities(link[1].trim()) : guid?.[1] ? decodeEntities(guid[1].trim()) : null
    });
  }
  return items;
}

export function buildMikanSearchUrl(keyword: string, base = 'https://mikanani.me'): string {
  return `${base.replace(/\/+$/, '')}/RSS/Search?searchstr=${encodeURIComponent(keyword)}`;
}

/** 下载 .torrent 并算出 infohash，失败返回 null。 */
export async function resolveTorrentMagnet(
  torrentUrl: string,
  displayName: string,
  options: { timeoutMs: number; retries: number }
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(torrentUrl, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!response.ok) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    const infoHash = torrentInfoHash(buffer);
    if (!infoHash) return null;
    return buildMagnet(infoHash, displayName);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchMikan(
  keyword: string,
  options: { maxResults: number; timeoutMs: number; retries: number; base?: string; resolveMagnet?: boolean }
): Promise<SearchResult[]> {
  const url = buildMikanSearchUrl(keyword, options.base);
  const xml = await fetchText(url, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    headers: { accept: 'application/rss+xml,application/xml,text/xml,*/*' }
  });
  if (!xml) {
    log.debug(`搜索「${keyword}」失败`);
    return [];
  }

  const items = parseMikanRss(xml).slice(0, options.maxResults);
  const results: SearchResult[] = items.map((item) => ({
    title: item.title,
    magnet: '',
    torrentUrl: item.torrentUrl,
    sizeBytes: item.sizeBytes,
    publishedAt: item.publishedAt,
    seederCount: null,
    leecherCount: null,
    tracker: 'mikan',
    provider: 'mikan',
    pageUrl: item.pageUrl ?? undefined
  }));

  // 只为前若干个候选解析 infohash，控制请求量。
  if (options.resolveMagnet !== false) {
    const limit = Math.min(results.length, 12);
    const resolved = await mapWithConcurrency(results.slice(0, limit), 4, async (item) =>
      resolveTorrentMagnet(item.torrentUrl!, item.title, options)
    );
    for (let index = 0; index < limit; index += 1) {
      const magnet = resolved[index];
      if (magnet) results[index]!.magnet = magnet;
    }
  }

  return results;
}

/** 简单的并发映射，避免一次性打太多请求。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}
