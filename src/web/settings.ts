import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';

/**
 * 界面上的「设置」页要读写 config.json。
 *
 * 两个原则：
 *   1. **只写用户真的改过的字段**。整份配置回写会把默认值和注释性字段
 *      （以及用户自己加的键）一起冲掉，之前就踩过「保存一次设置，
 *      savePath 被模板里的旧值覆盖」这种事。
 *   2. **改了立刻生效**。deps.config 是同一个对象引用（下载队列也指着它），
 *      所以就地改字段，绝大多数设置不需要重启；只有监听地址和日志级别
 *      这类启动时读一次的才提示重启。
 *
 * 密钥（密码 / SendKey / bot token）不回传给浏览器：设置页只显示
 * 「已设置」，要改就重新填一次。
 */

export type FieldKind =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | 'nullable-string'
  | 'nullable-number'
  | 'enum';

export type FieldRule = {
  kind: FieldKind;
  /** enum 的候选值。 */
  values?: string[];
  min?: number;
  max?: number;
  /** 改这一项之后必须重启程序才生效。 */
  restart?: boolean;
};

/**
 * 允许从界面修改的字段白名单。
 *
 * 之所以要白名单：这个接口能改「下载目录」这种直接影响文件落盘位置的设置，
 * 不该允许任意路径写入。没列在这里的字段仍然可以手工编辑 config.json。
 */
export const SETTINGS_SCHEMA: Record<string, FieldRule> = {
  plannerBaseUrl: { kind: 'string' },
  intervalMinutes: { kind: 'integer', min: 1, max: 1440 },
  collectionTypes: { kind: 'number[]' },
  includeBacklog: { kind: 'boolean' },

  'download.enabled': { kind: 'boolean' },
  'download.backend': { kind: 'enum', values: ['builtin', 'qbittorrent'], restart: true },
  'download.savePath': { kind: 'string' },
  'download.seriesDir': { kind: 'string' },
  'download.ignoreDirs': { kind: 'string[]' },
  'download.timeoutMs': { kind: 'integer', min: 60_000 },
  'download.stallTimeoutMs': { kind: 'integer', min: 30_000 },
  'download.trialSeconds': { kind: 'integer', min: 5, max: 3600 },
  'download.minThroughputKBps': { kind: 'number', min: 0, max: 100_000 },
  'download.probeCandidates': { kind: 'integer', min: 0, max: 100 },
  'download.maxAttempts': { kind: 'integer', min: 1, max: 100 },
  'download.budgetMinutes': { kind: 'integer', min: 1, max: 10_080 },
  'download.readyDelayMinutes': { kind: 'integer', min: 0, max: 1440 },
  'download.activeIntervalMinutes': { kind: 'integer', min: 1, max: 1440 },
  'download.idleIntervalMinutes': { kind: 'integer', min: 1, max: 10_080 },
  'download.releaseWindowHours': { kind: 'integer', min: 1, max: 168 },
  'download.retryRounds': { kind: 'integer', min: 1, max: 100 },
  'download.retryBackoffMinutes': { kind: 'number', min: 0, max: 1440 },
  'download.retryMaxBackoffMinutes': { kind: 'number', min: 0, max: 10_080 },
  'download.maxEpisodesPerSubjectPerRun': { kind: 'integer', min: 1, max: 9999 },
  'download.maxTorrentsPerRun': { kind: 'integer', min: 1, max: 999 },
  'download.onlyAiredAfter': { kind: 'nullable-string' },
  'download.lookbackDays': { kind: 'nullable-number', min: 0, max: 3650 },

  'preference.requireKeywords': { kind: 'string[]' },
  'preference.excludeKeywords': { kind: 'string[]' },
  'preference.containerPreference': { kind: 'string[]' },
  'preference.resolutionPreference': { kind: 'string[]' },
  'preference.subtitlePreference': { kind: 'string[]' },
  'preference.preferGroups': { kind: 'string[]' },
  'preference.avoidGroups': { kind: 'string[]' },
  'preference.seederSaturation': { kind: 'integer', min: 1, max: 10_000 },
  'preference.preferBatch': { kind: 'boolean' },
  'preference.weights.container': { kind: 'number', min: 0, max: 1000 },
  'preference.weights.resolution': { kind: 'number', min: 0, max: 1000 },
  'preference.weights.subtitle': { kind: 'number', min: 0, max: 1000 },
  'preference.weights.group': { kind: 'number', min: 0, max: 1000 },
  'preference.weights.seeders': { kind: 'number', min: 0, max: 1000 },
  'preference.weights.batch': { kind: 'number', min: 0, max: 1000 },

  'trackers.animesGarden': { kind: 'boolean' },
  'trackers.mikan': { kind: 'boolean' },
  'trackers.mikanBase': { kind: 'nullable-string' },
  'trackers.mikanHosts': { kind: 'string[]' },
  'trackers.nyaaHosts': { kind: 'string[]' },
  'trackers.nyaa': { kind: 'boolean' },
  'trackers.maxResultsPerTracker': { kind: 'integer', min: 5, max: 500 },
  'trackers.timeoutMs': { kind: 'integer', min: 1000, max: 120_000 },
  'trackers.retries': { kind: 'integer', min: 0, max: 10 },

  'web.port': { kind: 'integer', min: 1, max: 65535, restart: true },
  'web.host': { kind: 'string', restart: true },
  'web.openBrowser': { kind: 'boolean' },
  'web.maxResultsPerTracker': { kind: 'integer', min: 5, max: 500 },

  logLevel: { kind: 'enum', values: ['debug', 'info', 'warn', 'error'], restart: true },
  logFile: { kind: 'string', restart: true },

  'notify.console': { kind: 'boolean' },
  'notify.serverChanKey': { kind: 'string' },
  'notify.telegram.botToken': { kind: 'string' },
  'notify.telegram.chatId': { kind: 'string' },

  'qbittorrent.url': { kind: 'string' },
  'qbittorrent.username': { kind: 'string' },
  'qbittorrent.password': { kind: 'string' },
  'qbittorrent.savePath': { kind: 'string' },
  'qbittorrent.category': { kind: 'string' },
  'qbittorrent.tags': { kind: 'string[]' },
  'qbittorrent.paused': { kind: 'boolean' }
};

export type PatchEntry = { path: string; value: unknown };

export type PatchValidation = { ok: true; entries: PatchEntry[] } | { ok: false; error: string };

/** 把嵌套 patch 摊平成「点分路径 → 值」，顺带做类型与范围校验。 */
export function validatePatch(patch: unknown, schema: Record<string, FieldRule> = SETTINGS_SCHEMA): PatchValidation {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'patch 必须是一个对象' };
  }

  const entries: PatchEntry[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): string | null => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const error = walk(value as Record<string, unknown>, path);
        if (error) return error;
        continue;
      }

      const rule = schema[path];
      if (!rule) return `不支持修改 ${path}（想改的话请直接编辑 config.json）`;
      const problem = checkValue(path, value, rule);
      if (problem) return problem;
      entries.push({ path, value });
    }
    return null;
  };

  const error = walk(patch as Record<string, unknown>, '');
  if (error) return { ok: false, error };
  if (entries.length === 0) return { ok: false, error: '没有要修改的内容' };
  return { ok: true, entries };
}

function checkValue(path: string, value: unknown, rule: FieldRule): string | null {
  switch (rule.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') return `${path} 必须是 true/false`;
      return null;
    case 'string':
      if (typeof value !== 'string') return `${path} 必须是字符串`;
      return null;
    case 'nullable-string':
      if (value !== null && typeof value !== 'string') return `${path} 必须是字符串或 null`;
      return null;
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} 必须是数字`;
      if (rule.kind === 'integer' && !Number.isInteger(value)) return `${path} 必须是整数`;
      if (rule.min !== undefined && value < rule.min) return `${path} 不能小于 ${rule.min}`;
      if (rule.max !== undefined && value > rule.max) return `${path} 不能大于 ${rule.max}`;
      return null;
    }
    case 'nullable-number':
      if (value === null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} 必须是数字或 null`;
      if (rule.min !== undefined && value < rule.min) return `${path} 不能小于 ${rule.min}`;
      if (rule.max !== undefined && value > rule.max) return `${path} 不能大于 ${rule.max}`;
      return null;
    case 'string[]':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return `${path} 必须是字符串数组`;
      return null;
    case 'number[]':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'number')) return `${path} 必须是数字数组`;
      return null;
    case 'enum':
      if (typeof value !== 'string' || !(rule.values ?? []).includes(value)) {
        return `${path} 只能是 ${(rule.values ?? []).join(' / ')}`;
      }
      return null;
    default:
      return `${path} 的类型不支持`;
  }
}

/** 就地写入一个「点分路径 → 值」，中间层不存在时补上空对象。 */
export function applyEntries(target: Record<string, unknown>, entries: readonly PatchEntry[]): void {
  for (const { path, value } of entries) {
    const parts = path.split('.');
    let node = target;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        const created: Record<string, unknown> = {};
        node[part] = created;
        node = created;
      } else {
        node = next as Record<string, unknown>;
      }
    }
    node[parts[parts.length - 1] as string] = value;
  }
}

/** 去掉 patch 里的密钥字段后返回（用于回显「改了哪些」）。 */
export function redactPatch(entries: readonly PatchEntry[]): PatchEntry[] {
  return entries.map((entry) =>
    /password|serverChanKey|botToken/i.test(entry.path) ? { path: entry.path, value: '（已更新）' } : entry
  );
}

export const SECRET_PATHS = ['qbittorrent.password', 'notify.serverChanKey', 'notify.telegram.botToken'];

/** 哪些字段改了需要重启（用于给用户提示）。 */
export function restartEntries(entries: readonly PatchEntry[]): string[] {
  return entries.filter((entry) => SETTINGS_SCHEMA[entry.path]?.restart === true).map((entry) => entry.path);
}

/** 回传给浏览器的配置：密钥只报「有没有设置」，不回传内容。 */
export function redactConfig(config: AppConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const secrets: Record<string, boolean> = {};

  for (const path of SECRET_PATHS) {
    const parts = path.split('.');
    let node: Record<string, unknown> | null = clone;
    for (const part of parts.slice(0, -1)) {
      const child: unknown = node === null ? null : node[part];
      node = typeof child === 'object' && child !== null && !Array.isArray(child) ? (child as Record<string, unknown>) : null;
    }
    if (node === null) continue;
    const key = parts[parts.length - 1] as string;
    const current = node[key];
    secrets[path] = typeof current === 'string' && current !== '';
    node[key] = '';
  }

  clone.secrets = secrets;
  return clone;
}

/** 读磁盘上的原始 config.json（保留用户自己加的键）；不存在或坏了返回空对象。 */
export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function writeRawConfig(path: string, raw: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

/** 顶层未知键：只是提示，不算错（用户可能自己加了备注之类的字段）。 */
export function unknownTopLevelKeys(raw: Record<string, unknown>, known: readonly string[]): string[] {
  const set = new Set(known);
  return Object.keys(raw).filter((key) => !set.has(key));
}
