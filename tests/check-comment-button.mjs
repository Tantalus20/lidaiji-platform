import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// 段评入口契约：段尾行内、不可复制、数量正确、点击行为不变。
// 这是源码级静态断言，配合 check-site.mjs 的构建产物断言一起运行。

const root = path.resolve(process.argv[2] || path.join(new URL("..", import.meta.url).pathname));
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const commentsJs = fs.readFileSync(
  path.join(root, "themes/lidaiji/assets/js/comments.js"), "utf8",
);
const siteCss = fs.readFileSync(
  path.join(root, "themes/lidaiji/assets/css/site.css"), "utf8",
);

// 1. 按钮必须插入段落内部（段尾行内），不得再使用 afterend 独占下一行。
assert(/paragraph\.appendChild\(button\)/.test(commentsJs),
  "段评按钮必须 appendChild 到段落内部（段尾行内）");
assert(!/insertAdjacentElement\("afterend"/.test(commentsJs),
  "段评按钮不得再插入段落之后（afterend 会独占一行）");

// 2. 按钮文本不得写入 DOM 文本节点，避免被复制进正文。
assert(!/button\.textContent\s*=\s*[^;]*段评/.test(commentsJs),
  "段评按钮不得把“段评”写入 textContent（会被复制进正文）");
assert(/button\.dataset\.badge\s*=/.test(commentsJs),
  "段评数量必须通过 data-badge 传递，由 CSS 伪元素渲染");
assert(/setAttribute\("aria-label"/.test(commentsJs),
  "段评按钮必须保留 aria-label 以保证屏幕阅读器可读");

// 3. 按钮仍只挂在普通正文段落上，不进入引用/列表/标题等块级内容。
assert(/\.article-content > p\[data-paragraph-id\]/.test(commentsJs),
  "段评按钮选择器必须限定为正文直接子级段落");

// 4. CSS 必须是行内布局，且文字不可选中。
const buttonRule = siteCss.match(/\.paragraph-comment-button\s*\{([\s\S]*?)\}/);
assert(buttonRule, "缺少 .paragraph-comment-button 样式");
const ruleBody = buttonRule ? buttonRule[1] : "";
assert(/display:\s*inline-flex/.test(ruleBody), "段评按钮必须是 inline-flex 行内元素");
assert(!/display:\s*block/.test(ruleBody), "段评按钮不得是 block（会独占一行）");
assert(/white-space:\s*nowrap/.test(ruleBody), "段评按钮必须 nowrap（换行时整体下移）");
assert(/user-select:\s*none/.test(ruleBody), "段评按钮必须禁止选中");
assert(/vertical-align:\s*baseline/.test(ruleBody), "段评按钮必须基线对齐");
assert(/\.paragraph-comment-button::before[\s\S]*?attr\(data-badge\)/.test(siteCss),
  "段评标签必须由 ::before + attr(data-badge) 渲染");

// 5. 打印样式必须隐藏段评按钮。
const printBlock = siteCss.match(/@media print\s*\{([\s\S]*)\}\s*$/);
assert(printBlock && printBlock[1].includes(".paragraph-comment-button"),
  "打印样式必须隐藏段评按钮");

// 6. 面板焦点返回与状态提示逻辑保持不变。
assert(/trigger\?\.focus\(\)/.test(commentsJs), "关闭面板后必须把焦点还给段评按钮");
assert(/提交段评，等待审核/.test(commentsJs), "提交按钮文案与状态提示不得改变");

if (failures.length) {
  console.error(`段评入口契约检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("段评入口契约检查通过：段尾行内、不可复制、数量与点击行为不变。");
