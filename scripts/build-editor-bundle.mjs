#!/usr/bin/env node
/* 构建《历代纪》编辑器前端包：
 *   studio/editor/*.mjs + ProseMirror 依赖 → studio/static/vendor/prosemirror-bundle.js
 *
 * 产物提交进公开仓库（运行时不依赖 node_modules）。
 * 修改 studio/editor/ 源码后必须重新运行：npm run build:editor
 * 可用环境变量 LIDAIJI_EDITOR_OUTPUT 覆盖输出路径（供新鲜度检查使用）。
 */

import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.LIDAIJI_EDITOR_OUTPUT || path.join(root, "studio/static/vendor/prosemirror-bundle.js");
const version = require(path.join(root, "package.json")).version;

await build({
  entryPoints: [path.join(root, "studio/editor/editor.mjs")],
  outfile: output,
  bundle: true,
  format: "iife",
  globalName: "LidaijiEditor",
  target: ["es2018"],
  legalComments: "inline",
  banner: {
    js: `/*! Lidaiji Studio 编辑器前端包（自动生成，请勿手改）。
 * 源码：studio/editor/*.mjs；重新生成：npm run build:editor。
 * 包含 ProseMirror（MIT，https://prosemirror.net）及其依赖。平台版本 ${version}。 */`,
  },
});

console.log(`编辑器包已生成：${output}`);
