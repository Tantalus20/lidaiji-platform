/* 跨平台 npm 入口：npm run publish。
 * macOS/Linux → scripts/publish.sh（既有 SSH/scp 发布流程）。
 * Windows → 生成发布包并给出上传指引（OpenSSH 的 scp 可用时可直接上传，
 * 服务器端部署脚本由用户按其既有流程执行；完整自动化发布在 Windows 上标记为实验性）。 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, run, IS_WIN, log } from "./cross-platform/common.mjs";

if (!IS_WIN) {
  run("bash", [path.join(ROOT, "scripts", "publish.sh"), ...process.argv.slice(2)]);
  process.exit(0);
}

log("Windows 发布流程：先生成标准发布包。");
run("node", [path.join(ROOT, "scripts", "run-package.mjs")]);

const target = process.env.WRITING_SSH_TARGET || process.argv[process.argv.indexOf("--target") + 1] || "";
const domain = process.env.WRITING_DOMAIN || "";
if (target && domain) {
  log(`检测到 WRITING_SSH_TARGET=${target} 与 WRITING_DOMAIN=${domain}。`);
  const scp = spawnSync("where", ["scp"], { encoding: "utf8", windowsHide: true });
  if (scp.status === 0) {
    log("本机已安装 OpenSSH scp；请手动上传发布包后，在服务器执行部署脚本（见 docs/deployment.md）。");
    log("Windows 上的端到端自动发布为实验性支持：完整 HTTPS/服务自启/回滚验证以 Linux 服务器为准。");
  } else {
    log("未找到 scp，请使用 WinSCP 或服务器控制台上传 dist/releases/ 下的发布包。");
  }
} else {
  log("发布包已生成。请在服务器上执行既有部署脚本完成发布（见 docs/deployment.md 方案一）。");
}
