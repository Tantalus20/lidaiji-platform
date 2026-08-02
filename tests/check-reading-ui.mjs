import fs from "node:fs";
import path from "node:path";

// 阅读界面回归契约：目录高亮、标题锚点、回到顶部、轻提示、导航 aria-current、
// 段评状态分级。这是源码级静态断言，配合 check-site.mjs 的构建产物断言运行。
// 若设置了 SITE_DIR，额外对构建产物做输出级断言。

const root = path.resolve(process.argv[2] || path.join(new URL("..", import.meta.url).pathname));
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const siteJs = read("themes/lidaiji/assets/js/site.js");
const siteCss = read("themes/lidaiji/assets/css/site.css");
const commentsJs = read("themes/lidaiji/assets/js/comments.js");
const header = read("themes/lidaiji/layouts/partials/header.html");
const single = read("themes/lidaiji/layouts/_default/single.html");

// 1. 标题锚点渲染钩子：保留原锚点 id，锚点链接可被脚本识别。
const renderHeading = "themes/lidaiji/layouts/_default/_markup/render-heading.html";
assert(fs.existsSync(path.join(root, renderHeading)), "缺少标题渲染钩子 render-heading.html");
if (fs.existsSync(path.join(root, renderHeading))) {
  const hook = read(renderHeading);
  assert(/id="\{\{ \.Anchor \}\}"/.test(hook), "标题渲染钩子必须保留原锚点 id");
  assert(hook.includes("heading-anchor"), "标题渲染钩子必须输出 heading-anchor 链接");
  assert(hook.includes("aria-label"), "标题锚点必须有 aria-label");
}

// 2. 目录当前章节高亮：使用 IntersectionObserver，不用高频滚动监听。
assert(siteJs.includes("IntersectionObserver"), "目录高亮必须使用 IntersectionObserver");
assert(siteJs.includes("toc-current"), "目录高亮必须写入 toc-current 类");
assert(siteJs.includes('aria-current", "location"'), "目录当前项必须标记 aria-current=location");

// 3. 阅读进度与回到顶部必须 rAF 节流。
assert(siteJs.includes("requestAnimationFrame"), "滚动相关逻辑必须使用 requestAnimationFrame 节流");
assert(siteJs.includes("back-to-top"), "缺少回到顶部按钮注入");
assert(siteJs.includes("prefers-reduced-motion"), "回到顶部必须尊重减少动态设置");

// 3b. 篇章目录浮动按钮：取自系列导航、当前篇 aria-current、Esc 可关。
assert(siteJs.includes("toc-fab"), "缺少篇章目录按钮注入");
assert(siteJs.includes("chapter-menu"), "缺少篇目面板注入");
assert(siteJs.includes('aria-expanded", "false"'), "目录按钮必须有 aria-expanded 状态");
assert(siteJs.includes('aria-current", "page"'), "篇目面板必须标记当前篇");
assert(siteCss.includes(".chapter-menu") && siteCss.includes(".reader-fabs"), "站点CSS缺少目录按钮与面板样式");

// 4. 阅读位置记忆与篇目读至标记。
assert(siteJs.includes("lidaiji-reading-positions"), "缺少阅读位置存储键 lidaiji-reading-positions");
assert(siteJs.includes("reading-resume"), "缺少续读提示注入逻辑");
assert(siteJs.includes("data-read-state"), "缺少篇目读至标记逻辑");
assert(!siteJs.includes("window.location.href ="), "续读不得自动跳转，只能由读者点击");
const chapterList = read("themes/lidaiji/layouts/partials/chapter-list.html");
assert(chapterList.includes("data-read-state"), "篇目模板缺少读至标记占位");
assert(siteCss.includes(".reading-resume") && siteCss.includes(".chapter-read"), "站点CSS缺少续读与读至标记样式");
const printBlock2 = siteCss.match(/@media print\s*\{([\s\S]*)\}\s*$/);
assert(printBlock2 && printBlock2[1].includes(".reading-resume"), "打印样式必须隐藏续读提示");

// 5. 标题锚点复制退化为普通锚点（无 clipboard 时不得 preventDefault）。
assert(siteJs.includes("navigator.clipboard"), "标题锚点必须支持复制链接");
assert(siteJs.includes("site-toast"), "复制反馈必须使用轻提示而不是 alert");
assert(!siteJs.includes("alert("), "不得使用浏览器原生 alert");

// 5. CSS：新组件样式与打印隐藏齐全。
for (const selector of [".heading-anchor", ".toc-current", ".back-to-top", ".site-toast", '[aria-current="page"]', '[data-tone="error"]']) {
  assert(siteCss.includes(selector), `站点CSS缺少样式：${selector}`);
}
const printBlock = siteCss.match(/@media print\s*\{([\s\S]*)\}\s*$/);
assert(printBlock && printBlock[1].includes(".back-to-top") && printBlock[1].includes(".heading-anchor"),
  "打印样式必须隐藏回到顶部与标题锚点");
assert(/:root\s*\{[\s\S]*?--danger:/.test(siteCss), "缺少错误状态颜色变量 --danger");
assert(/\[data-theme="dark"\]\s*\{[\s\S]*?--danger:/.test(siteCss), "深色模式缺少 --danger 变量");

// 6. 段评状态分级：保留原契约，新增 tone。
assert(commentsJs.includes("status.dataset.tone"), "段评状态必须输出 data-tone 分级");
assert(/setStatus\([^)]*,\s*"error"\)/.test(commentsJs), "段评失败状态必须使用 error 分级");
assert(/setStatus\([^)]*,\s*"success"\)/.test(commentsJs), "段评提交成功必须使用 success 分级");

// 7. 导航与目录无障碍。
assert(header.includes('aria-current="page"'), "主导航必须标记当前栏目 aria-current=page");
assert(single.includes("TableOfContents-mobile"), "移动端目录必须改为独立 id，避免与桌面目录重复");
assert(single.includes('aria-label="文章目录"'), "桌面目录必须有 aria-label");

// 8. 构建产物级断言（仅在传入 SITE_DIR 时执行）。
if (process.env.SITE_DIR) {
  const site = path.resolve(process.env.SITE_DIR);
  const htmlFiles = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) htmlFiles.push(full);
    }
  };
  walk(site);
  let pagesWithAnchoredHeadings = 0;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    const relative = path.relative(site, file);
    const duplicateToc = html.match(/id=(?:"TableOfContents"|TableOfContents)[\s>]/g) || [];
    assert(duplicateToc.length <= 1, `${relative} 存在重复 TableOfContents id`);
    // 只检查正文容器内的标题；模板里的栏目 h2（如“最近更新”）不应有锚点。
    const marker = html.search(/class=(?:"article-content"|article-content)/);
    if (marker < 0) continue;
    const end = html.indexOf("<footer", marker);
    const region = html.slice(marker, end > marker ? end : undefined);
    const headings = region.match(/<h[2-4][\s>]/g) || [];
    if (!headings.length) continue;
    pagesWithAnchoredHeadings += 1;
    const anchored = region.match(/<h[2-4][^>]*>(?:(?!\/h[2-4]>)[\s\S])*?heading-anchor/g) || [];
    assert(anchored.length === headings.length,
      `${relative} 有 ${headings.length - anchored.length} 个正文标题缺少锚点链接`);
  }
  const home = fs.readFileSync(path.join(site, "index.html"), "utf8");
  assert(home.includes('aria-current="page"') || home.includes("aria-current=page"), "首页导航缺少 aria-current=page");
  console.log(`构建产物阅读界面检查：${htmlFiles.length} 个页面，${pagesWithAnchoredHeadings} 个含带锚点标题。`);
}

if (failures.length) {
  console.error(`阅读界面契约检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("阅读界面契约检查通过：目录高亮、标题锚点、回到顶部、轻提示、导航与段评状态分级。");
