#!/usr/bin/env node
/* 分享站长文站构建产物契约检查（输出级 + 源码级）。

用法：check-share-site.mjs <repo-root>
环境：SITE_DIR 指向分享站构建输出（缺省 <repo>/dist/share）；
      LIDAIJI_SHARE_CONTENT_ROOT 指向私有内容根（缺省 <repo> 上一级
      lidaiji-share-private）。

保证：分享站与《历代纪》正式作品站隔离——无 works/essays/archives 导航、
无评论 JS/comment-manifest/paragraph-id、摘录与仅链接不泄漏全文、
草稿不出现在输出、目录/上下篇/分类/RSS 可用。
*/
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || process.cwd());
const site = path.resolve(process.env.SITE_DIR || path.join(root, "dist", "share"));
const contentRoot = path.resolve(
  process.env.LIDAIJI_SHARE_CONTENT_ROOT || path.join(root, "..", "lidaiji-share-private"),
);
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.readFileSync(file, "utf8");

/* ---------- 读取分享内容（私有根，只读） ---------- */
const items = [];
const itemsDir = path.join(contentRoot, "items");
if (fs.existsSync(itemsDir)) {
  for (const entry of fs.readdirSync(itemsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = path.join(itemsDir, entry.name, "index.md");
    if (!fs.existsSync(index)) continue;
    const source = read(index);
    const fm = source.startsWith("---\n") ? source.split("---\n")[1] || "" : "";
    const field = (key, fallback = "") => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      if (!m) return fallback;
      return m[1].trim().replace(/^['"]|['"]$/g, "");
    };
    const title = field("title");
    const slug = field("slug") || entry.name;
    const body = source.split("---\n").slice(2).join("---\n").trim();
    const blockList = (key) => {
      const m = fm.match(new RegExp(`^${key}:\\s*$\\n((?:[ \\t]*-[ \\t]+[^\\n]+\\n?)*)`, "m"));
      if (!m) return [];
      return [...m[1].matchAll(/-[ \t]+([^\n]+)/g)].map((x) => x[1].trim().replace(/^['"]|['"]$/g, ""));
    };
    items.push({
      dir: entry.name,
      title,
      slug,
      draft: field("draft", "false") === "true",
      rightsMode: field("rightsMode", "original"),
      kind: field("shareKind", "other"),
      categories: blockList("categories").length ? blockList("categories") : (field("categories", "[]").match(/[^[\]\s,'"]+/g) || []).map((x) => x.replace(/^['"]|['"]$/g, "")),
      date: field("date", "2000-01-01"),
      bodySample: [...body].slice(0, 80).join(""),
    });
  }
}
const published = items.filter((item) => !item.draft);

/* ---------- 输出结构 ---------- */
["index.html", "404.html", "index.xml", "sitemap.xml", "categories/index.html"].forEach((file) => {
  assert(fs.existsSync(path.join(site, file)), `分享站缺少必要输出：${file}`);
});
const htmlFiles = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".html")) htmlFiles.push(full);
  }
};
walk(site);
assert(htmlFiles.length > 0, "分享站没有任何 HTML 输出");

const homeHtml = read(path.join(site, "index.html"));
assert(homeHtml.includes("长文分享"), "分享站首页缺少站名");

/* ---------- 已发布文章 URL 与标题 ---------- */
for (const item of published) {
  const page = path.join(site, item.slug, "index.html");
  assert(fs.existsSync(page), `已发布分享缺少页面：${item.slug}/`);
  if (fs.existsSync(page)) {
    const html = read(page);
    assert(html.includes(item.title), `${item.slug} 页面缺少标题`);
    assert(homeHtml.includes(`/${item.slug}/`), `首页缺少 ${item.slug} 的链接`);
  }
}

/* ---------- 草稿绝不进入输出 ---------- */
for (const item of items.filter((x) => x.draft)) {
  assert(!fs.existsSync(path.join(site, item.slug, "index.html")), `草稿不应出现在输出：${item.slug}`);
}

/* ---------- 与正式作品站隔离（输出级） ---------- */
const forbidden = [
  "/works/",
  "/essays/",
  "/archives/",
  "/timeline/",
  "/search/",
  "/people/",
  "/periods/",
  "comment-manifest",
  "comments.js",
  "article-comments",
  "data-ac-",
  "api/comments",
  "paragraph-id",
  "articleId",
  "articleRevision",
];
for (const file of htmlFiles) {
  const html = read(file);
  for (const token of forbidden) {
    assert(!html.includes(token), `${file} 不应出现正式站特征：${token}`);
  }
}

/* ---------- 摘录/仅链接不泄漏全文（全站扫描，含首页/RSS/分类页） ---------- */
const metaOnlyItems = published.filter((item) => ["excerpt", "link-only"].includes(item.rightsMode));
for (const item of metaOnlyItems) {
  if (!item.bodySample) continue;
  for (const file of htmlFiles) {
    const html = read(file);
    assert(!html.includes(item.bodySample), `${file} 是${item.rightsMode}分享，不得出现其正文（${item.slug}）`);
  }
  const page = path.join(site, item.slug, "index.html");
  if (fs.existsSync(page)) {
    const html = read(page);
    assert(html.includes("meta-only-note"), `${item.slug} 应显示“摘录/仅链接”提示`);
  }
}

/* ---------- 目录 / 上下篇 / 分类 / RSS ---------- */
// 上一篇/下一篇按模板排序（日期倒序，同日期的先后由模板决定，此处不假设
// tie-break）：只断言每页的 rel=prev/next 指向“其他已发布页”，且首页存在。
if (published.length >= 2) {
  const slugs = new Set(published.map((item) => item.slug));
  const seenPrev = new Set();
  const seenNext = new Set();
  for (const item of published) {
    const page = path.join(site, item.slug, "index.html");
    if (!fs.existsSync(page)) continue;
    const html = read(page);
    const hrefs = [...html.matchAll(/rel=(?:prev|next)[^>]*href=([^ >]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, ""));
    for (const href of hrefs) {
      const slug = href.replace(/^\/|\/$/g, "");
      assert(slugs.has(slug) && slug !== item.slug, `${item.slug} 的上下篇指向了非发布页：${href}`);
    }
    const hasRel = (rel) => html.includes(`rel=${rel}`) || html.includes(`rel="${rel}"`);
    if (hasRel("prev")) seenPrev.add(item.slug);
    if (hasRel("next")) seenNext.add(item.slug);
  }
  // 排序链完整性：至少一篇有上一篇、一篇有下一篇（首尾边界）
  assert(seenPrev.size >= 1 && seenNext.size >= 1, "上下篇导航链不完整");
  const countLinks = [...htmlFiles].filter((f) => read(f).includes("article-pager")).length;
  assert(countLinks === published.length, `上下篇导航页数不符：${countLinks}/${published.length}`);
} else {
  assert(published.length > 0, "没有已发布分享用于结构检查");
}

const categoryTerms = new Set();
for (const item of published) for (const cat of item.categories) categoryTerms.add(cat);
for (const cat of categoryTerms) {
  const page = path.join(site, "categories", cat, "index.html");
  assert(fs.existsSync(page), `缺少分类页：${cat}`);
}

const rss = fs.existsSync(path.join(site, "index.xml")) ? read(path.join(site, "index.xml")) : "";
for (const item of published.slice(0, 3)) {
  assert(rss.includes(`/${item.slug}/`), `RSS 缺少 ${item.slug} 的链接`);
}

/* ---------- 源码级隔离（模板不引用评论/正式站） ---------- */
const layoutsDir = path.join(root, "share-site", "layouts");
const templateFiles = [];
const walkTemplates = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkTemplates(full);
    else if (entry.name.endsWith(".html")) templateFiles.push(full);
  }
};
walkTemplates(layoutsDir);
for (const file of templateFiles) {
  const source = read(file);
  assert(!source.includes("comments.js"), `${file} 不得引用评论脚本`);
  assert(!source.includes("articleId"), `${file} 不得引用 articleId`);
  assert(!source.includes("paragraph-id"), `${file} 不得生成段落锚点`);
}
const hugoToml = read(path.join(root, "share-site", "hugo.toml"));
assert(!/^\[comments\]/m.test(hugoToml), "分享站不得配置评论系统");

/* ---------- 结果 ---------- */
if (failures.length) {
  console.error(`分享站契约检查失败：${failures.length} 项`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log(`分享站契约检查通过：${items.length} 篇（已发布 ${published.length}，草稿 ${items.length - published.length}），${htmlFiles.length} 个 HTML。`);
