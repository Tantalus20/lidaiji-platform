#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../comments-service/src/config");
const { openDatabase } = require("../comments-service/src/db");
const { syncManifest } = require("../comments-service/src/manifest");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comments-perf-"));
const config = loadConfig({ dataDir: directory, database: path.join(directory, "comments.sqlite3") });
const db = openDatabase(config);
const paragraphCount = 1000;
const paragraphs = Array.from({ length: paragraphCount }, (_, index) => ({
  paragraphId: `p-${index.toString(16).padStart(12, "0")}`,
  position: index,
  headingContext: "",
  excerpt: `十万字压力测试第${index}段摘录`,
  checksum: index.toString(16).padStart(64, "0"),
}));
syncManifest(db, {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  articles: [{
    articleId: "article-aaaaaaaaaaaaaaaa",
    revision: "article-aaaaaaaaaaaaaaaa@perf",
    title: "十万字压力测试",
    canonicalPath: "/works/performance/",
    paragraphComments: "open",
    sourceChecksum: "f".repeat(64),
    paragraphs,
  }],
});
const now = new Date().toISOString();
db.exec("BEGIN");
const insert = db.prepare(`
  INSERT INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
    source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,approved_at,public_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
for (let index = 0; index < 10_000; index += 1) {
  const paragraph = paragraphs[index % paragraphCount];
  insert.run(`comment_perf_${index}`, "article-aaaaaaaaaaaaaaaa", "article-aaaaaaaaaaaaaaaa@perf", paragraph.paragraphId,
    paragraph.excerpt, `访客${index}`, `性能测试段评${index}`, "approved", `source${index}`, "", 0, `hash${index}`, now, now, now, now);
}
db.exec("COMMIT");

const countStart = performance.now();
const counts = db.prepare("SELECT paragraph_id,COUNT(*) count FROM comments WHERE article_id=? AND status='approved' GROUP BY paragraph_id")
  .all("article-aaaaaaaaaaaaaaaa");
const countMs = performance.now() - countStart;
const countBytes = Buffer.byteLength(JSON.stringify({ articleId: "article-aaaaaaaaaaaaaaaa", counts: Object.fromEntries(counts.map((row) => [row.paragraph_id, row.count])) }));
const detailStart = performance.now();
const detail = db.prepare("SELECT id,display_name,body,public_at FROM comments WHERE article_id=? AND paragraph_id=? AND status='approved' ORDER BY public_at")
  .all("article-aaaaaaaaaaaaaaaa", "p-000000000000");
const detailMs = performance.now() - detailStart;
const quick = db.prepare("PRAGMA quick_check").get().quick_check;
db.close();
fs.rmSync(directory, { recursive: true, force: true });
if (countMs > 250 || detailMs > 100 || quick !== "ok" || detail.length !== 10) process.exit(1);
console.log(JSON.stringify({ paragraphCount, comments: 10_000, countBytes, countMs: Number(countMs.toFixed(2)), detailMs: Number(detailMs.toFixed(2)), quick }));
