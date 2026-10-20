/* npm 入口：npm run package（macOS/Linux）。
 * P0-B：打包前必须冻结 release snapshot；站点与源码包必须记录同一快照身份。
 *   - 静态站点包：dist/site → tar.gz
 *   - 源码包：scripts/create-source-package.sh（canonical，快照绑定）
 * 输出目录：dist/releases/<时间戳>/，同时打印各包 SHA-256。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, log, die, findPython, runCapture } from "./cross-platform/common.mjs";

function shasum(file) {
  const result = spawnSync("shasum", ["-a", "256", file], { encoding: "utf8" });
  return (result.stdout || "").split(/\s+/)[0];
}

function makeTar(sourceDir, outputFile) {
  const result = spawnSync("tar", ["-czf", outputFile, "-C", sourceDir, "."], {
    stdio: "pipe",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) die(`tar 打包失败：${(result.stderr || "").toString()}`);
}

function createSnapshot() {
  const python = findPython() || die("未找到 Python，无法创建 release snapshot。");
  const workspaceJson = runCapture(python, [
    path.join(ROOT, "tools", "workspace.py"), "show", `--platform-root=${ROOT}`,
  ]);
  if (!workspaceJson) die("workspace show 失败。");
  const workspace = JSON.parse(workspaceJson);
  const snapshotArgs = [
    path.join(ROOT, "tools", "release_snapshot.py"), "create",
    `--platform-root=${ROOT}`, "--mode=full_site",
    `--content-root=${workspace.contentRoot}`,
    `--site-overrides-root=${workspace.siteOverridesRoot}`,
    `--author-notes-root=${workspace.authorNotesRoot}`,
  ];
  if (process.env.LIDAIJI_PUBLISH_AUTHOR_NOTES === "1") snapshotArgs.push("--publish-author-notes");
  const snapshotJson = runCapture(python, snapshotArgs);
  if (!snapshotJson) die("release snapshot 创建失败（平台代码必须来自干净提交）。");
  return JSON.parse(snapshotJson);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0";
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "_");
const outDir = path.join(ROOT, "dist", "releases", `${stamp}`);
ensureDir(outDir);

const siteDir = path.join(ROOT, "dist", "site");
if (!fs.existsSync(path.join(siteDir, "index.html"))) {
  die("缺少 dist/site 构建产物，请先运行 npm run build。");
}

const snapshot = createSnapshot();
const releaseTar = path.join(outDir, `lidaiji-site-v${version}_${stamp}.tar.gz`);
const sourceTar = path.join(outDir, `lidaiji-source-v${version}_${stamp}.tar.gz`);

makeTar(siteDir, releaseTar);

const result = spawnSync("bash", [path.join(ROOT, "scripts", "create-source-package.sh"), sourceTar, "site"], {
  stdio: "inherit",
  env: { ...process.env, LIDAIJI_RELEASE_SNAPSHOT: snapshot.snapshotDir },
});
if (result.status !== 0) die("源码包生成失败。");

log(`发布包目录：${outDir}`);
console.log(`静态站包：${releaseTar}`);
console.log(`  SHA-256：${shasum(releaseTar)}`);
console.log(`源码包：${sourceTar}`);
console.log(`  SHA-256：${shasum(sourceTar)}`);
console.log(`发布快照：${snapshot.snapshotId}（${snapshot.snapshotMode}）`);
console.log("上传后可在服务器执行部署脚本（见 docs/deployment.md）。");
