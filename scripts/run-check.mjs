/* 跨平台 npm 入口：npm run check。
 * Windows/Linux → scripts/cross-platform/check.mjs（Node 核心检查集 + 构建）；
 * macOS → scripts/check.sh（全套既有检查，行为不变）。 */

import path from "node:path";
import { ROOT, run } from "./cross-platform/common.mjs";

if (process.platform === "darwin") {
  run("bash", [path.join(ROOT, "scripts", "check.sh")]);
} else {
  run("node", [path.join(ROOT, "scripts", "cross-platform", "check.mjs")]);
}
