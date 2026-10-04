import { execFile } from 'node:child_process';
import { logger } from '../util/log.js';

const log = logger('schedule');

/**
 * 读取 Windows 计划任务的状态。
 *
 * 为什么要做这个：这套程序的自动化其实全靠两个计划任务在跑
 * （定时追番 + 常驻 Web 界面）。以前想知道「它到底还在跑吗、上次跑成功没有」
 * 只能自己开「任务计划程序」去翻 —— 界面上完全看不到，于是
 * 「昨天为什么没下」这种问题无从回答。
 *
 * 实现上的两点讲究：
 *   1. 用 Get-ScheduledTaskInfo 而不是解析 schtasks 的文本输出 ——
 *      schtasks 的列名随系统语言变化（中文系统是「下次运行时间」），
 *      按列名解析在别的语言下必然错位；而 .NET 属性名是语言无关的。
 *   2. 时间在 PowerShell 里就先格式化好再序列化：Windows PowerShell 5.1
 *      的 ConvertTo-Json 对 DateTime 的表示并不统一（有的版本是
 *      \/Date(...)\/ 这种老格式），先转成字符串就没有这个歧义。
 */

export type ScheduledTaskInfo = {
  name: string;
  /** Ready / Running / Disabled / Queued … */
  state: string;
  lastRun: string | null;
  nextRun: string | null;
  /** 上次运行的退出码，0 表示成功。 */
  lastResult: number | null;
  /** 退出码翻译成人话。 */
  lastResultText: string;
  /** 重复间隔（例如「每 15 分钟」），没有重复触发器时为 null。 */
  interval: string | null;
};

export type ScheduleProbeResult = {
  ok: boolean;
  /** 探测不可用时的原因（非 Windows、PowerShell 不存在等）。 */
  message: string;
  tasks: ScheduledTaskInfo[];
  checkedAt: string;
};

/** 这两个任务名由 packaging/windows/scripts/install-startup.ps1 创建。 */
export const TASK_NAMES = ['BangumiDownloader', 'BangumiDownloader-GUI'];

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: ScheduleProbeResult } | null = null;

/** 把一个 ISO8601 时长（PT15M / PT1H30M）说成人话。 */
export function formatInterval(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(raw.trim());
  if (!match) return null;

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 1440 + hours * 60 + minutes + (seconds > 0 ? 1 : 0);
  if (total <= 0) return null;
  if (total < 60) return `每 ${total} 分钟`;
  if (total % 60 === 0) return `每 ${total / 60} 小时`;
  return `每 ${total} 分钟`;
}

/**
 * 把计划任务的退出码翻译成人话。
 *
 * 这里必须把「上一次还在跑，所以这次的触发被拒」单独说清楚：
 * 追番是长任务（一轮可能跑几小时），而触发器在播出窗口里每 15 分钟就来一次，
 * 于是任务计划程序会返回 0x800710E0。这是**完全正常**的（MultipleInstances=IgnoreNew
 * 就是为此设的），但界面上直接显示「异常退出」会让人以为坏了 ——
 * 实测就是这么被误会的。
 */
export function describeResult(code: number | null): string {
  if (code === null) return '未知';
  switch (code) {
    case 0:
      return '成功（0）';
    case 0x41301:
      return '正在运行（0x41301）';
    case 0x41303:
      return '还没运行过（0x41303）';
    case 0x41306:
      return '被用户中止（0x41306）';
    case 0x80070420:
      return '任务已被删除（0x80070420）';
    case 0x800710e0:
      // ERROR_REQUEST_REFUSED：上一轮还在跑，这次触发被跳过
      return '上一轮还在跑，这次触发跳过（正常）';
    default:
      return code > 0x40000000 ? `异常退出（0x${code.toString(16).toUpperCase()}）` : `退出码 ${code}`;
  }
}

export function buildProbeScript(names: readonly string[]): string {
  const list = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$names=@(${list})`,
    '$out=@()',
    'foreach($n in $names){',
    '  $t=Get-ScheduledTask -TaskName $n',
    '  if($t){',
    '    $i=Get-ScheduledTaskInfo -TaskName $n',
    '    $rep=$null',
    '    foreach($tr in $t.Triggers){ if($tr.Repetition -and $tr.Repetition.Interval){ $rep=[string]$tr.Repetition.Interval; break } }',
    '    $last=$null; if($i.LastRunTime -and $i.LastRunTime -gt [datetime]::MinValue){ $last=$i.LastRunTime.ToString("yyyy-MM-dd HH:mm:ss") }',
    '    $next=$null; if($i.NextRunTime -and $i.NextRunTime -gt [datetime]::MinValue){ $next=$i.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss") }',
    '    $out+=[pscustomobject]@{name=$n;state=[string]$t.State;lastRun=$last;nextRun=$next;lastResult=$i.LastTaskResult;missed=$i.NumberOfMissedRuns;interval=$rep}',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress -Depth 4'
  ].join('\n');
}

function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** 解析 PowerShell 的输出。分开导出是为了能在非 Windows 上测这段逻辑。 */
export function parseProbeOutput(raw: string): ScheduledTaskInfo[] {
  const text = raw.trim();
  if (text === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.warn(`计划任务探测输出不是 JSON：${text.slice(0, 200)}`);
    return [];
  }

  // ConvertTo-Json 在只有一个元素时可能给出单个对象而不是数组，两种都收
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const tasks: ScheduledTaskInfo[] = [];

  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') continue;
    const result = typeof record.lastResult === 'number' ? record.lastResult : null;
    tasks.push({
      name: record.name,
      state: typeof record.state === 'string' ? record.state : '未知',
      lastRun: typeof record.lastRun === 'string' ? record.lastRun : null,
      nextRun: typeof record.nextRun === 'string' ? record.nextRun : null,
      lastResult: result,
      lastResultText: describeResult(result),
      interval: formatInterval(typeof record.interval === 'string' ? record.interval : null)
    });
  }

  return tasks;
}

/**
 * 查一次计划任务状态。结果缓存 30 秒 —— 界面每隔几秒轮询一次，
 * 每次都去起一个 PowerShell 进程太浪费（启动本身就要一两秒）。
 */
export async function probeScheduledTasks(options: { force?: boolean; names?: readonly string[] } = {}): Promise<ScheduleProbeResult> {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const value = await probeScheduledTasksUncached(options.names ?? TASK_NAMES);
  cache = { at: now, value };
  return value;
}

async function probeScheduledTasksUncached(names: readonly string[]): Promise<ScheduleProbeResult> {
  const checkedAt = new Date().toISOString();

  if (process.platform !== 'win32') {
    return {
      ok: false,
      message: '只有 Windows 才有计划任务；当前系统用 cron / launchd 之类的工具代替。',
      tasks: [],
      checkedAt
    };
  }

  try {
    const stdout = await runPowerShell(buildProbeScript(names));
    const tasks = parseProbeOutput(stdout);
    if (tasks.length === 0) {
      return {
        ok: false,
        message: `没有找到计划任务（${names.join('、')}）。双击 packaging\\windows\\1-setup.cmd 可以安装。`,
        tasks: [],
        checkedAt
      };
    }
    return { ok: true, message: `已找到 ${tasks.length} 个计划任务`, tasks, checkedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`计划任务探测失败：${message}`);
    return { ok: false, message: `查询计划任务失败：${message.split('\n')[0]}`, tasks: [], checkedAt };
  }
}

/** 测试用：清掉缓存。 */
export function resetScheduleCache(): void {
  cache = null;
}
