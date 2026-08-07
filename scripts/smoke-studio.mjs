/* 工作台浏览器冒烟：用 headless Chrome（CDP）验证前端可运行。
 * 用法：node scripts/smoke-studio.mjs [<url>|auto] [--edit <path>]
 *   - <url>：对指定实例验证（如 http://127.0.0.1:4173）
 *   - auto ：自启一个演示内容实例（端口 4176，临时目录 .cache 之外），
 *            结束后自动清理；缺 Chrome 时跳过（CI 与开发机均有 Chrome）
 * 覆盖：首页渲染文章卡片、编辑页编辑器加载正文、工具栏按钮、无未捕获异常。
 * 注意：auto 模式会重置并写入演示工作区（.cache/studio-demo-workspace）。 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
let base = args[0] || "auto";
const editPathIndex = args.indexOf("--edit");
const editPath = editPathIndex >= 0 ? args[editPathIndex + 1] : "";

if (base === "auto" && !fs.existsSync(CHROME)) {
  console.log("跳过浏览器冒烟（未找到 Chrome）。");
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let studioProc = null;
let shareRoot = "";
if (base === "auto") {
  const port = 4176;
  fs.rmSync(path.join(root, ".cache", "studio-demo-workspace"), { recursive: true, force: true });
  const python = path.join(root, ".venv-importer", "bin", "python3");
  /* 演示分享私有根：位于仓库外（fail-closed 要求内容根不得在仓库内部） */
  shareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-share-demo-"));
  spawnSync(python, [path.join(root, "scripts", "create-share-demo-content.py"), "--root", shareRoot], {
    stdio: "ignore",
  });
  studioProc = spawn(
    python,
    ["-m", "studio", "--project-root", root, "--port", String(port), "--no-browser"],
    {
      env: { ...process.env, LIDAIJI_WORKSPACE_MODE: "demo", LIDAIJI_SHARE_CONTENT_ROOT: shareRoot },
      stdio: "ignore",
    },
  );
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* 尚未就绪 */
    }
    await sleep(500);
  }
  if (!healthy) {
    console.error("失败：演示实例未能启动。");
    process.exit(1);
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`通过：${name}`);
  } else {
    failures += 1;
    console.error(`失败：${name}${detail ? `（${detail}）` : ""}`);
  }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (error) => reject(new Error(`WebSocket 错误：${error.message || error}`));
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        } else if (data.method === "Runtime.exceptionThrown") {
          const details = data.params.exceptionDetails || {};
          const desc = (details.exception && details.exception.description) || "";
          this.errors.push(`${details.text || "exception"} :: ${desc.slice(0, 200)}`);
        } else if (data.method === "Log.entryAdded" && data.params.entry.level === "error") {
          this.errors.push(`${data.params.entry.text} @${data.params.entry.url || ""}`);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      this.id += 1;
      this.pending.set(this.id, { resolve, reject });
      this.ws.send(JSON.stringify({ id: this.id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    return result?.result?.value;
  }

  async evaluateAsync(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

const port = 9222 + Math.floor(Math.random() * 500);
const profile = path.join(os.tmpdir(), `lidaiji-smoke-${Date.now()}`);

/* 编辑器 UI 验收（v0.2.6）：段落类型状态、active/enabled、保存状态、往返保持。
 * 全部使用演示工作区中的虚构文章；不触碰生产内容。 */
async function runEditorUiAcceptance(cdp, editPath) {
  const read = async () =>
    JSON.parse(
      (await cdp.evaluate(
        `JSON.stringify({
          blockType: (document.querySelector('#tbBlockType')||{}).value || '',
          stBlockType: (document.querySelector('#stBlockType')||{}).textContent || '',
          stAlign: (document.querySelector('#stAlign')||{}).textContent || '',
          saveStatus: (document.querySelector('#editSaveStatus')||{}).textContent || '',
          alignCenterPressed: document.querySelector('#tbAlignCenter').getAttribute('aria-pressed'),
          alignRightPressed: document.querySelector('#tbAlignRight').getAttribute('aria-pressed'),
          undoDisabled: document.querySelector('#tbUndo').disabled,
          redoDisabled: document.querySelector('#tbRedo').disabled,
          linkDisabled: document.querySelector('#tbLink').disabled,
          stNote: (document.querySelector('#stNote')||{}).textContent || '',
        })`,
      )) || "{}",
    );
  const setBlockType = (value) =>
    cdp.evaluate(`(() => {
      const sel = document.querySelector('#tbBlockType');
      sel.value = '${value}';
      sel.dispatchEvent(new Event('change'));
    })()`);
  const clickAlign = (id) => cdp.evaluate(`document.querySelector('#${id}').click()`);
  const focusEditor = () => cdp.evaluate(`document.querySelector('#editorHost .ProseMirror').focus()`);

  check("正文段落：类型=正文", (await read()).blockType === "paragraph", await read().then((r) => r.blockType));

  await focusEditor();
  await cdp.send("Input.insertText", { text: "验收插入文字" });
  await sleep(400);
  let ui = await read();
  check("输入后立即显示有未保存修改", ui.saveStatus.includes("未保存"), ui.saveStatus);
  check("输入后撤销可用、重做不可用", !ui.undoDisabled && ui.redoDisabled, `undo=${ui.undoDisabled} redo=${ui.redoDisabled}`);

  await setBlockType("poetry");
  await sleep(700);
  ui = await read();
  check("光标转诗歌：类型=诗歌且状态条同步", ui.blockType === "poetry" && ui.stBlockType === "诗歌", ui.stBlockType);
  check("诗歌说明提示显示", ui.stNote.includes("诗行编辑方式将在后续版本改进"), ui.stNote);

  await clickAlign("tbAlignCenter");
  await sleep(700);
  ui = await read();
  check("诗歌+居中同时 active", ui.blockType === "poetry" && ui.alignCenterPressed === "true" && ui.stAlign === "居中", `${ui.blockType}/${ui.alignCenterPressed}/${ui.stAlign}`);

  await setBlockType("endnote");
  await sleep(700);
  await clickAlign("tbAlignRight");
  await sleep(700);
  ui = await read();
  check("附记+右对齐同时 active", ui.blockType === "endnote" && ui.alignRightPressed === "true" && ui.stAlign === "右对齐", `${ui.blockType}/${ui.alignRightPressed}/${ui.stAlign}`);
  check("附记说明提示显示", ui.stNote.includes("无编号的补充说明块"), ui.stNote);

  await setBlockType("paragraph");
  await sleep(700);
  ui = await read();
  check("转回正文后类型复位", ui.blockType === "paragraph" && ui.stBlockType === "正文", ui.stBlockType);

  /* 撤销/重做状态实时变化：撤销一次 → 回到容器状态；重做恢复正文 */
  await cdp.evaluate(`document.querySelector('#tbUndo').click()`);
  await sleep(700);
  ui = await read();
  check("撤销后回到容器状态", ["诗歌", "附记", "引用"].includes(ui.stBlockType), ui.stBlockType);
  check("撤销后重做可用", !ui.redoDisabled, "redo 应可用");
  await cdp.evaluate(`document.querySelector('#tbRedo').click()`);
  await sleep(700);
  ui = await read();
  check("重做后回到正文", ui.stBlockType === "正文", ui.stBlockType);

  /* 设定确定性的最终状态：附记 + 右对齐 → 保存 */
  await setBlockType("endnote");
  await sleep(700);
  await clickAlign("tbAlignRight");
  await sleep(700);
  await cdp.evaluate(`document.querySelector('#editSave').click()`);
  let saved = false;
  for (let i = 0; i < 20 && !saved; i += 1) {
    await sleep(500);
    saved = (await read()).saveStatus.includes("已保存");
  }
  check("保存成功后显示已保存", saved, (await read()).saveStatus);

  /* 保存失败：临时使 fetch 失败，点击保存 → 保存失败且可重试 */
  await cdp.evaluate(`window.__origFetch = window.fetch; window.fetch = () => Promise.reject(new Error('forced-fail'));`);
  await cdp.evaluate(`document.querySelector('#editSave').click()`);
  await sleep(1200);
  ui = await read();
  check("保存失败状态明确", ui.saveStatus.includes("保存失败"), ui.saveStatus);
  await cdp.evaluate(`window.fetch = window.__origFetch;`);

  /* 重新打开：类型与对齐保持（附记/右对齐已保存） */
  const bodyBefore = await cdp.evaluateAsync(
    `(async () => { const r = await fetch('/api/article?path=${encodeURIComponent(editPath)}'); const j = await r.json(); return j.article.body; })()`,
  );
  check("Markdown 未意外重写（锚点仍在）", (bodyBefore.match(/<!-- paragraph-id:/g) || []).length >= 1, "锚点丢失");
  check("Markdown 短代码结构保持（endnote/align）", bodyBefore.includes("{{< endnote >}}") && bodyBefore.includes("{{< align right >}}"), "短代码缺失");
  await cdp.send("Page.navigate", { url: `${base}/#/` });
  await sleep(1200);
  await cdp.send("Page.navigate", { url: `${base}/#/edit?path=${encodeURIComponent(editPath)}` });
  await sleep(3000);
  ui = await read();
  const reopened = JSON.parse(
    (await cdp.evaluate(
      `JSON.stringify({
        endNoteInEditor: !!document.querySelector('.ProseMirror .end-note'),
        endNoteAlignedRight: !!document.querySelector('.ProseMirror .end-note p[data-align="right"]'),
        toolbarAlive: ((document.querySelector('#stBlockType')||{}).textContent || '') !== '',
      })`,
    )) || "{}",
  );
  check("重新打开后附记块在编辑器中渲染", reopened.endNoteInEditor, "end-note 缺失");
  check("重新打开后右对齐保持", reopened.endNoteAlignedRight, "data-align=right 缺失");
  check("重新打开后工具栏状态正常", reopened.toolbarAlive && ui.stBlockType !== "", ui.stBlockType);

  /* 窄窗口工具栏可用（flex-wrap） */
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const toolbar = JSON.parse(
    (await cdp.evaluate(
      `JSON.stringify({ display: getComputedStyle(document.querySelector('.editor-toolbar')).display, wraps: document.querySelector('.editor-toolbar').scrollHeight <= document.querySelector('.editor-toolbar').clientHeight * 2 })`,
    )) || "{}",
  );
  check("窄窗口工具栏仍可用", toolbar.display !== "none", toolbar.display);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

/* 保存状态 UI 验收（v0.2.6 收口）：真实页面 DOM 断言「正在保存」中间态。
 * 通过包裹 window.fetch 注入延迟/失败/计数，不修改服务端。 */
async function runSaveStateAcceptance(cdp, editPath) {
  const status = () => cdp.evaluate("(document.querySelector('#editSaveStatus')||{}).textContent || ''");
  const reloadEditor = async () => {
    await cdp.send("Page.navigate", { url: `${base}/#/` });
    await sleep(1200);
    await cdp.send("Page.navigate", { url: `${base}/#/edit?path=${encodeURIComponent(editPath)}` });
    await sleep(3000);
  };
  const installFetchTrap = (delayMs, fail = false, countOnly = false) =>
    cdp.evaluate(`(() => {
      const orig = window.fetch;
      window.__saveCount = 0;
      window.fetch = (url, opts) => {
        if (String(url).includes('/api/article/save')) {
          window.__saveCount += 1;
          if (${countOnly ? "false" : "true"} && ${fail ? "true" : "false"}) {
            return new Promise((_, rej) => setTimeout(() => rej(new Error('forced-fail')), ${delayMs}));
          }
          return new Promise((resolve, reject) => {
            setTimeout(() => orig(url, opts).then(resolve, reject), ${delayMs});
          });
        }
        return orig(url, opts);
      };
    })()`);
  const restoreFetch = () => cdp.evaluate("window.fetch = window.__origFetch;");

  /* 场景1：正常保存（延迟 1200ms）——中间态必须真实出现在 DOM */
  await reloadEditor();
  await installFetchTrap(1200, false);
  await cdp.evaluate("document.querySelector('#editorHost .ProseMirror').focus()");
  await cdp.send("Input.insertText", { text: "甲" });
  await sleep(300);
  check("S1 修改后显示有未保存修改", (await status()).includes("未保存"), await status());
  await cdp.evaluate("document.querySelector('#editSave').click()");
  await sleep(400);
  check("S1 请求 pending 期间 DOM 显示「正在保存」", (await status()).includes("正在保存"), await status());
  await sleep(1000);
  check("S1 放行后显示已保存", (await status()).includes("已保存"), await status());
  await restoreFetch();

  /* 场景2：保存失败——正在保存 → 保存失败 */
  await installFetchTrap(800, true);
  await cdp.evaluate("document.querySelector('#editorHost .ProseMirror').focus()");
  await cdp.send("Input.insertText", { text: "乙" });
  await sleep(300);
  await cdp.evaluate("document.querySelector('#editSave').click()");
  await sleep(300);
  check("S2 pending 期间显示正在保存", (await status()).includes("正在保存"), await status());
  await sleep(2000); // 越过点击保存失败(800ms)与自动保存重试失败，最终停留在 保存失败
  check("S2 失败后显示保存失败", (await status()).includes("保存失败"), await status());
  await restoreFetch();

  /* 场景3：保存期间继续输入——A 成功不得伪报已保存 */
  await reloadEditor();
  await installFetchTrap(1200, false);
  await cdp.evaluate("document.querySelector('#editorHost .ProseMirror').focus()");
  await cdp.send("Input.insertText", { text: "丙" });
  await sleep(300);
  await cdp.evaluate("document.querySelector('#editSave').click()");
  await sleep(300);
  await cdp.send("Input.insertText", { text: "丁" }); // pending 期间继续输入 B
  await sleep(1400); // A 完成（版本不匹配分支：不得显示已保存）
  const s3 = await status();
  check("S3 保存期间输入后不伪报已保存", !s3.includes("已保存") && s3.includes("未保存"), s3);
  await sleep(2500); // 自动再次保存 B → 最终已保存
  check("S3 随后自动保存 B 后已保存", (await status()).includes("已保存"), await status());
  await restoreFetch();

  /* 场景4：重复点击——pending 期间再点保存，写请求数 = 1 */
  await reloadEditor();
  await installFetchTrap(1200, false, true);
  await cdp.evaluate("document.querySelector('#editorHost .ProseMirror').focus()");
  await cdp.send("Input.insertText", { text: "戊" });
  await sleep(300);
  await cdp.evaluate("document.querySelector('#editSave').click()");
  await sleep(300);
  await cdp.evaluate("document.querySelector('#editSave').click()"); // 第二次点击
  await sleep(300);
  const count1 = await cdp.evaluate("window.__saveCount");
  check("S4 pending 期间重复点击不产生并发写（1 次）", count1 === 1, `count=${count1}`);
  const s4 = await status();
  check("S4 重复点击期间仍为正在保存", s4.includes("正在保存"), s4);
  await sleep(1200);
  check("S4 完成后已保存", (await status()).includes("已保存"), await status());
  await restoreFetch();

  /* 场景5：极快保存——顺序正确，最终已保存 */
  await reloadEditor();
  await cdp.evaluate("document.querySelector('#editorHost .ProseMirror').focus()");
  await cdp.send("Input.insertText", { text: "己" });
  await sleep(300);
  await cdp.evaluate("document.querySelector('#editSave').click()");
  await sleep(100);
  const s5 = await status();
  check("S5 极快保存状态机顺序正确（不滞留有未保存修改）", !s5.includes("未保存"), s5);
  await sleep(1200);
  check("S5 最终已保存", (await status()).includes("已保存"), await status());
}

/* 长文分享验收（v0.1）：列表、新建、编辑保存（无段评锚点）、QQ 摘要、
 * 准备发布确认（QQ 默认未启用）。全部使用演示分享私有根（仓库外）。 */
async function runShareAcceptance(cdp) {
  const readShare = async () =>
    JSON.parse(
      (await cdp.evaluate(
        `JSON.stringify({
          nav: !!document.querySelector("[data-nav='share']"),
          newBtn: !!document.querySelector("#view-share a[href='#/share-edit']"),
          groups: document.querySelectorAll("#shareGroups .share-group").length,
          pubPanel: !!document.querySelector("#sharePublications"),
          qqNote: (document.querySelector("#sharePublishNote")||{}).textContent || '',
          fmVisible: !document.querySelector("#shareFmPanel").classList.contains("hidden"),
          fmHidden: document.querySelector("#fmPanel").classList.contains("hidden"),
          notesHidden: (document.querySelector("#notesPanel")||{}).classList ? document.querySelector("#notesPanel").classList.contains("hidden") : true,
          prepareVisible: !document.querySelector("#shareEditPrepare").classList.contains("hidden"),
          saveStatus: (document.querySelector("#editSaveStatus")||{}).textContent || '',
          metaId: (document.querySelector("#shareMetaId")||{}).textContent || '',
          qqChars: (document.querySelector("#shareQqChars")||{}).textContent || '',
          confirmUrl: (document.querySelector("#shareConfirmUrl")||{}).textContent || '',
          qqEnabledNote: (document.querySelector("#shareQqEnabledNote")||{}).textContent || '',
          sourceText: (document.querySelector("#editorSource")||{}).textContent || '',
          confirmView: !document.querySelector("#view-share-confirm").classList.contains("hidden"),
        })`,
      )) || "{}",
    );

  /* 分享首页 */
  await cdp.send("Page.navigate", { url: `${base}/#/share` });
  await sleep(2500);
  let ui = await readShare();
  check("分享首页导航存在", ui.nav, "缺少长文分享导航");
  check("分享首页新建按钮存在", ui.newBtn, "缺少新建分享按钮");
  check("分享首页按状态分组渲染", ui.groups >= 1, `groups=${ui.groups}`);
  check("分享首页发布任务面板存在", ui.pubPanel, "缺少发布任务面板");
  check("QQ 自动发布状态显示未启用", ui.qqNote.includes("未启用"), ui.qqNote);

  /* 新建分享 → 编辑页（分享模式） */
  await cdp.send("Page.navigate", { url: `${base}/#/share-edit` });
  await sleep(2500);
  ui = await readShare();
  check("新建分享进入分享编辑模式（表单/隐藏作品面板）", ui.fmVisible && ui.fmHidden && ui.notesHidden, `fm=${ui.fmVisible} notesHidden=${ui.notesHidden}`);
  check("分享编辑页显示准备发布按钮", ui.prepareVisible, "缺少准备发布按钮");

  /* 填表 + 正文 + QQ 摘要 */
  await cdp.evaluate(`(() => {
    const f = document.querySelector("#shareFmForm");
    f.title.value = "冒烟测试分享";
    f.author.value = "冒烟作者";
    f.title.dispatchEvent(new Event("input"));
    f.author.dispatchEvent(new Event("input"));
    document.querySelector("#shareQqSummary").value = "这是冒烟测试的 QQ 摘要。";
    document.querySelector("#shareQqSummary").dispatchEvent(new Event("input"));
  })()`);
  await cdp.evaluate(`document.querySelector("#editorHost .ProseMirror").focus()`);
  await cdp.send("Input.insertText", { text: "冒烟测试分享正文段落。" });
  await sleep(600);
  ui = await readShare();
  check("分享正文输入后显示未保存修改", ui.saveStatus.includes("未保存"), ui.saveStatus);
  check("QQ 摘要字符统计更新且含阅读全文", ui.qqChars.includes("最终 QQ 文案") && ui.qqChars.includes("阅读全文"), ui.qqChars);

  /* 保存：不得出现段评锚点，shareId 生成 */
  await cdp.evaluate(`document.querySelector("#editSave").click()`);
  let saved = false;
  for (let i = 0; i < 20 && !saved; i += 1) {
    await sleep(500);
    ui = await readShare();
    saved = ui.saveStatus.includes("已保存");
  }
  check("分享保存成功", saved, ui.saveStatus);
  check("分享保存后 shareId 已生成", /^sh-/.test(ui.metaId), ui.metaId);

  /* Markdown 源码无段评锚点 */
  await cdp.evaluate(`document.querySelector("#tbSource").click()`);
  await sleep(600);
  ui = await readShare();
  check("分享 Markdown 源码不含 paragraph-id", !ui.sourceText.includes("paragraph-id"), "源码出现段评锚点");
  check("分享 Markdown 源码正文完整", ui.sourceText.includes("冒烟测试分享正文段落"), "正文缺失");
  await cdp.evaluate(`document.querySelector("#editorSourceBack").click()`);
  await sleep(400);

  /* 准备发布 → 确认页 */
  await cdp.evaluate(`document.querySelector("#shareEditPrepare").click()`);
  await sleep(2500);
  ui = await readShare();
  check("发布确认页显示网页地址", /^https?:\/\//.test(ui.confirmUrl), ui.confirmUrl);
  check("发布确认页显示 QQ 未启用说明", ui.qqEnabledNote.includes("未启用"), ui.qqEnabledNote);
  const confirmText = await cdp.evaluate(`(document.querySelector("#shareConfirmText")||{}).value || ""`);
  check("发布确认页 QQ 文案含阅读全文", confirmText.includes("阅读全文"), "缺少阅读全文链接");
  const whenNow = await cdp.evaluate(`document.querySelector('input[name="shareWhen"]:checked').value`);
  check("发布时间默认现在发布", whenNow === "now", whenNow);
  /* 返回修改 */
  await cdp.evaluate(`document.querySelector("#shareConfirmBack").click()`);
  await sleep(1500);
  ui = await readShare();
  check("返回修改回到分享编辑页", ui.fmVisible && !ui.confirmView, `confirmView=${ui.confirmView}`);

  /* 演示分享页在分享首页分组中可见（已保存 → 草稿组） */
  await cdp.send("Page.navigate", { url: `${base}/#/share` });
  await sleep(2500);
  const draftCount = await cdp.evaluate(`document.querySelectorAll("#shareGroups .share-row-title").length`);
  check("分享首页列出新建分享", draftCount >= 1, `rows=${draftCount}`);
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let cdp = null;
try {
  // Chrome 冷启动可能需要较长时间；最多等待 20 秒让 CDP 端口就绪
  let page = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = targets.find((target) => target.type === "page");
      if (page) break;
    } catch {
      /* 尚未就绪 */
    }
    await sleep(1000);
  }
  check("Chrome CDP 可用", Boolean(page), "未找到页面目标");
  if (!page) process.exit(1);

  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");

  await cdp.send("Page.navigate", { url: `${base}/` });
  await sleep(3500);

  const homeState = JSON.parse(
    (await cdp.evaluate(
      `JSON.stringify({ cards: document.querySelectorAll('.article-card').length, workspace: (document.querySelector('#workspaceTarget')||{}).textContent || '' })`,
    )) || "{}",
  );
  check("首页渲染文章卡片", homeState.cards > 0, `cards=${homeState.cards}`);
  check("首页工作区已识别", Boolean(homeState.workspace) && !homeState.workspace.includes("正在确认"), homeState.workspace);

  if (editPath) {
    await cdp.send("Page.navigate", { url: `${base}/#/edit?path=${encodeURIComponent(editPath)}` });
    await sleep(3500);
    const editState = JSON.parse(
      (await cdp.evaluate(
        `JSON.stringify({
          prose: (() => { const el = document.querySelector('.ProseMirror'); return el ? el.textContent.length : -1; })(),
          bold: !!document.querySelector('#tbBold'),
          italic: !!document.querySelector('#tbItalic'),
          blockTypeSelect: !!document.querySelector('#tbBlockType'),
          align: !!document.querySelector('#tbAlignCenter') && !!document.querySelector('#tbAlignRight'),
          link: !!document.querySelector('#tbLink'),
          image: !!document.querySelector('#tbImage'),
          undo: !!document.querySelector('#tbUndo'),
          redo: !!document.querySelector('#tbRedo'),
          statusBar: !!document.querySelector('#editStatusBar'),
          saveStatus: (document.querySelector('#editSaveStatus')||{}).textContent || '',
          hasEndnoteText: document.body.textContent.includes('尾注'),
          hasAttachNote: (() => { const sel = document.querySelector('#tbBlockType'); return sel ? Array.from(sel.options).some(o => o.value === 'endnote' && o.textContent === '附记') : false; })()
        })`,
      )) || "{}",
    );
    check("编辑页编辑器加载正文", editState.prose > 0, `prose=${editState.prose}`);
    check("工具栏五分组控件存在", editState.bold && editState.italic && editState.link && editState.image && editState.blockTypeSelect && editState.undo && editState.redo, "工具栏控件缺失");
    check("段落类型下拉含「附记」", editState.hasAttachNote, "缺少附记选项");
    check("界面不再出现「尾注」文案", !editState.hasEndnoteText, "仍出现尾注");
    check("状态条存在（段落/对齐/保存）", editState.statusBar, "缺少编辑状态条");
    check("保存状态初始为已保存", editState.saveStatus === "已保存", editState.saveStatus);

    await runEditorUiAcceptance(cdp, editPath);
    await runSaveStateAcceptance(cdp, editPath);
    if (shareRoot) {
      await runShareAcceptance(cdp);
    }
  }

  await sleep(500);
  const runtimeErrors = cdp.errors.filter(
    (text) => !/favicon|GCM|gpu|SharedImage|Failed to load resource/i.test(text),
  );
  check("无未捕获 JS 异常", runtimeErrors.length === 0, JSON.stringify(runtimeErrors.slice(0, 3)));} catch (error) {
  failures += 1;
  console.error(`失败：冒烟流程异常（${error.message}）`);
} finally {
  if (cdp) cdp.close();
  chrome.kill("SIGKILL");
  if (studioProc) studioProc.kill("SIGKILL");
}

if (failures) {
  console.error(`浏览器冒烟失败 ${failures} 项。`);
  process.exit(1);
}
console.log("浏览器冒烟通过。");
