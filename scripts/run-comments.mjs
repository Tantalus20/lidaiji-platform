/* 跨平台 npm 入口：npm run comments:init / comments:create-admin。
 * 全部平台使用 Node 实现（等价于 scripts/comments-init-local.sh 与
 * scripts/comments-create-admin-local.sh）。 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { ROOT, ensureDir, die } from "./cross-platform/common.mjs";

const event = process.env.npm_lifecycle_event || "";
const dataDir = process.env.LIDAIJI_COMMENTS_DATA || path.join(ROOT, ".cache", "comments-local");
ensureDir(dataDir);

const env = {
  ...process.env,
  COMMENTS_DATA_DIR: dataDir,
  COMMENTS_DB: path.join(dataDir, "comments.sqlite3"),
  COMMENTS_HOST: "127.0.0.1",
  COMMENTS_PORT: "4317",
  COMMENTS_PUBLIC_ORIGIN: "http://127.0.0.1:4317",
  COMMENTS_HMAC_SECRET: "local-demo-secret-change-before-production-0001",
};

function runCli(args, input) {
  const result = spawnSync(
    "node",
    ["--experimental-sqlite", path.join(ROOT, "comments-service", "src", "cli.js"), ...args],
    { stdio: ["pipe", "inherit", "inherit"], input, env, windowsHide: true },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      if (char === "\u0003") process.exit(1);
      process.stdout.write("\x1b[2K\x1b[200D");
      process.stdout.write(question);
      process.stdout.write("*".repeat(buffer.length));
    };
    const buffer = [];
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.off("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

if (event === "comments:init") {
  runCli(["migrate"]);
  console.log(`本地评论数据库已初始化：${env.COMMENTS_DB}`);
} else if (event === "comments:create-admin") {
  const username = process.argv[2] || "demo-admin";
  promptHidden("输入本地测试管理员密码（至少 12 个字符）：").then((password) => {
    if (password.length < 12) die("密码至少 12 个字符。");
    runCli(["create-admin", username], `${password}\n`);
  });
} else {
  die(`未知操作：${event}`);
}
