/* 跨平台构建核心（Windows 使用；Unix 继续走 scripts/build.sh，行为不变）。
 * 流程与 scripts/build.sh 等价：materialize 工作区 → 内容/图片检查 →
 * 段评锚点准备 → Hugo 构建 → manifest → 产物检查 → 输出 dist/site。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { IS_WIN, ROOT, die, ensureDir, findPython, log, run, runCapture } from "./common.mjs";

const DIST = path.join(ROOT, "dist");
let STAGING = "";
let WORKSPACE = "";

function cleanup() {
  if (STAGING) fs.rmSync(STAGING, { recursive: true, force: true });
  if (WORKSPACE) fs.rmSync(WORKSPACE, { recursive: true, force: true });
}
process.on("exit", cleanup);

function findHugo() {
  if (process.env.HUGO_BIN && fs.existsSync(process.env.HUGO_BIN)) return process.env.HUGO_BIN;
  const local = path.join(ROOT, ".hugo-local");
  if (fs.existsSync(local)) return local;
  const found = runCapture("hugo", ["version"]);
  if (found) return "hugo";
  die("未找到 Hugo。请安装 Hugo Extended 并加入 PATH，或设置 HUGO_BIN。");
}

export function buildSite({ layoutTestSource = "" } = {}) {
  ensureDir(DIST);
  STAGING = fs.mkdtempSync(path.join(DIST, ".site."));
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-build-workspace."));
  const python = findPython() || die("未找到 Python（需 docx/PIL/yaml/pypinyin）。请先运行 setup 完成环境初始化。");

  log("物化构建工作区（平台代码 + 内容仓库）……");
  const workspaceJson = runCapture(python, [
    path.join(ROOT, "tools", "workspace.py"),
    "materialize",
    `--platform-root=${ROOT}`,
    `--destination=${WORKSPACE}`,
  ]);
  if (!workspaceJson) die("workspace materialize 失败。");
  const parsed = JSON.parse(workspaceJson);
  const contentRoot = parsed.contentRoot;

  if (layoutTestSource) {
    // 注入虚构排版测试内容：先转临时副本，绝不写入内容仓库。
    const sourceDir = path.join(ROOT, layoutTestSource);
    if (fs.existsSync(sourceDir)) {
      fs.rmSync(path.join(WORKSPACE, "content"), { recursive: true, force: true });
      fs.mkdirSync(path.join(WORKSPACE, "content"), { recursive: true });
      fs.cpSync(contentRoot, path.join(WORKSPACE, "content"), { recursive: true });
      fs.cpSync(sourceDir, path.join(WORKSPACE, "content", "essays", "layout-test"), { recursive: true });
      log("已注入虚构排版测试内容。");
    }
  }

  log("Word 内容检查……");
  const unsafe = findUnsafeContent(contentRoot);
  if (unsafe.length) {
    die(`Word 原稿不得放入 Hugo 公开内容目录：\n  ${unsafe.join("\n  ")}`);
  }

  log("段评锚点准备……");
  run(python, [path.join(ROOT, "scripts", "comments-prepare.py"), `--project-root=${WORKSPACE}`]);

  const hugo = findHugo();
  const args = [
    "--source", WORKSPACE,
    "--minify", "--gc", "--cleanDestinationDir",
    "--cacheDir", path.join(ROOT, ".cache", "hugo"),
    "--destination", STAGING,
  ];
  if (process.env.SITE_BASE_URL) args.push("--baseURL", process.env.SITE_BASE_URL);
  log("Hugo 构建……");
  run(hugo, args);

  run("node", [path.join(ROOT, "scripts", "build-comment-manifest.mjs"), WORKSPACE, STAGING]);
  run("node", [path.join(ROOT, "tests", "check-site.mjs")], { env: { ...process.env, SITE_DIR: STAGING } });

  const previous = path.join(DIST, "site.previous");
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(path.join(DIST, "site"))) {
    fs.renameSync(path.join(DIST, "site"), previous);
  }
  fs.renameSync(STAGING, path.join(DIST, "site"));

  for (const checker of ["check-reading-ui.mjs", "check-reader-tools.mjs", "check-article-comments.mjs"]) {
    run("node", [path.join(ROOT, "tests", checker), ROOT], {
      env: { ...process.env, SITE_DIR: path.join(DIST, "site") },
    });
  }

  const pages = countFiles(path.join(DIST, "site"), ".html");
  log(`构建成功：${pages} 个HTML页面。`);
  log(`输出目录：${path.join(DIST, "site")}`);
}

function findUnsafeContent(contentRoot) {
  const unsafe = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^\.\S*\.import-/i.test(entry.name)) unsafe.push(full);
        else walk(full);
      } else if (/\.(docx|docm|dotx|dotm)$/i.test(entry.name)) {
        unsafe.push(full);
      }
    }
  };
  if (fs.existsSync(contentRoot)) walk(contentRoot);
  return unsafe;
}

function countFiles(dir, ext) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) count += countFiles(full, ext);
    else if (full.endsWith(ext)) count += 1;
  }
  return count;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const layoutIndex = args.indexOf("--layout-test-source");
  const layoutTestSource = layoutIndex >= 0 ? args[layoutIndex + 1] : "";
  buildSite({ layoutTestSource });
}
