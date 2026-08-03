# 查看《历代纪》作者工作台状态（只读）。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

Write-Host "历代纪作者工作台状态"
$pid0 = Get-LidaijiStudioPid
if ($pid0 -gt 0) {
    Write-Host "  进程 PID：$pid0"
    Write-Host "  健康检查：$(if (Test-LidaijiHealth) { '通过' } else { '未通过' })"
} else {
    Write-Host "  进程 PID：（无）"
    Write-Host "  健康检查：未通过"
}
Write-Host "  监听地址：仅 127.0.0.1:$Port（不对外网或局域网开放）"
Write-Host "  日志目录：$LogDir"
Write-Host "  状态目录：$StateDir"
exit 0
