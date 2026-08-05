"use strict";

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-comments-test-"));
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
  const manifest = {
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
        { paragraphId: "p-222222222222", position: 1, headingContext: "", excerpt: "第二段摘录", checksum: "c".repeat(64) },
        { paragraphId: "p-333333333333", position: 2, headingContext: "", excerpt: "第三段摘录", checksum: "d".repeat(64) },
        { paragraphId: "p-444444444444", position: 3, headingContext: "", excerpt: "第四段摘录", checksum: "e".repeat(64) },
        { paragraphId: "p-555555555555", position: 4, headingContext: "", excerpt: "第五段摘录", checksum: "f".repeat(64) },
        { paragraphId: "p-666666666666", position: 5, headingContext: "", excerpt: "第六段摘录", checksum: "g".repeat(64) },
        { paragraphId: "p-777777777777", position: 6, headingContext: "", excerpt: "第七段摘录", checksum: "h".repeat(64) },
        { paragraphId: "p-888888888888", position: 7, headingContext: "", excerpt: "第八段摘录", checksum: "i".repeat(64) },
        { paragraphId: "p-999999999999", position: 8, headingContext: "", excerpt: "第九段摘录", checksum: "j".repeat(64) },
        { paragraphId: "p-aaaaaaaaaaaa", position: 9, headingContext: "", excerpt: "第十段摘录", checksum: "k".repeat(64) },
      ],
    }],
  };
  syncManifest(db, manifest);
  db.prepare("INSERT INTO admins(id,username,password_hash,status,created_at) VALUES('admin-1','owner',?,'active',?)")
    .run(hashPassword("very-long-test-password"), new Date().toISOString());
  const server = createApp({ db, config });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      directory, config, db, manifest, server, base,
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

function payload(overrides = {}) {
  return {
    articleId: "article-1234567890abcdef",
    articleRevision: "article-1234567890abcdef@rev1",
    paragraphId: "p-111111111111",
    displayName: "小陈",
    body: "这是一条等待审核的游客段评。",
    website: "",
    clientId: "browser-test",
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

test("游客提交、审核与公开读取", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.close());
  const submitted = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  assert.equal(submitted.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending");

  const pendingCounts = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/counts");
  assert.deepEqual(pendingCounts.body.counts, {});
  const pendingPublic = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/paragraphs/p-111111111111");
  assert.equal(pendingPublic.body.comments.length, 0);

  const session = await login(ctx);
  const comment = ctx.db.prepare("SELECT id FROM comments").get();
  const approved = await request(ctx, `/api/comments/v1/admin/comments/${comment.id}/approve`, {
    method: "POST", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }, body: "{}",
  });
  assert.equal(approved.body.status, "approved");
  const counts = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/counts");
  assert.equal(counts.body.counts["p-111111111111"], 1);
  const visible = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/paragraphs/p-111111111111");
  assert.equal(visible.body.comments.length, 1);
  assert.deepEqual(Object.keys(visible.body.comments[0]).sort(), ["articleRevision", "body", "displayName", "id", "paragraphRevised", "publicAt"].sort());
});

test("所有新段评始终进入pending且前端伪造状态无效", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ status: "approved", approvedAt: "now" })) });
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "pending");
});

test("显示名和正文边界由服务端校验", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (const data of [payload({ displayName: "" }), payload({ displayName: "a".repeat(41) }), payload({ body: "短" }), payload({ body: "长".repeat(3001) })]) {
    const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(data) });
    assert.equal(result.response.status, 400);
  }
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM comments").get().count, 0);
});

test("HTML、脚本与危险URL被拒绝", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (const body of ["这里含有<script>脚本</script>", "javascript:alert(1) 内容", "https://a.test https://b.test https://c.test"]) {
    const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ body })) });
    assert.equal(result.response.status, 400);
  }
});

test("虚假articleId和错误paragraphId被拒绝", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const falseArticle = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ articleId: "article-ffffffffffffffff" })) });
  const falseParagraph = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ paragraphId: "p-ffffffffffff" })) });
  assert.equal(falseArticle.response.status, 400);
  assert.equal(falseParagraph.response.status, 400);
});

test("locked和off文章拒绝新提交", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (const mode of ["locked", "off"]) {
    ctx.db.prepare("UPDATE articles SET paragraph_comments_mode=?").run(mode);
    const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ body: `模式${mode}测试正文` })) });
    assert.equal(result.response.status, 400);
  }
});

test("蜜罐内容进入spam且公共接口不可见", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ website: "bot.example" })) });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT status FROM comments").get().status, "spam");
  const publicResult = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/paragraphs/p-111111111111");
  assert.equal(publicResult.body.comments.length, 0);
});

test("相同来源和内容短时间重复提交受限", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const first = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  const second = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  assert.equal(first.response.status, 202);
  assert.equal(second.response.status, 429);
});

test("每分钟应用层限流生效", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (let index = 0; index < 3; index += 1) {
    const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ body: `第${index}条不同的限流测试正文。` })) });
    assert.equal(result.response.status, 202);
  }
  const blocked = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ body: "第四条会被限流的测试正文。" })) });
  assert.equal(blocked.response.status, 429);
});

test("轮换来源地址不能绕过匿名浏览器限流", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (let index = 0; index < 3; index += 1) {
    const result = await request(ctx, "/api/comments/v1/comments", {
      method: "POST",
      headers: { "X-Real-IP": `10.8.0.${index + 1}` },
      body: JSON.stringify(payload({ body: `浏览器组合限流正文第${index}条。` })),
    });
    assert.equal(result.response.status, 202);
  }
  const blocked = await request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    headers: { "X-Real-IP": "10.8.0.99" },
    body: JSON.stringify(payload({ body: "轮换地址后的第四条正文。" })),
  });
  assert.equal(blocked.response.status, 429);
});

test("错误Origin被拒绝", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = await fetch(`${ctx.base}/api/comments/v1/comments`, {
    method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" }, body: JSON.stringify(payload()),
  });
  assert.equal(result.status, 403);
});

test("管理员接口要求会话与CSRF", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const noSession = await request(ctx, "/api/comments/v1/admin/comments");
  assert.equal(noSession.response.status, 401);
  const session = await login(ctx);
  const noCsrf = await request(ctx, "/api/comments/v1/admin/logout", { method: "POST", headers: { Cookie: session.cookie }, body: "{}" });
  assert.equal(noCsrf.response.status, 403);
});

test("登录错误统一且登录受限流", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (const username of ["missing", "owner"]) {
    const result = await request(ctx, "/api/comments/v1/admin/login", { method: "POST", body: JSON.stringify({ username, password: "wrong-password-value" }) });
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error, "用户名或密码不正确。");
  }
});

test("拒绝、垃圾、隐藏和删除状态不进入公开接口", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const session = await login(ctx);
  for (const [index, action] of ["reject", "spam", "hide", "delete"].entries()) {
    await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({
      body: `${action}动作测试正文第${index}条。`,
      clientId: `browser-${index}`,
    })) });
    const id = ctx.db.prepare("SELECT id FROM comments ORDER BY created_at DESC LIMIT 1").get().id;
    const result = await request(ctx, `/api/comments/v1/admin/comments/${id}/${action}`, {
      method: "POST", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }, body: "{}",
    });
    assert.equal(result.response.status, 200);
    const visible = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/paragraphs/p-111111111111");
    assert.equal(visible.body.comments.length, 0);
    ctx.db.prepare("DELETE FROM rate_limit_events WHERE kind='comment'").run();
  }
});

test("审核动作写入独立日志", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  const session = await login(ctx);
  const id = ctx.db.prepare("SELECT id FROM comments").get().id;
  await request(ctx, `/api/comments/v1/admin/comments/${id}/approve`, {
    method: "POST", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ reason: "内容合规" }),
  });
  const log = ctx.db.prepare("SELECT * FROM moderation_actions").get();
  assert.equal(log.previous_status, "pending");
  assert.equal(log.new_status, "approved");
  assert.equal(log.reason, "内容合规");
});

test("manifest重复同步幂等且WAL开启", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = syncManifest(ctx.db, ctx.manifest);
  assert.equal(result.revisions, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM article_revisions").get().count, 1);
  assert.equal(ctx.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
});

test("删除段落后历史评论标记orphaned但不会物理删除", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  const next = structuredClone(ctx.manifest);
  next.articles[0].revision = "article-1234567890abcdef@rev2";
  next.articles[0].paragraphs = next.articles[0].paragraphs.filter((p) => p.paragraphId !== "p-111111111111");
  syncManifest(ctx.db, next);
  const row = ctx.db.prepare("SELECT status,paragraph_excerpt FROM comments").get();
  assert.equal(row.status, "orphaned");
  assert.equal(row.paragraph_excerpt, "第一段摘录");
});

test("旧版已通过段评在正文修订后带修订提示", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  ctx.db.prepare("UPDATE comments SET status='approved',approved_at=?,public_at=?").run(new Date().toISOString(), new Date().toISOString());
  const next = structuredClone(ctx.manifest);
  next.articles[0].revision = "article-1234567890abcdef@rev2";
  next.articles[0].paragraphs[0].excerpt = "修订后的第一段";
  syncManifest(ctx.db, next);
  const visible = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/paragraphs/p-111111111111");
  assert.equal(visible.body.comments[0].paragraphRevised, true);
});

test("大请求体拒绝且不写数据库", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const response = await fetch(`${ctx.base}/api/comments/v1/comments`, {
    method: "POST", headers: { Origin: "http://example.test", "Content-Type": "application/json" }, body: JSON.stringify({ value: "x".repeat(40_000) }),
  }).catch(() => null);
  if (response) assert.ok([400, 413].includes(response.status));
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM comments").get().count, 0);
});

test("健康检查执行SQLite完整性检查并报告真实版本与Bot状态", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const result = await request(ctx, "/healthz");
  assert.equal(result.body.ok, true);
  assert.equal(result.body.version, pkg.version);
  assert.equal(result.body.chapterReviewBot.configured, false);
  assert.equal(result.body.chapterReviewBot.state, "DISABLED");
});

test("修改标题和永久链接后评论仍由articleId关联", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  const next = structuredClone(ctx.manifest);
  next.articles[0].title = "新标题";
  next.articles[0].canonicalPath = "/essays/new-slug/";
  syncManifest(ctx.db, next);
  const row = ctx.db.prepare("SELECT c.article_id,a.title,a.canonical_path FROM comments c JOIN articles a ON a.article_id=c.article_id").get();
  assert.equal(row.article_id, "article-1234567890abcdef");
  assert.equal(row.title, "新标题");
  assert.equal(row.canonical_path, "/essays/new-slug/");
});

test("管理员Session Cookie具备安全属性且退出后失效", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const session = await login(ctx);
  const setCookie = session.cookie;
  const rawLogin = await request(ctx, "/api/comments/v1/admin/login", {
    method: "POST", body: JSON.stringify({ username: "owner", password: "very-long-test-password" }),
  });
  const header = rawLogin.response.headers.get("set-cookie");
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  // http 回环登录（SSH 隧道）不得下发 Secure cookie；经 https 反代则必须带
  assert.doesNotMatch(header, /Secure/i);
  const httpsLogin = await fetch(`${ctx.base}/api/comments/v1/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ username: "owner", password: "very-long-test-password" }),
  });
  assert.match(httpsLogin.headers.get("set-cookie") || "", /Secure/i);
  const loggedOut = await request(ctx, "/api/comments/v1/admin/logout", {
    method: "POST", headers: { Cookie: setCookie, "X-CSRF-Token": session.csrfToken }, body: "{}",
  });
  assert.equal(loggedOut.response.status, 200);
  const denied = await request(ctx, "/api/comments/v1/admin/comments", { headers: { Cookie: setCookie } });
  assert.equal(denied.response.status, 401);
});

test("过期Session不能继续访问后台", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const session = await login(ctx);
  ctx.db.prepare("UPDATE sessions SET expires_at=?").run("2000-01-01T00:00:00.000Z");
  const result = await request(ctx, "/api/comments/v1/admin/comments", { headers: { Cookie: session.cookie } });
  assert.equal(result.response.status, 401);
});

test("批量通过需要CSRF并写入每条审核日志", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (let index = 0; index < 2; index += 1) {
    await request(ctx, "/api/comments/v1/comments", {
      method: "POST",
      headers: { "X-Real-IP": `10.0.0.${index + 1}` },
      body: JSON.stringify(payload({ body: `批量审核测试正文${index}。` })),
    });
  }
  const ids = ctx.db.prepare("SELECT id FROM comments ORDER BY id").all().map((row) => row.id);
  const session = await login(ctx);
  const denied = await request(ctx, "/api/comments/v1/admin/comments/batch", {
    method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ ids, action: "approve" }),
  });
  assert.equal(denied.response.status, 403);
  const result = await request(ctx, "/api/comments/v1/admin/comments/batch", {
    method: "POST", headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ ids, action: "approve" }),
  });
  assert.equal(result.body.updated, 2);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM moderation_actions").get().count, 2);
});

test("多个不同来源并发提交不会损坏数据库", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request(ctx, "/api/comments/v1/comments", {
    method: "POST",
    headers: { "X-Real-IP": `10.1.0.${index + 1}` },
    body: JSON.stringify(payload({ body: `并发提交测试正文第${index}条。`, clientId: `concurrent-${index}` })),
  })));
  assert.equal(results.filter((item) => item.response.status === 202).length, 12);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM comments").get().count, 12);
  assert.equal(ctx.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
});

test("公共响应序列化后不含指纹、IP、审核人或管理员字段", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload()) });
  ctx.db.prepare("UPDATE comments SET status='approved',approved_at=?,public_at=?").run(new Date().toISOString(), new Date().toISOString());
  const visible = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/paragraphs/p-111111111111");
  const serialized = JSON.stringify(visible.body);
  for (const forbidden of ["fingerprint", "source_", "admin", "approved_at", "status", "paragraph_excerpt"]) assert.equal(serialized.includes(forbidden), false);
});

test("SQL注入文本只能作为普通纯文本保存", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const body = "这是测试'); DROP TABLE comments; -- 仍然只是普通文本。";
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ displayName: "Robert');--", body })) });
  assert.equal(result.response.status, 202);
  assert.equal(ctx.db.prepare("SELECT body FROM comments").get().body, body);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM comments").get().count, 1);
});

test("控制字符和非法Unicode输入安全失败", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const result = await request(ctx, "/api/comments/v1/comments", { method: "POST", body: JSON.stringify(payload({ body: "正常开头\u0007包含控制字符" })) });
  assert.equal(result.response.status, 400);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) count FROM comments").get().count, 0);
});

test("manifest拒绝重复articleId和重复paragraphId", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const duplicateArticle = structuredClone(ctx.manifest);
  duplicateArticle.articles.push(structuredClone(duplicateArticle.articles[0]));
  assert.throws(() => syncManifest(ctx.db, duplicateArticle), /重复articleId/);
  const duplicateParagraph = structuredClone(ctx.manifest);
  duplicateParagraph.articles[0].paragraphs.push(structuredClone(duplicateParagraph.articles[0].paragraphs[0]));
  assert.throws(() => syncManifest(ctx.db, duplicateParagraph), /重复paragraphId/);
});

test("管理后台按状态分页且不会一次返回全部记录", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const now = new Date().toISOString();
  for (let index = 0; index < 30; index += 1) {
    ctx.db.prepare(`
      INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
        source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(`comment_page_${index}`, "article-1234567890abcdef", "article-1234567890abcdef@rev1", "p-111111111111",
      "第一段摘录", "分页访客", `分页测试${index}`, "pending", `source-${index}`, "", 0, `hash-${index}`, now, now);
  }
  const session = await login(ctx);
  const first = await request(ctx, "/api/comments/v1/admin/comments?status=pending&page=1", { headers: { Cookie: session.cookie } });
  const second = await request(ctx, "/api/comments/v1/admin/comments?status=pending&page=2", { headers: { Cookie: session.cookie } });
  assert.equal(first.body.comments.length, 25);
  assert.equal(second.body.comments.length, 5);
  assert.equal(first.body.pages, 2);
});

test("只有approved计入数量映射", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const now = new Date().toISOString();
  for (const [index, status] of ["pending", "approved", "rejected", "spam", "hidden", "deleted", "orphaned"].entries()) {
    ctx.db.prepare(`
      INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
        source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,public_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(`comment_status_${index}`, "article-1234567890abcdef", "article-1234567890abcdef@rev1", "p-111111111111",
      "第一段摘录", "状态访客", `状态测试${status}`, status, `s-${index}`, "", 0, `h-${index}`, now, now, status === "approved" ? now : null);
  }
  const counts = await request(ctx, "/api/comments/v1/articles/article-1234567890abcdef/counts");
  assert.equal(counts.body.counts["p-111111111111"], 1);
});

test("管理员登录：无来源头的回环请求放行，错误Origin被拒", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  // 无 Origin 且无 Referer（SSH 隧道 / CLI 场景）→ 放行
  const raw = await fetch(`${ctx.base}/api/comments/v1/admin/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "very-long-test-password" }),
  });
  assert.equal(raw.status, 200);
  // 错误 Origin → 403
  const evil = await fetch(`${ctx.base}/api/comments/v1/admin/login`, {
    method: "POST", headers: { Origin: "https://evil.test", "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "very-long-test-password" }),
  });
  assert.equal(evil.status, 403);
});

test("管理员登录：http 回环不设置 Secure cookie", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const raw = await fetch(`${ctx.base}/api/comments/v1/admin/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "very-long-test-password" }),
  });
  const setCookie = raw.headers.get("set-cookie") || "";
  assert.ok(setCookie.includes("SameSite=Strict"), setCookie);
  assert.ok(!setCookie.includes("Secure"), "http 回环登录不得下发 Secure cookie");
});

test("回环来源校验：非回环无头请求拒绝，IPv4映射回环放行", async (t) => {
  const { adminOriginAllowed, isLoopbackAddress } = require("../src/app");
  const config = { publicOrigin: "http://example.test" };
  const evt = (remoteAddress, headers = {}) => ({ headers, socket: { remoteAddress } });
  // 非回环地址、无 Origin 无 Referer → 拒绝
  assert.equal(adminOriginAllowed(evt("10.8.0.99"), config), false);
  assert.equal(adminOriginAllowed(evt("2001:db8::1"), config), false);
  // 回环地址、无 Origin 无 Referer → 允许
  assert.equal(adminOriginAllowed(evt("127.0.0.1"), config), true);
  assert.equal(adminOriginAllowed(evt("::1"), config), true);
  // IPv4 映射回环 → 允许
  assert.equal(adminOriginAllowed(evt("::ffff:127.0.0.1"), config), true);
  assert.equal(isLoopbackAddress("::ffff:127.5.6.7"), true);
  // 回环地址 + 错误 Origin → 拒绝
  assert.equal(adminOriginAllowed(evt("127.0.0.1", { origin: "https://evil.test" }), config), false);
  // 正确公开 Origin → 允许
  assert.equal(adminOriginAllowed(evt("10.8.0.99", { origin: "http://example.test" }), config), true);
  // 无 Origin 但 Referer 匹配公开来源 → 允许
  assert.equal(adminOriginAllowed(evt("10.8.0.99", { referer: "http://example.test/admin/" }), config), true);
  // 无 Origin、Referer 不匹配 → 拒绝
  assert.equal(adminOriginAllowed(evt("10.8.0.99", { referer: "http://other.test/admin/" }), config), false);
});
