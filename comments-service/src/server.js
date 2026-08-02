#!/usr/bin/env node
"use strict";

const { loadConfig } = require("./config");
const { openDatabase } = require("./db");
const { createApp } = require("./app");

const config = loadConfig();
if (process.env.NODE_ENV === "production" && config.hmacSecret.length < 32) {
  throw new Error("生产环境COMMENTS_HMAC_SECRET必须至少32个字符。");
}
const db = openDatabase(config);
const server = createApp({ db, config });
server.listen(config.port, config.host, () => {
  process.stdout.write(`历代纪段评服务已监听 http://${config.host}:${config.port}\n`);
});
const close = () => server.close(() => {
  db.close();
  process.exit(0);
});
process.on("SIGTERM", close);
process.on("SIGINT", close);
