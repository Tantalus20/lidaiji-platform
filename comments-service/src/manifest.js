"use strict";

const fs = require("node:fs");
const { transaction } = require("./db");

function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.articles)) throw new Error("评论manifest格式无效。");
  const articles = new Set();
  for (const article of value.articles) {
    if (!/^article-[a-f0-9]{16}$/.test(article.articleId) || articles.has(article.articleId)) throw new Error("manifest含非法或重复articleId。");
    articles.add(article.articleId);
    if (!/^\/[A-Za-z0-9/_-]+\/$/.test(article.canonicalPath)) throw new Error(`${article.articleId}的永久链接无效。`);
    if (!["open", "locked", "off"].includes(article.paragraphComments)) throw new Error(`${article.articleId}的段评模式无效。`);
    const ids = new Set();
    for (const paragraph of article.paragraphs || []) {
      if (!/^p-[a-f0-9]{12}$/.test(paragraph.paragraphId) || ids.has(paragraph.paragraphId)) throw new Error(`${article.articleId}含非法或重复paragraphId。`);
      ids.add(paragraph.paragraphId);
    }
  }
  return value;
}

function syncManifest(db, manifestOrPath) {
  const manifest = validateManifest(typeof manifestOrPath === "string"
    ? JSON.parse(fs.readFileSync(manifestOrPath, "utf8"))
    : manifestOrPath);
  const now = new Date().toISOString();
  return transaction(db, () => {
    let revisions = 0;
    let paragraphs = 0;
    for (const article of manifest.articles) {
      db.prepare(`
        INSERT INTO articles(article_id,current_revision,title,canonical_path,paragraph_comments_mode,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(article_id) DO UPDATE SET current_revision=excluded.current_revision,title=excluded.title,
          canonical_path=excluded.canonical_path,paragraph_comments_mode=excluded.paragraph_comments_mode,updated_at=excluded.updated_at
      `).run(article.articleId, article.revision, article.title, article.canonicalPath, article.paragraphComments, now, now);
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO article_revisions(article_id,revision,published_at,paragraph_count,source_checksum,created_at)
        VALUES(?,?,?,?,?,?)
      `).run(article.articleId, article.revision, manifest.generatedAt || now, article.paragraphs.length, article.sourceChecksum, now);
      revisions += Number(inserted.changes);
      db.prepare("UPDATE paragraphs SET status='historical' WHERE article_id=?").run(article.articleId);
      for (const paragraph of article.paragraphs) {
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
    return { articles: manifest.articles.length, revisions, paragraphs };
  });
}

module.exports = { validateManifest, syncManifest };
