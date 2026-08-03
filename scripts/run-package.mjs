/* 跨平台 npm 入口：npm run package。
 * 生成标准发布包（与 scripts/publish.sh 的打包步骤一致）：
 *   - 静态站点包：dist/site → tar.gz
 *   - 源码包：git archive HEAD → tar.gz + manifest + sha256
 * Windows 使用系统自带 tar.exe（Windows 10 1803+）或 Git 的 tar；Unix 用系统 tar。
 * 输出目录：dist/releases/<时间戳>/，同时打印各包 SHA-256。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, ensureDir, log, die } from "./cross-platform/common.mjs";

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

function gitArchive(outputFile) {
  const result = spawnSync("git", ["archive", "--format=tar", "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
    cwd: ROOT,
    windowsHide: true,
  });
  if (result.status !== 0) die(`git archive 失败（需要已提交的工作区）：${(result.stderr || "").toString().trim()}`);
  fs.writeFileSync(outputFile, result.stdout);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.0.0";
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "_");
const outDir = path.join(ROOT, "dist", "releases", `${stamp}`);
ensureDir(outDir);

const siteDir = path.join(ROOT, "dist", "site");
if (!fs.existsSync(path.join(siteDir, "index.html"))) {
  die("缺少 dist/site 构建产物，请先运行 npm run build。");
}

const releaseTar = path.join(outDir, `lidaiji-site-v${version}_${stamp}.tar.gz`);
const sourceTar = path.join(outDir, `lidaiji-source-v${version}_${stamp}.tar.gz`);
const sourceTmp = path.join(outDir, "source.tar");

makeTar(siteDir, releaseTar);
gitArchive(sourceTmp);
const gzip = spawnSync("gzip", ["-c", sourceTmp], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
if (gzip.status !== 0) die("源码包压缩失败。");
fs.writeFileSync(sourceTar, gzip.stdout);
fs.rmSync(sourceTmp, { force: true });

// 源码包清单
const manifestLines = spawnSync("git", ["ls-files"], { encoding: "utf8", cwd: ROOT })
  .stdout.split("\n").filter(Boolean);
fs.writeFileSync(`${sourceTar}.manifest.txt`, manifestLines.join("\n") + "\n");
fs.writeFileSync(`${sourceTar}.sha256`, `${shasum(sourceTar)}  ${path.basename(sourceTar)}\n`);

log(`发布包目录：${outDir}`);
console.log(`静态站包：${releaseTar}`);
console.log(`  SHA-256：${shasum(releaseTar)}`);
console.log(`源码包：${sourceTar}`);
console.log(`  SHA-256：${shasum(sourceTar)}`);
console.log("上传后可在服务器执行部署脚本（见 docs/deployment.md）。");
