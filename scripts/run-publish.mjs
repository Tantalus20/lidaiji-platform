/* npm 入口：npm run publish（macOS/Linux）。
 * 统一走 scripts/publish.sh 的 SSH/scp 发布流程。 */

import path from "node:path";
import { ROOT, run } from "./cross-platform/common.mjs";

run("bash", [path.join(ROOT, "scripts", "publish.sh"), ...process.argv.slice(2)]);
