/* 工作台浏览器冒烟：用 headless Chrome（CDP）验证前端可运行。
 * 用法：node scripts/smoke-studio.mjs [<url>|auto] [--edit <path>]
 *   - <url>：对指定实例验证（如 http://127.0.0.1:4173）
 *   - auto ：自启一个演示内容实例（端口 4176，临时目录 .cache 之外），
 *            结束后自动清理；缺 Chrome 时跳过（CI 与开发机均有 Chrome）
 * 覆盖：首页渲染文章卡片、编辑页编辑器加载正文、工具栏按钮、无未捕获异常。
 * 注意：auto 模式会重置并写入演示工作区（.cache/studio-demo-workspace）。 */

import { spawn } from "node:child_process";
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
if (base === "auto") {
  const port = 4176;
  fs.rmSync(path.join(root, ".cache", "studio-demo-workspace"), { recursive: true, force: true });
  const python = path.join(root, ".venv-importer", "bin", "python3");
  studioProc = spawn(
    python,
    ["-m", "studio", "--project-root", root, "--port", String(port), "--no-browser"],
    {
      env: { ...process.env, LIDAIJI_WORKSPACE_MODE: "demo" },
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
          this.errors.push(data.params.exceptionDetails.text || "exception");
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
  await sleep(1500);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((target) => target.type === "page");
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
          align: !!document.querySelector('#tbAlignCenter') && !!document.querySelector('#tbAlignRight'),
          containers: !!document.querySelector('#tbPoetry') && !!document.querySelector('#tbEndnote'),
          saveStatus: (document.querySelector('#editSaveStatus')||{}).textContent || ''
        })`,
      )) || "{}",
    );
    check("编辑页编辑器加载正文", editState.prose > 0, `prose=${editState.prose}`);
    check("工具栏按钮存在", editState.bold && editState.italic, "粗体/斜体按钮缺失");
    check("对齐与排版按钮存在", editState.align && editState.containers, "对齐/诗歌/尾注按钮缺失");
    check("保存状态已就绪", editState.saveStatus === "已保存", editState.saveStatus);
  }

  await sleep(500);
  const runtimeErrors = cdp.errors.filter(
    (text) => !/favicon|GCM|gpu|SharedImage|Failed to load resource/i.test(text),
  );
  check("无未捕获 JS 异常", runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(" | "));} catch (error) {
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
