import type { QbittorrentConfig } from '../config.js';
import { logger } from '../util/log.js';

const log = logger('qbittorrent');

/**
 * qBittorrent WebUI API 客户端（cookie 认证）。
 * 参考 WebUI API v2：/api/v2/auth/login、/api/v2/torrents/add、/api/v2/torrents/info 等。
 */

export class QbittorrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QbittorrentError';
  }
}

export type TorrentInfo = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  save_path: string;
  category: string;
  tags: string;
  content_path?: string;
};

export type TorrentFile = {
  index: number;
  name: string;
  size: number;
  priority: number;
  progress: number;
};

/** 文件优先级，取值与 qBittorrent 一致。 */
export const FilePriority = {
  Skip: 0,
  Normal: 1,
  High: 6,
  Maximal: 7
} as const;

export type AddTorrentOptions = {
  /** 磁力链接或 .torrent 直链。与 torrentBuffer 二选一。 */
  url?: string;
  /** 种子文件的完整内容。给出时优先于 url，并且可以立刻指定 filePrio。 */
  torrentBuffer?: Uint8Array;
  savePath?: string;
  category?: string;
  tags?: string[];
  paused?: boolean;
  /** 只下载这些文件索引，其余跳过。留空表示全部下载。 */
  fileIndexes?: number[];
};

export class QbittorrentClient {
  readonly #config: QbittorrentConfig;
  readonly #timeoutMs: number;
  #cookie: string | null = null;

  constructor(config: QbittorrentConfig, options: { timeoutMs?: number } = {}) {
    this.#config = config;
    this.#timeoutMs = options.timeoutMs ?? 15000;
  }

  get baseUrl(): string {
    return this.#config.url.replace(/\/+$/, '');
  }

  async #request(path: string, init: RequestInit = {}, retryOnAuth = true): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const headers = new Headers(init.headers);
    // qBittorrent 要求 Referer/Origin 与 Host 一致，用于 CSRF 校验
    headers.set('Referer', this.baseUrl);
    headers.set('Origin', this.baseUrl);
    if (this.#cookie) headers.set('cookie', this.#cookie);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal
      });

      if (response.status === 403 && retryOnAuth) {
        // 会话过期，重新登录一次
        this.#cookie = null;
        await this.login();
        return this.#request(path, init, false);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new QbittorrentError(`请求 qBittorrent 超时：${this.baseUrl}${path}`);
      }
      throw new QbittorrentError(
        `无法连接 qBittorrent（${this.baseUrl}）：${error instanceof Error ? error.message : String(error)}\n` +
          '请确认 qBittorrent 正在运行，且已开启「选项 → WebUI → 网页用户界面(远程控制)」。'
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async login(): Promise<void> {
    const body = new URLSearchParams({
      username: this.#config.username,
      password: this.#config.password
    });
    const response = await this.#request(
      '/api/v2/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body
      },
      false
    );

    if (response.status === 403) {
      throw new QbittorrentError('qBittorrent 因登录失败次数过多暂时封禁了本机 IP，请稍后再试或重启 qBittorrent。');
    }
    const text = (await response.text()).trim();
    if (text !== 'Ok.') {
      throw new QbittorrentError(
        `qBittorrent 登录失败（用户名或密码不对？）。返回：${text || response.status}\n` +
          '请在 config.json 的 qbittorrent.username / password 里填写 WebUI 的账号密码。'
      );
    }

    const setCookie = response.headers.get('set-cookie');
    const sid = setCookie ? /SID=([^;]+)/.exec(setCookie)?.[1] : null;
    if (!sid) {
      // 有些版本在 bypass_local_auth 打开时不返回 cookie，此时无需 cookie 也能调用
      log.debug('登录响应里没有 SID，可能已开启本机免密');
      this.#cookie = '';
      return;
    }
    this.#cookie = `SID=${sid}`;
    log.debug('已登录 qBittorrent');
  }

  async ensureLoggedIn(): Promise<void> {
    if (this.#cookie === null) await this.login();
  }

  /** 应用与 WebAPI 版本，用于连通性检查。 */
  async version(): Promise<{ app: string; api: string }> {
    await this.ensureLoggedIn();
    const [appResponse, apiResponse] = await Promise.all([
      this.#request('/api/v2/app/version'),
      this.#request('/api/v2/app/webapiVersion')
    ]);
    return {
      app: (await appResponse.text()).trim(),
      api: (await apiResponse.text()).trim()
    };
  }

  /** 确保分类存在，不存在则创建。 */
  async ensureCategory(category: string, savePath?: string): Promise<void> {
    if (!category) return;
    await this.ensureLoggedIn();
    const body = new URLSearchParams({ category });
    if (savePath) body.set('savePath', savePath);
    const response = await this.#request('/api/v2/torrents/createCategory', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    // 分类已存在时 qBittorrent 返回 409，属于正常情况
    if (!response.ok && response.status !== 409) {
      log.debug(`创建分类 ${category} 返回 ${response.status}`);
    }
  }

  /**
   * 添加种子。返回 qBittorrent 的原始响应文本。
   * qBittorrent 在失败时也会返回 200 + "Fails."，所以必须检查响应体。
   */
  async addTorrent(options: AddTorrentOptions): Promise<void> {
    await this.ensureLoggedIn();
    const body = new URLSearchParams();
    if (options.torrentBuffer) {
      // 直接给种子内容，qBittorrent 立刻就有文件列表，filePrio 才能生效
      body.set('torrents', Buffer.from(options.torrentBuffer).toString('base64'));
    } else if (options.url) {
      body.set('urls', options.url);
    } else {
      throw new QbittorrentError('添加种子失败：既没有 url 也没有种子内容');
    }
    if (options.savePath) body.set('savepath', options.savePath);
    if (options.category) body.set('category', options.category);
    if (options.tags && options.tags.length > 0) body.set('tags', options.tags.join(','));
    body.set('paused', options.paused ? 'true' : 'false');
    // 保留顶层文件夹，避免多集种子把文件摊平到下载目录
    body.set('root_folder', 'true');

    if (options.fileIndexes && options.fileIndexes.length > 0) {
      // filePrio 是「索引:优先级|索引:优先级」，索引对应该种子内部文件序号
      body.set('filePrio', options.fileIndexes.map((index) => `${index}:${FilePriority.Normal}`).join('|'));
    }

    const response = await this.#request('/api/v2/torrents/add', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = (await response.text()).trim();
    if (!response.ok || /fail/i.test(text)) {
      const label = options.url ?? (options.torrentBuffer ? '<内嵌种子>' : '<空>');
      throw new QbittorrentError(`添加种子失败：${text || response.status}（${label.slice(0, 80)}…）`);
    }
  }

  async listTorrents(): Promise<TorrentInfo[]> {
    await this.ensureLoggedIn();
    const response = await this.#request('/api/v2/torrents/info');
    if (!response.ok) return [];
    return (await response.json()) as TorrentInfo[];
  }

  async torrentFiles(hash: string): Promise<TorrentFile[]> {
    await this.ensureLoggedIn();
    const response = await this.#request(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`);
    if (!response.ok) return [];
    return (await response.json()) as TorrentFile[];
  }

  /** 设置单个种子的文件优先级。 */
  async setFilePriority(hash: string, fileIndexes: number[], priority: number): Promise<void> {
    if (fileIndexes.length === 0) return;
    await this.ensureLoggedIn();
    const body = new URLSearchParams({
      hash,
      id: fileIndexes.join('|'),
      priority: String(priority)
    });
    await this.#request('/api/v2/torrents/filePrio', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
  }

  async deleteTorrents(hashes: string[], deleteFiles = false): Promise<void> {
    if (hashes.length === 0) return;
    await this.ensureLoggedIn();
    const body = new URLSearchParams({
      hashes: hashes.join('|'),
      deleteFiles: deleteFiles ? 'true' : 'false'
    });
    await this.#request('/api/v2/torrents/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
  }

  /** 等待种子元数据就绪（磁力链接需要先取到种子信息才有文件列表）。 */
  async waitForMetadata(hash: string, timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const files = await this.torrentFiles(hash);
      if (files.length > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }
}
