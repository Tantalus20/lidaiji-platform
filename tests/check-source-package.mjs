import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || ".");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-source-package-test-"));
const project = path.join(base, "project");
const output = path.join(base, "writing-source-test.tar.gz");
const commentsOutput = path.join(base, "lidaiji-comments-test.tar.gz");
const extracted = path.join(base, "extracted");
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
}

try {
  const hugoBin = process.env.HUGO_BIN || path.join(root, ".hugo-local");
  const importPython = process.env.WRITING_IMPORT_PYTHON || path.join(root, ".venv-importer", "bin", "python3");
  const ignored = new Set([".git", ".cache", ".venv-importer", "dist", "node_modules"]);
  fs.cpSync(root, project, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      if (!relative) return true;
      return !relative.split(path.sep).some((part) => ignored.has(part));
    },
  });
  run("git", ["init"], { cwd: project });
  run("git", ["config", "user.name", "发布包测试"], { cwd: project });
  run("git", ["config", "user.email", "package-test@example.invalid"], { cwd: project });
  run("git", ["add", "--all"], { cwd: project });
  run("git", ["commit", "-m", "fixture"], { cwd: project });

  const privateFiles = [
    ".cache/private.sqlite3",
    ".DS_Store",
    "._README.md",
    ".env",
    ".author-settings",
    "incoming/private-manuscript.docx",
    "incoming/private-manuscript.docm",
    "comments-service/data/private.sqlite3",
    "dist/private.log",
    "public/private.log",
  ];
  for (const relative of privateFiles) {
    const target = path.join(project, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `PRIVATE-PACKAGE-FIXTURE:${relative}`);
  }

  run(path.join(project, "scripts", "create-source-package.sh"), [output, "site"], { cwd: project });
  run(path.join(project, "scripts", "create-source-package.sh"), [commentsOutput, "comments"], { cwd: project });
  const members = run("tar", ["-tzf", output]).trim().split("\n");
  for (const relative of privateFiles) {
    assert(!members.includes(relative), `源码包混入敏感或本地文件：${relative}`);
  }
  const required = [
    "config/_default/hugo.toml",
    "examples/demo-content/works/cloud-post-office/_index.md",
    "examples/demo-author-notes/article-a11da1e000000001.yaml",
    "themes/lidaiji/layouts/_default/single.html",
    "scripts/build.sh",
    "scripts/create-source-package.sh",
    "studio/server.py",
    "comments-service/package.json",
  ];
  required.forEach((relative) => assert(members.includes(relative), `源码包缺少正式文件：${relative}`));
  assert(!members.some((name) => name.startsWith("screenshots/") || name.startsWith("artifacts/")), "源码包含测试截图");
  assert(!members.some((name) => /(^|\/)\.env/.test(name)), "源码包含.env文件");
  assert(!members.some((name) => /(^|\/)\._/.test(name) || name.endsWith(".DS_Store")), "源码包含macOS垃圾文件");
  assert(!members.some((name) => /\.sqlite(?:3)?(?:-|$)/.test(name)), "源码包含SQLite文件");
  assert(!members.some((name) => /\.doc(?:x|m)$/.test(name)), "源码包含私人Word文件");

  const expectedHash = fs.readFileSync(`${output}.sha256`, "utf8").trim().split(/\s+/)[0];
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");
  assert(expectedHash === actualHash, "源码包SHA-256不匹配");
  const manifest = fs.readFileSync(`${output}.manifest.txt`, "utf8").trim().split("\n");
  assert(JSON.stringify(manifest) === JSON.stringify(members), "源码包清单与实际成员不一致");

  const commentMembers = run("tar", ["-tzf", commentsOutput]).trim().split("\n");
  assert(commentMembers.includes("package.json"), "评论服务包缺少package.json");
  assert(commentMembers.includes("src/server.js"), "评论服务包缺少服务入口");
  assert(!commentMembers.some((name) => name.startsWith("comments-service/")), "评论服务包目录层级错误");
  assert(!commentMembers.some((name) => /(^|\/)\.env/.test(name)), "评论服务包包含.env文件");
  assert(!commentMembers.some((name) => /\.sqlite(?:3)?(?:-|$)/.test(name)), "评论服务包包含SQLite文件");
  const expectedCommentsHash = fs.readFileSync(`${commentsOutput}.sha256`, "utf8").trim().split(/\s+/)[0];
  const actualCommentsHash = crypto.createHash("sha256").update(fs.readFileSync(commentsOutput)).digest("hex");
  assert(expectedCommentsHash === actualCommentsHash, "评论服务包SHA-256不匹配");

  fs.mkdirSync(extracted);
  run("tar", ["-xzf", output, "-C", extracted]);
  run(path.join(extracted, "scripts", "build.sh"), [], {
    cwd: extracted,
    env: {
      ...process.env,
      HUGO_BIN: hugoBin,
      WRITING_IMPORT_PYTHON: importPython,
      SITE_BASE_URL: "https://example.com/",
    },
  });
  assert(fs.existsSync(path.join(extracted, "dist", "site", "index.html")), "干净解包后无法构建网站");
} catch (error) {
  failures.push(
    `源码包测试执行失败：${error.stderr?.toString() || ""}\n${error.stdout?.toString() || ""}\n${error.message}\ncode=${error.code} status=${error.status} signal=${error.signal}`,
  );
} finally {
  const expectedPrefix = `${os.tmpdir()}${path.sep}lidaiji-source-package-test-`;
  if (!base.startsWith(expectedPrefix)) throw new Error("拒绝清理非测试临时目录");
  fs.rmSync(base, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`源码发布包检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("源码发布包检查通过：仅Git源码、敏感文件零混入、清单与SHA正确、干净目录可构建。");
