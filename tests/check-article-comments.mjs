import fs from "node:fs";
import path from "node:path";

// 章评前端契约：区域位置、纯文本渲染、表单行为、状态反馈、非文章页不出现。
// 源码级断言始终执行；设置 SITE_DIR 时追加构建产物断言。

const root = path.resolve(process.argv[2] || path.join(new URL("..", import.meta.url).pathname));
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const js = read("themes/lidaiji/assets/js/article-comments.js");
const css = read("themes/lidaiji/assets/css/site.css");
const single = read("themes/lidaiji/layouts/_default/single.html");
const head = read("themes/lidaiji/layouts/partials/head.html");

// 1. 模板：章评区只在文章页输出，带锚点供后台跳转。
assert(single.includes('id="article-comments"'), "文章模板缺少章评区锚点 article-comments");
assert(single.includes("data-article-comments"), "章评区缺少 data-article-comments 容器");
assert(single.includes("data-ac-form") && single.includes("data-ac-open"), "章评区缺少写章评入口与表单");
assert(/<form class="article-comment-form" data-ac-form hidden>/.test(single), "章评表单必须默认隐藏，不直接展开");
assert(single.includes('minlength="10" maxlength="3000"'), "章评正文前端长度限制必须为10-3000");

// 2. 脚本加载条件与段评一致（仅评论文章页）。
assert(head.includes('resources.Get "js/article-comments.js"'), "head未加载章评脚本");
assert(head.indexOf('resources.Get "js/article-comments.js"') > head.indexOf('resources.Get "js/comments.js"'),
  "章评脚本必须与段评脚本处于同一条件分支");

// 3. 安全与行为：纯文本、无alert、无innerHTML、不泄露评论内容到控制台。
assert(!js.includes("innerHTML"), "章评脚本不得使用innerHTML");
assert(!js.includes("alert("), "章评脚本不得使用alert");
assert(!/console\.(log|info|debug)/.test(js), "章评脚本不得向控制台输出调试信息");
assert(js.includes("textContent"), "章评必须以textContent纯文本渲染");
assert(js.includes('scope: "article"'), "章评提交必须携带scope=article");

// 4. 表单行为：Esc关闭、焦点返还、防重复提交、失败保留输入、成功不清空前不重置。
assert(js.includes('event.key === "Escape"'), "章评表单必须支持Esc关闭");
assert(js.includes("openButton.focus()"), "关闭表单后焦点必须返还写章评按钮");
assert(js.includes("submitButton.disabled = true"), "提交中必须禁用重复提交");
assert(js.includes("lidaiji-comment-client"), "章评必须复用段评的匿名浏览器标识");
assert(js.includes("章评暂时无法加载，正文阅读不受影响"), "API失败必须有统一提示");
assert(js.includes('data.message || "章评已提交，等待审核。"'), "提交成功必须显示待审核提示");

// 5. 计数与分页：只统计approved章评，默认小批量加载。
assert(js.includes("articleCount"), "章评数量必须来自counts接口的articleCount");
assert(js.includes("limit=${PAGE_SIZE}") || js.includes("limit="), "章评必须分页加载");
assert(/PAGE_SIZE = 5/.test(js), "章评默认每批5条");

// 6. 样式：区域、列表、表单与打印隐藏齐全。
for (const selector of [".article-comments", ".article-comment", ".article-comment-form", ".article-comments-more", ".article-comments-total"]) {
  assert(css.includes(selector), `站点CSS缺少章评样式：${selector}`);
}
const printBlock = css.match(/@media print\s*\{([\s\S]*)\}\s*$/);
assert(printBlock && printBlock[1].includes(".article-comment-form"), "打印样式必须隐藏章评表单");

// 7. 构建产物级断言（仅在传入 SITE_DIR 时执行）。
if (process.env.SITE_DIR) {
  const site = path.resolve(process.env.SITE_DIR);
  const readOut = (file) => fs.readFileSync(path.join(site, file), "utf8");
  const manifest = JSON.parse(readOut("comment-manifest.json"));
  const firstPath = manifest.articles[0].canonicalPath.replace(/^\//, "") + "index.html";
  const article = readOut(firstPath);
  assert(article.includes('id=article-comments') || article.includes('id="article-comments"'), "文章页缺少章评区");
  assert(!article.includes("article-comment\""), "静态HTML不应包含已渲染的章评条目");
  for (const file of ["index.html", "404.html", "search/index.html", "timeline/index.html", "about/index.html"]) {
    assert(!readOut(file).includes("data-article-comments"), `${file} 不应出现章评区`);
  }
}

if (failures.length) {
  console.error(`章评前端契约检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("章评前端契约检查通过：区域位置、纯文本渲染、表单行为、状态反馈与非文章页隔离。");
