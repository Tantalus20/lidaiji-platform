"use strict";

// bot-api.test.js — QQ章评入口 + 统一通知任务测试（v0.5.0）。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { syncManifest } = require("../src/manifest");
const { createApp } = require("../src/app");
const { hashPassword, sha256 } = require("../src/security");
const { hmacSha256Hex } = require("../src/bot-api");

const PEPPER = "test-pepper-value-0123456789";

function fixture(over = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-bot-test-"));
  const config = loadConfig({
    dataDir: directory,
    database: path.join(directory, "comments.sqlite3"),
    publicOrigin: "http://example.test",
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    qqCommentPepper: PEPPER,
    qqBotToken: "bot-token-abc",
    ...over,
  });
  const db = openDatabase(config);
  const manifest = {
    schemaVersion: 1, generatedAt: "2026-08-05T00:00:00.000Z",
    articles: [
      {
        articleId: "article-1234567890abcdef", revision: "article-1234567890abcdef@rev1",
        title: "红颜祸水", canonicalPath: "/essays/hongyan/", paragraphComments: "open",
        sourceChecksum: "a".repeat(64), aliases: ["雅俗共赏"],
        paragraphs: [{ paragraphId: "p-111111111111", position: 0, headingContext: "", excerpt: "第一段", checksum: "b".repeat(64) }],
      },
      {
        articleId: "article-1111111111111111", revision: "article-1111111111111111@rev1",
        title: "考试机器", canonicalPath: "/essays/kaoshi/", paragraphComments: "open",
        sourceChecksum: "c".repeat(64),
        paragraphs: [{ paragraphId: "p-222222222222", position: 0, headingContext: "", excerpt: "段", checksum: "d".repeat(64) }],
      },
      {
        articleId: "article-aaaaaaaaaaaaaaaa", revision: "article-aaaaaaaaaaaaaaaa@rev1",
        title: "体面", canonicalPath: "/essays/timian-a/", paragraphComments: "open",
        sourceChecksum: "e".repeat(64),
        paragraphs: [{ paragraphId: "p-333333333333", position: 0, headingContext: "", excerpt: "段", checksum: "f".repeat(64) }],
      },
      {
        articleId: "article-bbbbbbbbbbbbbbbb", revision: "article-bbbbbbbbbbbbbbbb@rev1",
        title: "体面", canonicalPath: "/essays/timian-b/", paragraphComments: "open",
        sourceChecksum: "g".repeat(64),
        paragraphs: [{ paragraphId: "p-444444444444", position: 0, headingContext: "", excerpt: "段", checksum: "h".repeat(64) }],
      },
    ],
  };
  syncManifest(db, manifest);
  db.prepare("INSERT INTO admins(id,username,password_hash,status,created_at) VALUES('admin-1','owner',?,'active',?)")
    .run(hashPassword("very-long-test-password"), new Date().toISOString());
  const server = createApp({ db, config, manifest });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({
      directory, config, db, manifest, server, base: `http://127.0.0.1:${server.address().port}`,
      close() { return new Promise((done) => server.close(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); done(); })); },
    });
  }));
}

function botRequest(ctx, payload, token = "bot-token-abc") {
  return fetch(`${ctx.base}/api/bot/chapter-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
}

const BASE = {
  schemaVersion: 1, articleTitle: "红颜祸水", body: "这一篇真正写的不是失恋，而是女主第一次发现自己的权力并不存在。",
  displayName: "测试昵称", platform: "QQ", externalUserId: "QQ:1000001", sourceMessageId: "msg-0001", sourceGroupId: "QQ-Group:100000001",
};

test("B01 正确Token提交成功：scope=article、status=pending、source_type=qq、同事务通知任务", async () => {
  const ctx = await fixture();
  try {
    const { status, data } = await botRequest(ctx, BASE);
    assert.equal(status, 202);
    assert.equal(data.ok, true);
    assert.ok(/^CR-[A-Z0-9]{6,}$/.test(data.publicReviewId), `审核编号不可枚举：${data.publicReviewId}`);
    const row = ctx.db.prepare("SELECT * FROM comments WHERE public_review_id=?").get(data.publicReviewId);
    assert.equal(row.scope, "article");
    assert.equal(row.paragraph_id, "");
    assert.equal(row.status, "pending");
    assert.equal(row.source_type, "qq");
    assert.equal(row.article_id, "article-1234567890abcdef");
    assert.equal(row.display_name, "测试昵称");
    const task = ctx.db.prepare("SELECT * FROM comment_notification_tasks WHERE comment_id=?").get(row.id);
    assert.ok(task, "通知任务应同事务创建");
    assert.equal(task.event_type, "comment_pending_created");
    assert.equal(task.status, "pending");
  } finally { await ctx.close(); }
});

test("B02 错误Token拒绝（401 UNAUTHORIZED）", async () => {
  const ctx = await fixture();
  try {
    const { status, data } = await botRequest(ctx, BASE, "wrong-token");
    assert.equal(status, 401);
    assert.equal(data.error, "UNAUTHORIZED");
  } finally { await ctx.close(); }
});

test("B03 书名号标题与唯一别名解析", async () => {
  const ctx = await fixture();
  try {
    const r1 = await botRequest(ctx, { ...BASE, articleTitle: "《红颜祸水》", sourceMessageId: "m1" });
    assert.equal(r1.status, 202);
    const r2 = await botRequest(ctx, { ...BASE, articleTitle: "雅俗共赏", body: "雅俗共赏这条别名解析验证正文内容。", sourceMessageId: "m2" });
    assert.equal(r2.status, 202);
    assert.equal(r2.data.articleTitle, "红颜祸水");
  } finally { await ctx.close(); }
});

test("B04 无匹配与多匹配", async () => {
  const ctx = await fixture();
  try {
    const miss = await botRequest(ctx, { ...BASE, articleTitle: "不存在文章", sourceMessageId: "m3" });
    assert.equal(miss.status, 404);
    assert.equal(miss.data.error, "ARTICLE_NOT_FOUND");
    const amb = await botRequest(ctx, { ...BASE, articleTitle: "体面", sourceMessageId: "m4" });
    assert.equal(amb.status, 400);
    assert.equal(amb.data.error, "ARTICLE_AMBIGUOUS");
  } finally { await ctx.close(); }
});

test("B05 actorHash/sourceGroupHash：HMAC-pepper、不保存原QQ与群号", async () => {
  const ctx = await fixture();
  try {
    const { data } = await botRequest(ctx, BASE);
    const row = ctx.db.prepare("SELECT * FROM comments WHERE public_review_id=?").get(data.publicReviewId);
    const expectActor = hmacSha256Hex(PEPPER, "QQ|QQ:1000001");
    const expectGroup = hmacSha256Hex(PEPPER, "QQ|group|QQ-Group:100000001");
    assert.equal(row.actor_hash, expectActor);
    assert.equal(row.source_group_hash, expectGroup);
    assert.ok(!row.actor_hash.includes("1000001"), "actor_hash不得包含原QQ");
    const raw = JSON.stringify(ctx.db.prepare("SELECT * FROM comments WHERE id=?").get(row.id));
    assert.ok(!raw.includes("QQ:1000001"), "数据库不得保存完整QQ");
    assert.ok(!raw.includes("QQ-Group:100000001"), "数据库不得保存真实群号");
    const tasks = JSON.stringify(ctx.db.prepare("SELECT * FROM comment_notification_tasks").all());
    assert.ok(!tasks.includes("QQ:1000001") && !tasks.includes("QQ-Group:100000001"), "通知任务不得含QQ/群号");
  } finally { await ctx.close(); }
});

test("B06 严格消息幂等：同一sourceMessageKey返回原编号、不重复入库", async () => {
  const ctx = await fixture();
  try {
    const r1 = await botRequest(ctx, BASE);
    const r2 = await botRequest(ctx, { ...BASE, body: "完全不同的正文" });
    assert.equal(r1.status, 202);
    assert.equal(r2.status, 200);
    assert.equal(r2.data.deduplicated, true);
    assert.equal(r2.data.publicReviewId, r1.data.publicReviewId);
    const count = Number(ctx.db.prepare("SELECT COUNT(*) count FROM comments WHERE source_type='qq'").get().count);
    assert.equal(count, 1, "同一消息不得创建第二条评论");
    const tasks = Number(ctx.db.prepare("SELECT COUNT(*) count FROM comment_notification_tasks").get().count);
    assert.equal(tasks, 1, "不得创建第二条通知任务");
  } finally { await ctx.close(); }
});

test("B07 内容短期去重：同一actor+文章+正文10分钟内返回已有编号", async () => {
  const ctx = await fixture();
  try {
    const r1 = await botRequest(ctx, BASE);
    const r2 = await botRequest(ctx, { ...BASE, sourceMessageId: "msg-other", sourceGroupId: "QQ-Group:200000002" });
    assert.equal(r2.data.deduplicated, true);
    assert.equal(r2.data.publicReviewId, r1.data.publicReviewId);
  } finally { await ctx.close(); }
});

test("B08 限流：actor 10分钟3条、群1小时30条", async () => {
  const ctx = await fixture();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await botRequest(ctx, { ...BASE, body: `第${i}条评论正文`, sourceMessageId: `m${i}` });
      assert.equal(r.status, 202, `第${i}条应成功`);
    }
    const r4 = await botRequest(ctx, { ...BASE, body: "第四条评论正文内容", sourceMessageId: "m4" });
    assert.equal(r4.status, 429);
    assert.equal(r4.data.error, "RATE_LIMITED");
  } finally { await ctx.close(); }
});

test("B09 正文校验：空/过短/过长/行数/控制字符/正常HTML字符", async () => {
  const ctx = await fixture();
  try {
    const empty = await botRequest(ctx, { ...BASE, body: "", sourceMessageId: "e1" });
    assert.equal(empty.data.error, "CONTENT_TOO_SHORT");
    const short = await botRequest(ctx, { ...BASE, body: "短", sourceMessageId: "e2" });
    assert.equal(short.data.error, "CONTENT_TOO_SHORT");
    const long = await botRequest(ctx, { ...BASE, body: "字".repeat(1501), sourceMessageId: "e3" });
    assert.equal(long.data.error, "CONTENT_TOO_LONG");
    const lines = await botRequest(ctx, { ...BASE, body: Array.from({ length: 21 }, (_, i) => `第${i}行`).join("\n"), sourceMessageId: "e4" });
    assert.equal(lines.data.error, "TOO_MANY_LINES");
    const ctrl = await botRequest(ctx, { ...BASE, body: "测试\u0000控制字符", sourceMessageId: "e5" });
    assert.equal(ctrl.data.error, "INVALID_CONTENT");
    const html = await botRequest(ctx, { ...BASE, body: "正常 <b>尖括号</b> 与 & 符号", sourceMessageId: "e6" });
    assert.equal(html.status, 202, "正常<>&应允许");
    const row = ctx.db.prepare("SELECT body FROM comments WHERE public_review_id=?").get(html.data.publicReviewId);
    assert.equal(row.body, "正常 <b>尖括号</b> 与 & 符号", "数据库保存规范化纯文本，不做实体转义");
  } finally { await ctx.close(); }
});

test("B10 未知字段拒绝；昵称清洗；空昵称回退匿名读者", async () => {
  const ctx = await fixture();
  try {
    const extra = await botRequest(ctx, { ...BASE, malicious: "x", sourceMessageId: "x1" });
    assert.equal(extra.status, 400);
    assert.equal(extra.data.error, "INVALID_CONTENT");
    const nick = await botRequest(ctx, { ...BASE, body: "昵称清洗验证正文内容独立。", displayName: "名".repeat(50) + "\u0000[CQ:at,qq=1]", sourceMessageId: "x2" });
    assert.equal(nick.status, 202);
    const row = ctx.db.prepare("SELECT display_name FROM comments WHERE public_review_id=?").get(nick.data.publicReviewId);
    assert.ok(row.display_name.length <= 40);
    assert.ok(!row.display_name.includes("[CQ:"));
    const anon = await botRequest(ctx, { ...BASE, body: "匿名昵称回退验证正文内容。", displayName: "   ", sourceMessageId: "x3" });
    assert.equal(anon.status, 202);
    const row2 = ctx.db.prepare("SELECT display_name FROM comments WHERE public_review_id=?").get(anon.data.publicReviewId);
    assert.equal(row2.display_name, "匿名读者");
  } finally { await ctx.close(); }
});

test("B11 网站段评与网站章评均创建通知任务", async () => {
  const ctx = await fixture();
  try {
    const para = await fetch(`${ctx.base}/api/comments/v1/comments`, {
      method: "POST",
      headers: { Origin: "http://example.test", "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "paragraph", articleId: "article-1234567890abcdef", clientId: "browser-id-12345678",
        paragraphId: "p-111111111111", displayName: "网站读者", body: "一段网站段评正文",
      }),
    });
    assert.equal(para.status, 202);
    const article = await fetch(`${ctx.base}/api/comments/v1/comments`, {
      method: "POST",
      headers: { Origin: "http://example.test", "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "article", articleId: "article-1234567890abcdef", clientId: "browser-id-23456789",
        displayName: "网站读者", body: "这是一条网站章评正文内容。",
      }),
    });
    assert.equal(article.status, 202);
    const tasks = ctx.db.prepare("SELECT comment_id,event_type FROM comment_notification_tasks").all();
    assert.equal(tasks.length, 2, `网站段评+网站章评应有2条通知任务，当前${tasks.length}`);
  } finally { await ctx.close(); }
});

test("B12 事务失败无残留：坏articleId的网站章评不产生通知任务", async () => {
  const ctx = await fixture();
  try {
    const res = await fetch(`${ctx.base}/api/comments/v1/comments`, {
      method: "POST",
      headers: { Origin: "http://example.test", "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "article", articleId: "article-ffffffffffffffff", clientId: "browser-id-34567890",
        displayName: "x", body: "不存在的文章评论正文",
      }),
    });
    assert.equal(res.status, 400);
    const tasks = Number(ctx.db.prepare("SELECT COUNT(*) count FROM comment_notification_tasks").get().count);
    assert.equal(tasks, 0);
  } finally { await ctx.close(); }
});
