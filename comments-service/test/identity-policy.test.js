"use strict";

// P0-production-features：评论身份策略层（disabled | cqnb）。
// 验证：匿名投稿→pending；cqnb+登录必填→401；已登录→按 AUTO_APPROVE 公开；
// 登录必填但身份模式未启用→fail-closed 500；显示名取自澄清南北身份。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { syncManifest } = require("../src/manifest");
const { createApp } = require("../src/app");
const { hashPassword } = require("../src/security");

function manifest() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-09T00:00:00.000Z",
    articles: [{
      articleId: "article-1234567890abcdef",
      revision: "article-1234567890abcdef@rev1",
      title: "测试文章",
      canonicalPath: "/essays/test/",
      paragraphComments: "open",
      sourceChecksum: "a".repeat(64),
      paragraphs: [
        { paragraphId: "p-111111111111", position: 0, headingContext: "", excerpt: "第一段摘录", checksum: "b".repeat(64) },
      ],
    }],
  };
}

function startCqnbFake() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const cookies = String(request.headers.cookie || "");
      if (!/cqnb_platform=good-session/.test(cookies)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        user: { id: "user-1122334455", username: "reader_chen", displayName: "陈读者" },
      }));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        close() { return new Promise((done) => server.close(done)); },
      });
    });
  });
}

async function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-comments-identity-"));
  const cqnb = await startCqnbFake();
  const config = loadConfig({
    dataDir: directory,
    database: path.join(directory, "comments.sqlite3"),
    publicOrigins: overrides.publicOrigins || ["http://example.test"],
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    rateMinute: 60,
    rateHour: 600,
    rateDay: 6000,
    loginTenMinutes: 8,
    identityMode: overrides.identityMode || "disabled",
    cqnbSessionUrl: `http://127.0.0.1:${cqnb.port}/api/auth/session`,
    requireCommentLogin: overrides.requireCommentLogin === true,
    autoApproveComments: overrides.autoApproveComments === true,
  });
  const db = openDatabase(config);
  syncManifest(db, manifest());
  db.prepare("INSERT INTO admins(id,username,password_hash,status,created_at) VALUES('admin-1','owner',?,'active',?)")
    .run(hashPassword("very-long-test-password"), new Date().toISOString());
  const server = createApp({ db, config });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({
      directory, config, db, server, cqnb,
      base: `http://127.0.0.1:${server.address().port}`,
      close() {
        return new Promise((done) => {
          server.close(() => {
            db.close();
            fs.rmSync(directory, { recursive: true, force: true });
            cqnb.close().then(done);
          });
        });
      },
    });
  }));
}

async function request(ctx, route, options = {}) {
  const response = await fetch(`${ctx.base}${route}`, {
    ...options,
    headers: { Origin: "http://example.test", "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

function payload(overrides = {}) {
  return {
    articleId: "article-1234567890abcdef",
    articleRevision: "article-1234567890abcdef@rev1",
    paragraphId: "p-111111111111",
    displayName: "游客小陈",
    body: "这是一条策略测试段评。",
    website: "",
    clientId: "browser-test-1234",
    ...overrides,
  };
}

test("默认 disabled：匿名投稿一律进入 pending", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending");
  assert.equal(ctx.db.prepare("SELECT display_name FROM comments").get().display_name, "游客小陈");
});

test("cqnb+登录必填+自动公开：已登录提交直接 approved，显示名取身份", async (t) => {
  const ctx = await fixture({ identityMode: "cqnb", requireCommentLogin: true, autoApproveComments: true });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    body: JSON.stringify(payload({ displayName: "伪造名" })),
    headers: { Cookie: "cqnb_platform=good-session" },
  });
  assert.equal(result.response.status, 202);
  const row = ctx.db.prepare("SELECT status, display_name FROM comments").get();
  assert.equal(row.status, "approved");
  assert.equal(row.display_name, "陈读者");
});

test("cqnb+登录必填：未登录提交返回 401", async (t) => {
  const ctx = await fixture({ identityMode: "cqnb", requireCommentLogin: true });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  assert.equal(result.response.status, 401);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) c FROM comments").get().c, 0);
});

test("cqnb+允许匿名：未登录提交进入 pending", async (t) => {
  const ctx = await fixture({ identityMode: "cqnb", requireCommentLogin: false });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending");
});

test("cqnb+自动公开但未登录（游客匿名）：仍进入 pending", async (t) => {
  const ctx = await fixture({ identityMode: "cqnb", requireCommentLogin: false, autoApproveComments: true });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending",
    "游客匿名评论必须保持默认待审核，即使开启自动公开");
});

test("cqnb+登录必填+审核制：已登录提交进入 pending", async (t) => {
  const ctx = await fixture({ identityMode: "cqnb", requireCommentLogin: true, autoApproveComments: false });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    body: JSON.stringify(payload()),
    headers: { Cookie: "cqnb_platform=good-session" },
  });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending");
});

test("登录必填但身份模式未启用：fail-closed 500 且不写入", async (t) => {
  const ctx = await fixture({ identityMode: "disabled", requireCommentLogin: true });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  assert.equal(result.response.status, 500);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) c FROM comments").get().c, 0);
});

test("多域名白名单：别名 Origin 的登录评论被接受", async (t) => {
  const ctx = await fixture({
    publicOrigins: ["http://example.test", "http://alias.test"],
    identityMode: "cqnb",
    requireCommentLogin: true,
    autoApproveComments: true,
  });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    body: JSON.stringify(payload()),
    headers: { Origin: "http://alias.test", Cookie: "cqnb_platform=good-session" },
  });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "approved");
});

test("多域名白名单：未知 Origin 仍然 403", async (t) => {
  const ctx = await fixture({ publicOrigins: ["http://example.test", "http://alias.test"] });
  t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    body: JSON.stringify(payload()),
    headers: { Origin: "http://evil.test" },
  });
  assert.equal(result.response.status, 403);
});

test("Origin 白名单解析：去尾斜杠、去重、拒绝带路径", () => {
  const config = loadConfig({ publicOrigins: "http://example.test/, http://alias.test,http://example.test" });
  assert.equal(config.publicOrigin, "http://example.test");
  assert.deepEqual(config.publicOrigins, ["http://example.test", "http://alias.test"]);
  assert.throws(() => loadConfig({ publicOrigins: "http://example.test/path" }), /只能填写站点 Origin/);
});
