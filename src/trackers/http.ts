import { logger } from '../util/log.js';

const log = logger('http');

const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7'
};

export type FetchOptions = {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: BodyInit;
};

/**
 * 带超时与重试的 fetch 包装。网络类工具失败很常见（站点被墙、限流），
 * 所以重试是默认行为，最终失败只记日志并返回 null，由调用方决定降级策略。
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = options.retries ?? 2;
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: { ...DEFAULT_HEADERS, ...options.headers },
        body: options.body,
        signal: controller.signal,
        redirect: 'follow'
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        // 4xx 除了 429 之外重试没意义
        if (response.status < 500 && response.status !== 429) {
          log.debug(`${url} → ${response.status}，不再重试`);
          return null;
        }
      } else {
        return await response.text();
      }
    } catch (error) {
      lastError = error instanceof Error ? (error.name === 'AbortError' ? '超时' : error.message) : String(error);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  log.debug(`${url} 请求失败：${lastError}`);
  return null;
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T | null> {
  const text = await fetchText(url, options);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    log.debug(`${url} 返回的不是合法 JSON`);
    return null;
  }
}

/**
 * 抓二进制内容。
 * 有些站点（例如 nyaa）会在没带 accept-encoding 时依然返回 gzip/brotli 压缩体，
 * 这时用 resp.text() 会得到乱码，必须走 arrayBuffer 再按 content-encoding 解压。
 */
export async function fetchBytes(url: string, options: FetchOptions = {}): Promise<Uint8Array | null> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = options.retries ?? 2;
  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: { ...DEFAULT_HEADERS, ...options.headers },
        body: options.body,
        signal: controller.signal,
        redirect: 'follow'
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) return null;
      } else {
        const raw = new Uint8Array(await response.arrayBuffer());
        return await decodeBody(raw, response.headers.get('content-encoding'));
      }
    } catch (error) {
      lastError = error instanceof Error ? (error.name === 'AbortError' ? '超时' : error.message) : String(error);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }

  log.debug(`${url} 请求失败：${lastError}`);
  return null;
}

/**
 * 按内容真实情况解压。
 *
 * 不能只信 content-encoding 头：Node 的 fetch 在部分情况下会自行解压，
 * 但依然保留 content-encoding: gzip 响应头，此时再解压一次就会
 * "incorrect header check"。所以先看魔数，只有确实是被压缩的字节才解压。
 */
async function decodeBody(raw: Uint8Array, encoding: string | null): Promise<Uint8Array> {
  const normalized = (encoding ?? '').trim().toLowerCase();
  if (normalized === '' || normalized === 'identity') return raw;
  if (!looksCompressed(raw, normalized)) return raw;

  const { gunzipSync, inflateSync, brotliDecompressSync } = await import('node:zlib');
  try {
    if (normalized.includes('br')) return new Uint8Array(brotliDecompressSync(raw));
    if (normalized.includes('gzip') || normalized.includes('x-gzip')) return new Uint8Array(gunzipSync(raw));
    if (normalized.includes('deflate')) return new Uint8Array(inflateSync(raw));
  } catch (error) {
    log.debug(`解压 ${normalized} 失败，按原文处理：${(error as Error).message}`);
    return raw;
  }
  return raw;
}

/** 通过魔数判断字节流是否真的处于压缩状态。 */
function looksCompressed(bytes: Uint8Array, encoding: string): boolean {
  if (bytes.length < 2) return false;
  const [b0, b1] = [bytes[0]!, bytes[1]!];
  if (encoding.includes('gzip') || encoding.includes('x-gzip')) {
    return b0 === 0x1f && b1 === 0x8b;
  }
  if (encoding.includes('deflate')) {
    // zlib 头：0x78 开头且 (b0<<8|b1) % 31 === 0；否则可能是裸 deflate
    if (b0 === 0x78 && ((b0 << 8) | b1) % 31 === 0) return true;
    return false;
  }
  if (encoding.includes('br')) {
    // brotli 没有固定魔数，只能排除明显的文本/HTML 开头
    return !(b0 === 0x3c || b0 === 0x7b || b0 === 0x5b);
  }
  return false;
}
