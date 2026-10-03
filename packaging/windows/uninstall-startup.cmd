# 卸载开机自启计划任务，并结束正在运行的后台进程。
$ErrorActionPreference = 'Continue'

$taskName = 'BangumiDownloader'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "已删除计划任务：$taskName" -ForegroundColor Green
} else {
    Write-Host "没有找到计划任务 $taskName，可能本来就没装过。"
}

# 结束正在跑的守护进程（只结束本目录下的那个，避免误杀别的程序）
$processes = Get-CimInstance Win32_Process -Filter "Name = 'bangumi-downloader.exe'" -ErrorAction SilentlyContinue
$killed = 0
foreach ($process in $processes) {
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
}
if ($killed -gt 0) {
    Write-Host "已结束 $killed 个正在运行的下载进程。" -ForegroundColor Green
}

Write-Host "卸载完成。qBittorrent 里已开始的下载不受影响。"
