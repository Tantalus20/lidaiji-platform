"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS = path.resolve(__dirname, "..", "migrations");

function openDatabase(config) {
  fs.mkdirSync(path.dirname(config.database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.database);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  migrate(db, config.database);
  return db;
}

function migrate(db, databasePath = "") {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const files = fs.readdirSync(MIGRATIONS).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const file of files) {
    const version = Number(file.match(/^\d+/)[0]);
    if (applied.has(version)) continue;
    if (version >= 2 && databasePath && fs.existsSync(databasePath)) {
      // 结构性迁移之前自动备份，失败时可直接用备份回滚。
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const backupPath = `${databasePath}.pre-v${version}-${stamp}.bak`;
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      process.stdout.write(`数据库迁移v${version}前已自动备份：${backupPath}\n`);
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    const countsBefore = version >= 2 ? db.prepare("SELECT COUNT(*) count FROM comments").get().count : 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`数据库迁移${file}失败：${error.message}`);
    }
    if (version >= 2) {
      // 迁移后旧评论总数必须与迁移前一致，不一致视为失败并中止启动。
      const countAfter = Number(db.prepare("SELECT COUNT(*) count FROM comments").get().count);
      if (countAfter !== Number(countsBefore)) {
        throw new Error(`数据库迁移${file}后评论总数异常：迁移前${countsBefore}条，迁移后${countAfter}条。`);
      }
      const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
      if (integrity !== "ok") throw new Error(`数据库迁移${file}后完整性检查失败：${integrity}`);
    }
  }
}

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { openDatabase, migrate, transaction };
