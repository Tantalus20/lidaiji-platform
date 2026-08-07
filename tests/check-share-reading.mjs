#!/usr/bin/env node
/* 分享站阅读工具回归契约：字号调节、深浅主题、阅读位置记忆、目录、
   上一篇/下一篇、回到顶部。源码级断言始终执行；设置 SITE_DIR 时追加
   构建产物断言。 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || path.join(new URL("..", import.meta.url).pathname));
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const siteJs = read("share-site/assets/js/site.js");
const siteCss = read("share-site/assets/css/site.css");
const single = read("share-site/layouts/_default/single.html");
const baseof = read("share-site/layouts/_default/baseof.html");

// 1. 字号控件：三档位、aria-pressed、默认 hidden（无 JS 用原字号）。
assert(single.includes("reader-tools"), "分享文章模板缺少字号控件容器");
assert(single.includes('data-reader-font="small"') && single.includes('data-reader-font="large"'),
  "字号控件缺少小/大档位");
assert(/data-reader-font="standard" aria-pressed="true"/.test(single), "标准档位必须默认 aria-pressed=true");
assert(/<div class="reader-tools" hidden>/.test(single), "字号控件必须默认 hidden，无 JavaScript 时不出现");

// 2. 字号实现：状态属性 + CSS 变量，不逐节点写内联样式。
assert(siteCss.includes('.reading-layout[data-reader-font="small"]'), "缺少小字号档位样式");
assert(siteCss.includes('.reading-layout[data-reader-font="large"]'), "缺少大字号档位样式");
assert(siteCss.includes("--reader-font-scale"), "字号必须通过 --reader-font-scale 变量缩放");
assert(!/\.style\.fontSize/.test(siteJs), "不得用内联样式逐节点修改字号");

// 3. 持久化与回退。
assert(siteJs.includes("lidaiji-reader-font"), "缺少字号本地存储键 lidaiji-reader-font");
assert(siteJs.includes("dataset.readerFont"), "字号必须写入 data-reader-font 状态属性");
assert(siteJs.includes("readerTools.hidden = false"), "JS 运行时才显示字号控件");

// 4. 深浅主题：localStorage + data-theme。
assert(siteJs.includes("writing-site-theme"), "缺少主题本地存储键 writing-site-theme");
assert(siteJs.includes("dataset.theme"), "主题必须写入 html data-theme 状态属性");
assert(siteCss.includes('[data-theme="dark"]'), "缺少深色主题变量块");

// 5. 阅读位置记忆：localStorage 键、续读提示、不自动跳转、不上传。
assert(siteJs.includes("lidaiji-reading-positions"), "缺少阅读位置本地存储键 lidaiji-reading-positions");
assert(siteJs.includes("reading-resume"), "缺少续读提示注入逻辑");
assert(siteJs.includes("继续阅读"), "续读必须由读者点击才跳转");
assert(siteJs.includes("localStorage"), "阅读位置必须只存 localStorage");
assert(!/fetch\(|XMLHttpRequest/.test(siteJs), "分享站阅读脚本不得发起网络请求");

// 6. 目录：移动端 details + 桌面侧栏，仅长文且 JS 可见时高亮。
assert(single.includes("mobile-toc"), "分享文章模板缺少移动端目录");
assert(single.includes("desktop-toc"), "分享文章模板缺少桌面端目录");
assert(siteJs.includes("toc-current"), "目录高亮必须写入 toc-current 类");
assert(siteJs.includes("IntersectionObserver"), "目录高亮必须使用 IntersectionObserver");

// 7. 上一篇/下一篇 + 返回分享首页。
assert(single.includes('rel="prev"'), "分享文章模板缺少上一篇");
assert(single.includes('rel="next"'), "分享文章模板缺少下一篇");
assert(single.includes("返回长文分享首页"), "分享文章缺少返回分享首页入口");
assert(siteJs.includes("reader-pager-bar"), "缺少移动端快捷切换条注入逻辑");

// 8. 回到顶部 + 阅读进度。
assert(siteJs.includes("back-to-top"), "缺少回到顶部按钮注入");
assert(siteJs.includes("requestAnimationFrame"), "滚动相关逻辑必须使用 requestAnimationFrame 节流");
assert(baseof.includes("reading-progress"), "分享站 baseof 缺少阅读进度条");

// 9. 分享站页面不得携带正式站评论/锚点身份（模板级）。
assert(!single.includes("article-comments"), "分享文章模板不得包含评论区");
assert(!single.includes("data-comments"), "分享文章模板不得绑定评论脚本");
assert(!single.includes("paragraph-id"), "分享文章模板不得生成段落锚点");

// 10. 构建产物级断言（仅在传入 SITE_DIR 时执行）。
if (process.env.SITE_DIR) {
  const site = path.resolve(process.env.SITE_DIR);
  const readOut = (file) => fs.readFileSync(path.join(site, file), "utf8");
  const page = path.join(site, "ye-hang-chuan-ji", "index.html");
  assert(fs.existsSync(page), "演示长文页面不存在");
  if (fs.existsSync(page)) {
    const html = readOut("ye-hang-chuan-ji/index.html");
    assert(html.includes('data-reader-font="small"'), "构建产物缺少字号控件");
    assert(html.includes("mobile-toc"), "构建产物缺少移动端目录");
    assert(html.includes("desktop-toc"), "构建产物缺少桌面端目录");
    assert(html.includes("文章目录"), "构建产物目录必须可读");
    assert(!html.includes("comments"), "构建产物不得出现评论相关标记");
  }
}

if (failures.length) {
  console.error(`分享站阅读工具检查失败：${failures.length} 项`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log("分享站阅读工具检查通过。");
