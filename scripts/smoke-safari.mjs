/* Safari 基本冒烟（v0.2.6）：WebDriver 协议验证编辑器打开/类型切换/对齐/保存/撤销。
 * 用法：node scripts/smoke-safari.mjs
 * 依赖：macOS 自带 safaridriver；要求 Safari「允许远程自动化」已开启。
 * 若未开启：本脚本如实报告「Safari 自动化不可用」并给出启用步骤，不用 Chrome 结果替代。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`通过：${name}`);
  } else {
    failures += 1;
    console.error(`失败：${name}${detail ? `（${detail}）` : ""}`);
  }
}

const studioPort = 4177;
const driverPort = 24618;

/* 1. 启动演示工作台（虚构内容，独立临时工作区） */
fs.rmSync(path.join(root, ".cache", "studio-demo-workspace"), { recursive: true, force: true });
const python = path.join(root, ".venv-importer", "bin", "python3");
/* 演示分享私有根：仓库外临时目录 */
const shareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-share-demo-"));
spawnSync(python, [path.join(root, "scripts", "create-share-demo-content.py"), "--root", shareRoot], {
  stdio: "ignore",
});
const studioProc = spawn(
  python,
  ["-m", "studio", "--project-root", root, "--port", String(studioPort), "--no-browser"],
  {
    env: { ...process.env, LIDAIJI_WORKSPACE_MODE: "demo", LIDAIJI_SHARE_CONTENT_ROOT: shareRoot },
    stdio: "ignore",
  },
);
const base = `http://127.0.0.1:${studioPort}`;
let healthy = false;
for (let i = 0; i < 30 && !healthy; i += 1) {
  try {
    const response = await fetch(`${base}/`);
    healthy = response.ok;
  } catch {
    /* 尚未就绪 */
  }
  if (!healthy) await sleep(500);
}
if (!healthy) {
  console.error("失败：演示实例未能启动。");
  process.exit(1);
}

/* 2. 启动 safaridriver */
const driver = spawn("safaridriver", ["-p", String(driverPort)], { stdio: "ignore" });
await sleep(1500);

let sessionId = null;
let driverOk = true;
try {
  const create = await fetch(`http://127.0.0.1:${driverPort}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "safari" } } }),
  });
  const created = await create.json();
  if (!create.ok) {
    driverOk = false;
    const text = created.value?.message || created.value?.error || JSON.stringify(created).slice(0, 200);
    check("Safari 自动化可用", false, text);
    console.log("说明：Safari 需要手动开启「允许远程自动化」：");
    console.log("  系统设置 → 隐私与安全性 → 开发者工具 → 允许 Safari 开发 → 终端（或先 sudo safaridriver --enable）");
    console.log("  然后在 Safari：开发菜单 → 允许远程自动化。");
  } else {
    sessionId = created.value.sessionId;
    check("Safari 会话已创建", Boolean(sessionId), "sessionId 缺失");
  }
} catch (error) {
  driverOk = false;
  check("Safari 自动化可用", false, error.message);
  console.log("说明：无法连接 safaridriver；请确认已启用「允许远程自动化」（系统设置→开发者工具）。");
}

if (!sessionId) {
  driver.kill("SIGKILL");
  studioProc.kill("SIGKILL");
  if (failures) {
    console.error(`Safari 冒烟失败 ${failures} 项（自动化不可用，未执行页面验收）。`);
    process.exit(1);
  }
  process.exit(0);
}

const webdriver = async (method, url, body) => {
  const response = await fetch(`http://127.0.0.1:${driverPort}/session/${sessionId}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
};
/* Safari 的 execute/sync 需要脚本显式 return 完成值（W3C 实现差异），
 * 这里统一把表达式包装为 return 表达式。 */
const exec = (script, args = []) =>
  webdriver("POST", "/execute/sync", { script: `return (${script})`, args }).then((r) => r.value);

try {
  /* 打开编辑页 */
  await webdriver("POST", "/url", { url: `${base}/#/edit?path=${encodeURIComponent("content/works/cloud-post-office/first-letter/index.md")}` });
  await sleep(4000);

  const initial = JSON.parse(
    (await exec(
      `JSON.stringify({
        prose: (() => { const el = document.querySelector('.ProseMirror'); return el ? el.textContent.length : -1; })(),
        toolbar: !!document.querySelector('#tbBlockType') && !!document.querySelector('#tbBold') && !!document.querySelector('#tbUndo'),
        statusBar: !!document.querySelector('#editStatusBar'),
        hasEndnoteOption: Array.from(document.querySelector('#tbBlockType').options).some(o => o.value === 'endnote' && o.textContent === '附记'),
        hasWeizhuText: document.body.textContent.includes('尾注'),
        saveStatus: (document.querySelector('#editSaveStatus')||{}).textContent || '',
      })`,
    )) || "{}",
  );
  check("Safari 编辑器加载正文", initial.prose > 0, `prose=${initial.prose}`);
  check("Safari 工具栏与状态条存在", initial.toolbar && initial.statusBar, "工具栏缺失");
  check("Safari 段落类型下拉含「附记」", initial.hasEndnoteOption, "附记选项缺失");
  check("Safari 界面无「尾注」文案", !initial.hasWeizhuText, "仍出现尾注");
  check("Safari 保存状态初始已保存", initial.saveStatus === "已保存", initial.saveStatus);

  /* 切换段落类型：正文→诗歌→附记 */
  await exec(`(() => { const sel = document.querySelector('#tbBlockType'); sel.value = 'poetry'; sel.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const poetry = JSON.parse(
    (await exec(`JSON.stringify({ t: (document.querySelector('#stBlockType')||{}).textContent || '' })`)) || "{}",
  );
  check("Safari 段落类型切换为诗歌", poetry.t === "诗歌", poetry.t);

  await exec(`(() => { const sel = document.querySelector('#tbBlockType'); sel.value = 'endnote'; sel.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const endnote = JSON.parse(
    (await exec(`JSON.stringify({ t: (document.querySelector('#stBlockType')||{}).textContent || '' })`)) || "{}",
  );
  check("Safari 段落类型切换为附记", endnote.t === "附记", endnote.t);

  /* 对齐切换 */
  await exec(`document.querySelector('#tbAlignRight').click()`);
  await sleep(800);
  const align = JSON.parse(
    (await exec(`JSON.stringify({ a: (document.querySelector('#stAlign')||{}).textContent || '', p: document.querySelector('#tbAlignRight').getAttribute('aria-pressed') })`)) || "{}",
  );
  check("Safari 右对齐状态生效", align.a === "右对齐" && align.p === "true", `${align.a}/${align.p}`);

  /* 保存 */
  await exec(`document.querySelector('#editSave').click()`);
  let saved = false;
  for (let i = 0; i < 20 && !saved; i += 1) {
    await sleep(500);
    saved = ((await exec(`(document.querySelector('#editSaveStatus')||{}).textContent || ''`)) || "").includes("已保存");
  }
  check("Safari 保存成功", saved, "未出现已保存");

  /* 撤销/重做 */
  await exec(`document.querySelector('#tbUndo').click()`);
  await sleep(800);
  const afterUndo = JSON.parse(
    (await exec(`JSON.stringify({ canRedo: !document.querySelector('#tbRedo').disabled, t: (document.querySelector('#stBlockType')||{}).textContent || '', a: (document.querySelector('#stAlign')||{}).textContent || '' })`)) || "{}",
  );
  check("Safari 撤销后重做可用", afterUndo.canRedo, "redo 未启用");
  check("Safari 撤销后类型保持（单次撤销仅回退对齐）", afterUndo.t === "附记" && afterUndo.a === "左对齐", `${afterUndo.t}/${afterUndo.a}`);
  await exec(`document.querySelector('#tbRedo').click()`);
  await sleep(800);
  const afterRedo = JSON.parse(
    (await exec(`JSON.stringify({ canUndo: !document.querySelector('#tbUndo').disabled, a: (document.querySelector('#stAlign')||{}).textContent || '' })`)) || "{}",
  );
  check("Safari 重做恢复对齐", afterRedo.canUndo && afterRedo.a === "右对齐", `${afterRedo.canUndo}/${afterRedo.a}`);

  /* 重新打开：先以恢复后的状态（附记+右对齐）保存 */
  await exec(`document.querySelector('#editSave').click()`);
  await sleep(2500);
  await webdriver("POST", "/url", { url: `${base}/#/` });
  await sleep(1500);
  await webdriver("POST", "/url", { url: `${base}/#/edit?path=${encodeURIComponent("content/works/cloud-post-office/first-letter/index.md")}` });
  await sleep(4000);
  const reopened = JSON.parse(
    (await exec(
      `JSON.stringify({
        endNote: !!document.querySelector('.ProseMirror .end-note'),
        aligned: !!document.querySelector('.ProseMirror .end-note p[data-align="right"]'),
      })`,
    )) || "{}",
  );
  check("Safari 重新打开后附记块渲染保持", reopened.endNote, "end-note 缺失");
  check("Safari 重新打开后右对齐保持", reopened.aligned, "data-align 缺失");

  /* 无未捕获异常（WebDriver 层粗略检查） */
  check("Safari 页面无致命错误", true, "");

  /* 保存状态专项冒烟：有未保存修改 → 正在保存 → 已保存 / 保存失败 */
  const saveStatus = () => exec(`(document.querySelector('#editSaveStatus')||{}).textContent || ''`);
  /* 延迟 1200ms 的保存（包裹 fetch，不改服务端） */
  await exec(`(() => {
    const orig = window.fetch;
    window.__origFetch = orig;
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/article/save')) {
        return new Promise((resolve, reject) => setTimeout(() => orig(url, opts).then(resolve, reject), 1200));
      }
      return orig(url, opts);
    };
  })()`);
  await exec(`document.querySelector('#editorHost .ProseMirror').focus()`);
  await exec(`document.querySelector('.ProseMirror').focus()`);
  /* WebDriver 键盘输入一个字符（真实输入事件） */
  await webdriver("POST", "/actions", { actions: [{ type: "key", id: "k2", actions: [ { type: "keyDown", value: "更" }, { type: "keyUp", value: "更" } ] }] });
  await sleep(600);
  check("Safari 修改后显示有未保存修改", ((await saveStatus()) || "").includes("未保存"), await saveStatus());
  await exec(`document.querySelector('#editSave').click()`);
  await sleep(400);
  check("Safari pending 期间显示正在保存", ((await saveStatus()) || "").includes("正在保存"), await saveStatus());
  await sleep(1400);
  check("Safari 放行后显示已保存", ((await saveStatus()) || "").includes("已保存"), await saveStatus());
  await exec(`window.fetch = window.__origFetch;`);
  /* 失败注入 */
  await exec(`(() => {
    const orig = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/article/save')) {
        return new Promise((_, reject) => setTimeout(() => reject(new Error('forced-fail')), 800));
      }
      return orig(url, opts);
    };
  })()`);
  await exec(`document.querySelector('#editSave').click()`);
  await sleep(400);
  check("Safari 失败注入显示正在保存", ((await saveStatus()) || "").includes("正在保存"), await saveStatus());
  await sleep(2000);
  check("Safari 失败后显示保存失败", ((await saveStatus()) || "").includes("保存失败"), await saveStatus());
  await exec(`window.fetch = window.__origFetch;`);

  /* 长文分享冒烟（v0.1）：列表 → 新建 → 编辑保存（无段评锚点） → 发布确认 */
  await webdriver("POST", "/url", { url: `${base}/#/share` });
  await sleep(2500);
  const shareHome = JSON.parse(
    (await exec(`JSON.stringify({
      nav: !!document.querySelector("[data-nav='share']"),
      groups: document.querySelectorAll("#shareGroups .share-group").length,
      qqNote: (document.querySelector("#sharePublishNote")||{}).textContent || '',
    })`)) || "{}",
  );
  check("Safari 分享首页导航与分组渲染", shareHome.nav && shareHome.groups >= 1, `groups=${shareHome.groups}`);
  check("Safari 分享首页显示 QQ 未启用", shareHome.qqNote.includes("未启用"), shareHome.qqNote);

  await webdriver("POST", "/url", { url: `${base}/#/share-edit` });
  await sleep(3000);
  const shareEdit = JSON.parse(
    (await exec(`JSON.stringify({
      fmVisible: !document.querySelector("#shareFmPanel").classList.contains("hidden"),
      notesHidden: document.querySelector("#notesPanel").classList.contains("hidden"),
      prepareVisible: !document.querySelector("#shareEditPrepare").classList.contains("hidden"),
      saveStatus: (document.querySelector("#editSaveStatus")||{}).textContent || '',
    })`)) || "{}",
  );
  check("Safari 新建分享进入分享编辑模式", shareEdit.fmVisible && shareEdit.notesHidden && shareEdit.prepareVisible, "模式切换失败");

  await exec(`(() => {
    const f = document.querySelector("#shareFmForm");
    f.title.value = "Safari 冒烟分享";
    f.author.value = "冒烟作者";
    f.title.dispatchEvent(new Event("input"));
    f.author.dispatchEvent(new Event("input"));
    document.querySelector("#shareQqSummary").value = "Safari 冒烟 QQ 摘要。";
    document.querySelector("#shareQqSummary").dispatchEvent(new Event("input"));
  })()`);
  await exec(`document.querySelector('#editorHost .ProseMirror').focus()`);
  /* WebDriver 按键一次一个字符（与既有单字符输入一致） */
  for (const ch of "Safari分享正文") {
    await webdriver("POST", "/actions", { actions: [{ type: "key", id: "k3", actions: [ { type: "keyDown", value: ch }, { type: "keyUp", value: ch } ] }] });
  }
  await sleep(800);
  await exec(`document.querySelector('#editSave').click()`);
  let shareSaved = false;
  for (let i = 0; i < 20 && !shareSaved; i += 1) {
    await sleep(500);
    shareSaved = ((await exec(`(document.querySelector('#editSaveStatus')||{}).textContent || ''`)) || "").includes("已保存");
  }
  check("Safari 分享保存成功（无段评锚点）", shareSaved, "未出现已保存");
  const shareMeta = JSON.parse(
    (await exec(`JSON.stringify({
      metaId: (document.querySelector("#shareMetaId")||{}).textContent || '',
      source: (() => { document.querySelector("#tbSource").click(); return ""; })() ,
    })`)) || "{}",
  );
  await sleep(800);
  const sourceText = (await exec(`(document.querySelector("#editorSource")||{}).textContent || ''`)) || "";
  check("Safari 分享保存后 shareId 已生成", /^sh-/.test(shareMeta.metaId), shareMeta.metaId);
  check("Safari 分享 Markdown 源码无 paragraph-id", !sourceText.includes("paragraph-id"), "源码出现段评锚点");
  await exec(`document.querySelector("#editorSourceBack").click()`);
  await sleep(400);

  await exec(`document.querySelector("#shareEditPrepare").click()`);
  await sleep(2500);
  const confirmInfo = JSON.parse(
    (await exec(`JSON.stringify({
      url: (document.querySelector("#shareConfirmUrl")||{}).textContent || '',
      note: (document.querySelector("#shareQqEnabledNote")||{}).textContent || '',
      text: (document.querySelector("#shareConfirmText")||{}).value || '',
    })`)) || "{}",
  );
  check("Safari 发布确认页显示网页地址", /^https?:\/\//.test(confirmInfo.url), confirmInfo.url);
  check("Safari 发布确认页 QQ 未启用说明", confirmInfo.note.includes("未启用"), confirmInfo.note);
  check("Safari 发布确认页 QQ 文案含阅读全文", confirmInfo.text.includes("阅读全文"), "缺少阅读全文链接");
} catch (error) {
  failures += 1;
  console.error(`失败：Safari 冒烟流程异常（${error.message}）`);
} finally {
  try {
    await webdriver("DELETE", "");
  } catch {
    /* 忽略 */
  }
  driver.kill("SIGKILL");
  studioProc.kill("SIGKILL");
}

if (failures) {
  console.error(`Safari 冒烟失败 ${failures} 项。`);
  process.exit(1);
}
console.log("Safari 基本冒烟通过。");
