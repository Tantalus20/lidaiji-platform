import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.argv[2] || ".");
const fixture = path.join(root, "tests", "fixtures", "author-notes");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lidaiji-author-notes-"));
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

function copyProject() {
  const ignored = new Set([".git", ".cache", ".venv-importer", "dist", "node_modules"]);
  fs.cpSync(root, temp, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      if (!relative) return true;
      if (relative === ".lidaiji-workspace.json") return false;
      return !relative.split(path.sep).some((part) => ignored.has(part));
    },
  });
  fs.cpSync(path.join(root, "examples", "demo-content"), path.join(temp, "content"), { recursive: true });
  fs.cpSync(path.join(root, "examples", "demo-author-notes"), path.join(temp, "data", "author-notes"), { recursive: true });
  fs.cpSync(path.join(fixture, "content"), path.join(temp, "content"), { recursive: true });
  fs.cpSync(path.join(fixture, "data"), path.join(temp, "data"), { recursive: true });
}

function allFiles(directory) {
  const found = [];
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...allFiles(target));
    else found.push(target);
  }
  return found;
}

function verify(destination, label, requireParagraphId) {
  const article = path.join(destination, "essays", "author-notes-security-test", "index.html");
  assert(fs.existsSync(article), `${label}缺少作者评测试文章`);
  if (!fs.existsSync(article)) return;
  const html = fs.readFileSync(article, "utf8");
  const entireOutput = allFiles(destination)
    .map((file) => fs.readFileSync(file))
    .reduce((result, value) => Buffer.concat([result, value]), Buffer.alloc(0));
  const text = entireOutput.toString("utf8");
  assert(html.includes("已发布段评"), `${label}未渲染published段评`);
  assert(html.includes("已发布章评"), `${label}未渲染published章评`);
  assert(!text.includes("DRAFT-AUTHOR-NOTE-9f7a6d"), `${label}泄露draft作者评`);
  assert(!allFiles(destination).some((file) => file.endsWith(".yaml")), `${label}复制了作者评源YAML`);
  assert(!text.includes("version: 1\nnotes:"), `${label}包含原始作者评数据`);
  assert(html.includes("&lt;script>"), `${label}未把script标签按文字转义`);
  assert(html.includes("&lt;img onerror=\"alert(1)\">"), `${label}未把onerror标签按文字转义`);
  assert(!html.includes("<img onerror="), `${label}产生可执行onerror标签`);
  assert(!/<script(?![^>]+src=)/i.test(html), `${label}包含内联脚本`);
  assert(/<script[^>]+src=\/js\/author-notes\.min\.[a-f0-9]+\.js/i.test(html), `${label}未加载指纹化作者评脚本`);
  if (requireParagraphId) {
    assert(html.includes("id=p-111111111111"), `${label}未注入稳定段落ID`);
  }
}

try {
  copyProject();
  const python = process.env.WRITING_IMPORT_PYTHON || path.join(root, ".venv-importer", "bin", "python3");
  const hugo = process.env.HUGO_BIN || path.join(root, ".hugo-local");
  execFileSync(python, [path.join(temp, "scripts", "comments-prepare.py"), "--project-root", temp, "--write"], {
    stdio: "pipe",
  });

  const naked = path.join(temp, "naked-hugo");
  execFileSync(hugo, [
    "--source", temp,
    "--destination", naked,
    "--baseURL", "https://example.com/",
    "--minify",
    "--cleanDestinationDir",
  ], { stdio: "pipe" });
  verify(naked, "裸Hugo构建", false);

  execFileSync(path.join(temp, "scripts", "build.sh"), [], {
    cwd: temp,
    env: {
      ...process.env,
      HUGO_BIN: hugo,
      WRITING_IMPORT_PYTHON: python,
      SITE_BASE_URL: "https://example.com/",
      LIDAIJI_CONTENT_REPO_ROOT: temp,
      LIDAIJI_CONTENT_ROOT: path.join(temp, "content"),
      LIDAIJI_AUTHOR_NOTES_ROOT: path.join(temp, "data", "author-notes"),
      LIDAIJI_SITE_OVERRIDES_ROOT: path.join(temp, "examples", "demo-site-overrides"),
    },
    stdio: "pipe",
  });
  verify(path.join(temp, "dist", "site"), "正式构建", true);
} catch (error) {
  failures.push(`作者评构建测试执行失败：${error.stderr?.toString() || error.message}`);
} finally {
  const expectedPrefix = `${os.tmpdir()}${path.sep}lidaiji-author-notes-`;
  if (!temp.startsWith(expectedPrefix)) throw new Error("拒绝清理非测试临时目录");
  fs.rmSync(temp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`作者评构建检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("作者评裸Hugo与正式构建检查通过：published可见、draft与源YAML零泄露。 ");
