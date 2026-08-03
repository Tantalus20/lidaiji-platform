# 后台启动《历代纪》作者工作台（只监听 127.0.0.1:4173）。
# 已运行时不重复启动；PID 与日志写入 %LOCALAPPDATA%\LidaijiStudio。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

New-LidaijiDirs

if (Test-LidaijiPort) {
    $pid0 = Get-LidaijiStudioPid
    Write-LidaijiLog "start: 已在运行（PID $pid0），跳过启动"
    Write-Host "作者工作台已在运行：$BaseUrl"
    exit 0
}

$python = Get-LidaijiPython
if (-not $python) {
    Write-Host "错误：找不到作者工作台运行环境（Python + DOCX 依赖）。请先运行 scripts\windows\setup.ps1。" -ForegroundColor Red
    exit 1
}

$parts = $python.Split(" ")
$pyExe = $parts[0]
$pyArgs = @()
if ($parts.Length -gt 1) { $pyArgs += $parts[1..($parts.Length - 1)] }
$pyArgs += @("-m", "studio", "--project-root", $ProjectRoot, "--no-browser")

$proc = Start-Process -FilePath $pyExe -ArgumentList $pyArgs -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog `
    -PassThru

Write-LidaijiLog "start: 已启动 PID $($proc.Id)（$pyExe）"
Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII

if (-not (Wait-LidaijiHealth -Seconds 30)) {
    Write-LidaijiLog "start: 健康检查超时"
    Write-Host "错误：作者工作台未能启动。请查看日志：$LogDir" -ForegroundColor Red
    exit 1
}
Write-Host "《历代纪》作者工作台已启动 $BaseUrl"
Write-Host "日志目录：$LogDir"
