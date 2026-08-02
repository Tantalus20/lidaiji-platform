"use strict";

// 章评（scope=article）API 契约：提交、审核、公开列表、计数隔离与安全边界。
// 段评回归由 comments.test.js 保证，本文件只覆盖章评新增行为。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { syncManifest } = require("../src/manifest");
const { createApp } = require("../src/app");
const { hashPassword } = require("../src/security");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-article-comments-test-"));
  const config = loadConfig({
    dataDir: directory,
    database: path.join(directory, "comments.sqlite3"),
    publicOrigin: "http://example.test",
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    rateMinute: 3,
    rateHour: 15,
    rateDay: 50,
    loginTenMinutes: 8,
  });
  const db = openDatabase(config);
  syncManifest(db, {
    schemaVersion: 1,
    generatedAt: "2026-07-29T00:00:00.000Z",
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
  });
  db.prepare("INSERT INTO admins(id,username,password_hash,status,created_at) VALUES('admin-1','owner',?,'active',?)")
    .run(hashPassword("very-long-test-password"), new Date().toISOString());
  const server = createApp({ db, config });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      directory, config, db, server, base,
      close() { return new Promise((done) => server.close(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); done(); })); },
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

function articlePayload(overrides = {}) {
  return {
    scope: "article",
    articleId: "article-1234567890abcdef",
    displayName: "整章读者",
    body: "读完这一章久久不能平静，想起了自己的学生时代。",
    website: "",
    clientId: "browser-article",
    ...overrides,
  };
}

async function login(ctx) {
  const result = await request(ctx, "/api/comments/v1/admin/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: "very-long-test-password" }),
  });
  const cookie = result.response.headers.get("set-cookie").split(";")[0];
  return { ...result.body, cookie };
}

async function approveAll(ctx) {
  const session = await login(ctx);
  const ids = ctx.db.prepare("SELECT id FROM comments WHERE status='pending'").all().map((row) => row.id);
  for (const id of ids) {
    await request(ctx, `/api/comments/v1/admin/comments/${id}/approve`, {
      method: "POST", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }, body: "{}",
    });
  }
  return ids;
}

test("章评提交默认pending且伪造状态无效", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const submitted = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ status: "approved", approvedAt: "now" })) });
  assert.equal(submitted.response.status, 202);
  assert.equal(submitted.body.message, "章评已提交，等待审核。");
  const row = ctx.db.prepare("SELECT status,scope,paragraph_id,paragraph_excerpt FROM comments").get();
  assert.equal(row.status, "pending");
  assert.equal(row.scope, "article");
  assert.equal(row.paragraph_id, "");
  assert.equal(row.paragraph_excerpt, "");
  const publicList = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/article-comments");
  assert.equal(publicList.body.total, 0);
  assert.equal(publicList.body.comments.length, 0);
});

test("章评不需要也不接受paragraphId", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ paragraphId: "p-111111111111" })) });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT paragraph_id FROM comments").get().paragraph_id, "");
});

test("非法scope被拒绝", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ scope: "site" })) });
  assert.equal(result.response.status, 400);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM comments").get().count, 0);
});

test("章评长度边界：少于10字或超过3000字拒绝", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (const body of ["太短了", "　", "长".repeat(3001), "          "]) {
    const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ body })) });
    assert.equal(result.response.status, 400);
  }
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM comments").get().count, 0);
});

test("章评拒绝虚假articleId、HTML与错误Origin", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const falseArticle = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ articleId: "article-ffffffffffffffff" })) });
  assert.equal(falseArticle.response.status, 400);
  const html = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ body: "这里有<script>脚本</script>内容" })) });
  assert.equal(html.response.status, 400);
  const evil = await fetch(`${ctx.base}/api/comments/v1/comments`, {
    method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify(articlePayload()),
  });
  assert.equal(evil.status, 403);
});

test("locked与off文章拒绝新章评", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (const mode of ["locked", "off"]) {
    ctx.db.prepare("UPDATE articles SET paragraph_comments_mode=?").run(mode);
    const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ body: `模式${mode}下的章评提交测试。` })) });
    assert.equal(result.response.status, 400);
  }
});

test("章评与段评共享限流额度", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (let index = 0; index < 3; index += 1) {
    const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ body: `第${index}条不同的章评限流测试正文。` })) });
    assert.equal(result.response.status, 202);
  }
  const blocked = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ body: "第四条章评触发限流。" })) });
  assert.equal(blocked.response.status, 429);
});

test("审核通过后章评公开且带分页，计数与段评隔离", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (let index = 0; index < 7; index += 1) {
    await request(ctx, "/api/comments/v1/comments", {
      method: "POST",
      headers: { "X-Real-IP": `10.2.0.${index + 1}` },
      body: JSON.stringify(articlePayload({ body: `第${index}条公开章评内容，值得细读。`, clientId: `article-client-${index}` })),
    });
  }
  // 同一文章的段评不应混入章评计数
  await request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    headers: { "X-Real-IP": "10.2.0.99" },
    body: JSON.stringify({
      articleId: "article-1234567890abcdef", paragraphId: "p-111111111111",
      displayName: "段评读者", body: "这是段评。", website: "", clientId: "paragraph-client",
    }),
  });
  await approveAll(ctx);
  const first = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/article-comments?offset=0&limit=5");
  assert.equal(first.body.total, 7);
  assert.equal(first.body.comments.length, 5);
  const second = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/article-comments?offset=5&limit=5");
  assert.equal(second.body.comments.length, 2);
  const keys = Object.keys(first.body.comments[0]).sort();
  assert.deepEqual(keys, ["articleRevision", "body", "displayName", "id", "paragraphRevised", "publicAt"].sort());
  const serialized = JSON.stringify(first.body);
  for (const forbidden of ["fingerprint", "source_", "admin", "status", "paragraph_excerpt"]) assert.equal(serialized.includes(forbidden), false);
  const counts = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/counts");
  assert.equal(counts.body.articleCount, 7);
  assert.equal(counts.body.counts["p-111111111111"], 1);
  const paragraphList = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/paragraphs/p-111111111111");
  assert.equal(paragraphList.body.comments.length, 1);
  assert.equal(paragraphList.body.comments[0].displayName, "段评读者");
});

test("后台可以按类型筛选章评与段评", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload()) });
  await request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    headers: { "X-Real-IP": "10.3.0.1" },
    body: JSON.stringify({
      articleId: "article-1234567890abcdef", paragraphId: "p-111111111111",
      displayName: "段评读者", body: "这是段评。", website: "", clientId: "filter-para",
    }),
  });
  const session = await login(ctx);
  const articleOnly = await request(ctx, "/api/comments/v1/admin/comments?status=pending&scope=article", { headers: { Cookie: session.cookie } });
  assert.equal(articleOnly.body.total, 1);
  assert.equal(articleOnly.body.comments[0].scope, "article");
  const paragraphOnly = await request(ctx, "/api/comments/v1/admin/comments?status=pending&scope=paragraph", { headers: { Cookie: session.cookie } });
  assert.equal(paragraphOnly.body.total, 1);
  assert.equal(paragraphOnly.body.comments[0].scope, "paragraph");
  const all = await request(ctx, "/api/comments/v1/admin/comments?status=pending", { headers: { Cookie: session.cookie } });
  assert.equal(all.body.total, 2);
  assert.equal(all.body.scopeStats.article, 1);
  const invalid = await request(ctx, "/api/comments/v1/admin/comments?status=pending&scope=site", { headers: { Cookie: session.cookie } });
  assert.equal(invalid.response.status, 400);
});

test("未授权访客不能读取后台或审核章评", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload()) });
  const id = ctx.db.prepare("SELECT id FROM comments").get().id;
  const denied = await request(ctx, `/api/comments/v1/admin/comments/${id}/approve`, { method: "POST", body: "{}" });
  assert.equal(denied.response.status, 401);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending");
});

test("蜜罐章评进入spam且不公开", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ website: "bot.example" })) });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "spam");
  const counts = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/counts");
  assert.equal(counts.body.articleCount, 0);
});

test("错误响应不泄露内部路径与数据库细节", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload({ articleId: "article-0000000000000000" })) });
  const text = JSON.stringify(result.body);
  assert.equal(text.includes("sqlite"), false);
  assert.equal(text.includes("/"), false);
});

test("同步manifest不会把章评误标记为orphaned", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(articlePayload()) });
  syncManifest(ctx.db, {
    schemaVersion: 1,
    generatedAt: "2026-07-30T00:00:00.000Z",
    articles: [{
      articleId: "article-1234567890abcdef",
      revision: "article-1234567890abcdef@rev2",
      title: "测试文章",
      canonicalPath: "/essays/test/",
      paragraphComments: "open",
      sourceChecksum: "d".repeat(64),
      paragraphs: [],
    }],
  });
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending");
});
