# ============================================================
#  注册「全自动追番」计划任务
#
#  设计目标：装一次之后再也不用管。
#
#  为什么是「每 30 分钟触发一次」而不是常驻一个进程：
#  下载可能持续几小时，常驻进程一旦被关机/睡眠打断就再也不会自己起来，
#  而定时触发天然具备「自我修复」能力 —— 下次触发会重新开始，
#  磁盘上的进度由引擎自己 resumeScan 接着下，不会重下已有数据。
#
#  重复触发不会打架：程序内部有单实例锁（data/.bangumi.lock），
#  上一次没跑完时，新触发的那次会直接退出。
# ============================================================
$ErrorActionPreference = 'Stop'

$taskName = 'BangumiDownloader'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'bangumi-downloader.exe'
$config = Join-Path $root 'config.json'
$watchlist = Join-Path $root 'watchlist.json'

if (-not (Test-Path $exe)) {
    Write-Host "找不到 bangumi-downloader.exe，请确认脚本位于解压后的目录内。" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $config)) {
    Write-Host "还没有 config.json，请先运行 1-setup.cmd。" -ForegroundColor Red
    exit 1
}

# 没有清单就先生成模板，避免任务空转
if (-not (Test-Path $watchlist)) {
    & $exe auto | Out-Null
    Write-Host "已生成追番清单模板：$watchlist" -ForegroundColor Yellow
    Write-Host "请把要追的番名填进 entries（enabled 改成 true 或删掉该字段），然后再运行本脚本。" -ForegroundColor Yellow
    exit 1
}

# 用 auto（清单模式）而不是 run：run 依赖本机 Watch Planner 服务，
# 那台服务不一定在这台机器上；清单模式完全本机闭环。
# --retry 6 表示一轮没下完就自动重试 6 轮，每轮都从磁盘进度继续。
$arguments = 'auto --retry 6'

$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $root

# 每 15 分钟触发一次；同时保留登录触发，保证开机后尽快跑一次。
#
# 为什么是 15 分钟：番剧播出后 30~60 分钟片源站才会出种。程序内部会按
# 「播出时刻 + readyDelayMinutes(默认60)」判断该不该找，所以 15 分钟一轮
# 既能在那之后尽快发现新种，又不会在播出当天一整天瞎搜。
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerRepeat = New-ScheduledTaskTrigger `
    -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# S4U：不需要存密码，也不需要用户登录，后台静默运行
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)

try {
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $triggerLogon, $triggerRepeat `
        -Principal $principal `
        -Settings $settings `
        -Force | Out-Null
} catch {
    Write-Host "注册计划任务失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "可以改用 4-auto.cmd 手动常驻运行。" -ForegroundColor Yellow
    exit 1
}

if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Write-Host "计划任务注册后未能读取到，请重试。" -ForegroundColor Red
    exit 1
}

# 立刻跑一次，不用等到下一个触发点
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5

$info = Get-ScheduledTaskInfo -TaskName $taskName
$savePath = (Get-Content $config -Raw | ConvertFrom-Json).download.savePath

Write-Host ''
Write-Host "全自动追番已装好：$taskName" -ForegroundColor Green
Write-Host "   程序目录：$root"
Write-Host "   追番清单：$watchlist"
Write-Host "   下载目录：$savePath"
Write-Host "   触发频率：每 15 分钟检查一次新集"
Write-Host "   单次上限：4 小时（到点由下一次触发接着下，进度不丢）"
Write-Host ''
Write-Host "   已立即启动一次（上次结果码 $($info.LastTaskResult)）。"
Write-Host "   之后无需再手动操作：有新集就下，下不完下次接着下。"
Write-Host ''
Write-Host "   想取消：运行 uninstall-startup.cmd"
Write-Host "   想看进度：看下载目录里的文件。"
