import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.env.PROJECT_ROOT || ".");
const contentRoot = path.join(root, "content");
const warningLimit = 5 * 1024 * 1024;
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".svg"]);
const failures = [];
const warnings = [];
let checked = 0;

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(contentRoot);
for (const file of files.filter((item) => imageExtensions.has(path.extname(item).toLowerCase()))) {
  checked += 1;
  const size = fs.statSync(file).size;
  if (size > warningLimit) warnings.push(`图片超过5MB：${path.relative(root, file)}（${(size / 1024 / 1024).toFixed(1)}MB）`);
  const head = fs.readFileSync(file).subarray(0, 16);
  const ext = path.extname(file).toLowerCase();
  const valid =
    (ext === ".png" && head.subarray(1, 4).toString() === "PNG") ||
    ((ext === ".jpg" || ext === ".jpeg") && head[0] === 0xff && head[1] === 0xd8) ||
    (ext === ".webp" && head.subarray(0, 4).toString() === "RIFF" && head.subarray(8, 12).toString() === "WEBP") ||
    (ext === ".avif" && head.subarray(4, 12).toString().includes("ftyp")) ||
    (ext === ".gif" && head.subarray(0, 3).toString() === "GIF") ||
    ext === ".svg";
  if (!valid) warnings.push(`图片扩展名与内容可能不一致：${path.relative(root, file)}`);
}

const markdownImage = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
for (const file of files.filter((item) => item.endsWith(".md"))) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(markdownImage)) {
    const reference = match[1].replace(/^<|>$/g, "");
    if (/^(?:https?:|data:|\/)/i.test(reference)) continue;
    const decoded = decodeURIComponent(reference.split("#")[0].split("?")[0]);
    const target = path.resolve(path.dirname(file), decoded);
    if (!target.startsWith(contentRoot + path.sep) || !fs.existsSync(target)) {
      failures.push(`${path.relative(root, file)} 引用了不存在的图片：${reference}`);
    }
  }
}

warnings.forEach((message) => console.warn(`警告：${message}`));
if (failures.length) {
  failures.forEach((message) => console.error(`错误：${message}`));
  process.exit(1);
}
console.log(`图片检查通过：${checked}个图片文件，${warnings.length}项非阻断警告。`);
