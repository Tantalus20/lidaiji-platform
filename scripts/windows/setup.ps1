# 《历代纪》Windows 环境检查与安装。
# 用法：
#   powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
#   powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1 -CheckOnly   # 只读预检
# 不要求管理员权限；不修改系统执行策略；不自动安装第三方软件。

param(
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

function Check-Command {
    param([string]$Name, [string]$Args, [string]$Label)
    try {
        if ($Args) {
            $out = & $Name $Args 2>$null
        } else {
            $out = & $Name 2>$null
        }
        if ($LASTEXITCODE -eq 0 -or $?) { return $true }
    } catch { }
    return $false
}

$issues = @()

Write-Host "《历代纪》Windows 环境检查" -ForegroundColor Cyan
Write-Host "项目根目录：$ProjectRoot"

$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("系统：{0}（版本 {1}）" -f $os.Caption, $os.Version)
if ($os.Version -lt "10.0") { $issues += "Windows 版本过低：需要 Windows 10 或 11。" }

$node = node --version 2>$null
if ($LASTEXITCODE -eq 0 -and $node) { Write-Host "Node.js：$node" } else { $issues += "缺少 Node.js：请安装 Node.js LTS（nodejs.org），安装后重新打开终端。" }

$npm = npm --version 2>$null
if ($LASTEXITCODE -eq 0 -and $npm) { Write-Host "npm：$npm" } else { $issues += "缺少 npm：通常随 Node.js 一起安装；如缺失请重装 Node.js LTS。" }

$hugo = hugo version 2>$null
if ($LASTEXITCODE -eq 0 -and $hugo) { Write-Host "Hugo：$($hugo.Split(' ')[2])" } else { $issues += "缺少 Hugo Extended：请从 gohugo.io 下载 hugo_extended Windows 版并加入 PATH（需要 v0.162.0 或更高）。" }

$python = Get-LidaijiPython
if ($python) {
    Write-Host "Python：$python"
} else {
    $issues += "缺少 Python 及 DOCX 导入依赖：请安装 Python 3.11+（python.org），然后在项目目录执行 `python -m venv .venv-importer` 与 `.venv-importer\Scripts\pip install -r importer\requirements.txt`。"
}

$git = git --version 2>$null
if ($LASTEXITCODE -eq 0 -and $git) { Write-Host "Git：$git" } else { $issues += "缺少 Git：请安装 Git for Windows（git-scm.com）。" }

if ($issues.Count -gt 0) {
    Write-Host ""
    Write-Host "环境检查未通过：" -ForegroundColor Yellow
    $issues | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    if ($CheckOnly) { exit 2 }
    Write-Host "请先安装以上缺失软件，再重新运行本脚本。" -ForegroundColor Yellow
    exit 2
}

Write-Host "环境检查通过。"

if ($CheckOnly) {
    Write-Host "只读预检通过（未安装任何依赖）。"
    exit 0
}

Write-Host "安装项目 npm 依赖（npm install）……"
Push-Location $ProjectRoot
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败。" }
} finally {
    Pop-Location
}

Write-Host "基础自检……"
node -e "require('$ProjectRoot\package.json')" 2>$null
if (-not $?) { Write-Host "基础自检失败。" -ForegroundColor Yellow; exit 2 }

Write-Host ""
Write-Host "安装完成。日常使用：" -ForegroundColor Cyan
Write-Host "  双击桌面/开始菜单的“历代纪作者工作台”，或运行："
Write-Host "  .\scripts\windows\open-studio.ps1"
Write-Host "工作台地址：http://127.0.0.1:4173"
Write-Host "详细文档：docs/windows.md"
