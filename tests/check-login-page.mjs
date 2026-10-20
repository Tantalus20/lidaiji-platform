import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// 登录页与评论登录门禁契约：
// 阅读公开，只有发评论需要 CQNB 登录；登录/注册走本站同源反代；
// 登录后评论直接公开，昵称来自账号；不得再出现“游客待审”旧文案。

const root = path.resolve(process.argv[2] || path.join(new URL("..", import.meta.url).pathname));
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const loginContent = read("content/login/_index.md");
assert(/layout:\s*"?auth"?/.test(loginContent), "登录页 front matter 必须使用 auth 布局");
assert(/url:\s*"?\/login\/"?/.test(loginContent), "登录页必须发布在 /login/");

const authLayout = read("themes/lidaiji/layouts/auth.html");
assert(authLayout.includes('data-auth-page'), "登录页缺少 data-auth-page 根节点");
assert(authLayout.includes('data-auth-tab="login"') && authLayout.includes('data-auth-tab="register"'),
  "登录页必须同时提供登录与注册页签");
assert(authLayout.includes('data-auth-form="login"') && authLayout.includes('data-auth-form="register"'),
  "登录页必须同时提供登录与注册表单");
assert(authLayout.includes('name="displayName"'), "注册表单必须允许填写显示名称");
assert(authLayout.includes('data-auth-return'), "登录页必须提供站内回跳链接");

const head = read("themes/lidaiji/layouts/partials/head.html");
assert(head.includes('resources.Get "js/account.js"'), "全站必须加载账号状态脚本 account.js");
assert(/eq \.Section "login"/.test(head) && /resources.Get "js\/auth\.js"/.test(head),
  "登录页必须加载 auth.js");

const accountJs = read("themes/lidaiji/assets/js/account.js");
assert(accountJs.includes('"/api/auth/session"'), "账号脚本必须检查 /api/auth/session");
assert(accountJs.includes('link.href = `/login/?return='), "未登录入口必须指向本站 /login/");
assert(accountJs.includes('"/api/auth/logout"'), "账号脚本必须提供退出接口");
assert(!/nsdynastygame\.cn/.test(accountJs), "账号脚本不得跳转到外站登录页");
assert(!/headers:\s*\{[^}]*Origin/.test(accountJs), "账号脚本不得手动设置浏览器禁止的 Origin 头");

const authJs = read("themes/lidaiji/assets/js/auth.js");
for (const endpoint of ["/api/auth/login", "/api/auth/register", "/api/auth/session"]) {
  assert(authJs.includes(endpoint), `登录脚本缺少 ${endpoint}`);
}
assert(!/nsdynastygame\.cn/.test(authJs), "登录脚本不得跳转到外站登录页");
assert(!/headers:\s*\{[^}]*Origin/.test(authJs), "登录脚本不得手动设置浏览器禁止的 Origin 头");
assert(/notLogin/.test(authJs) && /\\\/login/.test(authJs), "登录回跳必须拒绝 /login 自身，避免循环");

const commentsJs = read("themes/lidaiji/assets/js/comments.js");
const articleCommentsJs = read("themes/lidaiji/assets/js/article-comments.js");
for (const [name, source] of [["段评", commentsJs], ["章评", articleCommentsJs]]) {
  assert(source.includes('"/api/auth/session"'), `${name}脚本必须先校验登录会话`);
  assert(source.includes("`/login/?return="), `${name}脚本的登录引导必须指向本站 /login/`);
  assert(!/nsdynastygame\.cn/.test(source), `${name}脚本不得跳转到外站登录页`);
}

const single = read("themes/lidaiji/layouts/_default/single.html");
assert(single.includes("已通过澄清南北身份验证"), "评论表单必须说明身份来自澄清南北");
assert(single.includes("登录评论提交后直接公开"), "评论表单必须说明登录评论直接公开");
assert(single.includes("data-comments-name-input") && single.includes("data-ac-name-input"),
  "段评/章评昵称必须由账号身份填充");
assert(!/等待审核|未经身份核验/.test(single), "评论模板不得保留旧“等待审核/未经身份核验”文案");

const nginx = read("deploy/nginx/writing-site.conf.template");
assert(nginx.includes("location ^~ /api/auth/"), "Nginx 模板缺少 /api/auth/ 同源反代");
assert(nginx.includes("location ^~ /api/account"), "Nginx 模板缺少 /api/account 同源反代");
assert(!nginx.includes("proxy_set_header Origin"), "Nginx 不得覆盖浏览器 Origin（同源校验依赖原始值）");

const envExample = read(".env.example");
assert(/COMMENTS_PUBLIC_ORIGIN=.*,/.test(envExample), "环境模板必须展示多域名 Origin 逗号分隔示例");

if (failures.length) {
  console.error(`登录页契约检查失败（${failures.length}项）：`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("登录页契约检查通过：阅读公开、评论前登录、同源回跳、登录评论直接公开。");
