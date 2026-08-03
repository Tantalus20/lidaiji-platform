/* 跨平台公共工具：路径、python 定位、命令执行。
 * 只使用 Node 标准库；被 run-*.mjs 与 cross-platform/*.mjs 使用。 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const IS_WIN = process.platform === "win32";
/* Windows 上 npm/git 等命令是 .cmd 包装，spawnSync 需要显式后缀 */
export const npmCommand = IS_WIN ? "npm.cmd" : "npm";

export function die(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

/* 定位项目可用的 Python（DOCX 导入与 Studio 需要 docx/PIL/yaml/pypinyin）。
 * Windows 上依次尝试：项目 venv → py -3 → python → python3。 */
export function findPython() {
  const candidates = IS_WIN
    ? [
        path.join(ROOT, ".venv-importer", "Scripts", "python.exe"),
        path.join(ROOT, ".venv-importer", "python.exe"),
        "py -3",
        "python",
        "python3",
      ]
    : [
        path.join(ROOT, ".venv-importer", "bin", "python3"),
        "python3",
        "python",
      ];
  const probe = 'import docx, PIL, yaml, pypinyin';
  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep) || candidate.startsWith("py ")) {
        const parts = candidate.split(" ");
        const out = execFileSync(parts[0], [...parts.slice(1), "-c", probe], {
          stdio: "pipe",
          windowsHide: true,
        });
        if (out !== undefined) return candidate;
      } else {
        const out = execFileSync(candidate, ["-c", probe], { stdio: "pipe", windowsHide: true });
        if (out !== undefined) return candidate;
      }
    } catch {
      /* 尝试下一个 */
    }
  }
  return "";
}

/* 运行命令并继承 stdio；失败时以非零码退出。 */
export function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...options });
  if (result.error) {
    die(`${cmd} 无法执行：${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

/* 运行命令，返回 stdout 文本；失败返回空串。 */
export function runCapture(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function log(message) {
  console.log(`[历代纪] ${message}`);
}
