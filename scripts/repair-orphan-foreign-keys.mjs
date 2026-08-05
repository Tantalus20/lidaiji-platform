#!/usr/bin/env node
"use strict";

// repair-orphan-foreign-keys.mjs — 数据卫生：外键孤儿调查与安全修复（v0.5.2）
//
// 背景：生产库存在 3 条既存孤儿外键引用（sessions×1、moderation_actions×2，
// 均指向已被手工删除的管理员 admin_f8VCicoYWFaKtg）。代码中不存在删除管理员的
// 路径（create-admin 按 username upsert 保持 id），该孤儿类只能由人工直接
// DELETE admins 产生；当前版本不会继续生成同类孤儿。
//
// 修复策略（语义最小、零删除）：
//   - 对指向已删除管理员的孤儿行，补建“已停用占位管理员”父记录
//     （status=disabled + 不可验证的密码占位），恢复外键完整性；
//   - 不删除任何 session/审核日志/评论/段落；
//   - 不修改任何评论正文、status、scope、段落锚点。
//
// 用法：
//   node --experimental-sqlite scripts/repair-orphan-foreign-keys.mjs \
//     --database <副本路径> [--dry-run|--apply] [--report <输出路径>]
// 默认 --dry-run。--apply 单事务执行，失败自动回滚。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function usage() {
  process.stderr.write(
    "用法：node --experimental-sqlite scripts/repair-orphan-foreign-keys.mjs "
      + "--database <路径> [--dry-run|--apply] [--report <路径>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { mode: "dry-run", database: "", report: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--database") args.database = argv[++i] || "";
    else if (argv[i] === "--report") args.report = argv[++i] || "";
    else if (argv[i] === "--dry-run") args.mode = "dry-run";
    else if (argv[i] === "--apply") args.mode = "apply";
    else usage();
  }
  if (!args.database) usage();
  return args;
}

function digestOf(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(row.join("|"));
  return hash.digest("hex");
}

function aggregateDigests(db) {
  const comments = db.prepare(
    "SELECT id,status,scope,article_id,COALESCE(paragraph_id,''),source_type FROM comments ORDER BY id",
  ).all().map((r) => [r.id, r.status, r.scope, r.article_id, r.paragraph_id, r.source_type]);
  const paragraphs = db.prepare(
    "SELECT paragraph_id,article_id,status FROM paragraphs ORDER BY article_id,revision,paragraph_id",
  ).all().map((r) => [r.paragraph_id, r.article_id, r.status]);
  const articles = db.prepare(
    "SELECT article_id,canonical_path,paragraph_comments_mode FROM articles ORDER BY article_id",
  ).all().map((r) => [r.article_id, r.canonical_path, r.paragraph_comments_mode]);
  const tasks = db.prepare(
    "SELECT notification_id,status,comment_id FROM comment_notification_tasks ORDER BY notification_id",
  ).all().map((r) => [r.notification_id, r.status, r.comment_id]);
  return {
    commentsDigest: digestOf(comments),
    commentsTotal: comments.length,
    paragraphsDigest: digestOf(paragraphs),
    paragraphsCurrent: db.prepare("SELECT COUNT(*) c FROM paragraphs WHERE status='current'").get().c,
    paragraphsHistorical: db.prepare("SELECT COUNT(*) c FROM paragraphs WHERE status='historical'").get().c,
    articlesDigest: digestOf(articles),
    tasksDigest: digestOf(tasks),
    tasksTotal: tasks.length,
  };
}

function placeholdersFor(db, violations) {
  const placed = new Map();
  for (const violation of violations) {
    if (violation.parent !== "admins") continue;
    let adminId = "";
    if (violation.table === "sessions") {
      adminId = String(db.prepare("SELECT admin_id FROM sessions WHERE rowid=?").get(violation.rowid).admin_id);
    } else if (violation.table === "moderation_actions") {
      adminId = String(db.prepare("SELECT admin_id FROM moderation_actions WHERE rowid=?").get(violation.rowid).admin_id);
    }
    if (!adminId) continue;
    const exists = db.prepare("SELECT COUNT(*) c FROM admins WHERE id=?").get(adminId).c > 0;
    if (exists) continue;
    if (!placed.has(adminId)) {
      placed.set(adminId, {
        adminId,
        username: `removed-admin-${String(adminId).slice(6, 14)}`,
        // 占位密码：任何登录都会失败（账号 status=disabled，且该值无法通过校验）。
        passwordHash: "scrypt$0$0$0$disabled$placeholder",
        status: "disabled",
        createdAt: "2000-01-01T00:00:00.000Z",
      });
    }
  }
  return [...placed.values()];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const databasePath = path.resolve(args.database);
  if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`);
  const db = new DatabaseSync(databasePath, args.mode === "apply" ? {} : { readOnly: true });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");

  const report = {
    tool: "repair-orphan-foreign-keys",
    mode: args.mode,
    database: databasePath,
    generatedAt: new Date().toISOString(),
    before: aggregateDigests(db),
    violations: [],
    actions: [],
    unclear: [],
  };

  const raw = db.prepare("PRAGMA foreign_key_check").all();
  const violations = raw.map((row) => ({
    table: String(row.table),
    rowid: Number(row.rowid),
    parent: String(row.parent),
    fkid: Number(row.fkid),
  }));
  report.violations = violations;

  const adminOrphans = violations.filter((v) => v.parent === "admins");
  const other = violations.filter((v) => v.parent !== "admins");
  if (other.length) {
    report.unclear.push({ kind: "unsupported-violation", count: other.length, tables: [...new Set(other.map((v) => `${v.table}->${v.parent}`))] });
  }

  const placeholders = placeholdersFor(db, violations);
  report.actions = placeholders.map((p) => ({
    kind: "restore-disabled-placeholder-admin",
    adminId: p.adminId,
    username: p.username,
    status: p.status,
    restoresReferences: adminOrphans
      .filter((v) => {
        const adminId = v.table === "sessions"
          ? db.prepare("SELECT admin_id FROM sessions WHERE rowid=?").get(v.rowid).admin_id
          : db.prepare("SELECT admin_id FROM moderation_actions WHERE rowid=?").get(v.rowid).admin_id;
        return adminId === p.adminId;
      })
      .map((v) => `${v.table}#${v.rowid}`),
  }));

  report.summary = {
    orphanTotal: violations.length,
    missingAdminTotal: adminOrphans.length,
    unsupportedTotal: other.length,
    plannedInsertAdmins: placeholders.length,
  };

  if (args.mode === "apply") {
    if (placeholders.length) {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO admins(id,username,password_hash,status,created_at) VALUES(?,?,?,?,?)",
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const p of placeholders) {
          insert.run(p.adminId, p.username, p.passwordHash, p.status, p.createdAt);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      report.applied = { insertedAdmins: placeholders.length };
    } else {
      report.applied = { insertedAdmins: 0 };
    }
    report.after = aggregateDigests(db);
    report.after.integrityCheck = db.prepare("PRAGMA integrity_check").get().integrity_check;
    report.after.foreignKeyCheckRows = db.prepare("PRAGMA foreign_key_check").all().length;
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
