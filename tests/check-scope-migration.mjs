#!/usr/bin/env node
// V0.4.0 迁移演练：用 001 版旧数据库验证 002 scope 迁移的安全性与数据零变化。
// 覆盖：旧段评数量/ID/状态/关联/时间/内容不变、迁移幂等、触发器约束、
// 完整性检查、迁移前自动备份、备份恢复后段评与章评共存。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { migrate } = require("../comments-service/src/db");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-scope-migration-"));
const database = path.join(directory, "comments.sqlite3");
const MIGRATIONS = path.resolve(import.meta.dirname, "../comments-service/migrations");

// 1. 构造 001 版旧数据库（不经过新代码，直接执行 001 SQL）。
const legacy = new DatabaseSync(database);
legacy.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
legacy.exec(fs.readFileSync(path.join(MIGRATIONS, "001-initial.sql"), "utf8"));
legacy.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)").run("2026-07-01T00:00:00.000Z");
const now = "2026-07-15T08:00:00.000Z";
legacy.prepare(`
  INSERT INTO articles(article_id,current_revision,title,canonical_path,paragraph_comments_mode,created_at,updated_at)
  VALUES('article-1234567890abcdef','rev1','迁移演练文章','/essays/test/','open',?,?)
`).run(now, now);
legacy.prepare(`
  INSERT INTO paragraphs(article_id,revision,paragraph_id,position,heading_context,text_excerpt,text_checksum,status)
  VALUES('article-1234567890abcdef','rev1','p-111111111111',0,'','第一段摘录','${"a".repeat(64)}','current')
`).run();
const insertLegacy = legacy.prepare(`
  INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
    source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,approved_at,public_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const fixtures = [
  ["comment_legacy_pending", "pending", null, null],
  ["comment_legacy_approved", "approved", "2026-07-16T09:00:00.000Z", "2026-07-16T09:00:00.000Z"],
  ["comment_legacy_rejected", "rejected", null, null],
];
for (const [id, status, approvedAt, publicAt] of fixtures) {
  insertLegacy.run(id, "article-1234567890abcdef", "rev1", "p-111111111111", "第一段摘录",
    "旧读者", `${id}的正文内容`, status, "source", "browser", 0, `hash-${id}`, now, now, approvedAt, publicAt);
}
const before = legacy.prepare("SELECT * FROM comments ORDER BY id").all();
legacy.close();

// 2. 用新代码迁移（自动跑 002）。
const migrated = new DatabaseSync(database);
migrated.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
migrate(migrated, database);

// 3. 迁移前自动备份已生成。
const backups = fs.readdirSync(directory).filter((name) => name.includes(".pre-v2-"));
assert.equal(backups.length, 1, "迁移前必须自动生成一个备份");
const backupRowCount = new DatabaseSync(path.join(directory, backups[0]), { readOnly: true })
  .prepare("SELECT COUNT(*) count FROM comments").get().count;
assert.equal(Number(backupRowCount), 3, "自动备份必须包含全部旧段评");

// 4. 旧段评逐字段零变化。
const after = migrated.prepare("SELECT * FROM comments ORDER BY id").all();
assert.equal(after.length, before.length, "迁移后评论总数必须不变");
const statusCount = (rows) => rows.reduce((map, row) => ({ ...map, [row.status]: (map[row.status] || 0) + 1 }), {});
assert.deepEqual(statusCount(after), { pending: 1, approved: 1, rejected: 1 }, "迁移后状态分布必须不变");
for (const row of after) {
  const original = before.find((item) => item.id === row.id);
  assert.ok(original, `旧段评${row.id}丢失`);
  for (const field of ["article_id", "article_revision", "paragraph_id", "paragraph_excerpt", "display_name", "body", "status", "created_at", "updated_at", "approved_at", "public_at"]) {
    assert.deepEqual(row[field], original[field], `旧段评${row.id}的${field}发生变化`);
  }
  assert.equal(row.scope, "paragraph", "旧段评必须自动视为paragraph");
}
assert.equal(migrated.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "迁移后完整性检查必须通过");

// 5. 迁移幂等：再次执行不产生变化也不重复备份。
migrate(migrated, database);
assert.equal(fs.readdirSync(directory).filter((name) => name.includes(".pre-v2-")).length, 1, "重复迁移不得重复备份");
assert.equal(Number(migrated.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE version=2").get().count), 1);

// 6. 触发器约束。
assert.throws(() => migrated.prepare("UPDATE comments SET scope='site' WHERE id='comment_legacy_pending'").run(), /评论scope无效/, "非法scope必须被拒绝");
assert.throws(() => migrated.prepare("UPDATE comments SET paragraph_id='' WHERE id='comment_legacy_pending'").run(), /段评必须关联自然段/, "段评必须保留paragraph_id");
const insertNew = migrated.prepare(`
  INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
    source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
assert.throws(() => insertNew.run("comment_bad", "article-1234567890abcdef", "rev1", "p-111111111111", "", "访客", "带段落的章评", "pending", "s", "b", 0, "h", now, now, "article"), /章评不得关联自然段/);
insertNew.run("comment_new_article", "article-1234567890abcdef", "rev1", "", "", "新读者", "这是迁移后写入的章评。", "pending", "s", "b", 0, "h2", now, now, "article");
const scopeCount = migrated.prepare("SELECT scope,COUNT(*) count FROM comments GROUP BY scope").all();
assert.deepEqual(Object.fromEntries(scopeCount.map((row) => [row.scope, Number(row.count)])), { paragraph: 3, article: 1 });

// 7. 备份-恢复演练：删除数据库，从自动备份恢复，再迁移，段评全在。
migrated.close();
const restoredPath = path.join(directory, "restored.sqlite3");
fs.copyFileSync(path.join(directory, backups[0]), restoredPath);
const restored = new DatabaseSync(restoredPath);
restored.exec("PRAGMA journal_mode=WAL;");
migrate(restored, restoredPath);
assert.equal(Number(restored.prepare("SELECT COUNT(*) count FROM comments WHERE scope='paragraph'").get().count), 3, "恢复后旧段评必须全部存在");
assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
restored.close();

fs.rmSync(directory, { recursive: true, force: true });
console.log("scope迁移演练通过：旧段评零变化、触发器约束、自动备份、恢复后重迁移均正常。");
