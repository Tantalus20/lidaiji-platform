# 打开《历代纪》作者工作台：未运行则后台启动，就绪后用默认浏览器打开。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

if (-not (Test-LidaijiPort)) {
    Write-LidaijiLog "open: 未运行，启动"
    & "$PSScriptRoot\start-studio.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误：作者工作台未能启动。请查看日志：$LogDir" -ForegroundColor Red
        exit 1
    }
} else {
    Write-LidaijiLog "open: 已在运行"
}

if (-not (Wait-LidaijiHealth -Seconds 8)) {
    Write-Host "错误：作者工作台未就绪。请查看日志：$LogDir" -ForegroundColor Red
    exit 1
}

Write-LidaijiLog "open: 打开 $BaseUrl"
Start-Process $BaseUrl
exit 0
