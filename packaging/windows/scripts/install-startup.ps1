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
# --sync-task：每次触发后按最新的播出安排重排这个任务的触发器。
# 这样任务计划程序本身就是「按播出时间排」的：播出前后每 15 分钟一次，
# 其余时间只有低频的「重读计划」触发，不会整天无脑跑。
$arguments = 'auto --retry 6 --sync-task'

$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $root

# 触发器：先用一套「安全兜底」，程序第一次跑完就会按播出时间重排（--sync-task）。
#
#   - 登录时：重启后补上错过的
#   - 1 分钟后一次：立刻算出播出安排并重排触发器，不用等到下一个周期
#   - 每 3 小时一次（一直重复）：**兜底**。如果 --sync-task 因为权限之类的原因
#     没成功，任务仍然是每 3 小时跑一轮，追番不会因为「触发器没排上」而彻底停摆。
#     反过来，同步成功之后这一条会被保留成「重读计划」的低频触发。
#
# 重排之后的样子：每集一段（播出 + 60 分钟开始，每 15 分钟一次，持续 12 小时），
# 加上这条 3 小时的重读计划 —— 真正干活只在播出前后。
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerBootstrap = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
$triggerRepeat = New-ScheduledTaskTrigger `
    -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 180)

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
        -Trigger $triggerLogon, $triggerBootstrap, $triggerRepeat `
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
