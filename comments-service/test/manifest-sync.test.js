"use strict";

// manifest-sync.test.js — 段落同步语义与大规模失效门禁（v0.5.1）

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadConfig } = require("../src/config");
const { openDatabase } = require("../src/db");
const { syncManifest, validateManifest, paragraphMode, MAX_RETIRE_ABSOLUTE } = require("../src/manifest");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-manifest-test-"));
  const config = loadConfig({
    dataDir: directory,
    database: path.join(directory, "comments.sqlite3"),
    publicOrigin: "http://example.test",
    hmacSecret: "test-secret-that-is-at-least-thirty-two-bytes",
  });
  const db = openDatabase(config);
  return { directory, db, close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function article(id = "article-1234567890abcdef", over = {}) {
  return {
    articleId: id,
    revision: `${id}@rev1`,
    title: "测试文章",
    canonicalPath: "/essays/test/",
    paragraphComments: "open",
    sourceChecksum: "a".repeat(64),
    paragraphs: [
      { paragraphId: "p-111111111111", position: 0, headingContext: "", excerpt: "第一段", checksum: "b".repeat(64) },
      { paragraphId: "p-222222222222", position: 1, headingContext: "", excerpt: "第二段", checksum: "c".repeat(64) },
    ],
    ...over,
  };
}

function tenParagraphs() {
  return Array.from({ length: 10 }, (_, i) => ({
    paragraphId: `p-${String(i + 1).padStart(12, "0")}`, position: i, headingContext: "", excerpt: `第${i + 1}段`, checksum: "c".repeat(64),
  }));
}

const count = (db, sql, ...args) => Number(db.prepare(sql).get(...args).count);

test("01 未提供paragraphs字段：段落状态完全不动", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2);
    const next = article("article-1234567890abcdef", { paragraphs: undefined, paragraphsMode: "omitted" });
    next.revision = `${next.articleId}@rev2`;
    syncManifest(db, { schemaVersion: 1, articles: [next] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2, "未提供段落不得改动");
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current' AND revision=?", `${next.articleId}@rev1`), 2);
  } finally { close(); }
});

test("02 非权威空数组（缺paragraphsMode）：不修改段落", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    syncManifest(db, { schemaVersion: 1, articles: [article("article-1234567890abcdef", { paragraphs: [] })] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2, "空数组不得清空段落");
  } finally { close(); }
});

test("03 权威完整列表正常同步", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current' AND paragraph_id='p-111111111111'"), 1);
  } finally { close(); }
});

test("04 权威空列表：被门禁拦截（>20%或>100）而非静默清空", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const empty = article("article-1234567890abcdef", { paragraphsMode: "authoritative", paragraphs: [] });
    assert.throws(
      () => syncManifest(db, { schemaVersion: 1, articles: [empty] }),
      /门禁拦截/,
      "权威空列表不得静默清空全部段落",
    );
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2, "门禁拦截后状态不变");
  } finally { close(); }
});

test("05 新增段落：插入为current，旧段保留", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const next = article("article-1234567890abcdef", {
      revision: "article-1234567890abcdef@rev2",
      paragraphs: [
        { paragraphId: "p-111111111111", position: 0, headingContext: "", excerpt: "第一段", checksum: "b".repeat(64) },
        { paragraphId: "p-222222222222", position: 1, headingContext: "", excerpt: "第二段", checksum: "c".repeat(64) },
        { paragraphId: "p-333333333333", position: 2, headingContext: "", excerpt: "第三段", checksum: "d".repeat(64) },
      ],
    });
    syncManifest(db, { schemaVersion: 1, articles: [next] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 3);
  } finally { close(); }
});

test("06 删除一个段落：被删段转historical，其余保留current", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article("article-1234567890abcdef", { paragraphs: tenParagraphs() })] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 10);
    const next = article("article-1234567890abcdef", {
      revision: "article-1234567890abcdef@rev2",
      paragraphs: tenParagraphs().slice(1),
    });
    syncManifest(db, { schemaVersion: 1, articles: [next] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 9);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='historical'"), 10, "旧rev1整组转historical");
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE paragraph_id='p-000000000001' AND status='historical'"), 1, "被删段在旧revision中保持historical");
  } finally { close(); }
});

test("07 修改一个段落：正文变化但ID稳定，仍为current", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const next = article("article-1234567890abcdef", {
      revision: "article-1234567890abcdef@rev2",
      paragraphs: [
        { paragraphId: "p-111111111111", position: 0, headingContext: "", excerpt: "第一段（修订）", checksum: "z".repeat(64) },
        { paragraphId: "p-222222222222", position: 1, headingContext: "", excerpt: "第二段", checksum: "c".repeat(64) },
      ],
    });
    syncManifest(db, { schemaVersion: 1, articles: [next] });
    const row = db.prepare("SELECT status,text_excerpt FROM paragraphs WHERE paragraph_id='p-111111111111' AND status='current'").get();
    assert.equal(row.status, "current");
    assert.equal(row.text_excerpt, "第一段（修订）");
  } finally { close(); }
});

test("08 重复paragraphId：validateManifest拒绝", () => {
  const { db, close } = fixture();
  try {
    const dup = article("article-1234567890abcdef", {
      paragraphs: [
        { paragraphId: "p-111111111111", position: 0, headingContext: "", excerpt: "a", checksum: "b".repeat(64) },
        { paragraphId: "p-111111111111", position: 1, headingContext: "", excerpt: "b", checksum: "c".repeat(64) },
      ],
    });
    assert.throws(() => validateManifest({ schemaVersion: 1, articles: [dup] }), /重复paragraphId/);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs"), 0);
  } finally { close(); }
});

test("09 文章未变化：同步幂等，段落计数不变", () => {
  const { db, close } = fixture();
  try {
    const manifest = { schemaVersion: 1, articles: [article()] };
    syncManifest(db, manifest);
    syncManifest(db, manifest);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs"), 2);
  } finally { close(); }
});

test("10 多文章同步：各自段落互不干扰", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, {
      schemaVersion: 1,
      articles: [article("article-1234567890abcdef"), article("article-1111111111111111", { title: "第二篇" })],
    });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 4);
  } finally { close(); }
});

test("11 精简manifest启动：段落状态保持，不清空", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const minimal = {
      schemaVersion: 1, generatedAt: "2026-08-05T00:00:00.000Z",
      articles: [{ ...article(), paragraphs: [], aliases: [] }],
    };
    syncManifest(db, minimal);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2, "精简清单不得清空段落");
  } finally { close(); }
});

test("12 大规模失效门禁：超过阈值拒绝（>100绝对或>20%）", () => {
  const { db, close } = fixture();
  try {
    const many = Array.from({ length: 120 }, (_, i) => ({
      paragraphId: `p-${String(i + 1).padStart(12, "0")}`, position: i, headingContext: "", excerpt: `第${i}段`, checksum: "c".repeat(64),
    }));
    syncManifest(db, { schemaVersion: 1, articles: [article("article-1234567890abcdef", { paragraphs: many })] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 120);
    const onlyOne = article("article-1234567890abcdef", {
      paragraphsMode: "authoritative",
      paragraphs: [many[0]],
    });
    assert.throws(() => syncManifest(db, { schemaVersion: 1, articles: [onlyOne] }), /门禁拦截/);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 120, "门禁后保持原状");
  } finally { close(); }
});

test("12b 门禁阈值上限：恰好100个可以接受", () => {
  const { db, close } = fixture();
  try {
    const many = Array.from({ length: 100 }, (_, i) => ({
      paragraphId: `p-${String(i + 1).padStart(12, "0")}`, position: i, headingContext: "", excerpt: `第${i}段`, checksum: "c".repeat(64),
    }));
    syncManifest(db, { schemaVersion: 1, articles: [article("article-1234567890abcdef", { paragraphs: many })] });
    const keep = article("article-1234567890abcdef", {
      paragraphsMode: "authoritative",
      paragraphs: many.slice(0, 50),
    });
    assert.throws(() => syncManifest(db, { schemaVersion: 1, articles: [keep] }), /门禁拦截/, "50/100=50%>20%");
  } finally { close(); }
});

test("12c 显式运维参数可放行大规模失效", () => {
  const { db, close } = fixture();
  try {
    const many = Array.from({ length: 120 }, (_, i) => ({
      paragraphId: `p-${String(i + 1).padStart(12, "0")}`, position: i, headingContext: "", excerpt: `第${i}段`, checksum: "c".repeat(64),
    }));
    syncManifest(db, { schemaVersion: 1, articles: [article("article-1234567890abcdef", { paragraphs: many })] });
    const onlyOne = article("article-1234567890abcdef", { paragraphsMode: "authoritative", paragraphs: [many[0]] });
    const result = syncManifest(db, { schemaVersion: 1, articles: [onlyOne] }, { allowLargeRetire: true });
    assert.equal(result.retiring, 119);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 1);
  } finally { close(); }
});

test("13 恢复current：历史段落可经权威清单恢复", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    db.prepare("UPDATE paragraphs SET status='historical'").run();
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 0);
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2);
  } finally { close(); }
});

test("14 historical保留：未出现在权威清单中的旧段落保持historical", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article("article-1234567890abcdef", { paragraphs: tenParagraphs() })] });
    const next = article("article-1234567890abcdef", {
      revision: "article-1234567890abcdef@rev2",
      paragraphs: tenParagraphs().slice(0, 9),
    });
    syncManifest(db, { schemaVersion: 1, articles: [next] });
    syncManifest(db, { schemaVersion: 1, articles: [next] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='historical'"), 10, "旧rev1段落保持historical");
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs"), 19, "10个rev1 + 9个rev2");
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE paragraph_id='p-000000000010' AND revision='article-1234567890abcdef@rev1' AND status='historical'"), 1);
  } finally { close(); }
});

test("15 现有段评关联不变：段落失效与恢复不影响comments行", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    db.prepare(`
      INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
        source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope)
      VALUES('comment_test1',?,?,'p-111111111111','第一段','测试','这是一条测试段评。','approved','a','b',0,'h','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z','paragraph')
    `).run("article-1234567890abcdef", "article-1234567890abcdef@rev1");
    db.prepare("UPDATE paragraphs SET status='historical'").run();
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const row = db.prepare("SELECT status FROM comments WHERE id='comment_test1'").get();
    assert.equal(row.status, "approved", "段落状态变化不得改动评论状态");
    const para = db.prepare("SELECT status FROM paragraphs WHERE paragraph_id='p-111111111111'").get();
    assert.equal(para.status, "current");
  } finally { close(); }
});

test("16 段评计数恢复：权威清单同步后按段落计数正确", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    db.prepare(`
      INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
        source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope)
      VALUES('comment_c1',?,?,'p-222222222222','第二段','测试','段评正文内容足够长。','approved','a','b',0,'h','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z','paragraph')
    `).run("article-1234567890abcdef", "article-1234567890abcdef@rev1");
    db.prepare("UPDATE paragraphs SET status='historical'").run();
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const rows = db.prepare(`
      SELECT paragraph_id,COUNT(*) count FROM comments
      WHERE article_id=? AND status='approved' AND scope='paragraph' GROUP BY paragraph_id
    `).all("article-1234567890abcdef");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].paragraph_id, "p-222222222222");
  } finally { close(); }
});

test("17 新段评可提交：恢复后的current段落可供段评使用", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    db.prepare("UPDATE paragraphs SET status='historical'").run();
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const found = db.prepare(`
      SELECT * FROM paragraphs WHERE article_id=? AND revision=? AND paragraph_id=? AND status='current'
    `).get("article-1234567890abcdef", "article-1234567890abcdef@rev1", "p-111111111111");
    assert.ok(found, "提交段评所需的current段落必须存在");
  } finally { close(); }
});

test("18 章评不受影响：article scope评论与段落状态无关", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    db.prepare(`
      INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
        source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope)
      VALUES('comment_a1',?,?,'','','测试','章评正文内容足够长。','approved','a','b',0,'h','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z','article')
    `).run("article-1234567890abcdef", "article-1234567890abcdef@rev1");
    db.prepare("UPDATE paragraphs SET status='historical'").run();
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const row = db.prepare("SELECT status,scope FROM comments WHERE id='comment_a1'").get();
    assert.equal(row.status, "approved");
    assert.equal(row.scope, "article");
  } finally { close(); }
});

test("19 重复运行幂等：同一权威清单同步两次结果一致", () => {
  const { db, close } = fixture();
  try {
    const manifest = { schemaVersion: 1, articles: [article()] };
    const r1 = syncManifest(db, manifest);
    const r2 = syncManifest(db, manifest);
    assert.equal(r1.paragraphs, 2);
    assert.equal(r2.paragraphs, 2);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs"), 2);
  } finally { close(); }
});

test("20 服务重启不再次清空：模拟启动路径（omitted清单后再次权威同步）", () => {
  const { db, close } = fixture();
  try {
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    const minimal = { schemaVersion: 1, articles: [{ ...article(), paragraphs: [] }] };
    syncManifest(db, minimal);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2);
    syncManifest(db, minimal);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2, "多次启动不得清空");
    syncManifest(db, { schemaVersion: 1, articles: [article()] });
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2);
  } finally { close(); }
});

test("21 向后兼容：旧完整清单无paragraphsMode但有非空段落 → 视为authoritative", () => {
  const { db, close } = fixture();
  try {
    const legacy = { schemaVersion: 1, articles: [article()] };
    delete legacy.articles[0].paragraphsMode;
    assert.equal(paragraphMode(legacy.articles[0]), "authoritative");
    syncManifest(db, legacy);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 2);
  } finally { close(); }
});

test("22 旧精简清单（空数组、无模式）→ omitted；MAX_RETIRE_ABSOLUTE=100", () => {
  const { db, close } = fixture();
  try {
    const legacy = { schemaVersion: 1, articles: [{ ...article(), paragraphs: [] }] };
    assert.equal(paragraphMode(legacy.articles[0]), "omitted");
    syncManifest(db, legacy);
    assert.equal(count(db, "SELECT COUNT(*) count FROM paragraphs WHERE status='current'"), 0, "首次空清单不产生段落");
    assert.equal(MAX_RETIRE_ABSOLUTE, 100);
  } finally { close(); }
});
