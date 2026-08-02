import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "content/works/demo-collection/long-reading-test/index.md");
const hugeTarget = path.join(root, "content/works/demo-collection/long-novel-test/index.md");
const paragraph = "这是用于检验三万字中文长文排版的占位段落，不是作者真实作品。长篇阅读需要稳定的正文宽度、从容的行距、清楚的章节层级和可随时定位的目录，也需要在手机屏幕上保持自然换行。页面不会把完整段落切成碎片，不会依赖远程字体，更不会因为关闭脚本而失去正文。";
const sections = [];
for (let section = 1; section <= 12; section += 1) {
  sections.push(`## 第${section}章　演示章节\n`);
  sections.push(`> 本章用于观察长文滚动、目录定位与阅读进度。\n`);
  sections.push(`### 第${section}章小节\n`);
  if (section === 1) sections.push("开篇检索标记：青简初展。\n");
  if (section === 6) sections.push("中段检索标记：长河半渡。\n");
  if (section === 12) sections.push("末尾检索标记：卷帙将终。\n");
  for (let index = 0; index < 30; index += 1) {
    sections.push(`${paragraph}第${section}章第${index + 1}段在此继续，用以形成足够长但含义明确的测试文本。\n`);
  }
  if (section === 2) {
    sections.push("![演示用抽象封面](demo-long.png \"仅用于验证长文图片和说明\")\n");
    sections.push("| 项目 | 验证目标 |\n| --- | --- |\n| 目录 | 多级标题可定位 |\n| 图片 | 响应式且不溢出 |\n| 表格 | 手机端可阅读 |\n");
  }
  if (section === 3) sections.push("本段含有脚注，用于验证长文章中的注释排版。[^note]\n");
}

const frontMatter = `---
title: "第三篇：三万字长文压力测试"
subtitle: "重复占位文本，仅用于验证阅读体验"
date: 2026-05-20
lastmod: 2026-07-28
slug: "long-reading-test"
description: "一篇超过三万汉字的演示长文，用于验证目录、滚动、手机排版和无脚本阅读。"
draft: false
featured: false
weight: 30
collections: ["示例文集"]
categories: ["演示"]
tags: ["三万字", "压力测试"]
series: ["示例文集"]
period: ["演示时期"]
people: []
places: []
aliases: []
demo: true
---

本篇全文均为重复的占位中文段落，不是作者作品，也不描述任何真实人物或事件。

`;

fs.mkdirSync(path.dirname(target), { recursive: true });
const collectionIndex = path.join(root, "content/works/demo-collection/_index.md");
if (!fs.existsSync(collectionIndex)) {
  fs.writeFileSync(collectionIndex, `---
title: "示例文集"
description: "仅在临时自动测试目录生成，不进入作者正式内容。"
status: "测试"
---
`, "utf8");
}
fs.writeFileSync(target, frontMatter + sections.join("\n") + "\n[^note]: 长文测试脚注。\n", "utf8");
const size = fs.readFileSync(target, "utf8").length;
console.log(`三万字测试稿已生成：${size} 个字符。`);

const hugeSections = [];
for (let volume = 1; volume <= 20; volume += 1) {
  hugeSections.push(`## 第${volume}卷　十万字演示\n`);
  hugeSections.push(`> 这是第${volume}卷的压力测试提示，全部内容均为占位文本。\n`);
  for (let index = 0; index < 36; index += 1) {
    hugeSections.push(`${paragraph}第${volume}卷第${index + 1}段继续扩展，以模拟大型回忆录或长篇作品的真实页面长度与搜索负载。\n`);
  }
}
const hugeFrontMatter = `---
title: "第四篇：十万字大型作品压力测试"
subtitle: "纯占位测试文件，不含真实作品或人物"
date: 2026-06-01
lastmod: 2026-07-28
slug: "long-novel-test"
description: "超过十万字符的演示稿，用于验证大型作品构建、搜索和移动端阅读。"
draft: false
featured: false
weight: 40
collections: ["示例文集"]
categories: ["演示"]
tags: ["十万字", "压力测试"]
series: ["示例文集"]
period: ["演示时期"]
people: []
places: []
aliases: []
demo: true
---

本文件仅供自动压力测试，不是作者作品，不描述任何真实人物或事件。

`;
fs.mkdirSync(path.dirname(hugeTarget), { recursive: true });
fs.writeFileSync(hugeTarget, hugeFrontMatter + hugeSections.join("\n"), "utf8");
console.log(`十万字测试稿已生成：${fs.readFileSync(hugeTarget, "utf8").length} 个字符。`);
