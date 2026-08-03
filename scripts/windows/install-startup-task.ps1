# 安装《历代纪》Windows 登录自动启动（任务计划程序，当前用户，无需管理员）。
# 任务名称：LidaijiStudio；登录时后台启动工作台。重复安装幂等。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$taskName = "LidaijiStudio"
$taskPath = "\LidaijiStudio"
$taskFull = "$taskPath\$taskName"
$openScript = Join-Path $PSScriptRoot "open-studio.ps1"
$pwsh = (Get-Command powershell.exe).Source

# 若任务已存在，先删除（幂等）
$existing = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
    Write-Host "已移除旧任务。"
}

$action = New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null

Write-LidaijiLog "install-startup: 已注册任务 $taskFull"
Write-Host "已安装登录自动启动（任务：$taskFull）。"
Write-Host "卸载：npm run studio:uninstall（不删除文章、仓库、数据库）。"
