#!/usr/bin/env node
/* 构建《历代纪》工作台前端包：
 *   studio/app/*.mjs → studio/static/app-bundle.js
 *
 * 产物提交进公开仓库（运行时不依赖 node_modules）。
 * 修改 studio/app/ 源码后必须重新运行：npm run build:app
 * 可用环境变量 LIDAIJI_APP_OUTPUT 覆盖输出路径（供新鲜度检查使用）。
 */

import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.LIDAIJI_APP_OUTPUT || path.join(root, "studio/static/app-bundle.js");
const pkg = require(path.join(root, "package.json"));

await build({
  entryPoints: [path.join(root, "studio/app/main.mjs")],
  outfile: output,
  bundle: true,
  format: "iife",
  target: ["es2018"],
  legalComments: "inline",
  banner: {
    js: `/*! Lidaiji Studio 工作台前端包（自动生成，请勿手改）。
 * 源码：studio/app/*.mjs；重新生成：npm run build:app。
 * 平台 ${pkg.version} · Studio ${pkg.studioVersion}。 */`,
  },
});

console.log(`前端包已生成：${output}`);
