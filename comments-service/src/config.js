"use strict";

const path = require("node:path");

function integer(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function normalizeOrigin(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("COMMENTS_PUBLIC_ORIGIN 含空值。");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`COMMENTS_PUBLIC_ORIGIN 不是合法地址：${raw}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`COMMENTS_PUBLIC_ORIGIN 只能填写站点 Origin（协议+主机+端口），不能带路径：${raw}`);
  }
  return url.origin;
}

function normalizeOrigins(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  const origins = [...new Set(values.map(normalizeOrigin))];
  if (!origins.length) throw new Error("COMMENTS_PUBLIC_ORIGIN 至少需要一个站点 Origin。");
  return origins;
}

function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir || process.env.COMMENTS_DATA_DIR || "/var/lib/lidaiji-comments";
  // 双域名正式站：允许用逗号分隔多个 Origin；第一个是规范 Origin（CQNB 会话校验使用）。
  const publicOrigins = Object.freeze(normalizeOrigins(
    overrides.publicOrigins ?? overrides.publicOrigin ?? process.env.COMMENTS_PUBLIC_ORIGIN ?? "http://127.0.0.1:1313",
  ));
  return Object.freeze({
    host: overrides.host || process.env.COMMENTS_HOST || "127.0.0.1",
    port: integer(overrides.port ?? process.env.COMMENTS_PORT, 4317, 1, 65535),
    dataDir,
    database: overrides.database || process.env.COMMENTS_DB || path.join(dataDir, "comments.sqlite3"),
    staticDir: overrides.staticDir || process.env.COMMENTS_STATIC_DIR || "",
    publicOrigin: publicOrigins[0],
    publicOrigins,
    hmacSecret: overrides.hmacSecret || process.env.COMMENTS_HMAC_SECRET || "development-only-secret-change-before-production",
    sessionHours: integer(overrides.sessionHours ?? process.env.COMMENTS_SESSION_HOURS, 12, 1, 168),
    trustLoopbackProxy: String(overrides.trustLoopbackProxy ?? process.env.COMMENTS_TRUST_LOOPBACK_PROXY ?? "true") === "true",
    identityMode: String(overrides.identityMode ?? process.env.COMMENTS_IDENTITY_MODE ?? "disabled"),
    cqnbSessionUrl: overrides.cqnbSessionUrl || process.env.COMMENTS_CQNB_SESSION_URL || "http://127.0.0.1:3000/api/auth/session",
    requireCommentLogin: String(overrides.requireCommentLogin ?? process.env.COMMENTS_REQUIRE_LOGIN ?? "false") === "true",
    autoApproveComments: String(overrides.autoApproveComments ?? process.env.COMMENTS_AUTO_APPROVE ?? "false") === "true",
    maxBodyBytes: integer(overrides.maxBodyBytes ?? process.env.COMMENTS_MAX_BODY_BYTES, 32_768, 1_024, 262_144),
    qqCommentPepper: String(overrides.qqCommentPepper ?? process.env.LIDAIJI_QQ_COMMENT_PEPPER ?? ""),
    qqBotToken: String(overrides.qqBotToken ?? process.env.LIDAIJI_CHAPTER_REVIEW_BOT_TOKEN ?? ""),
    operatorNotifyUrl: String(overrides.operatorNotifyUrl ?? process.env.LIDAIJI_OPERATOR_NOTIFY_URL ?? "").replace(/\/$/, ""),
    operatorNotifyToken: String(overrides.operatorNotifyToken ?? process.env.LIDAIJI_OPERATOR_NOTIFY_TOKEN ?? ""),
    rate: Object.freeze({
      minute: integer(overrides.rateMinute ?? process.env.COMMENTS_RATE_MINUTE, 3, 1, 100),
      hour: integer(overrides.rateHour ?? process.env.COMMENTS_RATE_HOUR, 15, 1, 1000),
      day: integer(overrides.rateDay ?? process.env.COMMENTS_RATE_DAY, 50, 1, 5000),
      loginTenMinutes: integer(overrides.loginTenMinutes ?? process.env.COMMENTS_LOGIN_RATE, 8, 1, 100),
    }),
  });
}

module.exports = { loadConfig };
