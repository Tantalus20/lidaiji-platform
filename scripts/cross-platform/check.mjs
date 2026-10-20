/* Linux 核心检查（macOS 继续走 scripts/check.sh 全套）。
 * 执行 Node 静态/引擎检查、Python 测试、评论服务测试、Hugo 构建与 bash 语法检查
 * （排除 macOS 专用测试，如 test_author_workflow）。 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, findPython, log, run } from "./common.mjs";
import { buildSite } from "./build.mjs";

const nodeChecks = [
  "tests/check-source.mjs",
  "tests/check-editor-markdown.mjs",
  "tests/check-editor-format.mjs",
  "tests/check-editor-toolbar-state.mjs",
  "tests/check-save-state.mjs",
  "tests/check-scope-migration.mjs",
];

const pythonChecks = [
  "tests/test_preview_render.py",
  "tests/test_paragraph_ids.py",
  "tests/test_docx_import.py",
  "tests/test_workspace_resolution.py",
  "tests/test_release_snapshot.py",
];

// Linux 额外可跨平台的 Studio/导入器测试（test_author_workflow 依赖 macOS 桌面入口，排除）
const linuxPythonChecks = [
  "tests/test_studio.py",
  "tests/test_studio_articles.py",
  "tests/test_studio_versions.py",
  "tests/test_studio_media.py",
  "tests/test_studio_feedback.py",
  "tests/test_studio_notes.py",
  "tests/test_import_stages.py",
  "tests/test_docx_series_importer.py",
];

export function runCrossPlatformCheck() {
  log("Linux 核心检查开始……");

  for (const check of nodeChecks) {
    log(`运行 ${check}……`);
    run("node", [path.join(ROOT, check)]);
  }

  log("评论服务测试……");
  run("npm", ["--prefix", path.join(ROOT, "comments-service"), "run", "check"]);

  // Python 测试需要 DOCX 导入依赖（CI 负责安装）
  const python = process.env.LIDAIJI_PYTHON || findPython() || "python";
  for (const check of pythonChecks.concat(linuxPythonChecks)) {
    log(`运行 ${check}……`);
    run(python, [path.join(ROOT, check)]);
  }

  log("Hugo 构建验证……");
  buildSite();

  log("发布身份校验拒绝测试……");
  run("bash", [path.join(ROOT, "tests", "check-release-identity.sh")]);
  log("bash 脚本语法检查……");
  const scripts = [];
  for (const dir of ["scripts", "tests", "deploy"]) {
    if (fs.existsSync(path.join(ROOT, dir))) {
      for (const entry of fs.readdirSync(path.join(ROOT, dir))) {
        if (entry.endsWith(".sh")) scripts.push(path.join(ROOT, dir, entry));
      }
    }
  }
  for (const script of scripts) {
    try {
      execFileSync("bash", ["-n", script], { stdio: "pipe" });
    } catch (error) {
      console.error(`bash 语法错误：${script}\n${(error.stderr || "").toString()}`);
      process.exit(1);
    }
  }
  log(`bash 脚本语法检查通过（${scripts.length} 个文件）。`);

  log("Linux 核心检查通过。");
}

if (!process.platform.includes("darwin")) runCrossPlatformCheck();
