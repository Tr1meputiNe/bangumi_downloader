import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SchedulePlan } from './auto-schedule.js';
import { logger } from '../util/log.js';

const log = logger('task-schedule');

/**
 * 把「按播出时间排的计划」写进 Windows 计划任务的触发器。
 *
 * 为什么值得动计划任务本身：程序里的计划判断（没到点就跳过）已经把 96 轮/天
 * 压到了个位数，但那 96 次进程启动本身还是白来的 —— 任务计划程序按播出时间
 * 触发才是真的「按播出时间排」。实测非管理员身份也能改自己创建的任务的触发器。
 *
 * 排出来的触发器长这样：
 *   - 每集一段：从「播出 + 就绪延迟」开始，每 activeInterval 分钟触发一次，
 *     持续 releaseWindowHours 小时（这段时间是片源可能出现、需要盯着的时候）
 *   - 一个「重读计划」触发器：每 idleInterval 分钟一次，永远重复。
 *     计划本身会变（你在 Planner 里加了新番），没有它就要等下一集播出才发现
 *   - 保留「登录时」触发器：重启之后能补上错过的那些
 *
 * 安全底线：**绝不写空触发器**。算不出任何安排时保持原样，
 * 否则任务会变成「永远不触发」，那比多跑几轮糟糕得多。
 */

export type TaskTrigger = {
  /** 从这一刻开始盯。 */
  start: Date;
  /** 到这一刻还没下到就放过这一集。 */
  until: Date;
  label: string;
};

export type TaskSchedulePlan = {
  triggers: TaskTrigger[];
  /** 隔多久重读一遍计划（分钟）。 */
  refreshIntervalMinutes: number;
  /** 每段窗口内多久触发一次（分钟）。 */
  activeIntervalMinutes: number;
};

/** 一段窗口最多排多久的重复（上限，避免算出特别长的 duration）。 */
const MAX_DURATION_MS = 48 * 3_600_000;
/** 触发器数量上限：Windows 对单个任务的触发器数量有限制，别贴边。 */
const MAX_TRIGGERS = 32;
/** 只排未来这么多天内的安排（再远的等下次重读计划时再排）。 */
const HORIZON_DAYS = 21;

export function buildTaskSchedule(
  plan: Pick<SchedulePlan, 'triggers'>,
  now: Date,
  options: { activeIntervalMinutes: number; idleIntervalMinutes: number }
): TaskSchedulePlan {
  const horizon = now.getTime() + HORIZON_DAYS * 24 * 3_600_000;

  const triggers = plan.triggers
    .filter((item) => item.until.getTime() > now.getTime() && item.start.getTime() <= horizon)
    .map((item) => ({
      start: new Date(Math.max(item.start.getTime(), now.getTime() + 60_000)),
      until: item.until,
      label: item.label
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, MAX_TRIGGERS - 1);

  return {
    triggers,
    refreshIntervalMinutes: Math.max(1, options.idleIntervalMinutes),
    activeIntervalMinutes: Math.max(1, options.activeIntervalMinutes)
  };
}

export type TaskSyncPayload = {
  taskName: string;
  activeIntervalMinutes: number;
  refreshIntervalMinutes: number;
  /** 同步结果写到哪儿（PowerShell 写、Node 读，避免解析控制台输出）。 */
  resultPath: string;
  windows: Array<{ start: string; durationMinutes: number; label: string }>;
};

export function buildTaskSyncPayload(input: {
  taskName: string;
  plan: TaskSchedulePlan;
  resultPath: string;
}): TaskSyncPayload {
  return {
    taskName: input.taskName,
    activeIntervalMinutes: input.plan.activeIntervalMinutes,
    refreshIntervalMinutes: input.plan.refreshIntervalMinutes,
    resultPath: input.resultPath,
    windows: input.plan.triggers.map((item) => ({
      start: item.start.toISOString(),
      // 一段窗口最长给多久的重复：上限截断，反正之后还会重排
      durationMinutes: Math.max(
        1,
        Math.min(Math.round((item.until.getTime() - item.start.getTime()) / 60_000), MAX_DURATION_MS / 60_000)
      ),
      label: item.label
    }))
  };
}

/**
 * 生成给 PowerShell 的同步脚本。
 *
 * 触发器用 JSON 传（写进一个临时文件再读），不在命令行里拼时间字符串 ——
 * 中文 Windows 上日期格式随时区/区域变，拼字符串必然踩坑。
 */
export function renderSyncScript(input: { payload: TaskSyncPayload; resultPath: string }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$payloadPath = '${input.resultPath}.in.json'`,
    `$payload = Get-Content -Raw -LiteralPath $payloadPath | ConvertFrom-Json`,
    '$taskName = $payload.taskName',
    '',
    'function Write-Result($obj) {',
    '  $obj | ConvertTo-Json -Compress | Set-Content -LiteralPath $payload.resultPath -Encoding UTF8',
    '}',
    '',
    'try {',
    '  $task = Get-ScheduledTask -TaskName $taskName',
    '  $existing = @($task.Triggers)',
    '  $triggers = @()',
    '',
    '  # 每集一段：到点开始，按间隔重复，持续到这一集的窗口结束',
    '  foreach ($w in @($payload.windows)) {',
    '    $start = [datetime]::Parse($w.start).ToLocalTime()',
    '    $t = New-ScheduledTaskTrigger -Once -At $start',
    '    $t.Repetition = (New-ScheduledTaskTrigger -Once -At $start `',
    '      -RepetitionInterval (New-TimeSpan -Minutes $payload.activeIntervalMinutes) `',
    '      -RepetitionDuration (New-TimeSpan -Minutes $w.durationMinutes)).Repetition',
    '    $triggers += $t',
    '  }',
    '',
    '  # 重读计划：只要程序还在，就得定期看看计划变没变',
    '  $refreshAt = (Get-Date).AddMinutes($payload.refreshIntervalMinutes)',
    '  $refresh = New-ScheduledTaskTrigger -Once -At $refreshAt `',
    '    -RepetitionInterval (New-TimeSpan -Minutes $payload.refreshIntervalMinutes)',
    '  $triggers += $refresh',
    '',
    '  # 保留登录触发（重启后补上错过的那些）',
    '  $triggers += New-ScheduledTaskTrigger -AtLogOn',
    '',
    '  Set-ScheduledTask -TaskName $taskName -Trigger $triggers | Out-Null',
    '',
    '  $after = Get-ScheduledTask -TaskName $taskName',
    '  $info = Get-ScheduledTaskInfo -TaskName $taskName',
    '  Write-Result @{',
    '    ok = $true',
    '    count = @($after.Triggers).Count',
    '    nextRun = if ($info.NextRunTime) { $info.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { $null }',
    '    message = "已按播出时间排好 $($payload.windows.Count) 段窗口 + 每 $($payload.refreshIntervalMinutes) 分钟重读计划"',
    '  }',
    '} catch {',
    '  Write-Result @{ ok = $false; message = $_.Exception.Message; count = @($existing).Count }',
    '  exit 1',
    '} finally {',
    '  Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue',
    '}'
  ].join('\n');
}

export type SyncResult = {
  ok: boolean;
  message: string;
  /** 同步后的触发器数量。 */
  count?: number;
  nextRun?: string | null;
};

/**
 * 真正去改计划任务。只在 Windows 上做；失败一律返回 ok:false，不抛异常 ——
 * 计划任务没排成不该让「追番」这一轮失败。
 */
export async function syncTaskSchedule(options: {
  taskName: string;
  plan: TaskSchedulePlan;
  /** 不传就只算不写（dry-run，用于自检和测试）。 */
  apply: boolean;
}): Promise<SyncResult> {
  if (!options.apply) {
    return { ok: true, message: `（dry-run）会排 ${options.plan.triggers.length} 段窗口`, count: options.plan.triggers.length };
  }

  // 先查「有没有东西可排」再查平台：这条是逻辑底线（绝不写空触发器，
  // 否则任务会变成永远不触发），跟在哪台机器上跑无关，所以不该被平台判断挡住。
  if (options.plan.triggers.length === 0) {
    return {
      ok: false,
      message: `没有可用的播出安排，保持原来的触发器不动（每 ${options.plan.refreshIntervalMinutes} 分钟重读计划，届时会再排一次）`
    };
  }

  if (process.platform !== 'win32') {
    return { ok: false, message: `只有 Windows 有计划任务，这里没有可同步的东西（本来会排 ${options.plan.triggers.length} 段窗口）` };
  }

  const dir = mkdtempSync(join(tmpdir(), 'bd-task-'));
  const resultPath = join(dir, 'result.json');
  const scriptPath = join(dir, 'sync.ps1');

  try {
    const payload = buildTaskSyncPayload({ taskName: options.taskName, plan: options.plan, resultPath });
    writeFileSync(`${resultPath}.in.json`, JSON.stringify(payload), 'utf8');
    writeFileSync(scriptPath, renderSyncScript({ payload, resultPath }), 'utf8');

    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 60_000, windowsHide: true },
        (error) => (error ? reject(error) : resolve())
      );
    });

    const raw = await import('node:fs').then((fs) => fs.readFileSync(resultPath, 'utf8'));
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as SyncResult;
    if (!parsed.ok) log.warn(`计划任务触发时间同步失败：${parsed.message}`);
    else log.info(`计划任务已按播出时间排好：${parsed.message}（下次 ${parsed.nextRun ?? '未知'}）`);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
    log.warn(`计划任务触发时间同步失败：${message}`);
    return { ok: false, message: `同步计划任务失败：${message}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
