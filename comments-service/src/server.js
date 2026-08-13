#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./config");
const { openDatabase } = require("./db");
const { createApp } = require("./app");
const { validateManifest, syncManifest } = require("./manifest");
const { openStatsDatabase } = require("./stats");
const { startNotificationWorker } = require("./notify");

const config = loadConfig();
if (process.env.NODE_ENV === "production" && config.hmacSecret.length < 32) {
  throw new Error("生产环境COMMENTS_HMAC_SECRET必须至少32个字符。");
}
const db = openDatabase(config);
const statsDb = openStatsDatabase(config);
let manifest = { schemaVersion: 1, articles: [] };
const health = { manifest: null, stats: null };
const manifestFile = process.env.COMMENTS_MANIFEST || path.join(config.dataDir, "comment-manifest.json");
if (fs.existsSync(manifestFile)) {
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")));
    const synced = syncManifest(db, manifestFile);
    health.manifest = { ok: true, articles: synced.articles, revisions: synced.revisions, paragraphs: synced.paragraphs, omitted: synced.omitted, retiring: synced.retiring };
  } catch (error) {
    health.manifest = { ok: false, error: String(error.message || error).slice(0, 300) };
    process.stderr.write(`manifest同步失败：${error.message}\n`);
  }
}
// Share 身份清单（stats 校验 shareId 用）：缺文件时 share 命名空间 fail-closed。
// 草稿（draft=true）不进入统计身份 → 草稿 404，不得计数。
let shareManifest = { schemaVersion: 1, items: [] };
const shareManifestFile = config.shareManifest;
if (fs.existsSync(shareManifestFile)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(shareManifestFile, "utf8"));
    shareManifest = Array.isArray(parsed) ? { schemaVersion: 1, items: parsed } : parsed;
    shareManifest.items = (shareManifest.items || []).filter((item) => !item.draft);
    health.stats = { ok: true, shareItems: shareManifest.items.length };
  } catch (error) {
    health.stats = { ok: false, error: String(error.message || error).slice(0, 300) };
    process.stderr.write(`share 身份清单加载失败：${error.message}\n`);
  }
} else {
  health.stats = { ok: false, error: "share 身份清单不存在（share 统计将不可用）" };
}
const server = createApp({ db, config, manifest, health, statsDb, shareManifest });
const worker = config.operatorNotifyUrl ? startNotificationWorker({ db, config }) : null;
server.listen(config.port, config.host, () => {
  process.stdout.write(`历代纪评论服务已监听 http://${config.host}:${config.port}\n`);
});
const close = () => server.close(() => {
  if (worker) clearInterval(worker);
  statsDb.close();
  db.close();
  process.exit(0);
});
process.on("SIGTERM", close);
process.on("SIGINT", close);
