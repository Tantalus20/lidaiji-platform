import fs from "node:fs";

const failures = [];
const assert = (value, message) => { if (!value) failures.push(message); };
const read = (file) => fs.readFileSync(file, "utf8");
const backup = read("scripts/backup.sh");
assert(backup.includes('WRITING_BACKUP_DIR:-/var/backups/writing-site'), "备份默认目录不是/var/backups/writing-site");
assert(!backup.includes('WRITING_BACKUP_DIR:-$ROOT/backups'), "备份仍默认写入项目内部");
assert(backup.includes("INCLUDES=("), "备份未使用显式白名单");
for (const name of [
  "new-post", "preview", "build", "publish", "backup", "import-docx",
  "writing-site", "reimport-docx", "install-shortcuts", "studio",
]) {
  const file = `${name}.command`;
  assert(fs.existsSync(file), `缺少Mac命令文件：${file}`);
  if (fs.existsSync(file)) assert((fs.statSync(file).mode & 0o111) !== 0, `${file}没有执行权限`);
}
for (const old of ["新建文章.command", "预览网站.command", "发布网站.command", "备份网站.command"]) {
  assert(!fs.existsSync(old), `仍存在可能乱码的中文命令文件：${old}`);
}
const nginx = read("deploy/nginx/writing-site.conf.template");
assert(nginx.includes("listen 443 ssl;") && nginx.includes("http2 on;"), "Nginx未使用新版HTTP/2语法");
assert(!nginx.includes("listen 443 ssl http2;"), "Nginx仍包含旧HTTP/2语法");
assert(!nginx.includes("proxy_set_header Origin"), "Nginx不应覆盖浏览器Origin，否则同源检查失效");
assert(
  nginx.includes("location ^~ /admin/comments/"),
  "段评后台代理必须使用^~，避免admin.js/admin.css被静态资源正则截获",
);
const params = read("config/_default/params.toml");
assert(/searchMaxChars\s*=\s*120000/.test(params), "长文搜索上限未更新");
const generated = read("themes/lidaiji/layouts/index.json.json");
assert(generated.includes("searchMaxChars"), "搜索索引未使用集中配置");
const siteCss = read("themes/lidaiji/assets/css/site.css");
assert(
  /\.article-content\s*>\s*p:not\(\.text-center\):not\(\.text-mark\)\s*\{[^}]*text-indent:\s*2em;/s.test(siteCss),
  "中文文章普通正文段落没有统一设置两字首行缩进",
);
const serverPublish = read("scripts/server-publish.sh");
assert(serverPublish.includes('chmod -R a+rX "$RELEASE"'), "服务器发布未修正静态release读取权限");
assert(serverPublish.includes('[[ -L "$ROOT/current" && -e "$ROOT/current" ]]'), "首次发布仍可能把不存在的current当作旧release");
assert(!serverPublish.includes("tar -tzf \"$RELEASE_ARCHIVE\" | grep -q"), "发布包校验仍存在pipefail/SIGPIPE风险");
assert(serverPublish.includes("umask 077"), "服务器发布未固定私有文件掩码");
assert(serverPublish.includes('chmod 0600 "$COMMENTS_DB_BACKUP"'), "发布前评论数据库备份未固定0600权限");
const serverRollback = read("scripts/server-rollback.sh");
assert(serverRollback.includes("umask 077"), "服务器回滚未固定私有文件掩码");
assert(serverRollback.includes('chmod 0600 "$ROLLBACK_BACKUP"'), "回滚前评论数据库备份未固定0600权限");
assert(read("scripts/comments-backup.sh").includes("umask 077"), "评论备份未固定私有文件掩码");
assert(read("VERSION").trim() === "0.4.2", "公开网站版本不是0.4.2");
assert(JSON.parse(read("package.json")).version === "0.2.0", "平台发行版本不是0.2.0");
assert(read("PLATFORM_VERSION").trim() === "0.2.0", "PLATFORM_VERSION不是0.2.0");
// Studio 版本单一来源：package.json 的 studioVersion；其余展示位置必须一致
const studioVersion = JSON.parse(read("package.json")).studioVersion;
assert(/^\d+\.\d+\.\d+$/.test(studioVersion), "package.json.studioVersion 格式不正确");
assert(read("studio/static/index.html").includes(`工作台 v${studioVersion}`), "Studio页面版本与 studioVersion 不一致");
assert(read("README.md").includes(`studio v${studioVersion}`), "README组件版本与 studioVersion 不一致");
assert(read("scripts/macos/common.sh").includes(`STUDIO_APP_VERSION="${studioVersion}"`), "macOS应用版本与 studioVersion 不一致");
assert(JSON.parse(read("comments-service/package.json")).version === "0.4.0", "评论服务应保持0.4.0");
const studioNotes = read("studio/app/notes.mjs");
assert(studioNotes.includes("decoratePreviewNotes"), "Studio编辑预览缺少段落作者评入口");
assert(studioNotes.includes('p[data-paragraph-id]'), "Studio没有按稳定段落ID绑定作者评入口");
assert(
  studioNotes.includes('save("draft")') && studioNotes.includes('save("published")'),
  "段落旁作者评不能分别保存草稿和发布",
);
for (const file of [
  "comments-service/src/server.js",
  "comments-service/src/app.js",
  "comments-service/migrations/001-initial.sql",
  "deploy/systemd/lidaiji-comments.service",
  "deploy/nginx/comments-locations.conf.template",
  "scripts/comments-backup.sh",
  "scripts/comments-restore.sh",
  "scripts/comments-export.sh",
  "scripts/build-comment-manifest.mjs",
]) assert(fs.existsSync(file), `缺少段评系统文件：${file}`);
assert(!fs.existsSync("comments-service/.env"), "源码中存在评论服务.env");
assert(!fs.existsSync("comments-service/data"), "源码中存在评论数据库目录");
const commentsApp = read("comments-service/src/app.js");
assert(commentsApp.includes("status = honeypot ? \"spam\" : \"pending\""), "游客段评不再保证默认待审核");
assert(!commentsApp.includes("innerHTML"), "评论服务代码不应通过innerHTML渲染用户内容");
const commentsAdminHtml = read("comments-service/admin/index.html");
assert(
  /admin\.js\?v=\d+/.test(commentsAdminHtml) && /admin\.css\?v=\d+/.test(commentsAdminHtml),
  "段评后台资源缺少缓存版本参数",
);
for (const file of [
  "importer/docx-importer.py",
  "importer/docx-assistant.py",
  "importer/requirements.txt",
  "incoming/README.md",
  "scripts/import-docx.sh",
  "scripts/check-importer.sh",
  "scripts/check-word-content.sh",
  "scripts/writing-menu.sh",
  "scripts/install-desktop-shortcuts.sh",
  "scripts/publish-summary.py",
  "docs/Word写作流程.md",
  "docs/Word写作规范.md",
]) {
  assert(fs.existsSync(file), `缺少Word工作流文件：${file}`);
}
for (const file of [
  "importer/docx-importer.py",
  "importer/docx-assistant.py",
  "scripts/import-docx.sh",
  "scripts/check-importer.sh",
  "scripts/check-word-content.sh",
  "scripts/writing-menu.sh",
  "scripts/install-desktop-shortcuts.sh",
  "scripts/publish-summary.py",
]) {
  if (fs.existsSync(file)) assert((fs.statSync(file).mode & 0o111) !== 0, `${file}没有执行权限`);
}
const requirements = read("importer/requirements.txt");
for (const dependency of ["python-docx", "Pillow", "PyYAML", "pypinyin", "markdown-it-py"]) {
  assert(requirements.includes(dependency), `Word导入器缺少依赖：${dependency}`);
}
for (const file of [
  "studio/__init__.py",
  "studio/__main__.py",
  "studio/server.py",
  "studio/articles.py",
  "studio/preview_render.py",
  "studio/versions.py",
  "studio/publish_center.py",
  "studio/media.py",
  "studio/static/index.html",
  "studio/static/app-bundle.js",
  "studio/static/style.css",
  "scripts/start-studio.sh",
  "scripts/check-studio.sh",
  "tests/test_studio.py",
  "tests/test_studio_articles.py",
  "tests/test_studio_versions.py",
  "tests/test_studio_media.py",
  "tests/test_studio_feedback.py",
  "tests/test_studio_notes.py",
  "studio/feedback.py",
  "studio/notes.py",
  "docs/作者工作台.md",
]) {
  assert(fs.existsSync(file), `缺少作者工作台文件：${file}`);
}
for (const file of ["scripts/start-studio.sh", "scripts/check-studio.sh"]) {
  if (fs.existsSync(file)) assert((fs.statSync(file).mode & 0o111) !== 0, `${file}没有执行权限`);
}
const studioServer = read("studio/server.py");
assert(studioServer.includes('"127.0.0.1"'), "作者工作台必须只绑定127.0.0.1");
assert(!studioServer.includes('"0.0.0.0"') && !studioServer.includes("'0.0.0.0'"), "作者工作台不得绑定0.0.0.0");
const pkg = JSON.parse(read("package.json"));
assert(pkg.scripts && pkg.scripts.studio === "node scripts/run-studio.mjs", "package.json缺少studio启动脚本");
for (const name of ["studio:open", "studio:status", "studio:stop", "studio:restart", "studio:install", "studio:uninstall"]) {
  assert(pkg.scripts && pkg.scripts[name], `package.json缺少${name}命令`);
}
assert(backup.includes("studio"), "源码备份未包含作者工作台目录");
const publish = read("scripts/publish.sh");
assert(publish.includes('create-source-package.sh" "$SOURCE_ARCHIVE" site'), "发布未使用Git源码包生成器");
assert(
  publish.includes('COPYFILE_DISABLE=1 tar --no-xattrs -czf "$RELEASE_ARCHIVE"'),
  "macOS静态发布包未禁止AppleDouble与扩展属性条目",
);
const attributes = read(".gitattributes");
assert(attributes.includes("**/*.docx export-ignore"), "发布源码包未从Git导出层排除Word原稿");
assert(attributes.includes("/.venv-importer export-ignore"), "发布源码包未排除导入器虚拟环境");
assert(backup.includes("importer incoming"), "源码备份未包含导入器与Word来稿箱");
const importShell = read("scripts/import-docx.sh");
assert(importShell.includes('-r "$ROOT/importer/requirements.txt" >&2'), "首次安装依赖的输出会污染Python路径");
assert(importShell.includes("docx-assistant.py"), "Word快速导入未使用自动识别助手");
assert(importShell.includes("Lidaiji文稿备份"), "重新导入未配置永久旧稿备份");
assert(publish.includes("publish-summary.py"), "正式发布前未显示文章变更摘要");

// 作者批注（author-notes）主题契约
const authorNotesPartial = "themes/lidaiji/layouts/partials/author-notes.html";
assert(fs.existsSync(authorNotesPartial), "缺少作者批注 partial：author-notes.html");
const singleLayout = read("themes/lidaiji/layouts/_default/single.html");
const partialRefs = singleLayout.match(/\{\{\s*partial "author-notes\.html"/g) || [];
assert(partialRefs.length === 1, "single.html 应含且仅含一处 author-notes.html partial 引用");
if (fs.existsSync(authorNotesPartial)) {
  const partial = read(authorNotesPartial);
  assert(!/https?:\/\//.test(partial), "author-notes.html 不应引用任何外部资源");
  assert(partial.includes('status "published"') || partial.includes('"published"'), "author-notes.html 必须过滤 published 状态");
  assert(!partial.includes("innerHTML"), "author-notes.html 不应通过 innerHTML 渲染批注内容");
  assert(partial.includes('hugo.Data "author-notes"'), "author-notes.html 必须从非公开data目录读取批注");
  assert(partial.includes('resources.Get "js/author-notes.js"'), "作者段评增强脚本必须走Hugo资源管线");
  assert(!/<script(?![^>]+src=)/.test(partial), "author-notes.html 不得包含内联脚本");
}
assert(
  !read("scripts/build.sh").includes('-name "author-notes.yaml" -delete'),
  "作者评必须从源头隔离，不应依赖构建后find删除",
);
const authorNotesJs = read("themes/lidaiji/assets/js/author-notes.js");
assert(!authorNotesJs.includes("innerHTML"), "作者评脚本不得使用innerHTML");
assert(
  read("tests/check-site.mjs").includes("author-notes.yaml"),
  "check-site.mjs 必须断言产物不含 author-notes.yaml",
);

// macOS 作者工作台（LaunchAgent + .app + 启动器脚本）
const macosScripts = [
  "common.sh",
  "start-studio.sh",
  "stop-studio.sh",
  "restart-studio.sh",
  "status-studio.sh",
  "open-studio.sh",
  "install-launch-agent.sh",
  "uninstall-launch-agent.sh",
  "install-app.sh",
  "rotate-logs.sh",
];
for (const file of macosScripts) {
  const path = `scripts/macos/${file}`;
  assert(fs.existsSync(path), `缺少macOS工作台脚本：${path}`);
  assert((fs.statSync(path).mode & 0o111) !== 0, `${path}没有执行权限`);
  const content = read(path);
  assert(!/\/Users\/|\/mnt\/data\//.test(content), `${path}包含本机绝对路径`);
}
for (const file of [
  "scripts/macos/launcher.applescript",
  "scripts/macos/icon.py",
  "packaging/macos/cn.lidaiji.studio.plist.template",
]) {
  assert(fs.existsSync(file), `缺少macOS工作台文件：${file}`);
  if (fs.existsSync(file)) {
    assert(!/\/Users\/|\/mnt\/data\//.test(read(file)), `${file}包含本机绝对路径`);
  }
}
// check-macos-studio.sh 自身包含“/Users/”扫描模式，只断言存在与执行权限
assert(fs.existsSync("scripts/check-macos-studio.sh"), "缺少check-macos-studio.sh");
assert((fs.statSync("scripts/check-macos-studio.sh").mode & 0o111) !== 0, "check-macos-studio.sh没有执行权限");
const plistTemplate = read("packaging/macos/cn.lidaiji.studio.plist.template");
assert(
  plistTemplate.includes("__PROJECT_ROOT__") && plistTemplate.includes("__LOG_DIR__") && plistTemplate.includes("__PATH_VALUE__"),
  "plist模板缺少占位符",
);
assert(!fs.existsSync("scripts/macos/cn.lidaiji.studio.plist"), "本机生成的plist不能进入仓库");
assert(!fs.existsSync("scripts/macos/install.json"), "本机安装配置不能进入仓库");

// 正文所见即所得编辑器（ProseMirror 前端包 + 纯函数 Markdown 引擎）
for (const file of [
  "studio/editor/markdown.mjs",
  "studio/editor/editor.mjs",
  "studio/static/vendor/prosemirror-bundle.js",
  "scripts/build-editor-bundle.mjs",
  "scripts/check-editor-bundle.sh",
  "tests/check-editor-markdown.mjs",
  "tests/check-editor-format.mjs",
]) {
  assert(fs.existsSync(file), `缺少编辑器文件：${file}`);
}
const editorBundle = read("studio/static/vendor/prosemirror-bundle.js");
assert(editorBundle.length > 100000, "编辑器前端包过小");
assert(editorBundle.includes("createStudioEditor"), "编辑器前端包缺少编辑器入口");
assert(!/\/Users\/[^ ]*/.test(editorBundle), "编辑器前端包包含本机绝对路径");
const editorHtml = read("studio/static/index.html");
assert(editorHtml.includes('id="editorHost"'), "编辑页缺少编辑区容器");
assert(editorHtml.includes("/vendor/prosemirror-bundle.js"), "编辑页未引入编辑器前端包");
assert(!editorHtml.includes('id="editorBody"'), "编辑页不应再使用 textarea 编辑器");
const editorApp = read("studio/app/editor-page.mjs");
assert(editorApp.includes("LidaijiEditor.createStudioEditor"), "app 未接入所见即所得编辑器");
assert(editorApp.includes("replaceDocKeepCursor"), "app 缺少保存后光标保持");
assert(editorApp.includes("AUTOSAVE_DELAY"), "app 缺少自动保存");
assert(editorApp.includes("localStorage"), "app 缺少本地草稿机制");
assert(editorApp.includes('setAlignment("left")'), "app 缺少左对齐按钮接线");
assert(editorApp.includes("togglePoetry"), "app 缺少诗歌块接线");
assert(editorApp.includes("toggleEndnote"), "app 缺少尾注块接线");
const editorHtml2 = read("studio/static/index.html");
for (const id of ["tbAlignLeft", "tbAlignCenter", "tbAlignRight", "tbPoetry", "tbEndnote"]) {
  assert(editorHtml2.includes(`id="${id}"`), `工具栏缺少按钮：${id}`);
}
const markdownEngine = read("studio/editor/markdown.mjs");
assert(markdownEngine.includes("SHORTCODE_OPEN"), "Markdown 引擎缺少短代码解析");
assert(markdownEngine.includes("poetry_block"), "Markdown 引擎缺少诗歌块");
assert(markdownEngine.includes("endnote_block"), "Markdown 引擎缺少尾注块");
assert(read("studio/preview_render.py").includes("shortcode_block_rule"), "预览渲染器缺少短代码支持");
for (const file of [
  "themes/lidaiji/layouts/shortcodes/align.html",
  "themes/lidaiji/layouts/shortcodes/poetry.html",
  "themes/lidaiji/layouts/shortcodes/endnote.html",
]) {
  assert(fs.existsSync(file), `缺少短代码模板：${file}`);
}
const appBundle = read("studio/static/app-bundle.js");
assert(appBundle.length > 50000, "工作台前端包过小");
assert(!/\/Users\/[^ ]*/.test(appBundle), "工作台前端包包含本机绝对路径");
const editorPkg = JSON.parse(read("package.json"));
assert(editorPkg.scripts && editorPkg.scripts["build:editor"], "package.json缺少build:editor命令");
assert(editorPkg.scripts && editorPkg.scripts["build:app"], "package.json缺少build:app命令");
assert(editorPkg.devDependencies && editorPkg.devDependencies.esbuild, "缺少esbuild开发依赖");
assert(editorPkg.devDependencies && editorPkg.devDependencies["prosemirror-model"], "缺少prosemirror-model依赖");
assert(read(".gitignore").includes("node_modules/"), ".gitignore缺少node_modules条目");

// Windows 正式支持：PowerShell 脚本、跨平台 npm 入口、文档与 CI
for (const file of [
  "scripts/windows/common.ps1",
  "scripts/windows/setup.ps1",
  "scripts/windows/start-studio.ps1",
  "scripts/windows/stop-studio.ps1",
  "scripts/windows/restart-studio.ps1",
  "scripts/windows/status-studio.ps1",
  "scripts/windows/open-studio.ps1",
  "scripts/windows/install-startup-task.ps1",
  "scripts/windows/uninstall-startup-task.ps1",
  "scripts/windows/create-shortcut.ps1",
  "scripts/run-studio.mjs",
  "scripts/run-studio-tool.mjs",
  "scripts/run-check.mjs",
  "scripts/run-build.mjs",
  "scripts/run-dev.mjs",
  "scripts/run-package.mjs",
  "scripts/run-publish.mjs",
  "scripts/run-comments.mjs",
  "scripts/cross-platform/common.mjs",
  "scripts/cross-platform/build.mjs",
  "scripts/cross-platform/check.mjs",
  "docs/windows.md",
]) {
  assert(fs.existsSync(file), `缺少Windows/跨平台文件：${file}`);
}
const pkgScripts = JSON.parse(read("package.json")).scripts;
for (const [name, command] of Object.entries({
  studio: "node scripts/run-studio.mjs",
  check: "node scripts/run-check.mjs",
  build: "node scripts/run-build.mjs",
  dev: "node scripts/run-dev.mjs",
  package: "node scripts/run-package.mjs",
  "comments:init": "node scripts/run-comments.mjs",
})) {
  assert(pkgScripts[name] === command, `npm script ${name} 未跨平台化：${pkgScripts[name]}`);
}
const readme = read("README.md");
assert(readme.includes("不需要 Mac"), "README 缺少跨平台表述");
assert(readme.includes("平台支持") && readme.includes("Windows"), "README 缺少平台支持表");
assert(read("docs/deployment.md").includes("Windows 作者电脑 + Linux 服务器"), "部署文档缺少 Windows 方案");
assert(read(".github/workflows/ci.yml").includes("windows-latest"), "CI 缺少 windows-latest job");
assert(read(".github/workflows/ci.yml").includes("ubuntu-latest"), "CI 缺少 ubuntu-latest job");
assert(
  read("scripts/windows/setup.ps1").includes("-CheckOnly"),
  "setup.ps1 缺少只读预检模式",
);
assert(
  !/Stop-Process -Name node\b|taskkill \/IM node\.exe \/F/i.test(read("scripts/windows/stop-studio.ps1")),
  "stop-studio.ps1 不得误杀全部 Node 进程",
);

if (failures.length) {
  console.error(`源码检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("源码与维护脚本检查通过。");
