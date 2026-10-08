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
  // 工作区配置即使被强制跟踪，也必须被 export-ignore 排除出源码包。
  fs.writeFileSync(path.join(project, ".lidaiji-workspace.json"), '{"contentRepoRoot": "../private-fixture"}');
  run("git", ["add", "-f", ".lidaiji-workspace.json"], { cwd: project });
  run("git", ["add", "--all"], { cwd: project });
  run("git", ["commit", "-m", "fixture"], { cwd: project });

  // P0-B：site 源码包必须绑定 release snapshot；先在工作树干净时冻结。
  const snapshot = JSON.parse(run("python3", [
    path.join(project, "tools", "release_snapshot.py"), "create",
    "--platform-root", project, "--mode", "full_site",
    "--content-root", path.join(project, "examples", "demo-content"),
    "--site-overrides-root", path.join(project, "examples", "demo-site-overrides"),
  ]));
  assert(/^[0-9a-f]{16}$/.test(snapshot.snapshotId), "release snapshot ID 无效");

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

  const snapshotEnv = { ...process.env, LIDAIJI_RELEASE_SNAPSHOT: snapshot.snapshotDir };
  run(path.join(project, "scripts", "create-source-package.sh"), [output, "site"], { cwd: project, env: snapshotEnv });
  run(path.join(project, "scripts", "create-source-package.sh"), [commentsOutput, "comments"], { cwd: project });
  const members = run("tar", ["-tzf", output]).trim().split("\n");
  for (const relative of privateFiles) {
    assert(!members.includes(relative), `源码包混入敏感或本地文件：${relative}`);
  }
  assert(!members.includes(".lidaiji-workspace.json"), "源码包混入工作区配置");
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

  const sourceInfo = run("tar", ["-xOzf", output, "BUILD_INFO"]);
  const infoField = (text, key) => {
    const match = text.match(new RegExp(`^${key}: (.*)$`, "m"));
    return match ? match[1].trim() : "";
  };
  assert(infoField(sourceInfo, "releaseSnapshotId") === snapshot.snapshotId, "源码包BUILD_INFO未绑定快照");
  assert(infoField(sourceInfo, "releaseSnapshotFingerprint") === snapshot.snapshotFingerprint, "源码包快照指纹不一致");
  assert(infoField(sourceInfo, "contentManifestSha256") === snapshot.contentManifestSha256, "源码包内容清单摘要不一致");
  assert(infoField(sourceInfo, "sourceCommit") === snapshot.platformCommit, "源码包sourceCommit与快照平台提交不一致");
  assert(infoField(sourceInfo, "packageRole") === "platform-source-with-release-provenance", "源码包角色标记缺失");
  assert(infoField(sourceInfo, "reproducibleSiteFromPackage") === "false", "源码包不应声称可独立复现站点");
  assert(!/\/Users\/|\/home\//.test(sourceInfo), "源码包BUILD_INFO泄露绝对路径");

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
  // 解包目录没有 .git；P0-B 要求平台代码来自提交，测试先建立干净仓库。
  run("git", ["init"], { cwd: extracted });
  run("git", ["config", "user.name", "发布包测试"], { cwd: extracted });
  run("git", ["config", "user.email", "package-test@example.invalid"], { cwd: extracted });
  run("git", ["add", "--all"], { cwd: extracted });
  run("git", ["commit", "-m", "extracted"], { cwd: extracted });
  run(path.join(extracted, "scripts", "build.sh"), [], {
    cwd: extracted,
    env: {
      ...process.env,
      HUGO_BIN: hugoBin,
      WRITING_IMPORT_PYTHON: importPython,
      SITE_BASE_URL: "https://example.com/",
    },
  });
  const siteInfoPath = path.join(extracted, "dist", "site", "BUILD_INFO");
  assert(fs.existsSync(path.join(extracted, "dist", "site", "index.html")), "干净解包后无法构建网站");
  assert(fs.existsSync(siteInfoPath), "构建产物缺少BUILD_INFO");
  if (fs.existsSync(siteInfoPath)) {
    const siteInfo = fs.readFileSync(siteInfoPath, "utf8");
    const siteSnapshotId = infoField(siteInfo, "releaseSnapshotId");
    assert(/^[0-9a-f]{16}$/.test(siteSnapshotId), "站点BUILD_INFO缺少快照ID");
    assert(infoField(siteInfo, "snapshotMode") === "full_site", "站点快照模式不正确");
    assert(/^[0-9a-f]{64}$/.test(infoField(siteInfo, "contentManifestSha256")), "站点缺少内容清单摘要");
    const head = run("git", ["rev-parse", "HEAD"], { cwd: extracted }).trim();
    assert(infoField(siteInfo, "sourceCommit") === head, "站点sourceCommit与解包仓库提交不一致");

    // P0-B 关键证明：构建必须由快照平台代码决定。修改原工作树模板后复用快照，
    // 输出不得出现修改痕迹，且身份字段不变。
    const releasesDir = path.join(extracted, ".cache", "releases");
    const snapshotDirs = fs.existsSync(releasesDir)
      ? fs.readdirSync(releasesDir)
          .filter((name) => !name.startsWith("."))
          .map((name) => path.join(releasesDir, name))
      : [];
    assert(snapshotDirs.length >= 1, "构建未生成 release snapshot");
    if (snapshotDirs.length >= 1) {
      const marker = "P0B-WORKTREE-MUTATION-MARKER";
      fs.appendFileSync(
        path.join(extracted, "themes", "lidaiji", "layouts", "_default", "baseof.html"),
        `\n<!-- ${marker} -->\n`,
      );
      run(path.join(extracted, "scripts", "build.sh"), [], {
        cwd: extracted,
        env: {
          ...process.env,
          HUGO_BIN: hugoBin,
          WRITING_IMPORT_PYTHON: importPython,
          SITE_BASE_URL: "https://example.com/",
          LIDAIJI_RELEASE_SNAPSHOT: snapshotDirs[0],
        },
      });
      const outputFiles = [];
      const walkOutput = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walkOutput(full);
          else if (entry.name.endsWith(".html")) outputFiles.push(full);
        }
      };
      walkOutput(path.join(extracted, "dist", "site"));
      assert(
        !outputFiles.some((file) => fs.readFileSync(file, "utf8").includes(marker)),
        "构建读取了可变工作树代码而非快照平台代码",
      );
      const mutatedInfo = fs.readFileSync(siteInfoPath, "utf8");
      assert(infoField(mutatedInfo, "sourceCommit") === head, "复用快照后sourceCommit发生变化");
    }
  }
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
