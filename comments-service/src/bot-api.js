"use strict";

// bot-api.js — QQ章评投稿入口（受保护）。
// 错误信封：只返回固定错误码，不返回内部细节。

const crypto = require("node:crypto");
const { transaction } = require("./db");
const { randomToken, constantTimeEqual, safeText } = require("./security");

const ERRORS = Object.freeze({
  ARTICLE_NOT_FOUND: "ARTICLE_NOT_FOUND",
  ARTICLE_AMBIGUOUS: "ARTICLE_AMBIGUOUS",
  INVALID_TITLE: "INVALID_TITLE",
  INVALID_CONTENT: "INVALID_CONTENT",
  CONTENT_TOO_SHORT: "CONTENT_TOO_SHORT",
  CONTENT_TOO_LONG: "CONTENT_TOO_LONG",
  TOO_MANY_LINES: "TOO_MANY_LINES",
  RATE_LIMITED: "RATE_LIMITED",
  DUPLICATE: "DUPLICATE",
  SERVICE_DEGRADED: "SERVICE_DEGRADED",
  UNAUTHORIZED: "UNAUTHORIZED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

const ALLOWED_PAYLOAD_KEYS = new Set([
  "schemaVersion", "articleTitle", "body", "displayName", "platform",
  "externalUserId", "sourceMessageId", "sourceGroupId",
]);
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_LINES = 20;
const MAX_BODY = 1500;
const MIN_BODY = 5;
const MAX_NAME = 40;

function hmacSha256Hex(key, value) {
  return crypto.createHmac("sha256", String(key || "")).update(String(value || "")).digest("hex");
}

function normalizeTitle(raw) {
  let title = String(raw || "").trim();
  if (title.startsWith("《") && title.endsWith("》")) title = title.slice(1, -1).trim();
  return title;
}

function cleanName(raw) {
  let name = String(raw || "");
  name = name.replace(/\[CQ:[^\]]*\]/g, " ");
  name = name.replace(CONTROL_CHARS, "");
  name = name.replace(/\s+/g, " ").trim();
  const visible = name.replace(/\s+/g, "");
  if (visible.length === 0) return "匿名读者";
  return visible.slice(0, MAX_NAME);
}

function cleanBody(raw) {
  const text = String(raw || "");
  if (CONTROL_CHARS.test(text)) return { ok: false, error: ERRORS.INVALID_CONTENT };
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) return { ok: false, error: ERRORS.TOO_MANY_LINES };
  const normalized = lines.map((l) => l.replace(/\s+$/g, "")).join("\n").trim();
  const visible = normalized.replace(/\s+/g, "");
  if (visible.length < MIN_BODY) return { ok: false, error: ERRORS.CONTENT_TOO_SHORT };
  if (visible.length > MAX_BODY) return { ok: false, error: ERRORS.CONTENT_TOO_LONG };
  return { ok: true, value: normalized };
}

function resolveArticle(db, title, manifest) {
  const published = manifest.articles || [];
  const exact = published.filter((a) => a.title === title);
  if (exact.length === 1) return { kind: "ok", article: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.slice(0, 5).map((a) => a.title) };
  const alias = published.filter((a) => (a.aliases || []).includes(title));
  if (alias.length === 1) return { kind: "ok", article: alias[0] };
  if (alias.length > 1) return { kind: "ambiguous", candidates: alias.slice(0, 5).map((a) => a.title) };
  return { kind: "not_found" };
}

function newPublicReviewId() {
  return `CR-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function actorRate(db, field, value, since) {
  return Number(db.prepare(`SELECT COUNT(*) count FROM comments WHERE ${field}=? AND source_type='qq' AND created_at>=?`)
    .get(value, new Date(since).toISOString()).count);
}

function rejectIfRateLimited(db, actorHash, groupHash, now) {
  const tenMin = actorRate(db, "actor_hash", actorHash, now - 10 * 60_000);
  if (tenMin >= 3) return true;
  const day = actorRate(db, "actor_hash", actorHash, now - 24 * 3600_000);
  if (day >= 20) return true;
  if (groupHash) {
    const hour = actorRate(db, "source_group_hash", groupHash, now - 3600_000);
    if (hour >= 30) return true;
  }
  return false;
}

async function submitBotChapterReview({ request, response, db, config, manifest }) {
  if (!constantTimeEqual(config.qqBotToken, String(request.headers.authorization || "").replace(/^Bearer\s+/i, ""))) {
    throw Object.assign(new Error(ERRORS.UNAUTHORIZED), { statusCode: 401 });
  }
  const payload = JSON.parse(Buffer.concat(await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (c) => { size += c.length; if (size > config.maxBodyBytes) { reject(Object.assign(new Error(ERRORS.INVALID_CONTENT), { statusCode: 413 })); request.destroy(); return; } chunks.push(c); });
    request.on("end", () => resolve(chunks));
    request.on("error", reject);
  })).toString("utf8"));

  const extra = Object.keys(payload).filter((k) => !ALLOWED_PAYLOAD_KEYS.has(k));
  if (extra.length) throw Object.assign(new Error(ERRORS.INVALID_CONTENT), { statusCode: 400 });
  if (Number(payload.schemaVersion) !== 1) throw Object.assign(new Error(ERRORS.INVALID_CONTENT), { statusCode: 400 });

  const title = normalizeTitle(payload.articleTitle);
  if (!title) throw Object.assign(new Error(ERRORS.INVALID_TITLE), { statusCode: 400 });
  const resolved = resolveArticle(db, title, manifest);
  if (resolved.kind === "not_found") throw Object.assign(new Error(ERRORS.ARTICLE_NOT_FOUND), { statusCode: 404 });
  if (resolved.kind === "ambiguous") {
    return json(response, 400, { ok: false, error: ERRORS.ARTICLE_AMBIGUOUS, candidates: resolved.candidates });
  }

  const cleaned = cleanBody(payload.body);
  if (!cleaned.ok) throw Object.assign(new Error(cleaned.error), { statusCode: 400 });

  const platform = String(payload.platform || "").trim() || "unknown";
  const externalUserId = String(payload.externalUserId || "").trim();
  const groupId = String(payload.sourceGroupId || "").trim();
  const messageId = String(payload.sourceMessageId || "").trim();
  if (!externalUserId) throw Object.assign(new Error(ERRORS.INVALID_CONTENT), { statusCode: 400 });

  const pepper = config.qqCommentPepper;
  const actorHash = hmacSha256Hex(pepper, `${platform}|${externalUserId}`);
  const sourceGroupHash = groupId ? hmacSha256Hex(pepper, `${platform}|group|${groupId}`) : "";
  const sourceMessageKey = (groupId && messageId) ? hmacSha256Hex(pepper, `${platform}|${groupId}|${messageId}`) : "";
  const displayName = cleanName(payload.displayName);
  const now = Date.now();

  // 严格消息幂等
  if (sourceMessageKey) {
    const existing = db.prepare("SELECT public_review_id FROM comments WHERE source_type='qq' AND source_message_key=?").get(sourceMessageKey);
    if (existing && existing.public_review_id) {
      return json(response, 200, { ok: true, deduplicated: true, publicReviewId: existing.public_review_id, articleTitle: resolved.article.title, displayName });
    }
  }
  if (rejectIfRateLimited(db, actorHash, sourceGroupHash, now)) {
    throw Object.assign(new Error(ERRORS.RATE_LIMITED), { statusCode: 429 });
  }
  // 内容短期去重（10分钟）
  const bodyHash = hmacSha256Hex(pepper, cleaned.value.normalize("NFC"));
  const dup = db.prepare(`
    SELECT public_review_id FROM comments
    WHERE actor_hash=? AND article_id=? AND normalized_body_hash=? AND created_at>=?
    ORDER BY created_at ASC LIMIT 1
  `).get(actorHash, resolved.article.articleId, bodyHash, new Date(now - 10 * 60_000).toISOString());
  if (dup && dup.public_review_id) {
    return json(response, 200, { ok: true, deduplicated: true, publicReviewId: dup.public_review_id, articleTitle: resolved.article.title, displayName });
  }

  const commentId = `comment_${randomToken(12)}`;
  const publicReviewId = newPublicReviewId();
  const createdAt = new Date(now).toISOString();
  const notificationId = `ntf_${randomToken(12)}`;

  // 评论 + 通知任务同事务
  try {
    transaction(db, () => {
      db.prepare(`
        INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
          source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope,
          source_type,actor_hash,source_group_hash,source_message_key,public_review_id,normalized_body_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(commentId, resolved.article.articleId, resolved.article.revision, "", "", displayName, cleaned.value,
        "pending", `qq_${actorHash.slice(0, 16)}`, "", 0, bodyHash, createdAt, createdAt, "article",
        "qq", actorHash, sourceGroupHash, sourceMessageKey, publicReviewId, bodyHash);
      db.prepare(`
        INSERT INTO comment_notification_tasks(notification_id,comment_id,comment_public_id,event_type,status,
          attempt_count,next_attempt_at,last_error_code,relay_message_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(notificationId, commentId, publicReviewId, "comment_pending_created", "pending", 0, createdAt,
        "", "", createdAt, createdAt);
    });
  } catch (error) {
    if (error && /UNIQUE|uq_comments_qq_msgkey/.test(String(error.message))) {
      const existing = db.prepare("SELECT public_review_id FROM comments WHERE source_type='qq' AND source_message_key=?").get(sourceMessageKey);
      if (existing && existing.public_review_id) {
        return json(response, 200, { ok: true, deduplicated: true, publicReviewId: existing.public_review_id, articleTitle: resolved.article.title, displayName });
      }
    }
    throw error;
  }

  return json(response, 202, {
    ok: true, publicReviewId, articleTitle: resolved.article.title, displayName, deduplicated: false,
  }, { "Cache-Control": "no-store" });
}

function json(response, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  response.end(data);
}

module.exports = { ERRORS, submitBotChapterReview, hmacSha256Hex, cleanBody, cleanName, normalizeTitle, newPublicReviewId, resolveArticle };
