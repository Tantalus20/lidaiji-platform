/* 跨平台 npm 入口：npm run check。
 * Windows → scripts/cross-platform/check.mjs（Node 核心检查集）；
 * macOS/Linux → scripts/check.sh（全套既有检查，行为不变）。 */

import path from "node:path";
import { IS_WIN, ROOT, run } from "./cross-platform/common.mjs";

if (IS_WIN) {
  run("node", [path.join(ROOT, "scripts", "cross-platform", "check.mjs")]);
} else {
  run("bash", [path.join(ROOT, "scripts", "check.sh")]);
}
