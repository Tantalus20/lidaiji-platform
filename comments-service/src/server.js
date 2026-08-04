#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./config");
const { openDatabase } = require("./db");
const { createApp } = require("./app");
const { validateManifest, syncManifest } = require("./manifest");
const { startNotificationWorker } = require("./notify");

const config = loadConfig();
if (process.env.NODE_ENV === "production" && config.hmacSecret.length < 32) {
  throw new Error("生产环境COMMENTS_HMAC_SECRET必须至少32个字符。");
}
const db = openDatabase(config);
let manifest = { schemaVersion: 1, articles: [] };
const manifestFile = process.env.COMMENTS_MANIFEST || path.join(config.dataDir, "comment-manifest.json");
if (fs.existsSync(manifestFile)) {
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
    syncManifest(db, manifestFile);
  } catch (error) {
    process.stderr.write(`manifest同步失败：${error.message}\n`);
  }
}
const server = createApp({ db, config, manifest });
const worker = config.operatorNotifyUrl ? startNotificationWorker({ db, config }) : null;
server.listen(config.port, config.host, () => {
  process.stdout.write(`历代纪评论服务已监听 http://${config.host}:${config.port}\n`);
});
const close = () => server.close(() => {
  if (worker) clearInterval(worker);
  db.close();
  process.exit(0);
});
process.on("SIGTERM", close);
process.on("SIGINT", close);
