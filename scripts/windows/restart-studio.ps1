# 重新启动《历代纪》作者工作台（先停止，再后台启动）。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

& "$PSScriptRoot\stop-studio.ps1"
& "$PSScriptRoot\start-studio.ps1"
