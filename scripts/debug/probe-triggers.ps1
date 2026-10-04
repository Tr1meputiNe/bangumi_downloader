# 一次性试验：能不能在非管理员身份下改计划任务的触发器。
# 用一个临时任务试，不动正在用的那两个。
$ErrorActionPreference = 'Stop'
$name = 'BangumiDshTriggerProbe'

try {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue

  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c echo probe'
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
  # 先按「每 15 分钟」建一个，模拟现状
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal | Out-Null
  Write-Output "1. 建好：$((Get-ScheduledTask -TaskName $name).Triggers.Count) 个触发器"

  # 现在试试改成一堆「按播出时间」的触发器 + 一个刷新触发器
  $ready1 = (Get-Date).Date.AddDays(1).AddHours(22.5)
  $ready2 = (Get-Date).Date.AddDays(2).AddHours(20.5)

  $t1 = New-ScheduledTaskTrigger -Once -At $ready1
  $t1.Repetition = (New-ScheduledTaskTrigger -Once -At $ready1 -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 12)).Repetition
  $t2 = New-ScheduledTaskTrigger -Once -At $ready2
  $t2.Repetition = (New-ScheduledTaskTrigger -Once -At $ready2 -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 12)).Repetition
  $refresh = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(3) -RepetitionInterval (New-TimeSpan -Hours 3)
  $logon = New-ScheduledTaskTrigger -AtLogOn

  Set-ScheduledTask -TaskName $name -Trigger @($t1, $t2, $refresh, $logon) | Out-Null

  $after = Get-ScheduledTask -TaskName $name
  Write-Output "2. 改完：$($after.Triggers.Count) 个触发器"
  foreach ($t in $after.Triggers) {
    $kind = $t.CimClass.CimClassName
    $bits = @($kind, "start=$($t.StartBoundary)", "interval=$($t.Repetition.Interval)", "duration=$($t.Repetition.Duration)")
    Write-Output ("   " + ($bits -join ' '))
  }
  $info = Get-ScheduledTaskInfo -TaskName $name
  Write-Output "3. 下次运行：$($info.NextRunTime)"
  Write-Output "OK：非管理员也能改触发器"
} catch {
  Write-Output "FAILED：$($_.Exception.Message)"
} finally {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
