/* 跨平台 npm 入口：npm run build。
 * Windows → scripts/cross-platform/build.mjs（Node 构建核心）；
 * macOS/Linux → scripts/build.sh（既有行为不变）。
 * 环境变量：SITE_BASE_URL（发布域名）、LIDAIJI_LAYOUT_TEST_SOURCE（虚构测试内容注入）。 */

import path from "node:path";
import { IS_WIN, ROOT, run } from "./cross-platform/common.mjs";

const args = process.argv.slice(2);

if (IS_WIN) {
  run("node", [path.join(ROOT, "scripts", "cross-platform", "build.mjs"), ...args]);
} else {
  run("bash", [path.join(ROOT, "scripts", "build.sh"), ...args]);
}
