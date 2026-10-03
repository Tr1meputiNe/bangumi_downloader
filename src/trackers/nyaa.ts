import { fetchBytes } from './http.js';
import type { SearchResult } from '../anime/rank.js';
import { logger } from '../util/log.js';

const log = logger('nyaa');

/**
 * Nyaa 站点搜索。
 * 用户指定的是 nyaa.land，但实测该域名在部分网络下直接返回 403，
 * 因此这里按配置的域名列表依次尝试，并把第一个可用的域名缓存下来，
 * 避免每个关键词都去撞一次被墙的域名。
 *
 * Nyaa 没有公开 JSON API，这里解析 HTML 搜索结果表格。
 * 分类 1_2 = Anime / English-translated，1_0 = 全部 Anime。
 */

const ANIME_CATEGORY = '1_2';

export type NyaaRow = {
  title: string;
  magnet: string;
  sizeText: string;
  publishedAt: string;
  seeders: number | null;
  leechers: number | null;
  pageUrl: string;
};

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, '')).trim();
}

/** 把 nyaa 的 "1.2 GiB" / "800 MiB" 转成字节。 */
export function parseSizeText(text: string): number | null {
  const match = /([\d.]+)\s*(TiB|GiB|MiB|KiB|B|TB|GB|MB|KB)/i.exec(text.replace(/\s+/g, ' '));
  if (!match?.[1] || !match[2]) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  const factor: Record<string, number> = {
    b: 1,
    kib: 1024,
    kb: 1000,
    mib: 1024 ** 2,
    mb: 1000 ** 2,
    gib: 1024 ** 3,
    gb: 1000 ** 3,
    tib: 1024 ** 4,
    tb: 1000 ** 4
  };
  return Math.round(value * (factor[unit] ?? 1));
}

/** 解析 nyaa 搜索结果页。导出以便单测。 */
export function parseNyaaHtml(html: string, baseUrl: string): NyaaRow[] {
  const rows: NyaaRow[] = [];
  for (const match of html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const attrs = match[1] ?? '';
    const block = match[2] ?? '';
    if (!/class="[^"]*default/.test(attrs) && !/class="[^"]*success/.test(attrs) && !/class="[^"]*danger/.test(attrs)) {
      // 表头行没有 data- 属性，这里只跳过明显不是数据行的
    }

    const linkMatch = /<a href="(\/view\/\d+)"[^>]*title="([^"]*)"/.exec(block) ?? /<a href="(\/view\/\d+)"[^>]*>([^<]*)<\/a>/.exec(block);
    if (!linkMatch?.[1]) continue;

    const magnetMatch = /href="(magnet:\?[^"]+)"/.exec(block);
    if (!magnetMatch?.[1]) continue;

    const cells = [...block.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1] ?? '');
    // 列顺序：分类 / 标题 / 链接(magnet,torrent) / 大小 / 日期 / 做种 / 下载中 / 完成
    const sizeCell = cells[3] ?? '';
    const dateCell = cells[4] ?? '';
    const seedersCell = cells[5] ?? '';
    const leechersCell = cells[6] ?? '';

    const seeders = Number.parseInt(stripTags(seedersCell), 10);
    const leechers = Number.parseInt(stripTags(leechersCell), 10);

    rows.push({
      title: decodeEntities(linkMatch[2] ?? '').trim(),
      magnet: decodeEntities(magnetMatch[1]),
      sizeText: stripTags(sizeCell),
      publishedAt: stripTags(dateCell),
      seeders: Number.isFinite(seeders) ? seeders : null,
      leechers: Number.isFinite(leechers) ? leechers : null,
      pageUrl: `${baseUrl.replace(/\/+$/, '')}${linkMatch[1]}`
    });
  }
  return rows;
}

export function buildNyaaSearchUrl(base: string, keyword: string, category = ANIME_CATEGORY): string {
  const params = new URLSearchParams({
    f: '0',
    c: category,
    q: keyword
  });
  return `${base.replace(/\/+$/, '')}/?${params.toString()}`;
}

/** 记录第一个可用的域名，后续关键词直接使用。 */
let preferredHost: string | null = null;

export function resetPreferredNyaaHost(): void {
  preferredHost = null;
}

export async function searchNyaa(
  keyword: string,
  options: { maxResults: number; timeoutMs: number; retries: number; hosts: string[] }
): Promise<SearchResult[]> {
  const hosts = preferredHost
    ? [preferredHost, ...options.hosts.filter((host) => host !== preferredHost)]
    : options.hosts;

  for (const host of hosts) {
    const url = buildNyaaSearchUrl(host, keyword);
    // 必须走 fetchBytes：nyaa 会返回 gzip/brotli 压缩体，
    // 用 resp.text() 会拿到乱码，导致解析不出任何一行结果。
    const bytes = await fetchBytes(url, {
      timeoutMs: options.timeoutMs,
      retries: options.retries === 0 ? 0 : 1,
      headers: { accept: 'text/html,application/xhtml+xml' }
    });
    if (!bytes) continue;
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    const rows = parseNyaaHtml(html, host);
    if (rows.length === 0) {
      // 真的是拦截页（Cloudflare 质询等）时换下一个域名
      if (/cf-error|Just a moment\.\.\.|Check your browser|Access denied|Attention Required/i.test(html)) {
        log.debug(`${host} 返回拦截页，尝试下一个域名`);
        continue;
      }
      preferredHost = host;
      return [];
    }

    if (preferredHost !== host) {
      preferredHost = host;
      log.debug(`nyaa 使用域名 ${host}`);
    }

    return rows.slice(0, options.maxResults).map((row) => ({
      title: row.title,
      magnet: row.magnet,
      sizeBytes: parseSizeText(row.sizeText),
      publishedAt: row.publishedAt,
      seederCount: row.seeders,
      leecherCount: row.leechers,
      tracker: 'nyaa',
      provider: host.replace(/^https?:\/\//, ''),
      pageUrl: row.pageUrl
    }));
  }

  log.debug(`搜索「${keyword}」在所有 nyaa 域名上都失败了`);
  return [];
}
