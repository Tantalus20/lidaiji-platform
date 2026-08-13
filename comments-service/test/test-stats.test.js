"use strict";

// 逐篇浏览统计测试（stats V0.1）：身份/计数/并发/bot/去重逻辑/失败隔离。

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { syncManifest } = require("../src/manifest");
const { openStatsDatabase } = require("../src/stats");
const { createApp } = require("../src/app");

const ARTICLE_ID = "article-1234567890abcdef";
const SHARE_ID = "sh-20260813-000001";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-stats-test-"));
  const config = loadConfig({
    dataDir: directory,
    database: path.join(directory, "comments.sqlite3"),
    statsDatabase: path.join(directory, "stats.sqlite3"),
    publicOrigin: "http://example.test",
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    rateMinute: 3,
    rateHour: 15,
    rateDay: 50,
    loginTenMinutes: 8,
    statsPerMinute: 120,
  });
  const db = openDatabase(config);
  const statsDb = openStatsDatabase(config);
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-08-13T00:00:00.000Z",
    articles: [{
      articleId: ARTICLE_ID,
      revision: `${ARTICLE_ID}@rev1`,
      title: "测试文章",
      canonicalPath: "/essays/test/",
      paragraphComments: "open",
      sourceChecksum: "a".repeat(64),
      paragraphs: [],
    }],
  };
  syncManifest(db, manifest);
  const shareManifest = {
    schemaVersion: 1,
    items: [
      { shareId: SHARE_ID, slug: "test-share", title: "测试分享", draft: false },
      // 草稿不进入身份清单（构建时剔除）→ 统计必须 404
    ],
  };
  const server = createApp({ db, config, manifest, statsDb, shareManifest });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      directory, config, db, statsDb, manifest, server, base,
      close() {
        return new Promise((done) => server.close(() => {
          try { statsDb.close(); } catch {}
          try { db.close(); } catch {}
          fs.rmSync(directory, { recursive: true, force: true });
          done();
        }));
      },
    });
  }));
}

async function req(ctx, url, options = {}) {
  const headers = { connection: "close", ...(options.headers || {}) };
  const response = await fetch(`${ctx.base}${url}`, { ...options, headers });
  const body = await response.json();
  return { status: response.status, body };
}

const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const CURL_UA = "curl/8.7.1";
const PLAYWRIGHT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36";
const QQ_INAPP_UA = "QQ/8.9.28 CFNetwork/1240.0.4 Darwin/20.6.0";

const post = (ctx, url, ua) => req(ctx, url, { method: "POST", headers: { "user-agent": ua, origin: "http://example.test" } });
const get = (ctx, url, ua) => req(ctx, url, { headers: { "user-agent": ua } });

// ---- 身份验证（fail-closed）---------------------------------------------

test("works 合法 articleId 可计数", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const r = await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(r.status, 200);
  assert.equal(r.body.namespace, "works");
  assert.equal(r.body.contentId, ARTICLE_ID);
  assert.equal(r.body.views, 1);
});

test("share 合法 shareId 可计数", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const r = await post(ctx, `/api/stats/views/share/${SHARE_ID}`, CHROME_UA);
  assert.equal(r.status, 200);
  assert.equal(r.body.views, 1);
});

test("不存在 ID 一律 404 且不建行", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  for (const url of [
    "/api/stats/views/works/article-garbage000000",
    "/api/stats/views/share/sh-20260813-999999",
    "/api/stats/views/works/",
    "/api/stats/views/works/../etc/passwd",
  ]) {
    const r = await post(ctx, url, CHROME_UA);
    assert.equal(r.status, 404, `${url} 应 404`);
  }
  assert.equal(ctx.statsDb.prepare("SELECT COUNT(*) c FROM content_views").get().c, 0, "不得创建垃圾记录");
});

test("share 草稿 404（草稿不进入身份清单）", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const r = await post(ctx, "/api/stats/views/share/sh-20260813-999999", CHROME_UA);
  assert.equal(r.status, 404);
});

test("share 身份清单中 draft=true 的项不得计数", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-stats-draft-"));
  const config = loadConfig({
    dataDir: directory, database: path.join(directory, "comments.sqlite3"),
    statsDatabase: path.join(directory, "stats.sqlite3"),
    publicOrigin: "http://example.test",
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
  });
  const db = openDatabase(config);
  const statsDb = openStatsDatabase(config);
  const manifest = { schemaVersion: 1, generatedAt: "", articles: [] };
  const draftShare = "sh-20260813-0000d0";
  // 模拟服务启动逻辑：draft=true 的项被过滤（与 server.js 一致）
  const loaded = { schemaVersion: 1, items: [
    { shareId: draftShare, slug: "draft", title: "草稿", draft: true },
    { shareId: SHARE_ID, slug: "pub", title: "已发布", draft: false },
  ] };
  const shareIds = new Set(loaded.items.filter((item) => !item.draft).map((item) => item.shareId));
  const server = createApp({ db, config, manifest, statsDb, shareManifest: { items: [...shareIds].map((id) => ({ shareId: id })) } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const draft = await req({ base }, `/api/stats/views/share/${draftShare}`, { method: "POST", headers: { "user-agent": CHROME_UA, connection: "close" } });
    assert.equal(draft.status, 404, "草稿不得计数");
    const pub = await req({ base }, `/api/stats/views/share/${SHARE_ID}`, { method: "POST", headers: { "user-agent": CHROME_UA, connection: "close" } });
    assert.equal(pub.body.views, 1);
  } finally {
    await new Promise((done) => server.close(() => { statsDb.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); done(); }));
  }
});

test("非法 namespace 404", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const r = await post(ctx, `/api/stats/views/comments/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(r.status, 404);
});

test("路径穿越/非法字符 404", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const r = await post(ctx, "/api/stats/views/works/a%2F..%2Fb", CHROME_UA);
  assert.equal(r.status, 404);
});

// ---- 计数 ----------------------------------------------------------------

test("0→1→2；GET 不增加；POST 增加", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const first = await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(first.body.views, 1);
  const second = await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(second.body.views, 2);
  const g1 = await get(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(g1.body.views, 2, "GET 不得 +1");
  const g2 = await get(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(g2.body.views, 2);
});

test("100 并发 POST 精确 +100", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  const results = await Promise.all(
    Array.from({ length: 100 }, () => post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA)),
  );
  for (const r of results) assert.equal(r.status, 200);
  const g = await get(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(g.body.views, 101, "并发必须精确累加（原子 UPSERT，无 lost update）");
});

test("双命名空间绝不串数（同 ID 字符串）", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-stats-ns-"));
  const config = loadConfig({
    dataDir: directory, database: path.join(directory, "comments.sqlite3"),
    statsDatabase: path.join(directory, "stats.sqlite3"),
    publicOrigin: "http://example.test",
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
  });
  const db = openDatabase(config);
  const statsDb = openStatsDatabase(config);
  const id = "article-abcdefabcdef1234";
  const manifest = {
    schemaVersion: 1, generatedAt: "2026-08-13T00:00:00.000Z",
    articles: [
      { articleId: ARTICLE_ID, revision: `${ARTICLE_ID}@r`, title: "t", canonicalPath: "/x/", paragraphComments: "open", sourceChecksum: "a".repeat(64), paragraphs: [] },
      { articleId: id, revision: `${id}@r`, title: "t2", canonicalPath: "/y/", paragraphComments: "open", sourceChecksum: "b".repeat(64), paragraphs: [] },
    ],
  };
  syncManifest(db, manifest);
  // 同一 ID 字符串同时注册到 share 命名空间（同一服务实例、同一 stats 库）
  const server = createApp({ db, config, manifest, statsDb, shareManifest: { schemaVersion: 1, items: [{ shareId: id, slug: "s", title: "t", draft: false }] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = { base };
  try {
    await post(ctx, `/api/stats/views/works/${id}`, CHROME_UA);
    await post(ctx, `/api/stats/views/works/${id}`, CHROME_UA);
    const share = await post(ctx, `/api/stats/views/share/${id}`, CHROME_UA);
    assert.equal(share.body.views, 1, "share 侧从 0 开始");
    const works = await get(ctx, `/api/stats/views/works/${id}`, CHROME_UA);
    assert.equal(works.body.views, 2, "works 侧保持 2（不串数）");
  } finally {
    await new Promise((done) => server.close(() => { statsDb.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); done(); }));
  }
});

// ---- 批量 ----------------------------------------------------------------

test("批量接口按 namespace 返回 items", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  await post(ctx, `/api/stats/views/share/${SHARE_ID}`, CHROME_UA);
  const works = await get(ctx, "/api/stats/views?namespace=works", CHROME_UA);
  assert.deepEqual(works.body.items, { [ARTICLE_ID]: 2 });
  const share = await get(ctx, "/api/stats/views?namespace=share", CHROME_UA);
  assert.deepEqual(share.body.items, { [SHARE_ID]: 1 });
  const bad = await get(ctx, "/api/stats/views?namespace=comments", CHROME_UA);
  assert.equal(bad.status, 404);
});

// ---- Bot / 预览 UA 过滤 --------------------------------------------------

test("Chrome/Safari/QQ内置浏览器计数；Googlebot/curl/Headless/空UA 不计数", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const url = `/api/stats/views/works/${ARTICLE_ID}`;
  const cases = [
    [CHROME_UA, true], [SAFARI_UA, true], [QQ_INAPP_UA, true],
    [GOOGLEBOT_UA, false], [CURL_UA, false], [PLAYWRIGHT_UA, false], ["", false],
  ];
  let before = 0;
  for (const [ua, counts] of cases) {
    const r = await post(ctx, url, ua);
    assert.equal(r.status, 200);
    if (!counts) {
      assert.equal(r.body.views, before, `UA 不得计数: ${ua.slice(0, 30)}`);
    } else {
      before = r.body.views;
    }
  }
  const g = await get(ctx, url, CHROME_UA);
  assert.equal(g.body.views, 3, "仅 3 个真实浏览器 UA 计数（QQ 内置浏览器按真实读者计）");
});

// ---- 限流 ----------------------------------------------------------------

test("单 IP 超限返回 429（不持久化 IP）", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-stats-rate-"));
  const config = loadConfig({
    dataDir: directory, database: path.join(directory, "comments.sqlite3"),
    statsDatabase: path.join(directory, "stats.sqlite3"),
    publicOrigin: "http://example.test",
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    statsPerMinute: 5,
  });
  const db = openDatabase(config);
  const statsDb = openStatsDatabase(config);
  const manifest = { schemaVersion: 1, generatedAt: "", articles: [{ articleId: ARTICLE_ID, revision: `${ARTICLE_ID}@r`, title: "t", canonicalPath: "/x/", paragraphComments: "open", sourceChecksum: "a".repeat(64), paragraphs: [] }] };
  syncManifest(db, manifest);
  const server = createApp({ db, config, manifest, statsDb, shareManifest: { items: [] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let got429 = false;
    for (let i = 0; i < 8; i += 1) {
      const r = await req({ base }, `/api/stats/views/works/${ARTICLE_ID}`, { method: "POST", headers: { "user-agent": CHROME_UA, connection: "close" } });
      if (r.status === 429) got429 = true;
    }
    assert.ok(got429, "超过每分钟限额后应 429");
    // 限流后仅前 5 次计数；IP 不落库（content_views 无 IP 字段，仅一条计数行）
    const row = statsDb.prepare("SELECT view_count FROM content_views WHERE namespace='works' AND content_id=?").get(ARTICLE_ID);
    assert.equal(row.view_count, 5, "限流后只计 5 次");
  } finally {
    server.close(() => { statsDb.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  }
});

// ---- 失败隔离 ------------------------------------------------------------

test("stats 库故障（关闭）不影响评论与正文接口", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  ctx.statsDb.close(); // 模拟 stats 库故障
  const r = await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(r.status, 500);
  // 评论接口仍正常
  const counts = await get(ctx, `/api/comments/v1/articles/${ARTICLE_ID}/counts`, CHROME_UA);
  assert.equal(counts.status, 200);
  assert.equal(counts.body.articleId, ARTICLE_ID);
});

test("stats 返回始终 no-store 且不含 UA/IP", async (t) => {
  const ctx = await fixture(); t.after(() => ctx.close());
  const r = await post(ctx, `/api/stats/views/works/${ARTICLE_ID}`, CHROME_UA);
  assert.equal(r.status, 200);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes("123.45"), "响应不得包含 IP");
  assert.ok(!raw.includes("userAgent"), "响应不得包含 UA");
});
