#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { backup: sqliteBackup } = require("node:sqlite");
const { loadConfig } = require("./config");
const { openDatabase } = require("./db");
const { syncManifest } = require("./manifest");
const { hashPassword, randomToken } = require("./security");

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function backupDatabase(db, target) {
  if (typeof sqliteBackup === "function") {
    await sqliteBackup(db, target);
    return;
  }
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const escapedTarget = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedTarget}'`);
}

function exportData(db, mode = "public") {
  const statuses = mode === "audit" ? ["pending", "approved", "rejected", "spam", "hidden", "deleted", "orphaned"] : ["approved"];
  const placeholders = statuses.map(() => "?").join(",");
  const articles = db.prepare("SELECT * FROM articles ORDER BY canonical_path").all();
  const rows = db.prepare(`SELECT * FROM comments WHERE status IN (${placeholders}) ORDER BY article_id,paragraph_id,created_at`).all(...statuses);
  const comments = mode === "audit" ? rows : rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    article_id: row.article_id,
    article_revision: row.article_revision,
    paragraph_id: row.paragraph_id,
    paragraph_excerpt: row.paragraph_excerpt,
    display_name: row.display_name,
    body: row.body,
    status: row.status,
    created_at: row.created_at,
    approved_at: row.approved_at,
    public_at: row.public_at,
  }));
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), mode, articles, comments };
}

function markdownExport(data) {
  const byArticle = new Map(data.articles.map((article) => [article.article_id, { article, articleComments: [], paragraphs: new Map() }]));
  for (const comment of data.comments) {
    const entry = byArticle.get(comment.article_id);
    if (!entry) continue;
    if ((comment.scope || "paragraph") === "article") {
      entry.articleComments.push(comment);
      continue;
    }
    if (!entry.paragraphs.has(comment.paragraph_id)) entry.paragraphs.set(comment.paragraph_id, []);
    entry.paragraphs.get(comment.paragraph_id).push(comment);
  }
  const lines = [];
  for (const { article, articleComments, paragraphs } of byArticle.values()) {
    if (!articleComments.length && !paragraphs.size) continue;
    lines.push(`# 《${article.title}》评论`, "");
    if (articleComments.length) {
      lines.push("## 章评", "");
      for (const comment of articleComments) lines.push(`### ${comment.display_name}`, "", comment.body, "");
    }
    for (const [paragraphId, comments] of paragraphs) {
      lines.push(`## 段评 ${paragraphId}`, "", "原段落摘录：", "", `> ${comments[0].paragraph_excerpt.replace(/\n/g, " ")}`, "");
      for (const comment of comments) lines.push(`### ${comment.display_name}`, "", comment.body, "");
    }
  }
  return lines.join("\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const db = openDatabase(config);
  try {
    if (command === "migrate") {
      console.log("数据库迁移完成。");
    } else if (command === "sync-manifest") {
      const file = args[0];
      if (!file) throw new Error("请提供comment-manifest.json路径。");
      console.log(syncManifest(db, file));
    } else if (command === "create-admin") {
      const username = String(args[0] || "owner").trim();
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(username)) throw new Error("管理员用户名格式不正确。");
      const password = await stdin();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO admins(id,username,password_hash,status,created_at) VALUES(?,?,?,'active',?)
        ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,status='active'
      `).run(`admin_${randomToken(10)}`, username, hashPassword(password), now);
      console.log(`管理员${username}已创建或更新。`);
    } else if (command === "backup") {
      const target = path.resolve(args[0] || `comments-${Date.now()}.sqlite3`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await backupDatabase(db, target);
      console.log(target);
    } else if (command === "export-json" || command === "export-markdown") {
      const target = path.resolve(args[0] || (command.endsWith("json") ? "comments-export.json" : "comments-export.md"));
      const data = exportData(db, args.includes("--audit") ? "audit" : "public");
      fs.writeFileSync(target, command.endsWith("json") ? JSON.stringify(data, null, 2) : markdownExport(data), "utf8");
      console.log(target);
    } else if (command === "import-json") {
      const file = path.resolve(args[0] || "");
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.schemaVersion !== 1 || !Array.isArray(data.comments)) throw new Error("JSON导出格式无效。");
      db.exec("BEGIN IMMEDIATE");
      try {
        const insert = db.prepare(`
          INSERT OR IGNORE INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
            source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,approved_at,public_at,scope)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        let imported = 0;
        for (const item of data.comments) {
          if (!db.prepare("SELECT 1 ok FROM articles WHERE article_id=?").get(item.article_id)) throw new Error(`数据库缺少文章${item.article_id}，请先同步manifest。`);
          if (!["pending", "approved", "rejected", "spam", "hidden", "deleted", "orphaned"].includes(item.status)) throw new Error("JSON含非法评论状态。");
          const scope = item.scope === undefined ? "paragraph" : String(item.scope);
          if (!["paragraph", "article"].includes(scope)) throw new Error("JSON含非法评论类型。");
          const result = insert.run(
            String(item.id), String(item.article_id), String(item.article_revision), String(item.paragraph_id),
            String(item.paragraph_excerpt || ""), String(item.display_name), String(item.body), String(item.status),
            String(item.source_fingerprint || "imported"), String(item.browser_fingerprint || ""), Number(item.contains_link) ? 1 : 0,
            String(item.duplicate_hash || `import-${item.id}`), String(item.created_at), String(item.updated_at || item.created_at),
            item.approved_at || null, item.public_at || null, scope,
          );
          imported += Number(result.changes);
        }
        db.exec("COMMIT");
        console.log(`已从JSON导入${imported}条评论。`);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      throw new Error("命令：migrate | sync-manifest | create-admin | backup | export-json | export-markdown | import-json");
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`操作失败：${error.message}`);
  process.exit(1);
});
