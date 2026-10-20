/* npm 入口：npm run studio（macOS/Linux）。
 * 统一走 scripts/start-studio.sh；启动参数（--port 等）原样转发。 */

import path from "node:path";
import { ROOT, run } from "./cross-platform/common.mjs";

run("bash", [path.join(ROOT, "scripts", "start-studio.sh"), ...process.argv.slice(2)]);
