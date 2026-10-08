/* 跨平台 npm 入口：npm run package。
 * P0-B：打包前必须冻结 release snapshot；站点与源码包必须记录同一快照身份。
 *   - 静态站点包：dist/site → tar.gz
 *   - 源码包：Unix 走 scripts/create-source-package.sh（canonical，快照绑定）；
 *     Windows 使用 git archive <platformCommit> + BUILD_INFO 来源证明（tar.exe）。
 * 输出目录：dist/releases/<时间戳>/，同时打印各包 SHA-256。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, ensureDir, log, die, findPython, runCapture } from "./cross-platform/common.mjs";

function shasum(file) {
  if (process.platform === "win32") {
    const result = spawnSync("certutil", ["-hashfile", file, "SHA256"], { encoding: "utf8" });
    const match = /([0-9a-f]{64})/i.exec(result.stdout || "");
    if (!match) die("计算 SHA-256 失败。");
    return match[1].toLowerCase();
  }
  const result = spawnSync("shasum", ["-a", "256", file], { encoding: "utf8" });
  return (result.stdout || "").split(/\s+/)[0];
}

function makeTar(sourceDir, outputFile) {
  const result = spawnSync("tar", ["-czf", outputFile, "-C", sourceDir, "."], {
    stdio: "pipe",
    windowsHide: true,
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
  const snapshotJson = runCapture(python, [
    path.join(ROOT, "tools", "release_snapshot.py"), "create",
    `--platform-root=${ROOT}`, "--mode=full_site",
    `--content-root=${workspace.contentRoot}`,
    `--site-overrides-root=${workspace.siteOverridesRoot}`,
  ]);
  if (!snapshotJson) die("release snapshot 创建失败（平台代码必须来自干净提交）。");
  return JSON.parse(snapshotJson);
}

function buildInfoText(snapshot, version) {
  return [
    `version: ${version}`,
    `sourceCommit: ${snapshot.platformCommit}`,
    `releaseSnapshotId: ${snapshot.snapshotId}`,
    `releaseSnapshotFingerprint: ${snapshot.snapshotFingerprint}`,
    `snapshotMode: ${snapshot.snapshotMode}`,
    `contentManifestSha256: ${snapshot.contentManifestSha256}`,
    `configFingerprint: ${snapshot.configFingerprint}`,
    `builderVersion: ${snapshot.builderVersion}`,
    `buildTimestamp: ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "packageRole: platform-source-with-release-provenance",
    "reproducibleSiteFromPackage: false",
    "entrypoint: index.html",
  ].join("\n") + "\n";
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

if (process.platform !== "win32") {
  const result = spawnSync("bash", [path.join(ROOT, "scripts", "create-source-package.sh"), sourceTar, "site"], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, LIDAIJI_RELEASE_SNAPSHOT: snapshot.snapshotDir },
  });
  if (result.status !== 0) die("源码包生成失败。");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-source-"));
  const rawTar = path.join(tmp, "source.tar");
  const archive = spawnSync("git", ["archive", "--format=tar", snapshot.platformCommit], {
    cwd: ROOT,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (archive.status !== 0) die("git archive 失败。");
  fs.writeFileSync(rawTar, archive.stdout);
  const unpack = path.join(tmp, "unpack");
  ensureDir(unpack);
  if (spawnSync("tar", ["-xf", rawTar, "-C", unpack], { stdio: "pipe", windowsHide: true }).status !== 0) {
    die("源码包解包失败。");
  }
  fs.writeFileSync(path.join(unpack, "BUILD_INFO"), buildInfoText(snapshot, version));
  if (spawnSync("tar", ["-czf", sourceTar, "-C", unpack, "."], {
    stdio: "pipe", windowsHide: true, env: { ...process.env, COPYFILE_DISABLE: "1" },
  }).status !== 0) {
    die("源码包打包失败。");
  }
  const listing = spawnSync("tar", ["-tzf", sourceTar], { encoding: "utf8", windowsHide: true });
  fs.writeFileSync(`${sourceTar}.manifest.txt`, (listing.stdout || "").trim().split("\n").filter(Boolean).join("\n") + "\n");
  fs.writeFileSync(`${sourceTar}.sha256`, `${shasum(sourceTar)}  ${path.basename(sourceTar)}\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

log(`发布包目录：${outDir}`);
console.log(`静态站包：${releaseTar}`);
console.log(`  SHA-256：${shasum(releaseTar)}`);
console.log(`源码包：${sourceTar}`);
console.log(`  SHA-256：${shasum(sourceTar)}`);
console.log(`发布快照：${snapshot.snapshotId}（${snapshot.snapshotMode}）`);
console.log("上传后可在服务器执行部署脚本（见 docs/deployment.md）。");
