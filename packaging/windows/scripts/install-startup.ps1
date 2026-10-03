# 注册一个登录时自动启动的计划任务，让后台下载在开机后自动跑起来。
# 任务以当前用户身份运行，窗口最小化，不需要管理员权限。
$ErrorActionPreference = 'Stop'

$taskName = 'BangumiDownloader'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'bangumi-downloader.exe'
$config = Join-Path $root 'config.json'

if (-not (Test-Path $exe)) {
    Write-Host "找不到 bangumi-downloader.exe，请确认脚本位于解压后的目录内。" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $config)) {
    Write-Host "还没有 config.json，请先运行「1 首次配置.cmd」。" -ForegroundColor Red
    exit 1
}

$action = New-ScheduledTaskAction -Execute $exe -Argument 'run' -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
} catch {
    Write-Host "注册计划任务失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "可以改用「3 启动.cmd」手动运行。" -ForegroundColor Yellow
    exit 1
}

if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Write-Host "计划任务注册后未能读取到，请重试。" -ForegroundColor Red
    exit 1
}

Write-Host "已注册开机自启计划任务：$taskName" -ForegroundColor Green
Write-Host "工作目录：$root"
Write-Host "下次登录 Windows 后会自动在后台开始轮询并下载。"
Write-Host "需要取消时，运行「卸载开机自启.cmd」。"
