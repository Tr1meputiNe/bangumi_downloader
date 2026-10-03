import { fetchJson } from './http.js';
import type { SearchResult } from '../anime/rank.js';
import { logger } from '../util/log.js';

const log = logger('animes.garden');

/**
 * animes.garden 聚合搜索 API。
 * 它自己就聚合了 dmhy / mikan / nyaa 等多个站点，并且直接返回磁力链接，
 * 因此 dmhy 源通过它来获取（dmhy.org 直连在部分网络下会被重置）。
 *
 * 注意：该 API 的 provider 过滤参数并不可靠（实测带上 provider=nyaa 仍会返回 dmhy 结果），
 * 所以我们只把它当作「dmhy 镜像 + 补充源」，真正的 mikan / nyaa 走各自的官方接口。
 */

type GardenResource = {
  id: number;
  provider: string;
  providerId: string;
  title: string;
  href?: string;
  type?: string;
  magnet?: string;
  size?: number;
  createdAt?: string;
  publisher?: { id?: number; name?: string };
};

type GardenResponse = {
  status?: string;
  resources?: GardenResource[];
  pagination?: { page?: number; pageSize?: number; complete?: boolean };
};

const BASE_URL = 'https://api.animes.garden/resources';

export function buildGardenUrl(keyword: string, pageSize: number): string {
  const params = new URLSearchParams({
    search: keyword,
    page: '1',
    pageSize: String(pageSize)
  });
  return `${BASE_URL}?${params.toString()}`;
}

export function normalizeGardenResource(resource: GardenResource): SearchResult | null {
  if (!resource.title) return null;
  const magnet = resource.magnet?.trim();
  if (!magnet && !resource.href) return null;
  return {
    title: resource.title.trim(),
    magnet: magnet ?? '',
    sizeBytes: typeof resource.size === 'number' && resource.size > 0 ? resource.size : null,
    publishedAt: resource.createdAt ?? null,
    seederCount: null,
    leecherCount: null,
    tracker: 'animes.garden',
    provider: resource.provider || 'animes.garden',
    pageUrl: resource.href
  };
}

export async function searchAnimesGarden(
  keyword: string,
  options: { maxResults: number; timeoutMs: number; retries: number }
): Promise<SearchResult[]> {
  const url = buildGardenUrl(keyword, Math.max(10, Math.min(100, options.maxResults)));
  const payload = await fetchJson<GardenResponse>(url, {
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    headers: { accept: 'application/json' }
  });
  if (!payload?.resources) {
    log.debug(`搜索「${keyword}」无结果或请求失败`);
    return [];
  }
  return payload.resources
    .map(normalizeGardenResource)
    .filter((item): item is SearchResult => item !== null)
    .slice(0, options.maxResults);
}
