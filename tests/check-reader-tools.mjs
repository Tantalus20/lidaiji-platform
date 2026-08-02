import fs from "node:fs";
import path from "node:path";

// 阅读工具回归契约：正文字号调节与上一篇/下一篇快捷切换。
// 源码级断言始终执行；设置 SITE_DIR 时追加构建产物断言。

const root = path.resolve(process.argv[2] || path.join(new URL("..", import.meta.url).pathname));
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const siteJs = read("themes/lidaiji/assets/js/site.js");
const siteCss = read("themes/lidaiji/assets/css/site.css");
const single = read("themes/lidaiji/layouts/_default/single.html");

// 1. 字号控件：仅文章页模板输出，三档位、aria-pressed、默认隐藏（无 JS 用原字号）。
assert(single.includes("reader-tools"), "文章模板缺少字号控件容器");
assert(single.includes('data-reader-font="small"') && single.includes('data-reader-font="large"'),
  "字号控件缺少小/大档位");
assert(/data-reader-font="standard" aria-pressed="true"/.test(single), "标准档位必须默认 aria-pressed=true");
assert(/<div class="reader-tools" hidden>/.test(single), "字号控件必须默认 hidden，无 JavaScript 时不出现");
assert(single.includes('aria-labelledby="reader-font-label"'), "字号控件必须有可访问名称");

// 2. 字号实现：状态属性 + CSS 变量缩放，不逐节点写内联样式。
assert(siteCss.includes('.reading-layout[data-reader-font="small"]'), "缺少小字号档位样式");
assert(siteCss.includes('.reading-layout[data-reader-font="large"]'), "缺少大字号档位样式");
assert(siteCss.includes("--reader-font-scale"), "字号必须通过 --reader-font-scale 变量缩放");
assert(/\.article-content\s*\{[^}]*calc\(clamp\(1\.04rem, 1\.7vw, 1\.12rem\) \* var\(--reader-font-scale, 1\)\)/s.test(siteCss),
  "正文字号必须基于原 clamp 值乘以缩放变量");
assert(!/\.style\.fontSize/.test(siteJs), "不得用内联样式逐节点修改字号");

// 3. 持久化与回退。
assert(siteJs.includes("lidaiji-reader-font"), "缺少字号本地存储键 lidaiji-reader-font");
assert(siteJs.includes("dataset.readerFont"), "字号必须写入 data-reader-font 状态属性");
assert(siteJs.includes("readerTools.hidden = false"), "JS 运行时才显示字号控件");
assert(!siteJs.includes("alert("), "不得使用浏览器原生 alert");

// 4. 移动端快捷切换条：JS 注入、安全区、无键盘左右键切换。
assert(siteJs.includes("reader-pager-bar"), "缺少移动端快捷切换条注入逻辑");
assert(siteJs.includes("bar-disabled"), "第一篇/最后一篇必须输出禁用态而不是假链接");
assert(!/ArrowLeft|ArrowRight/.test(siteJs), "不得用键盘左右方向键切换文章");
assert(/\.reader-pager-bar\s*\{[\s\S]*?env\(safe-area-inset-bottom/.test(siteCss), "快捷切换条必须适配底部安全区");
assert(/\.reader-pager-bar\[hidden\]\s*\{\s*display:\s*none/.test(siteCss), "快捷切换条必须可隐藏");
assert(/\.article-pager a:only-child\s*\{[^}]*grid-column:\s*1 \/ -1/.test(siteCss), "单方向文章导航必须占满整行");

// 5. 打印隐藏新控件。
const printBlock = siteCss.match(/@media print\s*\{([\s\S]*)\}\s*$/);
assert(printBlock && printBlock[1].includes(".reader-tools") && printBlock[1].includes(".reader-pager-bar"),
  "打印样式必须隐藏字号控件与快捷切换条");

// 6. 构建产物级断言（仅在传入 SITE_DIR 时执行）。
if (process.env.SITE_DIR) {
  const site = path.resolve(process.env.SITE_DIR);
  const readOut = (file) => fs.readFileSync(path.join(site, file), "utf8");

  const manifest = JSON.parse(readOut("comment-manifest.json"));
  const articles = manifest.articles.map((item) => item.canonicalPath.replace(/^\//, "") + "index.html");
  for (const name of articles) {
    const html = readOut(name);
    assert(html.includes("reader-tools"), `${name} 缺少字号控件`);
    assert(!html.includes("reader-pager-bar"), `${name} 静态HTML不应包含快捷切换条（应由JS注入）`);
  }

  for (const file of ["index.html", "404.html", "search/index.html", "timeline/index.html", "about/index.html"]) {
    const html = readOut(file);
    assert(!html.includes("reader-tools"), `${file} 不应显示字号控件`);
  }
}

if (failures.length) {
  console.error(`阅读工具契约检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("阅读工具契约检查通过：字号三档位、跨文章持久化、上下篇边界与移动端快捷切换条。");
