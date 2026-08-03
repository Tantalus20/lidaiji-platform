/* 编辑器正式渲染链路自动测试。
 *
 * 1. 主题 CSS 必须显式渲染 <strong>/<em>，不得被重置为普通样式；
 * 2. 用本机 Hugo 构建一个临时迷你站点，验证正文中的 **加粗**、*斜体*、
 *    ***粗斜体*** 被渲染为语义化 <strong>/<em>；
 * 3. 编辑器关键文件与页面接线存在性检查。
 *
 * 依赖：HUGO_BIN 环境变量或仓库内 .hugo-local 或 PATH 中的 hugo。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`通过：${name}`);
  } catch (error) {
    failures += 1;
    console.error(`失败：${name}`);
    console.error(`  ${error.message}`);
  }
}

/* 1. 正式 CSS 没有抹除加粗/斜体 */
test("正式站点 CSS 显式渲染 strong/em", () => {
  const css = fs.readFileSync(path.join(root, "themes/lidaiji/assets/css/site.css"), "utf8");
  assert.match(
    css,
    /\.article-content\s+strong\s*\{[^}]*font-weight\s*:\s*700[^}]*\}/,
    "缺少 .article-content strong { font-weight: 700 }",
  );
  assert.match(
    css,
    /\.article-content\s+em\s*\{[^}]*font-style\s*:\s*italic[^}]*\}/,
    "缺少 .article-content em { font-style: italic }",
  );
  assert.ok(
    !/em\s*\{\s*[^}]*font-style\s*:\s*normal/i.test(css),
    "存在把 em 重置为 normal 的规则",
  );
});

/* 2. Hugo 渲染：**加粗** → <strong>，*斜体* → <em>，***粗斜*** → 两者 */
function findHugo() {
  if (process.env.HUGO_BIN && fs.existsSync(process.env.HUGO_BIN)) return process.env.HUGO_BIN;
  const local = path.join(root, ".hugo-local");
  if (fs.existsSync(local)) return local;
  return "hugo";
}

test("Hugo 构建后正文包含语义化 strong 与 em", () => {
  const hugo = findHugo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-format-check-"));
  try {
    fs.writeFileSync(
      path.join(work, "hugo.toml"),
      'baseURL = "https://example.invalid/"\ntitle = "fixture"\ndisableKinds = ["home", "rss", "sitemap", "taxonomy", "term", "section", "404", "robotsTXT"]\n',
    );
    fs.mkdirSync(path.join(work, "content", "p"), { recursive: true });
    fs.writeFileSync(
      path.join(work, "content", "p", "fixture.md"),
      [
        "---",
        "title: 格式测试",
        "---",
        "",
        "普通段落开始。",
        "",
        "这是**加粗的中文**。",
        "",
        "这是*斜体的中文*。",
        "",
        "这是***粗斜体的中文***。",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(work, "layouts", "_default"), { recursive: true });
    fs.writeFileSync(path.join(work, "layouts", "_default", "single.html"), "{{ .Content }}");
    execFileSync(hugo, ["--source", work, "--destination", path.join(work, "public")], {
      stdio: "pipe",
    });
    const candidates = [
      path.join(work, "public", "p", "fixture", "index.html"),
      path.join(work, "public", "p", "index.html"),
    ];
    const found = candidates.find((file) => fs.existsSync(file));
    assert.ok(found, `未找到 Hugo 构建产物：${candidates.join(" / ")}`);
    const html = fs.readFileSync(found, "utf8");
    assert.ok(html.includes("<strong>加粗的中文</strong>"), "加粗未渲染为 <strong>");
    assert.ok(html.includes("<em>斜体的中文</em>"), "斜体未渲染为 <em>");
    const combined =
      html.includes("<em><strong>粗斜体的中文</strong></em>") ||
      html.includes("<strong><em>粗斜体的中文</em></strong>");
    assert.ok(combined, "粗斜体未同时渲染为 <strong> 与 <em>");
    assert.ok(!html.includes("<span style=\"font-weight"), "正文不应使用内联样式替代 strong");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

/* 2b. Hugo 短代码渲染：align/poetry/endnote → 受控类名 */
test("Hugo 渲染段落排版短代码为受控类名", () => {
  const hugo = findHugo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-format-shortcode-"));
  try {
    fs.writeFileSync(
      path.join(work, "hugo.toml"),
      'baseURL = "https://example.invalid/"\ntitle = "fixture"\ndisableKinds = ["home", "rss", "sitemap", "taxonomy", "term", "section", "404", "robotsTXT"]\n',
    );
    fs.mkdirSync(path.join(work, "content", "p"), { recursive: true });
    fs.mkdirSync(path.join(work, "layouts", "shortcodes"), { recursive: true });
    fs.mkdirSync(path.join(work, "layouts", "_default"), { recursive: true });
    // 使用主题真实 shortcode 定义（与站点一致）
    const shortcodesDir = path.join(root, "themes/lidaiji/layouts/shortcodes");
    for (const name of ["align.html", "poetry.html", "endnote.html"]) {
      fs.copyFileSync(path.join(shortcodesDir, name), path.join(work, "layouts", "shortcodes", name));
    }
    fs.writeFileSync(
      path.join(work, "content", "p", "fixture.md"),
      [
        "---",
        "title: 排版测试",
        "---",
        "",
        "{{< align center >}}",
        "",
        "**加粗**题记",
        "",
        "{{< /align >}}",
        "",
        "{{< poetry >}}",
        "",
        "山有木兮*木有枝*",
        "",
        "心悦君兮君不知",
        "",
        "{{< /poetry >}}",
        "",
        "{{< endnote >}}",
        "",
        "写于二〇二六年八月",
        "",
        "**君纪鉴**",
        "",
        "{{< /endnote >}}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(work, "layouts", "_default", "single.html"), "{{ .Content }}");
    execFileSync(hugo, ["--source", work, "--destination", path.join(work, "public")], {
      stdio: "pipe",
    });
    const candidates = [
      path.join(work, "public", "p", "fixture", "index.html"),
      path.join(work, "public", "p", "index.html"),
    ];
    const found = candidates.find((file) => fs.existsSync(file));
    assert.ok(found, `未找到 Hugo 构建产物：${candidates.join(" / ")}`);
    const html = fs.readFileSync(found, "utf8");
    assert.ok(html.includes('<div class="text-align-center">'), "align 短代码未输出 text-align-center");
    assert.ok(html.includes("<strong>加粗</strong>"), "对齐块内加粗未渲染");
    assert.ok(html.includes('<div class="poetry-block">'), "poetry 短代码未输出 poetry-block");
    assert.ok(html.includes("<em>木有枝</em>"), "诗歌内斜体未渲染");
    assert.ok(html.includes('<div class="end-note">'), "endnote 短代码未输出 end-note");
    assert.ok(!html.includes("{{<"), "短代码标签泄漏到页面");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

/* 2c. 正式 CSS 存在段落排版规则 */
test("正式站点 CSS 包含段落排版规则", () => {
  const css = fs.readFileSync(path.join(root, "themes/lidaiji/assets/css/site.css"), "utf8");
  for (const selector of [
    ".article-content .text-align-center",
    ".article-content .text-align-right",
    ".article-content .text-align-left",
    ".article-content .poetry-block",
    ".article-content .end-note",
  ]) {
    assert.ok(css.includes(selector), `缺少 CSS 规则：${selector}`);
  }
  assert.match(css, /\.article-content \.poetry-block\s*\{[^}]*width: fit-content/, "诗歌块缺少整体居中布局");
  assert.match(css, /\.article-content \.end-note\s*\{[^}]*text-align: right/, "尾注块缺少右对齐");
});

/* 3. 编辑器接线存在性 */
test("编辑器源码、前端包与页面接线完整", () => {
  for (const file of [
    "studio/editor/markdown.mjs",
    "studio/editor/editor.mjs",
    "studio/static/vendor/prosemirror-bundle.js",
    "scripts/build-editor-bundle.mjs",
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `缺少文件：${file}`);
  }
  const bundle = fs.readFileSync(path.join(root, "studio/static/vendor/prosemirror-bundle.js"), "utf8");
  assert.ok(bundle.length > 100000, "编辑器前端包过小");
  assert.ok(bundle.includes("createStudioEditor"), "编辑器前端包缺少编辑器入口");
  // 在 Node vm 中执行 bundle，验证顶层与插件工厂不引用未定义标识符
  // （不依赖 node_modules，CI 可直接运行；无 DOM 环境，只测到插件构建为止）
  const sandbox = {};
  vm.runInNewContext(bundle, sandbox);
  assert.ok(sandbox.LidaijiEditor, "bundle 执行后未定义 LidaijiEditor 全局");
  assert.equal(typeof sandbox.LidaijiEditor.createStudioEditor, "function", "LidaijiEditor 缺少 createStudioEditor");
  const keymapSpec = sandbox.LidaijiEditor._internals.editorKeymap();
  assert.ok(keymapSpec["Mod-z"] && keymapSpec["Mod-b"] && keymapSpec["Mod-i"], "快捷键表不完整");
  const plugins = sandbox.LidaijiEditor._internals.buildEditorPlugins();
  assert.equal(plugins.length, 3, "插件集合构建失败（可能存在未定义标识符）");

  // 用最小 DOM 桩真正创建编辑器并加载/取回正文：
  // 可捕获 toDOM 规格错误、replace/replaceWith 误用、快捷键引用缺失等
  // 只有实例化才会暴露的问题。
  const rangeStub = {
    setStart: () => {},
    setEnd: () => {},
    selectNodeContents: () => {},
    collapse: () => {},
    insertNode: () => {},
    deleteContents: () => {},
    createContextualFragment: () => ({ firstChild: null }),
    commonAncestorContainer: null,
  };
  const selectionStub = {
    removeAllRanges: () => {},
    addRange: () => {},
    rangeCount: 0,
    anchorNode: null,
    focusNode: null,
    anchorOffset: 0,
    focusOffset: 0,
    getRangeAt: () => rangeStub,
  };
  const makeEl = (ownerDoc) => ({
    nodeType: 1,
    nodeName: "DIV",
    appendChild: () => {},
    removeChild: () => {},
    insertBefore: () => {},
    contains: () => false,
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    hasAttribute: () => false,
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    contentEditable: "",
    spellcheck: false,
    tabIndex: 0,
    draggable: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    parentNode: null,
    firstChild: null,
    nextSibling: null,
    childNodes: [],
    children: [],
    querySelectorAll: () => [],
    querySelector: () => null,
    focus: () => {},
    blur: () => {},
    cloneNode: () => null,
    textContent: "",
    innerHTML: "",
    ownerDocument: ownerDoc || null,
  });
  const sandbox2 = {
    console,
    navigator: { userAgent: "vm" },
    requestAnimationFrame: (fn) => fn(),
    getComputedStyle: () => ({}),
    innerHeight: 900,
    innerWidth: 1440,
    setTimeout,
    clearTimeout,
  };
  sandbox2.window = sandbox2;
  const documentElement = { nodeType: 1, style: {} };
  sandbox2.document = {
    createRange: () => rangeStub,
    getSelection: () => selectionStub,
    defaultView: sandbox2,
    createElement: () => makeEl(sandbox2.document),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement,
    body: documentElement,
  };
  vm.runInNewContext(bundle, sandbox2);
  const host = () => makeEl(sandbox2.document);
  const sample = "第一段**加粗**。\n\n第二段*斜体*。\n";
  const editor = sandbox2.LidaijiEditor.createStudioEditor(host(), {});
  editor.setMarkdown(sample);
  assert.equal(editor.getMarkdown(), sample, "编辑器加载后往返不一致");
  // Enter 在普通段落中必须分段（回归：不能只绑 splitListItem）
  const enterCommand = sandbox2.LidaijiEditor._internals.editorKeymap().Enter;
  let dispatched = false;
  const handled = enterCommand(editor.view.state, () => {
    dispatched = true;
  });
  assert.ok(handled === true && dispatched === true, "普通段落按回车未触发分段命令");
  // 段落对齐与容器 API
  editor.setAlignment("center");
  const centered = editor.getMarkdown();
  assert.ok(centered.includes("{{< align center >}}"), "居中未序列化为 align 短代码");
  editor.setAlignment("left");
  assert.ok(!editor.getMarkdown().includes("{{< align"), "恢复左对齐后应无对齐标记");
  editor.togglePoetry();
  assert.ok(editor.getMarkdown().includes("{{< poetry >}}"), "诗歌块未序列化");
  editor.togglePoetry();
  assert.ok(!editor.getMarkdown().includes("{{< poetry >}}"), "诗歌块转回普通正文失败");
  editor.toggleEndnote();
  assert.ok(editor.getMarkdown().includes("{{< endnote >}}"), "尾注块未序列化");
  editor.toggleEndnote();
  assert.ok(!editor.getMarkdown().includes("{{< endnote >}}"), "尾注块转回普通正文失败");
  editor.replaceDocKeepCursor("第一段**加粗**。\n\n<!-- paragraph-id:p-abc123 -->\n\n第二段*斜体*。\n");
  assert.ok(editor.getMarkdown().includes("paragraph-id:p-abc123"), "保存后锚点未保留");
  editor.toggleBold();
  editor.undo();
  editor.redo();
  editor.destroy();
  const empty = sandbox2.LidaijiEditor.createStudioEditor(host(), {});
  empty.setMarkdown("");
  assert.equal(empty.getMarkdown(), "", "空文档加载失败");
  empty.destroy();
  const rich = sandbox2.LidaijiEditor.createStudioEditor(host(), {});
  const richMarkdown = "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n- 一\n- 二\n\n> 引用\n\n## 标题\n\n![图](a.png)\n";
  rich.setMarkdown(richMarkdown);
  assert.equal(rich.getMarkdown(), richMarkdown, "表格/列表/引用/标题/图片文档往返失败");
  rich.destroy();
  const html = fs.readFileSync(path.join(root, "studio/static/index.html"), "utf8");
  assert.ok(html.includes('id="editorHost"'), "编辑页缺少编辑区容器");
  assert.ok(html.includes("/vendor/prosemirror-bundle.js"), "编辑页未引入前端包");
  assert.ok(!html.includes('id="editorBody"'), "编辑页不应再使用 textarea 编辑器");
  const app = fs.readFileSync(path.join(root, "studio/app/editor-page.mjs"), "utf8");
  assert.ok(app.includes("LidaijiEditor.createStudioEditor"), "app 未接入编辑器");
  assert.ok(app.includes("replaceDocKeepCursor"), "app 缺少保存后光标保持");
  assert.ok(app.includes("localStorage"), "app 缺少本地草稿机制");
  assert.ok(app.includes("AUTOSAVE_DELAY"), "app 缺少自动保存");
  const appBundle = fs.readFileSync(path.join(root, "studio/static/app-bundle.js"), "utf8");
  assert.ok(appBundle.length > 50000, "工作台前端包过小");
  assert.ok(appBundle.includes("LidaijiEditor.createStudioEditor"), "前端包未包含编辑器接入");
});

if (failures) {
  console.error(`编辑器格式链路测试失败 ${failures} 项。`);
  process.exit(1);
}
console.log("编辑器格式链路自动测试通过。");
