# 《历代纪》作者工作台 Windows 启动器公共函数。
# 只监听 127.0.0.1；日志与运行状态放在 %LOCALAPPDATA%\LidaijiStudio。

$ErrorActionPreference = "Stop"

# 仓库根目录：从脚本位置向上找到含 package.json 的目录
function Get-ProjectRoot {
    $dir = Split-Path -Parent $PSScriptRoot
    while ($dir) {
        if (Test-Path (Join-Path $dir "package.json")) { return $dir }
        $dir = Split-Path -Parent $dir
    }
    throw "找不到项目根目录（package.json）。"
}

$ProjectRoot = Get-ProjectRoot
$Port = 4173
$BaseUrl = "http://127.0.0.1:$Port/"
$StateDir = Join-Path $env:LOCALAPPDATA "LidaijiStudio"
$LogDir = Join-Path $StateDir "Logs"
$PidFile = Join-Path $StateDir "studio.pid"
$StdoutLog = Join-Path $LogDir "studio.stdout.log"
$StderrLog = Join-Path $LogDir "studio.stderr.log"
$LauncherLog = Join-Path $LogDir "launcher.log"

function New-LidaijiDirs {
    New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null
}

function Write-LidaijiLog {
    param([string]$Message)
    New-LidaijiDirs
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $LauncherLog -Value $line -Encoding UTF8
}

# 4173 是否已被监听
function Test-LidaijiPort {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        return $conn.Count -gt 0
    } catch {
        return $false
    }
}

# 校验 4173 监听进程确实是本工作台（命令行含 -m studio 且项目根匹配）
function Get-LidaijiStudioPid {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    } catch {
        return 0
    }
    if (-not $conn) { return 0 }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $proc) { return 0 }
    $cmdline = $proc.CommandLine
    if ($cmdline -notmatch "-m studio" -or $cmdline -notmatch [regex]::Escape($ProjectRoot)) { return 0 }
    return [int]$conn.OwningProcess
}

# 健康检查
function Test-LidaijiHealth {
    try {
        $resp = Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

# 等待健康检查，最多 seconds 秒
function Wait-LidaijiHealth {
    param([int]$Seconds = 15)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-LidaijiHealth) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return Test-LidaijiHealth
}

# 定位可用的 Python（项目 venv → py -3 → python）
function Get-LidaijiPython {
    $venvPy = Join-Path $ProjectRoot ".venv-importer\Scripts\python.exe"
    if (Test-Path $venvPy) { return $venvPy }
    $candidates = @("py -3", "python", "python3")
    foreach ($c in $candidates) {
        try {
            $parts = $c.Split(" ")
            & $parts[0] $parts[1..($parts.Length - 1)] -c "import docx, PIL, yaml, pypinyin" 2>$null
            if ($LASTEXITCODE -eq 0) { return $c }
        } catch { }
    }
    return ""
}
