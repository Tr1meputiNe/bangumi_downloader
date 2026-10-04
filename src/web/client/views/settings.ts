import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { html } from '../html.js';
import { api, type ConfigResponse } from '../api.js';
import { Card, Empty, Spinner } from '../components.js';
import { notify } from '../store.js';

/**
 * 设置页。
 *
 * 直接读写 config.json —— 但**只写你改过的字段**。整份回写是危险的：
 * 默认模板里的值会把你在文件里手改的东西冲掉（这个坑踩过一次，
 * savePath 被改回了旧值，下载全落到别的地方）。
 *
 * 密钥（qBittorrent 密码、Server 酱 SendKey、bot token）不会回传到浏览器，
 * 只显示「已设置」；要改就重新填一遍。
 */

type FieldKind = 'text' | 'number' | 'nullable-number' | 'bool' | 'list' | 'numbers' | 'select' | 'secret';

type FieldDef = {
  path: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  placeholder?: string;
  options?: string[];
  suffix?: string;
};

type GroupDef = { title: string; hint?: string; fields: FieldDef[] };

const GROUPS: GroupDef[] = [
  {
    title: '下载',
    hint: '内置引擎不需要任何外部程序；改成 qBittorrent 才需要下面那一组配置',
    fields: [
      { path: 'download.enabled', label: '启用下载', kind: 'bool', hint: '关掉只挑选不下载（调试用）' },
      { path: 'download.backend', label: '下载后端', kind: 'select', options: ['builtin', 'qbittorrent'], hint: '改这一项要重启' },
      { path: 'download.savePath', label: '下载目录', kind: 'text', placeholder: 'D:/anime_download' },
      { path: 'download.seriesDir', label: '番剧子目录', kind: 'text', hint: '所有下载内容都归纳到这个子目录下' },
      { path: 'download.ignoreDirs', label: '扫描时跳过', kind: 'list', hint: '校核本地内容时忽略的目录名，逗号分隔' },
      { path: 'download.readyDelayMinutes', label: '片源就绪延迟', kind: 'number', suffix: '分钟', hint: '播出后多久才开始找种（片源站一般 30~60 分钟出种）' },
      { path: 'download.activeIntervalMinutes', label: '等片源时间隔', kind: 'number', suffix: '分钟', hint: '一集到点还没下到时多久看一次，默认 15' },
      { path: 'download.idleIntervalMinutes', label: '空闲兜底间隔', kind: 'number', suffix: '分钟', hint: '没有已知播出安排时多久确认一次计划有没有变，默认 180' },
      { path: 'download.releaseWindowHours', label: '单集盯多久', kind: 'number', suffix: '小时', hint: '播出后最多密集盯多久，超过就降频，默认 12' },
      { path: 'download.budgetMinutes', label: '单次时间预算', kind: 'number', suffix: '分钟' },
      { path: 'download.timeoutMs', label: '单种超时', kind: 'number', suffix: '毫秒' },
      { path: 'download.stallTimeoutMs', label: '卡死判定', kind: 'number', suffix: '毫秒', hint: '多久没有新分片完成就认为卡住了' },
      { path: 'download.trialSeconds', label: '候选试跑', kind: 'number', suffix: '秒' },
      { path: 'download.minThroughputKBps', label: '试跑最低速度', kind: 'number', suffix: 'KB/s' },
      { path: 'download.probeCandidates', label: '探活候选数', kind: 'number', suffix: '条' },
      { path: 'download.maxAttempts', label: '最多试几条', kind: 'number', suffix: '条' },
      { path: 'download.retryRounds', label: '重试轮数', kind: 'number', suffix: '轮' },
      { path: 'download.retryBackoffMinutes', label: '重试间隔', kind: 'number', suffix: '分钟' },
      { path: 'download.retryMaxBackoffMinutes', label: '重试间隔上限', kind: 'number', suffix: '分钟' },
      { path: 'download.maxEpisodesPerSubjectPerRun', label: '单部每轮集数', kind: 'number', suffix: '集' },
      { path: 'download.maxTorrentsPerRun', label: '单轮种子数', kind: 'number', suffix: '个' },
      { path: 'download.onlyAiredAfter', label: '只下这之后播的', kind: 'text', placeholder: '2024-01-01', hint: '留空表示不限，避免第一次跑就全量回填' },
      { path: 'download.lookbackDays', label: '每集回看天数', kind: 'nullable-number', suffix: '天', hint: '留空表示不限' }
    ]
  },
  {
    title: '片源',
    hint: '关掉连不上的源可以明显加快搜索；mikan 在部分网络下不可达',
    fields: [
      { path: 'trackers.animesGarden', label: 'AnimeGarden', kind: 'bool' },
      { path: 'trackers.mikan', label: 'Mikan', kind: 'bool' },
      { path: 'trackers.nyaa', label: 'Nyaa', kind: 'bool' },
      { path: 'trackers.maxResultsPerTracker', label: '每源条数', kind: 'number', suffix: '条' },
      { path: 'trackers.timeoutMs', label: '网络超时', kind: 'number', suffix: '毫秒' },
      { path: 'trackers.retries', label: '失败重试', kind: 'number', suffix: '次' }
    ]
  },
  {
    title: '筛选偏好',
    hint: '打分与淘汰规则：被淘汰的候选在搜索页会标出来，但仍可手动勾选下载',
    fields: [
      { path: 'preference.requireKeywords', label: '必须包含', kind: 'list', hint: '留空表示不限制' },
      { path: 'preference.excludeKeywords', label: '排除词', kind: 'list' },
      { path: 'preference.resolutionPreference', label: '分辨率优先', kind: 'list' },
      { path: 'preference.containerPreference', label: '容器优先', kind: 'list' },
      { path: 'preference.subtitlePreference', label: '字幕优先', kind: 'list' },
      { path: 'preference.preferGroups', label: '偏好字幕组', kind: 'list' },
      { path: 'preference.avoidGroups', label: '避开字幕组', kind: 'list' },
      { path: 'preference.seederSaturation', label: '做种数满分线', kind: 'number', suffix: '个' },
      { path: 'preference.preferBatch', label: '缺多集时优先合集', kind: 'bool' }
    ]
  },
  {
    title: '自动追番',
    fields: [
      { path: 'plannerBaseUrl', label: 'Planner 地址', kind: 'text', hint: 'Bangumi Watch Planner 的地址，连不上会自动退回本地追番清单' },
      { path: 'collectionTypes', label: '抓取收藏状态', kind: 'numbers', hint: '1 想看 / 2 看过 / 3 在看 / 4 搁置 / 5 抛弃，默认 3' },
      { path: 'includeBacklog', label: '连同补番计划', kind: 'bool' },
      { path: 'intervalMinutes', label: '守护模式间隔', kind: 'number', suffix: '分钟' }
    ]
  },
  {
    title: '通知',
    fields: [
      { path: 'notify.console', label: '控制台输出', kind: 'bool' },
      { path: 'notify.serverChanKey', label: 'Server 酱 SendKey', kind: 'secret' },
      { path: 'notify.telegram.botToken', label: 'Telegram bot token', kind: 'secret' },
      { path: 'notify.telegram.chatId', label: 'Telegram chat id', kind: 'text' }
    ]
  },
  {
    title: 'qBittorrent（只有后端选它才用得上）',
    fields: [
      { path: 'qbittorrent.url', label: 'WebUI 地址', kind: 'text' },
      { path: 'qbittorrent.username', label: '用户名', kind: 'text' },
      { path: 'qbittorrent.password', label: '密码', kind: 'secret' },
      { path: 'qbittorrent.savePath', label: '保存路径', kind: 'text' },
      { path: 'qbittorrent.category', label: '分类', kind: 'text' },
      { path: 'qbittorrent.tags', label: '标签', kind: 'list' },
      { path: 'qbittorrent.paused', label: '加入后暂停', kind: 'bool' }
    ]
  },
  {
    title: '界面与日志',
    fields: [
      { path: 'web.port', label: '监听端口', kind: 'number', hint: '改这一项要重启程序' },
      { path: 'web.host', label: '监听地址', kind: 'text', hint: '127.0.0.1 只本机可访问；想远程访问填 Tailscale 地址。改这一项要重启' },
      { path: 'web.openBrowser', label: '启动时打开浏览器', kind: 'bool' },
      { path: 'web.maxResultsPerTracker', label: '界面搜索每源条数', kind: 'number', suffix: '条' },
      { path: 'logLevel', label: '日志级别', kind: 'select', options: ['debug', 'info', 'warn', 'error'], hint: '改这一项要重启' },
      { path: 'logFile', label: '日志文件', kind: 'text', hint: '留空则用 data/bangumi.log' }
    ]
  }
];

const FIELD_INDEX = new Map<string, FieldDef>();
for (const group of GROUPS) for (const field of group.fields) FIELD_INDEX.set(field.path, field);

function getPath(source: Record<string, unknown>, path: string): unknown {
  let node: unknown = source;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** 把配置里的值转成输入框里的字符串。 */
function toInput(field: FieldDef, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** 把输入框里的字符串转回配置里的类型。返回 undefined 表示非法输入。 */
export function parseFieldValue(field: FieldDef, raw: string): unknown {
  const text = raw.trim();
  switch (field.kind) {
    case 'bool':
      return text === 'true';
    case 'number': {
      if (text === '') return undefined;
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }
    case 'nullable-number': {
      if (text === '') return null;
      const value = Number(text);
      return Number.isFinite(value) ? value : undefined;
    }
    case 'list':
      return text === ''
        ? []
        : text
            .split(/[,，\n]/)
            .map((item) => item.trim())
            .filter((item) => item !== '');
    case 'numbers':
      if (text === '') return [];
      return text
        .split(/[,，\s]+/)
        .map((item) => Number(item.trim()))
        .filter((value) => Number.isFinite(value));
    default:
      return raw;
  }
}

function buildPatch(draft: Record<string, string>): { patch: Record<string, unknown>; error: string | null } {
  const patch: Record<string, unknown> = {};

  for (const [path, raw] of Object.entries(draft)) {
    const field = FIELD_INDEX.get(path);
    if (!field) continue;
    const value = parseFieldValue(field, raw);
    if (value === undefined) return { patch: {}, error: `${field.label} 填的不是有效数字` };

    const parts = path.split('.');
    let node = patch;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] as string] = value;
  }

  return { patch, error: null };
}

export function SettingsView() {
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [boolDraft, setBoolDraft] = useState<Record<string, boolean>>({});
  const [rawText, setRawText] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restartHint, setRestartHint] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await api.config();
      setData(response);
      setDraft({});
      setBoolDraft({});
      setRawText(JSON.stringify(response.config, null, 2));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const config = data?.config ?? null;

  const valueOf = useCallback(
    (field: FieldDef): string => {
      if (field.path in draft) return draft[field.path] as string;
      return toInput(field, config ? getPath(config, field.path) : undefined);
    },
    [draft, config]
  );

  const boolOf = useCallback(
    (field: FieldDef): boolean => {
      if (field.path in boolDraft) return boolDraft[field.path] as boolean;
      return config ? getPath(config, field.path) === true : false;
    },
    [boolDraft, config]
  );

  const secretSet = useCallback(
    (field: FieldDef): boolean => {
      const secrets = (config?.secrets ?? {}) as Record<string, boolean>;
      return secrets[field.path] === true;
    },
    [config]
  );

  const dirtyCount = Object.keys(draft).length + Object.keys(boolDraft).length;

  const save = useCallback(async () => {
    if (dirtyCount === 0) {
      notify('info', '没有改动');
      return;
    }
    const merged: Record<string, string> = { ...draft };
    // 复选框也要进 patch（值用 true/false 字符串表示）
    for (const [path, value] of Object.entries(boolDraft)) merged[path] = value ? 'true' : 'false';

    const { patch, error: buildError } = buildPatch(merged);
    if (buildError) {
      notify('err', buildError);
      return;
    }

    setBusy(true);
    try {
      const response = await api.configSave(patch);
      setData({ path: response.path, config: response.config, editable: data?.editable ?? [] });
      setDraft({});
      setBoolDraft({});
      setRawText(JSON.stringify(response.config, null, 2));
      setRestartHint(response.restartRequired);
      notify('ok', `已保存 ${response.changed.length} 项设置`);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, boolDraft, dirtyCount, data]);

  const saveRaw = useCallback(async () => {
    setBusy(true);
    try {
      const response = await api.configRaw(rawText);
      setData({ path: response.path, config: response.config, editable: data?.editable ?? [] });
      setDraft({});
      setBoolDraft({});
      setRestartHint(response.restartRequired);
      notify('ok', response.warnings && response.warnings.length > 0 ? `已保存；${response.warnings.join('；')}` : '已保存 config.json');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [rawText, data]);

  const groups = useMemo(() => GROUPS, []);

  if (error) {
    return html`
      <div class="view">
        <div class="banner err">读取配置失败：${error}</div>
      </div>
    `;
  }

  return html`
    <div class="view">
      <${Card}
        title="设置"
        hint=${data?.path ? html`配置文件：<span class="mono">${data.path}</span>` : '配置文件路径未知'}
        actions=${html`
          <button type="button" class="ghost small" onClick=${() => void load()}>重新载入</button>
          <button type="button" disabled=${busy || dirtyCount === 0} onClick=${() => void save()}>
            ${dirtyCount === 0 ? '保存' : `保存 ${dirtyCount} 项改动`}
          </button>
        `}
      >
        ${!config ? html`<${Spinner} label="读取配置…" />` : null}
        ${config &&
        html`
          <div class="dim small">
            只保存你改过的字段，其余内容（包括你自己加的键）原样保留。密钥不会显示出来，只提示有没有设置过。
          </div>
          ${restartHint.length > 0 &&
          html`<div class="banner warn">
            这些改动要重启程序才生效：${restartHint.join('、')}
            <div class="dim small">
              这台机器上的界面是计划任务常驻的（BangumiDownloader-GUI）：先跑 uninstall-startup.cmd 停掉，
              再双击 9-webui.cmd 启动即可。
            </div>
          </div>`}
        `}
      <//>

      ${config &&
      groups.map(
        (group) => html`
          <${Card} title=${group.title} hint=${group.hint}>
            <div class="form-grid">
              ${group.fields.map((field) => renderField(field, { valueOf, boolOf, secretSet, draft, boolDraft, setDraft, setBoolDraft }))}
            </div>
          <//>
        `
      )}

      ${config &&
      html`
        <${Card}
          title="高级：直接编辑 config.json"
          hint="字段名和嵌套结构就是文件里的样子；保存前会做一次类型检查，不合法的会被拒绝"
          actions=${html`
            <button type="button" class="ghost small" onClick=${() => setRawOpen((value) => !value)}>
              ${rawOpen ? '收起' : '展开'}
            </button>
            ${rawOpen && html`<button type="button" disabled=${busy} onClick=${() => void saveRaw()}>保存 JSON</button>`}
          `}
        >
          ${rawOpen
            ? html`<textarea class="raw-editor" spellCheck=${false} value=${rawText} onInput=${(e: Event) => setRawText((e.target as HTMLTextAreaElement).value)}></textarea>`
            : html`<${Empty} text="展开后可以整份编辑" hint="适合改界面上没列出来的字段（例如打分权重）" />`}
        <//>
      `}
    </div>
  `;
}

function renderField(
  field: FieldDef,
  helpers: {
    valueOf: (field: FieldDef) => string;
    boolOf: (field: FieldDef) => boolean;
    secretSet: (field: FieldDef) => boolean;
    draft: Record<string, string>;
    boolDraft: Record<string, boolean>;
    setDraft: (next: Record<string, string>) => void;
    setBoolDraft: (next: Record<string, boolean>) => void;
  }
) {
  const { valueOf, boolOf, secretSet, draft, boolDraft, setDraft, setBoolDraft } = helpers;
  const dirty = field.path in draft || field.path in boolDraft;

  if (field.kind === 'bool') {
    return html`
      <label class=${`field check ${dirty ? 'dirty' : ''}`}>
        <span class="field-label">${field.label}</span>
        <span class="field-control">
          <input
            type="checkbox"
            checked=${boolOf(field)}
            onChange=${(event: Event) => setBoolDraft({ ...boolDraft, [field.path]: (event.target as HTMLInputElement).checked })}
          />
        </span>
        ${field.hint && html`<span class="field-hint">${field.hint}</span>`}
      </label>
    `;
  }

  if (field.kind === 'select') {
    return html`
      <label class=${`field ${dirty ? 'dirty' : ''}`}>
        <span class="field-label">${field.label}</span>
        <span class="field-control">
          <select
            value=${valueOf(field)}
            onChange=${(event: Event) => setDraft({ ...draft, [field.path]: (event.target as HTMLSelectElement).value })}
          >
            ${(field.options ?? []).map((option) => html`<option value=${option}>${option}</option>`)}
          </select>
        </span>
        ${field.hint && html`<span class="field-hint">${field.hint}</span>`}
      </label>
    `;
  }

  const placeholder = field.kind === 'secret' && secretSet(field) ? '已设置，留空表示不修改' : field.placeholder ?? '';
  return html`
    <label class=${`field ${dirty ? 'dirty' : ''}`}>
      <span class="field-label">${field.label}</span>
      <span class="field-control">
        <input
          type=${field.kind === 'secret' ? 'password' : 'text'}
          value=${field.kind === 'secret' && !(field.path in draft) ? '' : valueOf(field)}
          placeholder=${placeholder}
          onInput=${(event: Event) => setDraft({ ...draft, [field.path]: (event.target as HTMLInputElement).value })}
        />
        ${field.suffix && html`<span class="suffix">${field.suffix}</span>`}
      </span>
      ${field.hint && html`<span class="field-hint">${field.hint}</span>`}
    </label>
  `;
}
