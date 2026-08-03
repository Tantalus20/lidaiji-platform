/* 跨平台 npm 入口：npm run studio。
 * Windows → scripts/windows/start-studio.ps1；macOS/Linux → scripts/start-studio.sh。
 * 启动参数（--port 等）原样转发。 */

import path from "node:path";
import { IS_WIN, ROOT, run } from "./cross-platform/common.mjs";

const args = process.argv.slice(2);

if (IS_WIN) {
  const ps = path.join(ROOT, "scripts", "windows", "start-studio.ps1");
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps, ...args]);
} else {
  run("bash", [path.join(ROOT, "scripts", "start-studio.sh"), ...args]);
}
