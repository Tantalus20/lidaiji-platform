/* 跨平台 npm 入口：studio:open / status / stop / restart / install / uninstall。
 * 按 npm_lifecycle_event 分发：
 *   Windows → scripts/windows/*.ps1
 *   macOS   → scripts/macos/*.sh（LaunchAgent/.app 可选便利功能）
 *   Linux   → open/status/stop/restart 用 Node 内联实现；install/uninstall 给出指引
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IS_WIN, ROOT, die, log } from "./cross-platform/common.mjs";

const event = process.env.npm_lifecycle_event || "";
const tool = event.replace(/^studio:/, ""); // open/status/stop/restart/install/uninstall/setup
const PORT = 4173;
const URL = "http://127.0.0.1:4173/";

/* 一次性本机授权设置：写入评论服务管理员凭据（Keychain/600文件），
 * 凭据不进入终端回显与日志。 */
function runSetup() {
  const candidates = [
    process.env.WRITING_IMPORT_PYTHON,
    path.join(ROOT, ".venv-importer", "bin", "python3"),
    "python3",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, [path.join(ROOT, "scripts", "studio-credentials-setup.py")], {
      stdio: "inherit",
    });
    if (result.error) continue;
    process.exit(result.status ?? 1);
  }
  die("未找到 Python 运行环境，无法执行本机授权设置。");
}

if (IS_WIN) {
  const script = {
    open: "open-studio.ps1",
    status: "status-studio.ps1",
    stop: "stop-studio.ps1",
    restart: "restart-studio.ps1",
    install: "install-startup-task.ps1",
    uninstall: "uninstall-startup-task.ps1",
  }[tool];
  if (tool === "setup") runSetup();
  if (!script) die(`未知操作：${tool}`);
  const ps = path.join(ROOT, "scripts", "windows", script);
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, ...process.argv.slice(2)],
    { stdio: "inherit", windowsHide: true },
  );
  process.exit(result.status ?? 1);
}

if (process.platform === "darwin") {
  const script = {
    open: "open-studio.sh",
    status: "status-studio.sh",
    stop: "stop-studio.sh",
    restart: "restart-studio.sh",
    install: "install-launch-agent.sh",
    uninstall: "uninstall-launch-agent.sh",
  }[tool];
  if (tool === "setup") runSetup();
  if (!script) die(`未知操作：${tool}`);
  const sh = path.join(ROOT, "scripts", "macos", script);
  spawnSync("bash", [sh, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(0);
}

/* ---------- Linux：Node 内联实现 ---------- */

import { execFileSync } from "node:child_process";

function portPid() {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    }).trim();
    return out.split("\n").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

function health() {
  try {
    execFileSync("curl", ["--fail", "--silent", "--max-time", "3", "-o", "/dev/null", URL], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function waitHealth(seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (health()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return health();
}

switch (tool) {
  case "open": {
    if (!health()) {
      log("启动 Studio……");
      spawnSync("bash", [path.join(ROOT, "scripts", "start-studio.sh")], { stdio: "inherit" });
      if (!(await waitHealth(20))) die("Studio 未能启动。");
    }
    spawnSync("xdg-open", [URL], { stdio: "ignore" });
    log(`已打开：${URL}`);
    break;
  }
  case "status": {
    const pid = portPid();
    console.log("历代纪作者工作台状态");
    console.log(`  端口：127.0.0.1:${PORT}${pid ? `（PID ${pid}）` : "（未监听）"}`);
    console.log(`  健康检查：${health() ? "通过" : "未通过"}`);
    break;
  }
  case "stop": {
    const pid = portPid();
    if (!pid) {
      log("作者工作台当前没有运行。");
      break;
    }
    try {
      const cmd = execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" });
      if (!cmd.includes("-m studio") || !cmd.includes("--project-root")) {
        die(`进程 ${pid} 不是本工作台，拒绝停止。`);
      }
    } catch {
      die(`进程 ${pid} 不存在。`);
    }
    execFileSync("kill", ["-TERM", pid], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1000));
    log("作者工作台已停止。");
    break;
  }
  case "restart": {
    const pid = portPid();
    if (pid) {
      try {
        execFileSync("kill", ["-TERM", pid], { stdio: "ignore" });
      } catch {
        /* 忽略 */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    spawnSync("bash", [path.join(ROOT, "scripts", "start-studio.sh")], { stdio: "inherit" });
    if (await waitHealth(20)) log(`作者工作台已重新启动：${URL}`);
    else die("作者工作台未能恢复。");
    break;
  }
  case "install":
  case "uninstall":
    console.log(
      `Linux 上请使用桌面环境的自启动配置（或 systemd 用户服务）管理 Studio；` +
        `直接运行 npm run studio 即可启动。`,
    );
    break;
  case "setup":
    runSetup();
    break;
  default:
    die(`未知操作：${tool}`);
}
