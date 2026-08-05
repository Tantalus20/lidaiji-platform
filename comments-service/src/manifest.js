"use strict";

// 评论manifest同步：段落语义 v0.5.1
//
// 每篇文章的段落同步由显式字段 paragraphsMode 控制：
//   - "omitted"       ：本次manifest不负责同步段落；完全跳过该文章的
//                        current/historical reconciliation（不更新、不失效）。
//   - "authoritative" ：按完整列表同步；列表中的段落保持/恢复 current，
//                        明确不存在的旧段落才可变为 historical。
//                       空列表只有在显式声明 authoritative 时才表示
//                       “该文章确实没有当前段落”，且仍受大规模失效门禁保护。
//
// 向后兼容：旧清单未声明 paragraphsMode 但携带非空 paragraphs 数组时视为
// authoritative（历史完整清单）；未提供或为空数组时视为 omitted——
// 绝不只依据空数组推测其权威性。

const fs = require("node:fs");
const { transaction } = require("./db");

// 大规模失效门禁：一次同步把超过该阈值的 current 段落改为 historical 时拒绝。
const MAX_RETIRE_ABSOLUTE = 100;
const MAX_RETIRE_RATIO = 0.2;

function paragraphMode(article) {
  if (article.paragraphsMode === "authoritative") return "authoritative";
  if (article.paragraphsMode === "omitted") return "omitted";
  if (Array.isArray(article.paragraphs) && article.paragraphs.length > 0) return "authoritative";
  return "omitted";
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.articles)) throw new Error("评论manifest格式无效。");
  const articles = new Set();
  for (const article of value.articles) {
    if (!/^article-[a-f0-9]{16}$/.test(article.articleId) || articles.has(article.articleId)) throw new Error("manifest含非法或重复articleId。");
    articles.add(article.articleId);
    if (!/^\/[A-Za-z0-9/_-]+\/$/.test(article.canonicalPath)) throw new Error(`${article.articleId}的永久链接无效。`);
    if (!["open", "locked", "off"].includes(article.paragraphComments)) throw new Error(`${article.articleId}的段评模式无效。`);
    if (article.paragraphsMode !== undefined && !["omitted", "authoritative"].includes(article.paragraphsMode)) {
      throw new Error(`${article.articleId}的paragraphsMode无效。`);
    }
    const ids = new Set();
    for (const paragraph of article.paragraphs || []) {
      if (!/^p-[a-f0-9]{12}$/.test(paragraph.paragraphId) || ids.has(paragraph.paragraphId)) throw new Error(`${article.articleId}含非法或重复paragraphId。`);
      ids.add(paragraph.paragraphId);
    }
  }
  return value;
}

function countRetiring(db, articleId, revision, paragraphIds) {
  if (!paragraphIds.length) {
    return Number(db.prepare("SELECT COUNT(*) count FROM paragraphs WHERE article_id=? AND status='current'").get(articleId).count);
  }
  const placeholders = paragraphIds.map(() => "?").join(",");
  return Number(db.prepare(`
    SELECT COUNT(*) count FROM paragraphs
    WHERE article_id=? AND status='current' AND paragraph_id NOT IN (${placeholders})
  `).get(articleId, ...paragraphIds).count);
}

/** 默认拒绝大规模段落失效；仅显式运维参数可放行。 */
function largeRetirementAllowed(db) {
  return String(db.allowLargeRetire || process.env.COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE || "") === "1";
}

function syncManifest(db, manifestOrPath, options = {}) {
  const manifest = validateManifest(typeof manifestOrPath === "string"
    ? JSON.parse(fs.readFileSync(manifestOrPath, "utf8"))
    : manifestOrPath);
  const allowLargeRetire = Boolean(options.allowLargeRetire) || largeRetirementAllowed(db);
  const now = new Date().toISOString();
  return transaction(db, () => {
    let revisions = 0;
    let paragraphs = 0;
    let omitted = 0;
    let totalRetiring = 0;
    let totalCurrentBefore = 0;
    const articleReport = [];
    for (const article of manifest.articles) {
      const mode = paragraphMode(article);
      const currentBefore = Number(db.prepare("SELECT COUNT(*) count FROM paragraphs WHERE article_id=? AND status='current'").get(article.articleId).count);
      totalCurrentBefore += currentBefore;
      if (mode === "authoritative") {
        totalRetiring += countRetiring(db, article.articleId, article.revision, (article.paragraphs || []).map((p) => p.paragraphId));
      }
      articleReport.push({ articleId: article.articleId, mode, currentBefore });
    }
    const totalCurrent = Number(db.prepare("SELECT COUNT(*) count FROM paragraphs WHERE status='current'").get().count) || totalCurrentBefore;
    if (
      !allowLargeRetire
      && (totalRetiring > MAX_RETIRE_ABSOLUTE || (totalCurrent > 0 && totalRetiring > totalCurrent * MAX_RETIRE_RATIO))
    ) {
      throw new Error(
        `段落同步被门禁拦截：本次将把${totalRetiring}个current段落改为historical`
        + `（阈值：绝对${MAX_RETIRE_ABSOLUTE}个或现有current的${Math.round(MAX_RETIRE_RATIO * 100)}%）。`
        + "如确认需要，设置COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE=1，或使用受控修复工具。",
      );
    }
    for (const article of manifest.articles) {
      const mode = paragraphMode(article);
      db.prepare(`
        INSERT INTO articles(article_id,current_revision,title,canonical_path,paragraph_comments_mode,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(article_id) DO UPDATE SET current_revision=excluded.current_revision,title=excluded.title,
          canonical_path=excluded.canonical_path,paragraph_comments_mode=excluded.paragraph_comments_mode,updated_at=excluded.updated_at
      `).run(article.articleId, article.revision, article.title, article.canonicalPath, article.paragraphComments, now, now);
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO article_revisions(article_id,revision,published_at,paragraph_count,source_checksum,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(article.articleId, article.revision, manifest.generatedAt || now, (article.paragraphs || []).length, article.sourceChecksum, now);
      revisions += Number(inserted.changes);
      if (mode === "omitted") {
        // 状态A：本次manifest不负责段落同步——段落状态保持不变。
        omitted += 1;
        continue;
      }
      db.prepare("UPDATE paragraphs SET status='historical' WHERE article_id=?").run(article.articleId);
      for (const paragraph of article.paragraphs || []) {
        db.prepare(`
          INSERT INTO paragraphs(article_id,revision,paragraph_id,position,heading_context,text_excerpt,text_checksum,status)
          VALUES(?,?,?,?,?,?,?,'current')
          ON CONFLICT(article_id,revision,paragraph_id) DO UPDATE SET position=excluded.position,
            heading_context=excluded.heading_context,text_excerpt=excluded.text_excerpt,text_checksum=excluded.text_checksum,status='current'
        `).run(article.articleId, article.revision, paragraph.paragraphId, paragraph.position, paragraph.headingContext || "", paragraph.excerpt, paragraph.checksum);
        paragraphs += 1;
      }
      db.prepare(`
        UPDATE comments SET status='orphaned',updated_at=?
        WHERE article_id=? AND status!='deleted' AND scope='paragraph' AND paragraph_id NOT IN
          (SELECT paragraph_id FROM paragraphs WHERE article_id=? AND revision=? AND status='current')
      `).run(now, article.articleId, article.articleId, article.revision);
    }
    return { articles: manifest.articles.length, revisions, paragraphs, omitted, retiring: totalRetiring };
  });
}

module.exports = {
  validateManifest,
  syncManifest,
  paragraphMode,
  MAX_RETIRE_ABSOLUTE,
  MAX_RETIRE_RATIO,
};
