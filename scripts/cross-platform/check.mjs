/* 跨平台核心检查（Windows 与 Linux 使用；macOS 继续走 scripts/check.sh 全套）。
 * Windows 分支执行：Node 静态/引擎检查、核心 Python 测试、评论服务测试、
 * Hugo 构建、PowerShell 脚本语法检查。
 * Linux 分支执行：同一套 Node/Python/评论/构建检查 + bash 脚本语法检查
 * （排除 macOS 专用测试，如 test_author_workflow）。 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { IS_WIN, ROOT, findPython, log, run } from "./common.mjs";
import { buildSite } from "./build.mjs";

const nodeChecks = [
  "tests/check-source.mjs",
  "tests/check-editor-markdown.mjs",
  "tests/check-editor-format.mjs",
  "tests/check-scope-migration.mjs",
];

const pythonChecks = [
  "tests/test_preview_render.py",
  "tests/test_paragraph_ids.py",
  "tests/test_docx_import.py",
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
  log(`${IS_WIN ? "Windows" : "Linux"} 核心检查开始……`);

  for (const check of nodeChecks) {
    log(`运行 ${check}……`);
    run("node", [path.join(ROOT, check)]);
  }

  log("评论服务测试……");
  if (IS_WIN) {
    // 等价于 comments-service 的 npm run check（server/app 语法 + node --test），
    // 直接用 node 执行，避免 Windows 上 npm.cmd 的引号/路径问题
    const service = path.join(ROOT, "comments-service");
    run("node", ["--check", path.join(service, "src", "server.js")]);
    run("node", ["--check", path.join(service, "src", "app.js")]);
    run("node", ["--test", path.join(service, "test")]);
  } else {
    run("npm", ["--prefix", path.join(ROOT, "comments-service"), "run", "check"]);
  }

  // Python 测试需要 DOCX 导入依赖（setup.ps1 / CI 负责安装）
  const python = process.env.LIDAIJI_PYTHON || findPython() || "python";
  for (const check of pythonChecks.concat(IS_WIN ? [] : linuxPythonChecks)) {
    log(`运行 ${check}……`);
    run(python, [path.join(ROOT, check)]);
  }

  log("Hugo 构建验证……");
  buildSite();

  if (IS_WIN) {
    log("PowerShell 脚本语法检查……");
    const psDir = path.join(ROOT, "scripts", "windows");
    const bad = [];
    if (fs.existsSync(psDir)) {
      for (const file of fs.readdirSync(psDir)) {
        if (!file.endsWith(".ps1")) continue;
        const message = runCapturePowerShell(psDir, file);
        if (message) bad.push(`${file}: ${message}`);
      }
    }
    if (bad.length) {
      console.error(`PowerShell 语法检查失败：\n${bad.join("\n")}`);
      process.exit(1);
    }
    log(`PowerShell 脚本语法检查通过（${bad.length === 0 ? "全部" : "部分"}）。`);
  } else {
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
  }

  log(`${IS_WIN ? "Windows" : "Linux"} 核心检查通过。`);
}

function runCapturePowerShell(dir, file) {
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$null = [System.Management.Automation.Language.Parser]::ParseFile('${(path.join(dir, file)).replace(/'/g, "''")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }`,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    return "";
  } catch (error) {
    return error.stderr ? error.stderr.toString().trim() : String(error.message);
  }
}

if (!process.platform.includes("darwin")) runCrossPlatformCheck();
