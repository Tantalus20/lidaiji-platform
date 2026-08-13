// 逐篇浏览统计 Safari 验收（真实 Safari，WebDriver 协议）。
// 用法：node scripts/smoke-view-stats-safari.mjs
// 依赖：safaridriver 已启用（sudo safaridriver --enable）；缺省如实报告不替代。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`通过：${name}`);
  else { failures += 1; console.error(`失败：${name}${detail ? `（${detail}）` : ""}`); }
}

const WORKS_DIR = path.join(root, "dist", "site");
const SHARE_DIR = "/tmp/share-out-abs/share";
const SHARE_IDENTITY = "/tmp/share-out-abs/share-identity-manifest.json";
if (!fs.existsSync(WORKS_DIR) || !fs.existsSync(SHARE_DIR)) {
  console.log("跳过：缺少站点构建产物。");
  process.exit(0);
}
const worksManifest = JSON.parse(fs.readFileSync(path.join(WORKS_DIR, "comment-manifest.json"), "utf8"));
const target = worksManifest.articles[0];
const articleUrl = `http://127.0.0.1:13013${target.canonicalPath}`;
const shareUrl = "http://127.0.0.1:13014/sh-20260813-a1b2c3/";
const STATS_BASE = "http://127.0.0.1:14317";
const driverPort = 24619;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-stats-safari-"));

const commentsProc = spawn(process.execPath, ["--experimental-sqlite", path.join(root, "comments-service", "src", "server.js")], {
  env: {
    ...process.env, NODE_ENV: "test",
    COMMENTS_DATA_DIR: dataDir, COMMENTS_PORT: "14317",
    COMMENTS_PUBLIC_ORIGIN: "http://127.0.0.1:13013",
    COMMENTS_HMAC_SECRET: "smoke-test-secret-that-is-long-enough-32",
    COMMENTS_MANIFEST: path.join(WORKS_DIR, "comment-manifest.json"),
    SHARE_MANIFEST: SHARE_IDENTITY,
  },
  stdio: "ignore",
});
let commentsReady = false;
for (let i = 0; i < 40 && !commentsReady; i += 1) {
  await sleep(250);
  try { commentsReady = (await fetch(`${STATS_BASE}/healthz`)).ok; } catch {}
}
check("统计服务启动", commentsReady);

function serveSite(port, siteDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/api/stats/")) {
      try {
        const upstream = await fetch(`${STATS_BASE}${url.pathname}${url.search}`, {
          method: req.method, headers: { "user-agent": req.headers["user-agent"] || "" },
        });
        res.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(await upstream.text());
      } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end('{"ok":false}');
      }
      return;
    }
    let file = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    let target2 = path.join(siteDir, file);
    if (fs.existsSync(target2) && fs.statSync(target2).isDirectory()) target2 = path.join(target2, "index.html");
    if (!target2.startsWith(siteDir) || !fs.existsSync(target2)) { res.writeHead(404); res.end("nf"); return; }
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".xml": "application/xml" };
    res.writeHead(200, { "Content-Type": types[path.extname(target2)] || "application/octet-stream" });
    res.end(fs.readFileSync(target2));
  });
  server.listen(port, "127.0.0.1");
  return server;
}
const worksServer = serveSite(13013, WORKS_DIR);
const shareServer = serveSite(13014, SHARE_DIR);
await sleep(500);

const driver = spawn("safaridriver", ["-p", String(driverPort)], { stdio: "ignore" });
await sleep(1500);
let sessionId = null;
try {
  const create = await fetch(`http://127.0.0.1:${driverPort}/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "safari" } } }),
  });
  const created = await create.json();
  if (!create.ok) {
    check("Safari 自动化可用", false, created.value?.message || created.value?.error || JSON.stringify(created).slice(0, 200));
    console.log("说明：请启用「允许远程自动化」（系统设置 → 开发者工具），或在 Safari 开发菜单开启。");
  } else {
    sessionId = created.value.sessionId;
    check("Safari 会话已创建", Boolean(sessionId));
  }
} catch (error) {
  check("Safari 自动化可用", false, error.message);
  console.log("说明：无法连接 safaridriver；请启用「允许远程自动化」。");
}

if (sessionId) {
  const wd = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${driverPort}/session/${sessionId}${url}`, {
      method, headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };
  const nav = async (url) => wd("POST", "/url", { url });
  const exec = async (script) => wd("POST", "/execute/sync", { script, args: [] });
  const readCount = async () => {
    const result = await exec("return (document.querySelector('[data-view-count]')||{textContent:'—'}).textContent.trim()");
    return result.value;
  };
  const bodyText = async () => {
    const result = await exec("return document.body.innerText.slice(0, 4000)");
    return result.value || "";
  };

  try {
    // 正式站
    await nav(articleUrl);
    await sleep(3500);
    const worksText = await bodyText();
    check("Safari 正式站标题渲染", worksText.includes(target.title));
    check("Safari 正式站正文渲染", worksText.includes("章评") || worksText.length > 300);
    check("Safari 正式站浏览 = 1", (await readCount()) === "1", `实际 ${await readCount()}`);
    await nav(articleUrl);
    await sleep(3000);
    check("Safari 正式站刷新仍 = 1", (await readCount()) === "1", `实际 ${await readCount()}`);

    // Share
    await nav(shareUrl);
    await sleep(3500);
    const shareText = await bodyText();
    check("Safari Share 标题渲染", shareText.includes("测试发布稿"));
    check("Safari Share 浏览 = 1", (await readCount()) === "1", `实际 ${await readCount()}`);
    await nav(shareUrl);
    await sleep(3000);
    check("Safari Share 刷新仍 = 1", (await readCount()) === "1", `实际 ${await readCount()}`);

    // 统计服务停掉 → 浏览 — 且正文可读
    commentsProc.kill("SIGKILL");
    await sleep(1000);
    await nav(articleUrl);
    await sleep(3000);
    const failText = await bodyText();
    check("Safari 统计不可用时正文仍可读", failText.includes(target.title));
    check("Safari 统计不可用显示浏览 —", (await readCount()) === "—", `实际 ${await readCount()}`);
  } catch (error) {
    check("Safari 页面验收", false, String(error && error.message || error));
  }
  await wd("DELETE", "").catch(() => {});
}

worksServer.close();
shareServer.close();
driver.kill("SIGKILL");
commentsProc.kill("SIGKILL");

console.log(`\nSafari 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures ? 1 : 0);
