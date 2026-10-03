import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../util/log.js';

const log = logger('state');

/**
 * 已推送记录。用来跨轮次去重，避免同一个种子被反复推给 qBittorrent。
 * 用 JSON 文件而不是 SQLite，是为了让打包出来的 exe 保持零原生依赖。
 */

export type StateRecord = {
  subjectId: number;
  subjectName: string;
  episode: number;
  /** 磁力 infohash；没有磁力时用 .torrent 直链的哈希。 */
  infoHash: string;
  title: string;
  tracker: string;
  sizeBytes: number | null;
  /** true 表示成功推送到 qBittorrent。 */
  added: boolean;
  addedAt: string;
};

type StateFile = {
  version: 1;
  records: StateRecord[];
};

export class StateStore {
  readonly #file: string;
  readonly #retentionDays: number;
  #records: StateRecord[] = [];
  #dirty = false;

  constructor(file: string, retentionDays = 180) {
    this.#file = file;
    this.#retentionDays = retentionDays;
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.#file)) {
      this.#records = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as StateFile;
      this.#records = Array.isArray(parsed?.records) ? parsed.records : [];
      log.debug(`载入 ${this.#records.length} 条历史记录`);
    } catch (error) {
      log.warn(`状态文件损坏，将以空状态继续：${(error as Error).message}`);
      this.#records = [];
    }
  }

  /** 原子落盘：先写临时文件再 rename，避免中途崩溃留下半个文件。 */
  save(force = false): void {
    if (!this.#dirty && !force) return;
    this.#prune();
    const payload: StateFile = { version: 1, records: this.#records };
    mkdirSync(dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temp, this.#file);
    this.#dirty = false;
  }

  #prune(): void {
    if (this.#retentionDays <= 0) return;
    const cutoff = Date.now() - this.#retentionDays * 24 * 60 * 60 * 1000;
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => {
      const time = Date.parse(record.addedAt);
      return Number.isNaN(time) || time >= cutoff;
    });
    if (this.#records.length !== before) {
      log.debug(`清理 ${before - this.#records.length} 条过期记录`);
    }
  }

  /** 该集是否已经推送过。 */
  hasEpisode(subjectId: number, episode: number): StateRecord | undefined {
    return this.#records.find((record) => record.subjectId === subjectId && record.episode === episode && record.added);
  }

  /** 该 infohash 是否已经推送过（合集场景下同一 infohash 覆盖多集）。 */
  hasInfoHash(infoHash: string): StateRecord | undefined {
    return this.#records.find((record) => record.infoHash === infoHash && record.added);
  }

  /** 记录一次推送尝试。 */
  record(entry: Omit<StateRecord, 'addedAt'> & { addedAt?: string }): void {
    const addedAt = entry.addedAt ?? new Date().toISOString();
    const index = this.#records.findIndex(
      (record) => record.subjectId === entry.subjectId && record.episode === entry.episode
    );
    const next: StateRecord = { ...entry, addedAt };
    if (index >= 0) this.#records[index] = next;
    else this.#records.push(next);
    this.#dirty = true;
  }

  list(): StateRecord[] {
    return [...this.#records];
  }

  get size(): number {
    return this.#records.length;
  }
}
