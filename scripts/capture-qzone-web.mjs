#!/usr/bin/env node
// QZone 官方网页 手动发图抓包监听（只记录、脱敏；不修改任何页面行为）。
//
// 用途：对照「QQ 官方网页当前如何上传图片 + 发表多图说说」与我们的
//       cgi_upload_image / emotion_cgi_publish_v6 请求差异，找出官方
//       「无副 feed（相册动态）」的上传参数/路径。
//
// 用法：
//   1) 启动带调试端口的 Chrome（独立配置目录，避免影响日常浏览）：
//        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//          --remote-debugging-port=9222 --user-data-dir=/tmp/qzone-capture-profile
//   2) 在该 Chrome 里登录测试号 QQ 空间网页版（user.qzone.qq.com/<测试号>）。
//   3) 运行本脚本：
//        node scripts/capture-qzone-web.mjs --cdp-port 9222 \
//            --out /tmp/qzone-capture.json --timeout 240
//   4) 回到 Chrome：新建说说 → 选 2 张测试图 → 发表。
//   5) 脚本在 timeout 秒后（或 Ctrl+C）写出脱敏记录并打印摘要。
//
// 脱敏：删除全部 Cookie 头；URL/postData 中的 p_skey/skey/uin/token/sign/key
//       等敏感值一律 [REDACTED]；其余字段名与值保留（albumtype/refer/needFeeds
//       等正是要对比的）。图片响应体不记录。

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const get = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const CDP_PORT = get("--cdp-port", "9222");
const OUT = get("--out", "/tmp/qzone-capture.json");
const TIMEOUT = Number(get("--timeout", "240"));

const SENSITIVE = /(p_skey|skey|uin|cookie|token|sign|key|sid|gtk)/i;
const INTERESTING = /(qzone\.qq\.com|photo\.store\.qq\.com|up\.qzone\.qq\.com|pic\.upqzfile)/i;

function redactText(text) {
  // 脱敏 URL/postData 中敏感参数的值；字段名保留
  return text
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return part;
      const name = part.slice(0, eq);
      return SENSITIVE.test(name) ? `${name}=[REDACTED]` : part;
    })
    .join("&");
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    const params = new URLSearchParams(u.search);
    for (const key of Array.from(params.keys())) {
      if (SENSITIVE.test(key)) params.set(key, "[REDACTED]");
    }
    u.search = params.toString();
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return redactText(url);
  }
}

const events = [];
let live = false;

function record(entry) {
  events.push(entry);
  if (entry.kind === "request" && entry.method) {
    console.log(`[${new Date(entry.ts).toISOString().slice(11, 19)}] ${entry.method} ${redactUrl(entry.url)}`);
    if (entry.paramNames?.length) console.log(`    参数: ${entry.paramNames.join(", ")}`);
    if (entry.bodyNames?.length) console.log(`    body: ${entry.bodyNames.join(", ")}`);
  }
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
console.log(`已连接 Chrome CDP :${CDP_PORT}（监听 ${TIMEOUT} 秒；请到 Chrome 里手动发 2 张图的说说）`);
for (const context of browser.contexts()) {
  for (const page of context.pages()) {
    page.on("request", (request) => {
      const url = request.url();
      if (!INTERESTING.test(url)) return;
      const headers = request.headers();
      delete headers.cookie; // 绝不记录 Cookie
      const postData = request.postData() || "";
      record({
        kind: "request",
        ts: Date.now(),
        method: request.method(),
        url,
        headers,
        postDataRedacted: postData ? redactText(postData) : "",
        paramNames: url.includes("?") ? Array.from(new URL(url).searchParams.keys()) : [],
        bodyNames: postData ? Array.from(new URLSearchParams(postData).keys()) : [],
      });
    });
    page.on("response", async (response) => {
      const url = response.url();
      if (!INTERESTING.test(url)) return;
      let bodyPreview = "";
      if (/cgi-bin\/(upload|emotion)/i.test(url)) {
        try {
          const body = await response.text();
          bodyPreview = redactText(body).slice(0, 400);
        } catch {}
      }
      record({ kind: "response", ts: Date.now(), status: response.status(), url, bodyPreview });
    });
    live = true;
  }
}
if (!live) {
  console.log("警告：CDP 上没有已打开的页面；请先打开 QZone 网页（保持该标签页开着）。");
}

// 定时器 + Ctrl+C 双通道收尾
const stop = async () => {
  const summary = summarize();
  writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), events }, null, 2));
  console.log("\n记录已写入:", OUT);
  console.log(summary);
  await browser.close();
  process.exit(0);
};
process.on("SIGINT", stop);

function summarize() {
  const groups = new Map();
  for (const e of events) {
    if (e.kind !== "request") continue;
    try {
      const u = new URL(e.url);
      const key = `${e.method} ${u.hostname}${u.pathname}`;
      if (!groups.has(key)) groups.set(key, { count: 0, params: new Set(), bodies: new Set() });
      const g = groups.get(key);
      g.count += 1;
      e.paramNames?.forEach((p) => g.params.add(p));
      e.bodyNames?.forEach((p) => g.bodies.add(p));
    } catch {}
  }
  const lines = ["\n===== 端点摘要（字段名，值已脱敏）====="];
  for (const [key, g] of groups) {
    lines.push(`${key}  ×${g.count}`);
    if (g.params.size) lines.push(`  query: ${[...g.params].sort().join(", ")}`);
    if (g.bodies.size) lines.push(`  body:  ${[...g.bodies].sort().join(", ")}`);
  }
  return lines.join("\n");
}

await sleep(TIMEOUT * 1000);
await stop();
