# 创建“历代纪作者工作台”桌面快捷方式（可选开始菜单）。
# 用法：
#   .\scripts\windows\create-shortcut.ps1              # 桌面
#   .\scripts\windows\create-shortcut.ps1 -StartMenu   # 开始菜单
# 快捷方式指向 open-studio.ps1（后台启动 + 打开浏览器）。

param(
    [switch]$StartMenu
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$openScript = Join-Path $PSScriptRoot "open-studio.ps1"
$targetDir = [Environment]::GetFolderPath("Desktop")
if ($StartMenu) {
    $targetDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
}
$lnkPath = Join-Path $targetDir "历代纪作者工作台.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = (Get-Command powershell.exe).Source
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$openScript`""
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$shortcut.Description = "历代纪作者工作台：本机写作与管理工具（127.0.0.1:4173）"
$shortcut.Save()

Write-LidaijiLog "create-shortcut: 已创建 $lnkPath"
Write-Host "已创建快捷方式：$lnkPath"
Write-Host "双击“历代纪作者工作台”即可打开工作台。"
