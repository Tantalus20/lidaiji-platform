"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { transaction } = require("./db");
const { submitBotChapterReview } = require("./bot-api");
const { createNotificationTask } = require("./notify");
const {
  fingerprint, parseCookies, randomToken, safeText, sha256, verifyPassword,
} = require("./security");

const ADMIN_DIR = path.resolve(__dirname, "..", "admin");
const COMMENT_STATUSES = new Set(["pending", "approved", "rejected", "spam", "hidden", "deleted", "orphaned"]);
const MODERATION = new Map([
  ["approve", "approved"], ["reject", "rejected"], ["spam", "spam"], ["hide", "hidden"], ["delete", "deleted"],
]);

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

function html(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  });
  response.end(data);
}

function staticAdmin(response, name, type) {
  const data = fs.readFileSync(path.join(ADMIN_DIR, name));
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
  });
  response.end(data);
}

function developmentStatic(response, staticDir, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = path.resolve(staticDir, relative || "index.html");
  const target = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? path.join(candidate, "index.html") : candidate;
  if (!target.startsWith(`${path.resolve(staticDir)}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8" };
  const data = fs.readFileSync(target);
  response.writeHead(200, {
    "Content-Type": types[path.extname(target)] || "application/octet-stream",
    "Content-Length": data.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  });
  response.end(data);
  return true;
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求内容过大。"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("请求不是有效JSON。"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function clientAddress(request, config) {
  const remote = request.socket.remoteAddress || "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (config.trustLoopbackProxy && loopback) {
    const forwarded = String(request.headers["x-real-ip"] || "").trim();
    if (/^[0-9a-f:.]{3,64}$/i.test(forwarded)) return forwarded;
  }
  return remote;
}

function sourceFingerprint(request, config) {
  return fingerprint(config.hmacSecret, clientAddress(request, config));
}

function originAllowed(request, config) {
  const origin = String(request.headers.origin || "");
  const referer = String(request.headers.referer || "");
  return origin === config.publicOrigin || (!origin && referer.startsWith(`${config.publicOrigin}/`));
}

function isLoopbackAddress(address) {
  // 回环地址：127.0.0.0/8、::1、IPv4 映射的 ::ffff:127.x.x.x
  return address === "::1"
    || address.startsWith("127.")
    || address.startsWith("::ffff:127.");
}

function adminOriginAllowed(request, config) {
  // 管理端点：带来源头时必须是公开来源（正式站 admin 页面）；
  // 无 Origin 且无 Referer 时，只有连接来源为回环地址才放行
  // （SSH 隧道、CLI、curl）。错误 Origin 即使来自回环也拒绝。
  const origin = String(request.headers.origin || "");
  const referer = String(request.headers.referer || "");
  if (origin) return origin === config.publicOrigin;
  if (referer) return referer.startsWith(`${config.publicOrigin}/`);
  return isLoopbackAddress(String(request.socket?.remoteAddress || ""));
}

function overHttps(request) {
  return String(request.headers["x-forwarded-proto"] || "").startsWith("https")
    || String(request.headers.origin || "").startsWith("https://");
}

function publicComment(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    body: row.body,
    publicAt: row.public_at,
    articleRevision: row.article_revision,
    paragraphRevised: Boolean(row.paragraph_revised),
  };
}

function cleanup(db) {
  const now = new Date().toISOString();
  const retention = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
  db.prepare("DELETE FROM rate_limit_events WHERE created_at<?").run(retention);
}

function rateCount(db, field, value, kind, since) {
  if (!["source_fingerprint", "browser_fingerprint"].includes(field)) throw new Error("限流字段无效。");
  return Number(db.prepare(`SELECT COUNT(*) count FROM rate_limit_events WHERE ${field}=? AND kind=? AND created_at>=?`).get(value, kind, since).count);
}

function enforceSubmissionRate(db, source, browser, config) {
  const now = Date.now();
  const windows = [
    [60_000, config.rate.minute, "每分钟"],
    [3_600_000, config.rate.hour, "每小时"],
    [86_400_000, config.rate.day, "每天"],
  ];
  for (const [milliseconds, limit, label] of windows) {
    const since = new Date(now - milliseconds).toISOString();
    if (rateCount(db, "source_fingerprint", source, "comment", since) >= limit
      || rateCount(db, "browser_fingerprint", browser, "comment", since) >= limit) {
      throw Object.assign(new Error(`提交过于频繁，已达到${label}限制，请稍后再试。`), { statusCode: 429 });
    }
  }
}

function sessionFor(request, db) {
  const raw = parseCookies(request.headers.cookie).lidaiji_admin;
  if (!raw) return null;
  return db.prepare(`
    SELECT s.token_hash,s.admin_id,s.csrf_token,s.expires_at,a.username
    FROM sessions s JOIN admins a ON a.id=s.admin_id
    WHERE s.token_hash=? AND s.expires_at>? AND a.status='active'
  `).get(sha256(raw), new Date().toISOString()) || null;
}

function requireAdmin(request, db, csrf = false) {
  const session = sessionFor(request, db);
  if (!session) throw Object.assign(new Error("管理员会话无效或已经过期。"), { statusCode: 401 });
  if (csrf && String(request.headers["x-csrf-token"] || "") !== session.csrf_token) {
    throw Object.assign(new Error("CSRF校验失败，请刷新后台后重试。"), { statusCode: 403 });
  }
  return session;
}

async function submitComment(request, response, db, config) {
  if (!originAllowed(request, config)) throw Object.assign(new Error("请求来源不被接受。"), { statusCode: 403 });
  const payload = await readJson(request, config.maxBodyBytes);
  const source = sourceFingerprint(request, config);
  const scope = payload.scope === undefined || payload.scope === "paragraph" ? "paragraph" : payload.scope;
  if (!["paragraph", "article"].includes(scope)) throw Object.assign(new Error("评论类型无效。"), { statusCode: 400 });
  const articleId = String(payload.articleId || "");
  const clientId = String(payload.clientId || "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) throw Object.assign(new Error("匿名浏览器标识无效，请刷新页面后重试。"), { statusCode: 400 });
  const browser = fingerprint(config.hmacSecret, clientId);
  enforceSubmissionRate(db, source, browser, config);
  const article = db.prepare("SELECT * FROM articles WHERE article_id=?").get(articleId);
  if (!article || article.paragraph_comments_mode !== "open") throw Object.assign(new Error("这篇文章当前不接受新评论。"), { statusCode: 400 });
  let paragraphId = "";
  let paragraphExcerpt = "";
  if (scope === "paragraph") {
    paragraphId = String(payload.paragraphId || "");
    const paragraph = db.prepare(`
      SELECT * FROM paragraphs WHERE article_id=? AND revision=? AND paragraph_id=? AND status='current'
    `).get(articleId, article.current_revision, paragraphId);
    if (!paragraph) throw Object.assign(new Error("无法确认对应自然段，请刷新文章后重试。"), { statusCode: 400 });
    paragraphExcerpt = paragraph.text_excerpt;
  }
  const displayName = safeText(payload.displayName, 1, 40, "显示名");
  const label = scope === "article" ? "章评正文" : "段评正文";
  const body = safeText(payload.body, scope === "article" ? 10 : 5, 3000, label);
  const linkCount = (body.match(/(?:https?:\/\/|www\.)/gi) || []).length;
  if (linkCount > 2 || /(?:javascript|data):/i.test(body)) throw Object.assign(new Error("评论包含过多或不安全的链接。"), { statusCode: 400 });
  const duplicateHash = sha256(`${scope}\0${articleId}\0${paragraphId}\0${body.normalize("NFC").replace(/\s+/g, " ").trim()}`);
  const duplicate = db.prepare(`
    SELECT id FROM comments WHERE (source_fingerprint=? OR browser_fingerprint=?) AND duplicate_hash=? AND created_at>=?
  `).get(source, browser, duplicateHash, new Date(Date.now() - 30 * 60_000).toISOString());
  if (duplicate) throw Object.assign(new Error("相同评论已经提交，请不要重复发送。"), { statusCode: 429 });
  const honeypot = String(payload.website || "").trim();
  const status = honeypot ? "spam" : "pending";
  const id = `comment_${randomToken(12)}`;
  const now = new Date().toISOString();
  transaction(db, () => {
    db.prepare(`
      INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
        source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, articleId, article.current_revision, paragraphId, paragraphExcerpt, displayName, body, status,
      source, browser, linkCount ? 1 : 0, duplicateHash, now, now, scope);
    db.prepare(`
      INSERT INTO rate_limit_events(source_fingerprint,browser_fingerprint,article_id,paragraph_id,kind,created_at)
      VALUES(?,?,?,?,?,?)
    `).run(source, browser, articleId, paragraphId, "comment", now);
    createNotificationTask(db, { commentId: id, publicReviewId: "", now: Date.now() });
  });
  const message = scope === "article" ? "章评已提交，等待审核。" : "段评已经提交，审核通过后将公开显示。";
  json(response, 202, { ok: true, message }, { "Cache-Control": "no-store" });
}

async function adminLogin(request, response, db, config) {
  if (!adminOriginAllowed(request, config)) throw Object.assign(new Error("请求来源不被接受。"), { statusCode: 403 });
  const payload = await readJson(request, config.maxBodyBytes);
  const username = String(payload.username || "").trim();
  const source = sourceFingerprint(request, config);
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  if (rateCount(db, "source_fingerprint", source, "login", since) >= config.rate.loginTenMinutes) {
    throw Object.assign(new Error("登录尝试过多，请稍后再试。"), { statusCode: 429 });
  }
  db.prepare(`
    INSERT INTO rate_limit_events(source_fingerprint,browser_fingerprint,article_id,paragraph_id,kind,created_at)
    VALUES(?,'','','','login',?)
  `).run(source, new Date().toISOString());
  const admin = db.prepare("SELECT * FROM admins WHERE username=? AND status='active'").get(username);
  if (!admin || !verifyPassword(String(payload.password || ""), admin.password_hash)) {
    throw Object.assign(new Error("用户名或密码不正确。"), { statusCode: 401 });
  }
  const token = randomToken();
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionHours * 3600_000);
  transaction(db, () => {
    db.prepare("INSERT INTO sessions(token_hash,admin_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(sha256(token), admin.id, csrf, expires.toISOString(), now.toISOString());
    db.prepare("UPDATE admins SET last_login_at=? WHERE id=?").run(now.toISOString(), admin.id);
  });
  const cookieSecure = overHttps(request) ? "Secure; " : "";
  json(response, 200, { ok: true, username: admin.username, csrfToken: csrf }, {
    "Cache-Control": "no-store",
    "Set-Cookie": `lidaiji_admin=${token}; Path=/; HttpOnly; ${cookieSecure}SameSite=Strict; Max-Age=${config.sessionHours * 3600}`,
  });
}

function adminComments(url, response, db) {
  const status = url.searchParams.get("status") || "pending";
  if (!COMMENT_STATUSES.has(status)) throw Object.assign(new Error("筛选状态无效。"), { statusCode: 400 });
  const scope = url.searchParams.get("scope") || "all";
  if (!["all", "paragraph", "article"].includes(scope)) throw Object.assign(new Error("筛选类型无效。"), { statusCode: 400 });
  const sourceParam = url.searchParams.get("source") || "all";
  if (!["all", "qq", "website"].includes(sourceParam)) throw Object.assign(new Error("来源筛选无效。"), { statusCode: 400 });
  const page = Math.max(1, Math.min(100000, Number(url.searchParams.get("page")) || 1));
  const limit = 25;
  const articleId = String(url.searchParams.get("articleId") || "");
  const query = String(url.searchParams.get("q") || "").slice(0, 80);
  const containsLink = url.searchParams.get("containsLink") === "1";
  const duplicatesOnly = url.searchParams.get("duplicatesOnly") === "1";
  const conditions = ["c.status=?"];
  const values = [status];
  if (scope !== "all") { conditions.push("c.scope=?"); values.push(scope); }
  if (sourceParam === "qq") { conditions.push("c.source_type='qq'"); }
  if (sourceParam === "website") { conditions.push("(c.source_type='website' OR c.source_type='')"); }
  if (articleId) { conditions.push("c.article_id=?"); values.push(articleId); }
  if (query) { conditions.push("(c.display_name LIKE ? OR c.body LIKE ?)"); values.push(`%${query}%`, `%${query}%`); }
  if (containsLink) conditions.push("c.contains_link=1");
  if (duplicatesOnly) conditions.push("EXISTS(SELECT 1 FROM comments d WHERE d.duplicate_hash=c.duplicate_hash AND d.id!=c.id)");
  const where = conditions.join(" AND ");
  const total = Number(db.prepare(`SELECT COUNT(*) count FROM comments c WHERE ${where}`).get(...values).count);
  const rows = db.prepare(`
    SELECT c.id,c.article_id,c.article_revision,c.paragraph_id,c.paragraph_excerpt,c.display_name,c.body,c.status,c.scope,c.source_type,
      c.public_review_id,c.contains_link,c.created_at,c.approved_at,a.title,a.canonical_path,a.current_revision,
      COALESCE(p.text_excerpt,'') current_excerpt
    FROM comments c JOIN articles a ON a.article_id=c.article_id
    LEFT JOIN paragraphs p ON p.article_id=c.article_id AND p.revision=a.current_revision AND p.paragraph_id=c.paragraph_id
    WHERE ${where} ORDER BY c.created_at ASC LIMIT ? OFFSET ?
  `).all(...values, limit, (page - 1) * limit);
  const stats = Object.fromEntries(db.prepare("SELECT status,COUNT(*) count FROM comments GROUP BY status").all().map((row) => [row.status, Number(row.count)]));
  const scopeStats = Object.fromEntries(db.prepare("SELECT scope,COUNT(*) count FROM comments GROUP BY scope").all().map((row) => [row.scope, Number(row.count)]));
  json(response, 200, { ok: true, page, pages: Math.max(1, Math.ceil(total / limit)), total, stats, scopeStats, comments: rows }, { "Cache-Control": "no-store" });
}

function moderate(request, response, db, session, commentId, action, reason = "") {
  const status = MODERATION.get(action);
  if (!status) throw Object.assign(new Error("审核动作无效。"), { statusCode: 400 });
  const comment = db.prepare("SELECT * FROM comments WHERE id=?").get(commentId);
  if (!comment) throw Object.assign(new Error("段评不存在。"), { statusCode: 404 });
  const now = new Date().toISOString();
  transaction(db, () => {
    db.prepare(`
      UPDATE comments SET status=?,updated_at=?,approved_at=?,public_at=? WHERE id=?
    `).run(status, now, status === "approved" ? now : comment.approved_at, status === "approved" ? now : null, commentId);
    db.prepare(`
      INSERT INTO moderation_actions(comment_id,admin_id,action,previous_status,new_status,reason,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(commentId, session.admin_id, action, comment.status, status, String(reason || "").slice(0, 500), now);
  });
  json(response, 200, { ok: true, id: commentId, status }, { "Cache-Control": "no-store" });
}

function createApp({ db, config, manifest }) {
  cleanup(db);
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, config.publicOrigin);
      const method = request.method || "GET";
      if (method === "GET" && url.pathname === "/healthz") {
        const integrity = db.prepare("PRAGMA quick_check").get();
        return json(response, 200, { ok: integrity.quick_check === "ok", version: "0.5.0" }, { "Cache-Control": "no-store" });
      }
      if (method === "GET" && url.pathname === "/admin/comments/") {
        return html(response, 200, fs.readFileSync(path.join(ADMIN_DIR, "index.html"), "utf8"));
      }
      if (method === "GET" && url.pathname === "/admin/comments/admin.js") return staticAdmin(response, "admin.js", "application/javascript; charset=utf-8");
      if (method === "GET" && url.pathname === "/admin/comments/admin.css") return staticAdmin(response, "admin.css", "text/css; charset=utf-8");

      let match = url.pathname.match(/^\/api\/comments\/v1\/articles\/(article-[a-f0-9]{16})\/counts$/);
      if (method === "GET" && match) {
        const article = db.prepare("SELECT article_id FROM articles WHERE article_id=?").get(match[1]);
        if (!article) return json(response, 404, { ok: false, error: "文章不存在。" });
        const rows = db.prepare("SELECT paragraph_id,COUNT(*) count FROM comments WHERE article_id=? AND status='approved' AND scope='paragraph' GROUP BY paragraph_id").all(match[1]);
        const articleCount = Number(db.prepare("SELECT COUNT(*) count FROM comments WHERE article_id=? AND status='approved' AND scope='article'").get(match[1]).count);
        return json(response, 200, { articleId: match[1], counts: Object.fromEntries(rows.map((row) => [row.paragraph_id, Number(row.count)])), articleCount }, { "Cache-Control": "public, max-age=60" });
      }
      match = url.pathname.match(/^\/api\/comments\/v1\/articles\/(article-[a-f0-9]{16})\/article-comments$/);
      if (method === "GET" && match) {
        const article = db.prepare("SELECT article_id FROM articles WHERE article_id=?").get(match[1]);
        if (!article) return json(response, 404, { ok: false, error: "文章不存在。" });
        const offset = Math.max(0, Math.min(1_000_000, Number(url.searchParams.get("offset")) || 0));
        const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("limit")) || 5));
        const total = Number(db.prepare("SELECT COUNT(*) count FROM comments WHERE article_id=? AND status='approved' AND scope='article'").get(match[1]).count);
        const rows = db.prepare(`
          SELECT c.*,a.current_revision,(c.article_revision!=a.current_revision) paragraph_revised
          FROM comments c JOIN articles a ON a.article_id=c.article_id
          WHERE c.article_id=? AND c.scope='article' AND c.status='approved' ORDER BY c.public_at ASC LIMIT ? OFFSET ?
        `).all(match[1], limit, offset);
        return json(response, 200, { articleId: match[1], total, offset, limit, comments: rows.map(publicComment) }, { "Cache-Control": "public, max-age=60" });
      }
      match = url.pathname.match(/^\/api\/comments\/v1\/articles\/(article-[a-f0-9]{16})\/paragraphs\/(p-[a-f0-9]{12})$/);
      if (method === "GET" && match) {
        const rows = db.prepare(`
          SELECT c.*,a.current_revision,(c.article_revision!=a.current_revision) paragraph_revised
          FROM comments c JOIN articles a ON a.article_id=c.article_id
          WHERE c.article_id=? AND c.paragraph_id=? AND c.status='approved' AND c.scope='paragraph' ORDER BY c.public_at ASC
        `).all(match[1], match[2]);
        return json(response, 200, { articleId: match[1], paragraphId: match[2], comments: rows.map(publicComment) }, { "Cache-Control": "public, max-age=60" });
      }
      if (method === "POST" && url.pathname === "/api/bot/chapter-reviews") {
        return await submitBotChapterReview({ request, response, db, config, manifest });
      }
      if (method === "POST" && url.pathname === "/api/comments/v1/comments") return await submitComment(request, response, db, config);
      if (method === "POST" && url.pathname === "/api/comments/v1/admin/login") return await adminLogin(request, response, db, config);
      if (method === "GET" && url.pathname === "/api/comments/v1/admin/session") {
        const session = requireAdmin(request, db);
        return json(response, 200, { ok: true, username: session.username, csrfToken: session.csrf_token }, { "Cache-Control": "no-store" });
      }
      if (method === "POST" && url.pathname === "/api/comments/v1/admin/logout") {
        const session = requireAdmin(request, db, true);
        db.prepare("DELETE FROM sessions WHERE token_hash=?").run(session.token_hash);
        const cookieSecure = overHttps(request) ? "Secure; " : "";
        return json(response, 200, { ok: true }, {
          "Cache-Control": "no-store",
          "Set-Cookie": `lidaiji_admin=; Path=/; HttpOnly; ${cookieSecure}SameSite=Strict; Max-Age=0`,
        });
      }
      if (method === "GET" && url.pathname === "/api/comments/v1/admin/comments") {
        requireAdmin(request, db);
        return adminComments(url, response, db);
      }
      if (method === "POST" && url.pathname === "/api/comments/v1/admin/comments/batch") {
        const session = requireAdmin(request, db, true);
        const payload = await readJson(request, config.maxBodyBytes);
        const ids = [...new Set(Array.isArray(payload.ids) ? payload.ids.map(String) : [])].filter((id) => /^comment_[A-Za-z0-9_-]+$/.test(id));
        const status = MODERATION.get(String(payload.action || ""));
        if (!status || !ids.length || ids.length > 100) throw Object.assign(new Error("批量审核参数无效。"), { statusCode: 400 });
        const now = new Date().toISOString();
        const updated = transaction(db, () => {
          let count = 0;
          for (const id of ids) {
            const comment = db.prepare("SELECT * FROM comments WHERE id=?").get(id);
            if (!comment) continue;
            db.prepare("UPDATE comments SET status=?,updated_at=?,approved_at=?,public_at=? WHERE id=?")
              .run(status, now, status === "approved" ? now : comment.approved_at, status === "approved" ? now : null, id);
            db.prepare(`
              INSERT INTO moderation_actions(comment_id,admin_id,action,previous_status,new_status,reason,created_at)
              VALUES(?,?,?,?,?,?,?)
            `).run(id, session.admin_id, `batch_${payload.action}`, comment.status, status, String(payload.reason || "").slice(0, 500), now);
            count += 1;
          }
          return count;
        });
        return json(response, 200, { ok: true, updated, status }, { "Cache-Control": "no-store" });
      }
      match = url.pathname.match(/^\/api\/comments\/v1\/admin\/comments\/(comment_[A-Za-z0-9_-]+)\/(approve|reject|spam|hide|delete)$/);
      if (method === "POST" && match) {
        const session = requireAdmin(request, db, true);
        const payload = await readJson(request, config.maxBodyBytes);
        return moderate(request, response, db, session, match[1], match[2], payload.reason);
      }
      if (method === "GET" && config.staticDir && developmentStatic(response, config.staticDir, url.pathname)) return;
      json(response, 404, { ok: false, error: "接口不存在。" }, { "Cache-Control": "no-store" });
    } catch (error) {
      if (!response.headersSent) json(response, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : "服务暂时不可用。" }, { "Cache-Control": "no-store" });
    }
  });
}

module.exports = { createApp, publicComment, clientAddress, originAllowed, adminOriginAllowed, isLoopbackAddress };
