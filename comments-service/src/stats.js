"use strict";

// 逐篇浏览统计模块（stats V0.1）。
//
// 设计原则（任务书 V1）：
// - 统一逻辑身份 namespace + content_id：works:<articleId> / share:<shareId>；
// - 独立数据库 stats.sqlite3（与评论库互不依赖，锁/事务完全隔离）；
// - 服务端必须验证内容真实存在（works=comment-manifest，share=share 身份清单）；
// - 原子递增（UPSERT view_count+1），绝不 read→+1→write；
// - bot/爬虫/预览 UA 瞬时判断后丢弃，不计数、不落库；
// - 不持久化 IP/UA/Cookie/QQ 号/指纹；
// - 统计失败只影响统计本身，绝不影响评论/正文。
//
// 隐私：数据库仅保存 namespace/content_id/view_count/created_at/updated_at。

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const NAMESPACES = new Set(["works", "share"]);
const CONTENT_ID_RE = /^[A-Za-z0-9._\-]{1,120}$/;

// bot/爬虫/链接预览/扫描/自动化测试 UA 标记（判断后即丢弃，不落库）。
const BOT_RE = new RegExp(
  "(" + [
    "bot", "crawler", "spider", "preview", "scanner",
    "curl", "wget", "headless", "slurp",
    "googlebot", "bingbot", "baiduspider", "duckduckbot",
    "facebookexternalhit", "telegrambot", "whatsapp", "qqbots",
    "playwright", "selenium", "puppeteer", "phantomjs",
    "monitor", "uptime", "healthcheck", "lighthouse",
  ].join("|") + ")",
  "i",
);

const MIGRATION_SQL = path.resolve(__dirname, "..", "migrations-stats", "001-content-views.sql");

function openStatsDatabase(config) {
  fs.mkdirSync(path.dirname(config.statsDatabase), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.statsDatabase);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  if (!applied.has(1)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(fs.readFileSync(MIGRATION_SQL, "utf8"));
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)").run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`stats 数据库迁移失败：${error.message}`);
    }
  }
  return db;
}

function isBotUserAgent(userAgent) {
  const ua = String(userAgent || "");
  if (!ua.trim()) return true; // 无 UA（链接预览/爬虫特征）→ 不计数
  return BOT_RE.test(ua);
}

function isValidContentId(contentId) {
  return CONTENT_ID_RE.test(String(contentId || ""));
}

function validateIdentity(namespace, contentId, worksArticleIds, shareIds) {
  // fail-closed：namespace 非法 / ID 非法 / 不在公开清单 → 视为不存在（404）
  if (!NAMESPACES.has(namespace) || !isValidContentId(contentId)) return false;
  if (namespace === "works") return worksArticleIds.has(contentId);
  return shareIds.has(contentId);
}

// 原子递增：UPSERT +1，返回最新计数。
function recordView(db, namespace, contentId, nowIso) {
  const row = db.prepare(`
    INSERT INTO content_views (namespace, content_id, view_count, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(namespace, content_id)
    DO UPDATE SET view_count = content_views.view_count + 1, updated_at = excluded.updated_at
    RETURNING view_count
  `).get(namespace, contentId, nowIso, nowIso);
  return Number(row.view_count);
}

function readView(db, namespace, contentId) {
  const row = db.prepare("SELECT view_count FROM content_views WHERE namespace=? AND content_id=?")
    .get(namespace, contentId);
  return row ? Number(row.view_count) : 0;
}

function batchCounts(db, namespace) {
  const rows = db.prepare("SELECT content_id, view_count FROM content_views WHERE namespace=?").all(namespace);
  return Object.fromEntries(rows.map((row) => [row.content_id, Number(row.view_count)]));
}

// 内存限流（不持久化）：单 IP 短时间异常大量 POST。滑动窗口按分钟。
function createStatsRateLimiter(perMinute) {
  const buckets = new Map(); // ip -> [timestampMs]
  const windowMs = 60_000;
  return {
    allowed(ip) {
      const now = Date.now();
      const list = (buckets.get(ip) || []).filter((ts) => now - ts < windowMs);
      if (list.length >= perMinute) {
        buckets.set(ip, list);
        return false;
      }
      list.push(now);
      buckets.set(ip, list);
      return true;
    },
    prune() {
      const now = Date.now();
      for (const [ip, list] of buckets) {
        const kept = list.filter((ts) => now - ts < windowMs);
        if (kept.length) buckets.set(ip, kept);
        else buckets.delete(ip);
      }
    },
  };
}

module.exports = {
  NAMESPACES,
  openStatsDatabase,
  isBotUserAgent,
  isValidContentId,
  validateIdentity,
  recordView,
  readView,
  batchCounts,
  createStatsRateLimiter,
};
