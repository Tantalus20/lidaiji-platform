/* 跨平台 npm 入口：npm run dev（本地网站 + 段评服务同源预览）。
 * 全部平台使用 Node 实现（等价于 scripts/dev-preview.sh）。
 * 参数：--port 7100 --host 127.0.0.1 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, log, die } from "./cross-platform/common.mjs";
import { buildSite } from "./cross-platform/build.mjs";

const args = process.argv.slice(2);
let host = "127.0.0.1";
let port = "7100";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") port = args[i + 1];
  if (args[i] === "--host") host = args[i + 1];
}
if (!/^\d+$/.test(port)) die("端口格式不正确。");

buildSite();

const dataDir = path.join(ROOT, ".cache", "comments-local");
ensureDir(dataDir);
const env = {
  ...process.env,
  COMMENTS_DATA_DIR: dataDir,
  COMMENTS_DB: path.join(dataDir, "comments.sqlite3"),
  COMMENTS_HOST: host,
  COMMENTS_PORT: port,
  COMMENTS_PUBLIC_ORIGIN: `http://${host}:${port}`,
  COMMENTS_STATIC_DIR: path.join(ROOT, "dist", "site"),
  COMMENTS_HMAC_SECRET: process.env.COMMENTS_HMAC_SECRET || "local-development-secret-32-bytes-minimum",
};

const cli = path.join(ROOT, "comments-service", "src", "cli.js");
const runCli = (extra) =>
  spawn("node", ["--experimental-sqlite", cli, ...extra], { stdio: "inherit", env, windowsHide: true });

runCli(["sync-manifest", path.join(ROOT, "dist", "site", "comment-manifest.json")]);
log(`本地预览（含段评服务）：http://${host}:${port}`);

const server = spawn(
  "node",
  ["--experimental-sqlite", path.join(ROOT, "comments-service", "src", "server.js")],
  { stdio: "inherit", env, windowsHide: true },
);
server.on("exit", (code) => process.exit(code ?? 0));
