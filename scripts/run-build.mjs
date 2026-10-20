/* npm 入口：npm run build（macOS/Linux）。
 * 正式构建统一走 scripts/build.sh。
 * 环境变量：SITE_BASE_URL（发布域名）、LIDAIJI_LAYOUT_TEST_SOURCE（虚构测试内容注入）。 */

import path from "node:path";
import { ROOT, run } from "./cross-platform/common.mjs";

run("bash", [path.join(ROOT, "scripts", "build.sh"), ...process.argv.slice(2)]);
