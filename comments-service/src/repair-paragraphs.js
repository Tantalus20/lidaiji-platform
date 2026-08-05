#!/usr/bin/env node
"use strict";

// repair-paragraphs.js — 受控段落恢复工具（v0.5.1）
//
// 用途：把“权威完整 manifest”中列出的段落恢复为 current 状态，
//       仅用于修复“精简 manifest 误将全部段落标记为 historical”的情况。
//
// 行为约束：
//   - 默认 --dry-run，只输出报告，不写数据库；
//   - --apply 才写库（单事务，失败整体回滚）；
//   - 只恢复（historical → current），绝不把任何段落改为 historical；
//   - 输出聚合数字，绝不输出评论正文。
//
// 用法：
//   node --experimental-sqlite src/repair-paragraphs.js \
//     --database <sqlite副本> --manifest <权威完整manifest> [--dry-run|--apply] [--report <路径>]


const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { validateManifest, paragraphMode } = require("./manifest");
const { transaction } = require("./db");

function usage() {
  process.stderr.write(
    "用法：node --experimental-sqlite src/repair-paragraphs.js "
      + "--database <路径> --manifest <路径> [--dry-run|--apply] [--report <路径>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { mode: "dry-run", database: "", manifest: "", report: "" };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--database") args.database = argv[++i] || "";
    else if (value === "--manifest") args.manifest = argv[++i] || "";
    else if (value === "--report") args.report = argv[++i] || "";
    else if (value === "--dry-run") args.mode = "dry-run";
    else if (value === "--apply") args.mode = "apply";
    else usage();
  }
  if (!args.database || !args.manifest) usage();
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const databasePath = path.resolve(args.database);
  const manifestPath = path.resolve(args.manifest);
  if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`);
  if (!fs.existsSync(manifestPath)) throw new Error(`manifest不存在：${manifestPath}`);
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));

  const report = {
    schemaVersion: manifest.schemaVersion,
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    database: databasePath,
    manifest: manifestPath,
    articles: [],
    totals: {
      manifestAuthoritativeParagraphs: 0,
      wouldRestoreCurrent: 0,
      stayHistorical: 0,
      noAuthoritativeMatch: 0,
      linkedParagraphComments: 0,
    },
  };

  const db = new DatabaseSync(databasePath, args.mode === "apply" ? {} : { readOnly: true });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

  let wouldRestore = 0;
  let stayHistorical = 0;
  let noMatch = 0;
  let linkedComments = 0;

  for (const article of manifest.articles) {
    const mode = paragraphMode(article);
    if (mode !== "authoritative") continue;
    const paragraphIds = (article.paragraphs || []).map((p) => p.paragraphId);
    report.totals.manifestAuthoritativeParagraphs += paragraphIds.length;
    if (!paragraphIds.length) continue;
    const placeholders = paragraphIds.map(() => "?").join(",");

    const rows = db.prepare(`
      SELECT paragraph_id, status FROM paragraphs
      WHERE article_id=? AND revision=?
    `).all(article.articleId, article.revision);
    const byId = new Map(rows.map((row) => [row.paragraph_id, row.status]));

    let articleRestore = 0;
    let articleMissing = 0;
    for (const paragraphId of paragraphIds) {
      if (!byId.has(paragraphId)) {
        noMatch += 1;
        articleMissing += 1;
      } else if (byId.get(paragraphId) !== "current") {
        articleRestore += 1;
      }
    }
    const articleStayHistorical = rows.filter((row) => !paragraphIds.includes(row.paragraph_id)).length;

    const linked = Number(db.prepare(`
      SELECT COUNT(*) count FROM comments
      WHERE article_id=? AND scope='paragraph' AND status!='deleted' AND paragraph_id IN (${placeholders})
    `).get(article.articleId, ...paragraphIds).count);

    wouldRestore += articleRestore;
    stayHistorical += articleStayHistorical;
    linkedComments += linked;
    report.articles.push({
      articleId: article.articleId,
      title: article.title,
      revision: article.revision,
      manifestParagraphs: paragraphIds.length,
      currentBefore: rows.filter((row) => row.status === "current").length,
      wouldRestoreCurrent: articleRestore,
      stayHistorical: articleStayHistorical,
      noAuthoritativeMatch: articleMissing,
      linkedParagraphComments: linked,
      potentialConflict: rows.filter((row) => row.status === "current" && !paragraphIds.includes(row.paragraph_id)).length,
    });
  }

  report.totals.wouldRestoreCurrent = wouldRestore;
  report.totals.stayHistorical = stayHistorical;
  report.totals.noAuthoritativeMatch = noMatch;
  report.totals.linkedParagraphComments = linkedComments;

  if (args.mode === "apply") {
    if (!wouldRestore) {
      report.applied = { restored: 0, message: "没有需要恢复的段落。" };
    } else {
      const applied = transaction(db, () => {
        let restored = 0;
        for (const article of manifest.articles) {
          if (paragraphMode(article) !== "authoritative") continue;
          const paragraphIds = (article.paragraphs || []).map((p) => p.paragraphId);
          if (!paragraphIds.length) continue;
          const placeholders = paragraphIds.map(() => "?").join(",");
          const result = db.prepare(`
            UPDATE paragraphs SET status='current'
            WHERE article_id=? AND revision=? AND paragraph_id IN (${placeholders})
          `).run(article.articleId, article.revision, ...paragraphIds);
          restored += Number(result.changes);
        }
        return restored;
      });
      report.applied = { restored: applied };
      const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
      const currentCount = Number(db.prepare("SELECT COUNT(*) count FROM paragraphs WHERE status='current'").get().count);
      report.applied.integrityCheck = integrity;
      report.applied.currentParagraphsAfter = currentCount;
    }
  }

  const output = JSON.stringify(report, null, 2);
  if (args.report) {
    fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
    fs.writeFileSync(path.resolve(args.report), output + "\n", "utf8");
  }
  process.stdout.write(output + "\n");
  db.close();
}

try {
  main();
} catch (error) {
  process.stderr.write(`修复工具失败：${error.message}\n`);
  process.exit(1);
}
