# 卸载《历代纪》Windows 登录自动启动（任务计划程序）。
# 只移除本项目的 LidaijiStudio 任务；不删除文章、仓库、数据库、日志或快捷方式。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$taskName = "LidaijiStudio"
$taskPath = "\LidaijiStudio"

$existing = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
    Write-LidaijiLog "uninstall-startup: 已移除任务"
    Write-Host "已移除登录自动启动任务（$taskPath\$taskName）。"
} else {
    Write-Host "登录自动启动任务不存在（可能之前已经卸载）。"
}
Write-Host "文章、仓库、数据库与配置未受影响；工作台仍可手动打开（scripts\windows\open-studio.ps1）。"
