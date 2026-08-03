/* 跨平台核心检查（Windows 使用；Unix 继续走 scripts/check.sh 全套）。
 * Windows 分支执行：Node 静态/引擎检查、核心 Python 测试、
 * 评论服务测试、Hugo 构建、PowerShell 脚本语法检查。 */

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

export function runWindowsCheck() {
  log("Windows 核心检查开始……");

  for (const check of nodeChecks) {
    log(`运行 ${check}……`);
    run("node", [path.join(ROOT, check)]);
  }

  log("评论服务测试……");
  run("npm", ["--prefix", path.join(ROOT, "comments-service"), "run", "check"]);

  // Python 测试需要 DOCX 导入依赖（setup.ps1 / CI 负责安装）
  const python = process.env.LIDAIJI_PYTHON || findPython() || "python";
  for (const check of pythonChecks) {
    log(`运行 ${check}……`);
    run(python, [path.join(ROOT, check)]);
  }

  log("Hugo 构建验证……");
  buildSite();

  log("PowerShell 脚本语法检查……");
  const psDir = path.join(ROOT, "scripts", "windows");
  if (fs.existsSync(psDir)) {
    const bad = [];
    for (const file of fs.readdirSync(psDir)) {
      if (!file.endsWith(".ps1")) continue;
      const check = runCapturePowerShell(psDir, file);
      if (check) bad.push(`${file}: ${check}`);
    }
    if (bad.length) {
      console.error(`PowerShell 语法检查失败：\n${bad.join("\n")}`);
      process.exit(1);
    }
    log(`PowerShell 脚本语法检查通过（${fs.readdirSync(psDir).filter((f) => f.endsWith(".ps1")).length} 个文件）。`);
  }

  log("Windows 核心检查通过。");
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

if (IS_WIN) runWindowsCheck();
