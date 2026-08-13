// 逐篇浏览统计浏览器验收（Chrome headless；正式站 + Share + 失败隔离）。
// 用法：node scripts/smoke-view-stats.mjs
// 前置：已构建 dist/site（build.sh）与 /tmp/share-out-abs/share（build-share.sh）
//       缺 Chrome 时跳过（返回 0）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { chromium } = await import("playwright");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`通过 ${name}`); }
  else { failed += 1; console.log(`失败 ${name} ${detail}`); }
}

const WORKS_DIR = path.join(root, "dist", "site");
const SHARE_DIR = "/tmp/share-out-abs/share";
const SHARE_IDENTITY = "/tmp/share-out-abs/share-identity-manifest.json";
const shareAvailable = fs.existsSync(SHARE_DIR) && fs.existsSync(SHARE_IDENTITY);

if (!fs.existsSync(CHROME) || !fs.existsSync(WORKS_DIR)) {
  console.log("跳过：缺 Chrome 或站点构建产物（dist/site）。");
  process.exit(0);
}
if (!shareAvailable) console.log("Share 构建产物不存在：跳过 Share 检查（Share 未随本分支部署）。");

const worksManifest = JSON.parse(fs.readFileSync(path.join(WORKS_DIR, "comment-manifest.json"), "utf8"));
const target = worksManifest.articles.find((a) => a.canonicalPath && !a.articleId.includes("garbage"));
if (!target) { console.log("跳过：comment-manifest 无文章。"); process.exit(0); }
const articleUrl = `http://127.0.0.1:13013${target.canonicalPath}`;
const shareUrl = "http://127.0.0.1:13014/sh-20260813-a1b2c3/";
const STATS_BASE = "http://127.0.0.1:14317";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-stats-smoke-"));
const tmpFile = (name) => path.join(dataDir, name);

// 1) 启动统计服务（真实 server.js + 迁移 + 双清单）
const commentsProc = spawn(process.execPath, ["--experimental-sqlite", path.join(root, "comments-service", "src", "server.js")], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    COMMENTS_DATA_DIR: dataDir,
    COMMENTS_PORT: "14317",
    COMMENTS_PUBLIC_ORIGIN: "http://127.0.0.1:13013",
    COMMENTS_HMAC_SECRET: "smoke-test-secret-that-is-long-enough-32",
    COMMENTS_MANIFEST: path.join(WORKS_DIR, "comment-manifest.json"),
    SHARE_MANIFEST: SHARE_IDENTITY,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let commentsReady = false;
for (let i = 0; i < 40 && !commentsReady; i += 1) {
  await sleep(250);
  try {
    const res = await fetch(`${STATS_BASE}/healthz`);
    if (res.ok) commentsReady = true;
  } catch {}
}
check("统计服务启动", commentsReady);

// 2) 静态站点 + /api/stats 代理（模拟 nginx 路由）
function serveSite(port, siteDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/api/stats/")) {
      try {
        const upstream = await fetch(`${STATS_BASE}${url.pathname}${url.search}`, {
          method: req.method,
          headers: { "user-agent": req.headers["user-agent"] || "" },
        });
        const body = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"stats unavailable"}');
      }
      return;
    }
    let file = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    let target = path.join(siteDir, file);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
    if (!target.startsWith(siteDir) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404); res.end("not found"); return;
    }
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".xml": "application/xml", ".ico": "image/x-icon" };
    res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream" });
    res.end(fs.readFileSync(target));
  });
  server.listen(port, "127.0.0.1");
  return server;
}
const worksServer = serveSite(13013, WORKS_DIR);
const shareServer = shareAvailable ? serveSite(13014, SHARE_DIR) : null;
await sleep(500);

// 3) 浏览器验收
let browser = null;
const REAL_CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
try {
  browser = await chromium.launch({ channel: "chrome" });
  // 真实访客上下文：标准 Chrome UA（headless 默认 UA 带 Headless 标记，属于 bot 不计）
  const context = await browser.newContext({ userAgent: REAL_CHROME_UA });

  // —— 正式作品站 ——
  const worksPage = await context.newPage();
  await worksPage.goto(articleUrl, { waitUntil: "domcontentloaded" });
  await sleep(2500); // 等待 1500ms 延迟后的 POST
  let text = await worksPage.locator("body").innerText();
  check("正式站标题渲染", text.includes(target.title));
  check("正式站正文渲染", (await worksPage.locator(".article-content").count()) > 0);
  const worksCount1 = await worksPage.locator("[data-view-count]").innerText().catch(() => "—");
  check("正式站首次显示浏览 1", worksCount1.trim() === "1", `实际 ${worksCount1}`);

  await worksPage.reload({ waitUntil: "domcontentloaded" });
  await sleep(2000);
  const worksCount2 = await worksPage.locator("[data-view-count]").innerText().catch(() => "—");
  check("正式站刷新仍为 1（30 分钟去重）", worksCount2.trim() === "1", `实际 ${worksCount2}`);

  // —— Share 站（仅当 Share 构建产物存在）——
  if (shareAvailable) {
    const sharePage = await context.newPage();
    await sharePage.goto(shareUrl, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    const shareText = await sharePage.locator("body").innerText();
    check("Share 标题渲染", shareText.includes("测试发布稿"));
    check("Share 正文渲染", (await sharePage.locator(".article-content").count()) > 0);
    const shareCount1 = await sharePage.locator("[data-view-count]").innerText().catch(() => "—");
    check("Share 首次显示浏览 1", shareCount1.trim() === "1", `实际 ${shareCount1}`);
    await sharePage.reload({ waitUntil: "domcontentloaded" });
    await sleep(2000);
    const shareCount2 = await sharePage.locator("[data-view-count]").innerText().catch(() => "—");
    check("Share 刷新仍为 1（去重）", shareCount2.trim() === "1", `实际 ${shareCount2}`);
  }

  // —— headless 默认 UA（含 Headless 标记）→ bot 不计数 ——
  const botCtx = await browser.newContext();
  const botPage = await botCtx.newPage();
  await botPage.goto(articleUrl, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const botText = await botPage.locator("body").innerText();
  check("headless 访问页面正常（不计正文访问）", botText.includes(target.title));
  await botCtx.close();

  // —— 统计失败隔离：拦截 /api/stats 返回 500 ——
  await context.route("**/api/stats/**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false}' }));
  const failPage = await context.newPage();
  let pageError = null;
  failPage.on("pageerror", (err) => { pageError = err; });
  await failPage.goto(articleUrl, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const failText = await failPage.locator("body").innerText();
  check("统计 500 时正文仍完整", failText.includes(target.title) && (await failPage.locator(".article-content").count()) > 0);
  check("统计 500 时无 JS 异常", !pageError, String(pageError || ""));
  const failCount = await failPage.locator("[data-view-count]").innerText().catch(() => "—");
  check("统计失败显示浏览 —", failCount.trim() === "—", `实际 ${failCount}`);
  await context.unroute("**/api/stats/**");
} catch (error) {
  check("浏览器流程", false, String(error && error.message || error));
} finally {
  if (browser) await browser.close().catch(() => {});
}

// 4) 服务端计数核对（真实 +1，headless/bot 不计）
const worksServerCount = await fetch(`${STATS_BASE}/api/stats/views/works/${target.articleId}`).then((r) => r.json());
check("服务端 works 计数 = 1", worksServerCount.views === 1, `实际 ${worksServerCount.views}`);
if (shareAvailable) {
  const shareServerCount = await fetch(`${STATS_BASE}/api/stats/views/share/sh-20260813-a1b2c3`).then((r) => r.json());
  check("服务端 share 计数 = 1", shareServerCount.views === 1, `实际 ${shareServerCount.views}`);
}
const botPost = await fetch(`${STATS_BASE}/api/stats/views/works/${target.articleId}`, {
  method: "POST", headers: { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
}).then((r) => r.json());
check("Googlebot 不计数", botPost.views === 1, `实际 ${botPost.views}`);

worksServer.close();
if (shareServer) shareServer.close();
commentsProc.kill();

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
