import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const site = path.resolve(process.env.SITE_DIR || "dist/site");
const requireDemoFixtures = process.env.REQUIRE_DEMO_FIXTURES === "1";
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (relative) => fs.readFileSync(path.join(site, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(site, relative));

const required = [
  "index.html",
  "works/index.html",
  "timeline/index.html",
  "search/index.html",
  "about/index.html",
  "404.html",
  "index.xml",
  "sitemap.xml",
  "search-index.json",
  "comment-manifest.json",
];
if (requireDemoFixtures) {
  required.push(
    "works/demo-collection/index.html",
    "works/demo-collection/long-reading-test/index.html",
    "works/demo-collection/long-novel-test/index.html",
    "categories/index.html",
    "tags/index.html",
    "series/index.html",
  );
}
required.forEach((file) => assert(exists(file), `缺少必要输出：${file}`));

const htmlFiles = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".html")) htmlFiles.push(full);
  }
};
walk(site);

const allFiles = [];
const walkAll = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkAll(full);
    else allFiles.push(path.relative(site, full).split(path.sep).join("/"));
  }
};
walkAll(site);
const allSiteFiles = () => allFiles;
// 作者批注源文件位于data目录，裸Hugo与正式构建都不得复制它。
assert(
  !allFiles.some((file) => file.endsWith("author-notes.yaml")),
  "产物中包含 author-notes.yaml（作者批注源文件绝不发布）",
);

const remoteRuntime = /<(?:script|link|img)\b[^>]+(?:src|href)=["']https?:\/\//i;
const inlineHandler = /<[^>]+\son[a-z]+\s*=/i;
const mixedContent = /(?:src|href)=["']http:\/\//i;
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, "utf8");
  const relative = path.relative(site, file);
  assert(/<html lang=(?:"zh-CN"|zh-CN)/i.test(html), `${relative} 未声明 zh-CN`);
  assert(!remoteRuntime.test(html), `${relative} 含远程运行时资源`);
  assert(!inlineHandler.test(html), `${relative} 含内联事件处理器`);
  assert(!mixedContent.test(html), `${relative} 含HTTP混合内容`);
  assert(!/password|api[_-]?key|private[_-]?key/i.test(html), `${relative} 疑似泄露敏感字段`);

  const links = [...html.matchAll(/\shref=["']([^"'#]+)(?:#[^"']*)?["']/gi)].map((match) => match[1]);
  for (const href of links) {
    if (/^(?:https?:|mailto:|tel:|javascript:)/i.test(href)) continue;
    const clean = href.split("?")[0];
    if (!clean || clean === "/") continue;
    const target = clean.startsWith("/")
      ? path.join(site, decodeURI(clean))
      : path.resolve(path.dirname(file), decodeURI(clean));
    const candidate = clean.endsWith("/") ? path.join(target, "index.html") : target;
    assert(fs.existsSync(candidate), `${relative} 的内部链接无效：${href}`);
  }
}

const home = read("index.html");
assert(Buffer.byteLength(home) < 1_000_000, "首页HTML超过1MB");
assert(!home.includes("未公开的草稿示例"), "草稿进入了正式构建");
assert(!/comments\.[a-f0-9]+\.js/.test(home), "首页不应加载段评脚本");

const commentManifest = JSON.parse(read("comment-manifest.json"));
assert(commentManifest.schemaVersion === 1 && Array.isArray(commentManifest.articles), "段评manifest格式异常");
const articleIds = new Set();
for (const article of commentManifest.articles) {
  assert(!articleIds.has(article.articleId), `重复articleId：${article.articleId}`);
  articleIds.add(article.articleId);
  const paragraphIds = new Set();
  for (const paragraph of article.paragraphs) {
    assert(!paragraphIds.has(paragraph.paragraphId), `${article.articleId}含重复paragraphId`);
    paragraphIds.add(paragraph.paragraphId);
  }
  const page = read(path.join(article.canonicalPath, "index.html"));
  assert(page.includes(`data-comment-article-id=${article.articleId}`), `${article.articleId}页面缺少稳定文章ID`);
  assert(!page.includes("paragraph-comment-button"), `${article.articleId}静态HTML不应包含段评按钮（应由前端脚本注入）`);
  for (const paragraph of article.paragraphs) {
    assert(page.includes(`data-paragraph-id=${paragraph.paragraphId}`), `${article.articleId}缺少段落锚点${paragraph.paragraphId}`);
  }
}

// 构建产物中的段评前端必须保持段尾行内契约（防止压缩或管线破坏）。
const builtCssName = allSiteFiles().find((name) => /css\/site\.[^/]*\.css$/.test(name));
if (commentManifest.articles.length) {
  assert(builtCssName, "构建产物缺少站点CSS");
  const builtJsName = allSiteFiles().find((name) => /js\/comments\.[^/]*\.js$/.test(name));
  assert(builtJsName, "构建产物缺少段评脚本");
  if (builtCssName) {
    const builtCss = read(builtCssName);
    assert(/\.paragraph-comment-button\{[^}]*display:inline-flex/.test(builtCss), "构建CSS中的段评按钮必须是inline-flex");
    assert(/\.paragraph-comment-button\{[^}]*user-select:none/.test(builtCss), "构建CSS中的段评按钮必须禁止选中");
    assert(builtCss.includes("attr(data-badge)"), "构建CSS中的段评标签必须由attr(data-badge)渲染");
  }
  if (builtJsName) {
    const builtJs = read(builtJsName);
    assert(builtJs.includes("appendChild"), "构建后的段评脚本必须把按钮插入段落内部");
    assert(builtJs.includes("badge"), "构建后的段评脚本必须保留data-badge数量传递");
  }
}

if (exists("works/cloud-post-office/first-letter/index.html")) {
  const first = read("works/cloud-post-office/first-letter/index.html");
  const second = read("works/cloud-post-office/second-letter/index.html");
  assert(/rel=(?:\"next\"|next)/.test(first), "demo第一篇缺少下一篇");
  assert(/rel=(?:\"prev\"|prev)/.test(second), "demo第二篇缺少上一篇");
  assert(first.includes("series-nav") && second.includes("series-nav"), "demo缺少系列篇目导航");
}

const searchIndex = JSON.parse(read("search-index.json"));
assert(Array.isArray(searchIndex), "搜索索引未正常生成");
assert(searchIndex.every((item) => typeof item.title === "string" && String(item.url).startsWith("/")), "搜索索引字段异常");
if (requireDemoFixtures) {
  const longRecord = searchIndex.find((item) => item.url === "/works/demo-collection/long-reading-test/");
  assert(longRecord, "三万字文章未进入搜索索引");
  for (const marker of ["青简初展", "长河半渡", "卷帙将终"]) {
    assert(String(longRecord?.content).includes(marker), `搜索索引无法检索长文位置：${marker}`);
  }

  const longSource = fs.readFileSync(path.resolve("content/works/demo-collection/long-reading-test/index.md"), "utf8");
  assert(longSource.length >= 30_000, "三万字测试稿不足30000字符");
  const longHtml = read("works/demo-collection/long-reading-test/index.html");
  assert(longHtml.includes("article-content"), "长文正文未生成");
  assert(longHtml.includes("文章目录"), "长文目录未生成");
  assert(/<table[\s>]/.test(longHtml), "三万字测试稿表格未生成");
  assert(/class=(?:"footnotes\b|footnotes\b)/.test(longHtml), "三万字测试稿脚注未生成");
  assert(/demo-long/.test(longHtml), "三万字测试稿图片未生成");
  assert(/series-nav/.test(longHtml), "三万字测试稿系列导航未生成");
  const hugeSource = fs.readFileSync(path.resolve("content/works/demo-collection/long-novel-test/index.md"), "utf8");
  assert(hugeSource.length >= 100_000, "十万字测试稿不足100000字符");
  const hugeHtml = read("works/demo-collection/long-novel-test/index.html");
  assert(hugeHtml.includes("article-content") && hugeHtml.includes("文章目录"), "十万字页面或目录未生成");
}

const rss = read("index.xml");
assert(rss.startsWith("<?xml") && /encoding="utf-8"/i.test(rss), "RSS不是UTF-8 XML");
assert(/<rss[\s>]/.test(rss) && /<channel>/.test(rss), "RSS结构不合法");
assert(/<title>[^<]*[\u3400-\u9fff]/.test(rss), "RSS中文标题未正常生成");
assert(!rss.includes("未公开的草稿示例"), "RSS包含草稿");
for (const link of rss.matchAll(/<link>([^<]+)<\/link>/g)) {
  assert(/^https?:\/\/[^ ]+/.test(link[1]), `RSS包含非法URL：${link[1]}`);
}
for (const date of rss.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)) {
  assert(!Number.isNaN(Date.parse(date[1])), `RSS日期格式不正确：${date[1]}`);
}

const allNames = [];
const collectNames = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectNames(full);
    else allNames.push(entry.name);
  }
};
collectNames(site);
assert(!allNames.some((name) => name === ".env" || name.endsWith(".md") || name.endsWith(".sh") || name === ".git"), "发布目录包含源码、脚本或敏感文件");
for (const forbidden of ["backups", "scripts", "private", ".git"]) {
  assert(!fs.existsSync(path.join(site, forbidden)), `发布目录包含禁止目录：${forbidden}`);
}

if (failures.length) {
  console.error(`自动检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`自动检查通过：${htmlFiles.length}个HTML页面，${searchIndex.length}条搜索记录。`);
