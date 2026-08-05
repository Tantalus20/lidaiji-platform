import fs from "node:fs";
import path from "node:path";

// 品牌断言（v0.5.1）：构建完成后，公开产物不得残留与站点名不一致的演示品牌。
// 用法：node tests/check-brand.mjs <siteDir> [期望站点名]
// 若期望站点名等于演示默认值（示例文集），则只断言标题存在、不检查禁用词
// （演示模式的页面本就使用演示品牌）。私人模式构建时传入正式站点名，
// 此时禁用词（示例文集/Example/Demo/TODO）必须完全不存在。

const siteDir = path.resolve(process.argv[2] || "dist/site");
const expected = process.argv[3] || "历代纪";
const DEMO_TITLE = "示例文集";
const FORBIDDEN = ["示例文集", "Example", "Demo", "TODO"];
const checkForbidden = expected !== DEMO_TITLE;

const failures = [];
const warn = [];

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (/\.(html|xml)$/i.test(entry.name)) results.push(full);
  }
  return results;
}

if (!fs.existsSync(siteDir)) {
  console.error(`品牌断言失败：站点目录不存在 ${siteDir}`);
  process.exit(1);
}

const files = walk(siteDir);
let scanned = 0;
let indexHtml = "";

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  scanned += 1;
  const rel = path.relative(siteDir, file);
  if (rel === "index.html") indexHtml = text;
  if (checkForbidden) {
    for (const token of FORBIDDEN) {
      if (text.includes(token)) failures.push(`${rel} 包含演示品牌词“${token}”`);
    }
  }
}

if (!indexHtml) failures.push("缺少 index.html");
if (indexHtml && !indexHtml.includes(`<title>`)) failures.push("index.html 缺少 title");
if (indexHtml && !indexHtml.includes(expected)) failures.push(`index.html 不包含站点名“${expected}”`);

if (!fs.existsSync(path.join(siteDir, "index.xml"))) warn.push("缺少 RSS index.xml（未扫描）");
if (!fs.existsSync(path.join(siteDir, "sitemap.xml"))) warn.push("缺少 sitemap.xml（未扫描）");

if (failures.length) {
  console.error(`品牌断言失败（扫描 ${scanned} 个文件）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
for (const item of warn) console.warn(`品牌断言警告：${item}`);
console.log(`品牌断言通过：${scanned} 个页面，站点名为“${expected}”${checkForbidden ? "，无演示品牌残留" : "（演示模式，跳过禁用词检查）"}。`);
