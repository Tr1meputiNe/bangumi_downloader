/**
 * 进程内搜索结果缓存。
 *
 * 一次搜索要打三个片源、还可能下载 mikan 的种子文件算 infohash，
 * 实测「葬送的芙莉莲」要 12 秒。手动搜索时同一个关键词反复搜很常见
 * （切筛选、翻回来看看），没有缓存体验会很差。
 *
 * 只放在内存里、不做持久化：这是可再生的数据，重启后重新搜即可，
 * 也避免引入「缓存过期了但用户不知道」这类难查的问题。
 * 顺带也减少了对片源站的请求压力。
 */

type Entry<T> = {
  value: T;
  expiresAt: number;
};

export type CacheOptions = {
  /** 存活时间（毫秒）。 */
  ttlMs: number;
  /** 最多缓存多少个关键词。 */
  maxEntries: number;
};

export class SearchCache<T> {
  readonly #options: CacheOptions;
  readonly #entries = new Map<string, Entry<T>>();

  constructor(options: CacheOptions) {
    this.#options = options;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    // 命中后重新插入，让 Map 的迭代顺序变成 LRU 顺序
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#options.ttlMs });
    while (this.#entries.size > this.#options.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** 取不到就执行 loader 并写入缓存。同一个 key 的并发调用会共用一次请求。 */
  async getOrLoad(key: string, loader: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };

    const pending = this.#inFlight.get(key);
    if (pending) return { value: await pending, cached: true };

    const promise = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);
    return { value: await promise, cached: false };
  }

  readonly #inFlight = new Map<string, Promise<T>>();

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}
