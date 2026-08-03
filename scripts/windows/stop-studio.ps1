# 停止《历代纪》作者工作台。
# 只停止经过验证（端口 4173 + 命令行含 -m studio + 项目根匹配）的进程；
# 绝不用 taskkill /IM node.exe 等误杀其他 Node 程序。

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$pidTarget = Get-LidaijiStudioPid
if ($pidTarget -eq 0) {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "作者工作台当前没有运行。"
    exit 0
}

Write-LidaijiLog "stop: 验证 PID $pidTarget（命令行/项目根匹配通过）"
# Windows 无 SIGTERM 语义；先尝试不带 /F 的 taskkill（尽力优雅），超时后强制终止。
# 强制终止会跳过 Python 的 finally 清理；下次启动时 Studio 会自动清扫临时会话目录。
# 经 cmd 执行并重定向 stderr，避免 PowerShell 5.1 的 NativeCommandError 中止脚本。
& cmd /c "taskkill /PID $pidTarget 2>nul" | Out-Null
Start-Sleep -Milliseconds 800

if (Test-LidaijiPort) {
    $again = Get-LidaijiStudioPid
    if ($again -eq $pidTarget) {
        Write-LidaijiLog "stop: 优雅停止超时，强制终止 PID $pidTarget"
        & cmd /c "taskkill /PID $pidTarget /F 2>nul" | Out-Null
    }
}

Start-Sleep -Milliseconds 500
Remove-Item $PidFile -ErrorAction SilentlyContinue
if (Test-LidaijiPort) {
    Write-Host "警告：端口 4173 仍被监听；请检查 %LOCALAPPDATA%\LidaijiStudio\Logs 日志。" -ForegroundColor Yellow
    exit 1
}
Write-LidaijiLog "stop: 已停止"
Write-Host "作者工作台已停止。"
