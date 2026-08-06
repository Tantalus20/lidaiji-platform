#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || ".");
const site = path.resolve(process.argv[3] || path.join(root, "dist/site"));
const marker = /^<!-- paragraph-id:(p-[a-f0-9]{12}) -->$/;

function parseFrontMatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("缺少Front Matter");
  const scalar = (key) => {
    const found = match[1].match(new RegExp(`^${key}:\\s*[\"']?([^\\n\"']+)[\"']?\\s*$`, "m"));
    return found ? found[1].trim() : "";
  };
  const commentsMatch = match[1].match(/^comments:\s*\n(?:[ \t]+.*\n?)*/m);
  const paragraph = commentsMatch?.[0].match(/paragraph:\s*(true|false|locked)/)?.[1] || "false";
  return {
    body: match[2],
    articleId: scalar("articleId"),
    revision: scalar("articleRevision"),
    title: scalar("title"),
    slug: scalar("slug"),
    draft: scalar("draft"),
    comments: paragraph,
  };
}

const decodeEntities = (value) => value
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, "\"");
const normalize = (value) => decodeEntities(value)
  .replace(/\[\^[^\]]+]/g, "")
  .replace(/!\[[^\]]*]\([^)]*\)/g, " 图片 ")
  .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
  .replace(/[*_`~\\]/g, "")
  .replace(/\s+/g, "")
  .trim()
  .toLowerCase();
const escapeHtml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (value) => decodeEntities(value
  .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "")
  .replace(/<[^>]+>/g, "")
  );

function sourceParagraphs(body) {
  const blocks = body.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const result = [];
  let heading = "";
  let id = "";
  for (const block of blocks) {
    const headingMatch = block.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      heading = plain(headingMatch[1]);
      id = "";
      continue;
    }
    const idMatch = block.match(marker);
    if (idMatch) {
      id = idMatch[1];
      continue;
    }
    if (id) {
      const text = plain(block.replace(/!\[[^\]]*]\([^)]*\)/g, "图片").replace(/\[([^\]]+)]\([^)]*\)/g, "$1").replace(/[*_`~\\]/g, ""));
      result.push({
        paragraphId: id,
        position: result.length,
        headingContext: heading,
        excerpt: text.slice(0, 240),
        checksum: crypto.createHash("sha256").update(normalize(block)).digest("hex"),
        normalized: normalize(block),
      });
      id = "";
    }
  }
  return result;
}

function injectParagraphs(html, paragraphs, articleId, revision, mode) {
  const containerMatch = html.match(/<div class=article-content>([\s\S]*?)<\/div><footer/);
  if (!containerMatch) throw new Error(`${articleId}找不到正文容器`);
  let body = containerMatch[1];
  const paragraphTags = [...body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)];
  const used = new Set();
  for (const paragraph of paragraphs) {
    const candidates = paragraphTags
      .map((match, index) => ({ match, index, normalized: normalize(plain(match[1])) }))
      .filter((item) => !used.has(item.index) && item.normalized === paragraph.normalized);
    if (!candidates.length) {
      throw new Error(`${articleId}/${paragraph.paragraphId}无法匹配生成后的自然段：${paragraph.excerpt.slice(0, 80)}`);
    }
    // Repeated identical prose remains distinct: source order maps to the first
    // still-unclaimed rendered paragraph rather than merging by text hash.
    const candidate = candidates[0];
    used.add(candidate.index);
    const original = candidate.match[0];
    const openingEnd = original.indexOf(">");
    const opening = original.slice(0, openingEnd);
    const replacement = `${opening} id=${paragraph.paragraphId} data-paragraph-id=${paragraph.paragraphId}>${original.slice(openingEnd + 1)}`;
    body = body.replace(original, replacement);
  }
  const articleOpen = "<article class=reading-layout";
  const enhancedOpen = `${articleOpen} data-comment-article-id=${escapeHtml(articleId)} data-comment-revision=${escapeHtml(revision)} data-comment-mode=${mode}`;
  return html.replace(containerMatch[1], body).replace(articleOpen, enhancedOpen);
}

const articleFiles = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === "index.md") articleFiles.push(full);
  }
}
for (const section of ["works", "essays", "archives"]) walk(path.join(root, "content", section));

// LIDAIJI_DETERMINISTIC_BUILD=1（隔离候选构建）时使用固定时间戳，
// 保证相同输入重复构建产生字节一致的 manifest（候选确定性）。
const generatedAt = process.env.LIDAIJI_DETERMINISTIC_BUILD === "1"
  ? "1970-01-01T00:00:00.000Z"
  : new Date().toISOString();
const manifest = { schemaVersion: 1, generatedAt, articles: [] };
const ids = new Set();
for (const file of articleFiles.sort()) {
  const parsed = parseFrontMatter(fs.readFileSync(file, "utf8"));
  if (!parsed.articleId) continue;
  // 草稿不进入正式站点：跳过（否则构建因页面不存在而失败，
  // 作者也无法在发布前安全保存草稿）。
  if (parsed.draft === "true") continue;
  if (ids.has(parsed.articleId)) throw new Error(`重复articleId：${parsed.articleId}`);
  ids.add(parsed.articleId);
  const relative = path.relative(path.join(root, "content"), file).split(path.sep);
  const canonicalPath = `/${relative.slice(0, -1).join("/")}/`;
  const htmlFile = path.join(site, canonicalPath, "index.html");
  if (!fs.existsSync(htmlFile)) throw new Error(`找不到文章页面：${canonicalPath}`);
  const paragraphs = sourceParagraphs(parsed.body);
  const mode = parsed.comments === "true" ? "open" : parsed.comments === "locked" ? "locked" : "off";
  const html = injectParagraphs(
    fs.readFileSync(htmlFile, "utf8"),
    paragraphs,
    parsed.articleId,
    parsed.revision,
    mode,
  );
  fs.writeFileSync(htmlFile, html);
  manifest.articles.push({
    articleId: parsed.articleId,
    revision: parsed.revision,
    title: parsed.title,
    canonicalPath,
    paragraphComments: mode,
    // v0.5.1：构建生成的清单携带完整权威段落列表，明确声明权威性，
    // 服务端据此同步段落状态；精简/手工清单必须省略该字段以免误清空。
    paragraphsMode: "authoritative",
    sourceChecksum: crypto.createHash("sha256").update(parsed.body).digest("hex"),
    paragraphs: paragraphs.map(({ normalized, ...item }) => item),
  });
}
fs.writeFileSync(path.join(site, "comment-manifest.json"), JSON.stringify(manifest));
console.log(`段评manifest：${manifest.articles.length}篇文章，${manifest.articles.reduce((sum, item) => sum + item.paragraphs.length, 0)}个自然段。`);
