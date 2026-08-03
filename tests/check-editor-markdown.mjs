/* 正文 Markdown 引擎自动测试（纯 Node，零第三方依赖，CI 可直接运行）。
 *
 * 覆盖：普通文字、中文加粗、中文斜体、中文粗斜体、部分格式、跨段落格式、
 * 取消加粗/斜体、锚点往返、标题/引用/列表/表格/图片、* 转义、
 * 段内换行、空文档、超长文本（5 万字以上、1000 段以上）往返与耗时。
 *
 * 若本机已安装根依赖（node_modules），还会追加 ProseMirror 层往返
 * 与光标偏移映射测试；CI 未装依赖时自动跳过该部分。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { parseMarkdown, serializeMarkdown } = await import(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "studio", "editor", "markdown.mjs")
);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`通过：${name}`);
  } catch (error) {
    failures += 1;
    console.error(`失败：${name}`);
    console.error(`  ${error.message}`);
  }
}

function roundtrip(markdown) {
  const doc = parseMarkdown(markdown);
  return { doc, out: serializeMarkdown(doc) };
}

function textOf(doc) {
  return (doc.content || [])
    .map((block) => (block.content || []).map((node) => node.text || "").join(""))
    .join("|");
}

/* 1. 普通文字 */
test("普通文字保存和重载", () => {
  const md = "第一段普通文字。\n\n第二段也普通。\n";
  assert.equal(roundtrip(md).out, md);
});

/* 2. 中文加粗 */
test("中文加粗往返并带 strong 语义", () => {
  const md = "第一段**加粗的中文**结束。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  const marked = doc.content[0].content.find((node) => node.marks);
  assert.equal(marked.text, "加粗的中文");
  assert.ok(marked.marks.includes("strong"));
});

/* 3. 中文斜体 */
test("中文斜体往返并带 em 语义", () => {
  const md = "第一段*斜体的中文*结束。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  const marked = doc.content[0].content.find((node) => node.marks);
  assert.equal(marked.text, "斜体的中文");
  assert.ok(marked.marks.includes("em"));
});

/* 4. 中文粗斜体 */
test("中文粗斜体往返并同时带 strong+em", () => {
  const md = "第一段***粗斜体的中文***结束。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  const marked = doc.content[0].content.find((node) => node.marks);
  assert.equal(marked.text, "粗斜体的中文");
  assert.ok(marked.marks.includes("strong") && marked.marks.includes("em"));
});

/* 5. 部分文字格式 */
test("段内部分文字格式（普通/粗/斜/粗斜混合）", () => {
  const md = "普通**加粗**普通*斜体*普通***粗斜***结尾。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  assert.equal(textOf(doc), "普通加粗普通斜体普通粗斜结尾。");
  const marks = doc.content[0].content.filter((node) => node.marks);
  assert.equal(marks.length, 3);
});

/* 6. 跨段落格式 */
test("跨段落格式与锚点同时往返", () => {
  const md = [
    "<!-- paragraph-id:p-100000000001 -->",
    "",
    "第一段**加粗**。",
    "",
    "<!-- paragraph-id:p-100000000002 -->",
    "",
    "第二段*斜体*。",
    "",
    "<!-- paragraph-id:p-100000000003 -->",
    "",
    "第三段***粗斜***。",
    "",
  ].join("\n");
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  assert.deepEqual(
    doc.content.map((block) => block.pid),
    ["p-100000000001", "p-100000000002", "p-100000000003"],
  );
});

/* 7. 取消加粗 */
test("取消加粗后序列化为普通文字", () => {
  const doc = parseMarkdown("**要取消的加粗**。\n");
  const node = doc.content[0].content.find((item) => item.marks);
  node.marks = node.marks.filter((mark) => mark !== "strong");
  const out = serializeMarkdown(doc);
  assert.equal(out, "要取消的加粗。\n");
});

/* 8. 取消斜体 */
test("取消斜体后序列化为普通文字", () => {
  const doc = parseMarkdown("*要取消的斜体*。\n");
  const node = doc.content[0].content.find((item) => item.marks);
  node.marks = node.marks.filter((mark) => mark !== "em");
  const out = serializeMarkdown(doc);
  assert.equal(out, "要取消的斜体。\n");
});

/* 9-14. 块级结构往返 */
test("标题/引用/列表/表格/图片往返", () => {
  const md = [
    "## 小标题",
    "",
    "> 引用第一行",
    "> 引用第二行",
    "",
    "- 无序一",
    "- 无序二",
    "",
    "1. 有序一",
    "1. 有序二",
    "",
    "| 甲 | 乙 |",
    "| --- | --- |",
    "| 1\\|1 | 2 |",
    "",
    "![虚构插图](images/image-001.webp)",
    "",
    "结尾段落。",
    "",
  ].join("\n");
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  assert.deepEqual(
    doc.content.map((block) => block.type),
    ["heading", "blockquote", "bullet_list", "ordered_list", "table", "image", "paragraph"],
  );
});

/* 15-16. 段内换行与转义 */
test("段内换行与 * 转义往返", () => {
  const md = "第一行\n第二行\n\n价格 5\\*3 与反斜杠 \\\\ 保留。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  const types = doc.content[0].content.map((node) => node.type);
  assert.ok(types.includes("hard_break"));
});

/* 17. 保存后重新打开（幂等） */
test("保存后重新打开保持格式（二次往返幂等）", () => {
  const md = "标题外**加粗**与*斜体*及***粗斜***。\n\n第二段普通。\n";
  const once = serializeMarkdown(parseMarkdown(md));
  const twice = serializeMarkdown(parseMarkdown(once));
  assert.equal(twice, once);
  assert.equal(twice, md);
});

/* 18. 空文档与纯空白 */
test("空文档与空白输入安全", () => {
  assert.equal(serializeMarkdown(parseMarkdown("")), "");
  assert.equal(serializeMarkdown(parseMarkdown("\n\n\n")), "");
  assert.equal(serializeMarkdown(parseMarkdown("   \n\t\n")), "");
});

/* 19. 代码围栏块零丢失往返 */
test("代码围栏块零丢失往返", () => {
  const md = "普通段落。\n\n```代码样式的文字\nx = 1\n```\n\n结尾。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  const block = doc.content.find((item) => item.type === "code_block");
  assert.equal(block.info, "代码样式的文字");
  assert.equal(block.text, "x = 1");
});

/* 20. 链接（含标题）往返 */
test("链接与带标题链接往返", () => {
  const md = "文字[链接文本](https://example.com)结束。\n\n另一条[带标题的链接](https://example.com \"标题\")。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  const links = [];
  for (const block of doc.content) {
    for (const node of block.content || []) {
      if (node.type === "link") links.push(node);
    }
  }
  assert.equal(links.length, 2);
  assert.equal(links[0].href, "https://example.com");
  assert.equal(links[1].title, "标题");
});

/* 21. _ 强调语义等价（解析为 em/strong，序列化统一为 *） */
test("_斜体_ 与 __加粗__ 语义等价", () => {
  const doc = parseMarkdown("_斜体_ 与 __加粗__ 并存。\n");
  const marked = doc.content[0].content.filter((node) => node.marks);
  assert.deepEqual(marked.map((node) => node.marks), [["em"], ["strong"]]);
  assert.equal(serializeMarkdown(doc), "*斜体* 与 **加粗** 并存。\n");
  const once = serializeMarkdown(parseMarkdown("_斜体_ 与 __加粗__ 并存。\n"));
  assert.equal(serializeMarkdown(parseMarkdown(once)), once, "_ 强调二次往返不稳定");
});

/* 22. 词内下划线保持字面（与 CommonMark 一致） */
test("词内下划线不参与强调", () => {
  const doc = parseMarkdown("中文_词内_下划线。\n");
  const marks = doc.content[0].content.filter((node) => node.marks);
  assert.equal(marks.length, 0);
  const once = serializeMarkdown(doc);
  const back = parseMarkdown(once);
  const text = back.content[0].content.map((node) => node.text || "").join("");
  assert.equal(text, "中文_词内_下划线。", "词内下划线的字面文本必须保留");
  assert.equal(serializeMarkdown(back), once, "词内下划线二次往返不稳定");
});

/* 23. 行内代码往返（含双反引号围栏） */
test("行内代码与反引号围栏往返", () => {
  const md = "行内`代码内容`保留。\n\n双反引号``a`b``围栏。\n";
  const { doc, out } = roundtrip(md);
  assert.equal(out, md);
  const codes = doc.content.flatMap((block) => (block.content || []).filter((node) => node.type === "code"));
  assert.equal(codes.length, 2);
  assert.equal(codes[0].text, "代码内容");
  assert.equal(codes[1].text, "a`b");
});

/* 24. 字面字符转义：链接/方括号/星号/下划线 */
test("字面 [ ] * _ 转义往返", () => {
  const source = "字面\\[括号](不是链接)和\\*星号\\*及\\_下划线\\_不是格式。\n";
  const doc = parseMarkdown(source);
  assert.equal(doc.content[0].content.filter((node) => node.marks).length, 0, "转义后的字符不应产生格式");
  const text = doc.content[0].content.map((node) => node.text || "").join("");
  assert.equal(text, "字面[括号](不是链接)和*星号*及_下划线_不是格式。");
  const once = serializeMarkdown(doc);
  const twice = serializeMarkdown(parseMarkdown(once));
  assert.equal(twice, once, "转义输出二次往返不稳定");
  // WYSIWYG 里以字面文本输入的“[x](y)”形态（非链接节点）必须转义，
  // 否则下次解析会把它变成链接
  const literalDoc = parseMarkdown("普通文字。\n");
  literalDoc.content[0].content = [{ type: "text", text: "字面[括号](不是链接)。" }];
  assert.equal(serializeMarkdown(literalDoc), "字面\\[括号](不是链接)。\n", "字面链接形态应被转义");
});

/* 25. 段落对齐：单段居中/右对齐/多段/恢复左对齐 */
test("单段居中、单段右对齐、多段对齐与恢复左对齐", () => {
  const center = roundtrip("{{< align center >}}\n\n题记内容\n\n{{< /align >}}\n");
  assert.equal(center.out, center.out && "{{< align center >}}\n\n题记内容\n\n{{< /align >}}\n");
  assert.equal(center.doc.content[0].align, "center");
  const right = roundtrip("{{< align right >}}\n\n写于二〇二六年八月\n\n{{< /align >}}\n");
  assert.equal(right.doc.content[0].align, "right");
  assert.equal(right.out, "{{< align right >}}\n\n写于二〇二六年八月\n\n{{< /align >}}\n");
  // 多段各包各的
  const multi = roundtrip(
    "{{< align center >}}\n\n段一\n\n{{< /align >}}\n\n{{< align center >}}\n\n段二\n\n{{< /align >}}\n",
  );
  assert.deepEqual(multi.doc.content.map((b) => b.align), ["center", "center"]);
  // 恢复左对齐：align 字段删除后不再有短代码
  const doc = parseMarkdown("{{< align center >}}\n\n题记\n\n{{< /align >}}\n");
  delete doc.content[0].align;
  assert.equal(serializeMarkdown(doc), "题记\n");
});

/* 26. 诗歌块与尾注块往返（多行、内部格式、组合） */
test("诗歌块与尾注块往返（多行/加粗斜体/组合）", () => {
  const poetry =
    "{{< poetry >}}\n\n山有木兮*木有枝*\n\n心悦君兮君不知\n\n{{< /poetry >}}\n";
  const { doc, out } = roundtrip(poetry);
  assert.equal(out, poetry);
  assert.equal(doc.content[0].type, "poetry_block");
  assert.equal(doc.content[0].content.length, 2);
  assert.equal(doc.content[0].content[0].content[1].marks[0], "em");
  const endnote =
    "{{< endnote >}}\n\n写于二〇二六年八月\n\n**君纪鉴**\n\n{{< /endnote >}}\n";
  const { doc: enDoc, out: enOut } = roundtrip(endnote);
  assert.equal(enOut, endnote);
  assert.equal(enDoc.content[0].type, "endnote_block");
  assert.equal(enDoc.content[0].content[1].content[0].marks[0], "strong");
  const combo =
    "{{< align center >}}\n\n**加粗**题记\n\n{{< /align >}}\n\n正文。\n\n{{< poetry >}}\n\n诗行一\n\n{{< /poetry >}}\n\n{{< endnote >}}\n\n尾注*日期*\n\n{{< /endnote >}}\n";
  assert.equal(roundtrip(combo).out, combo);
});

/* 27. 容器内锚点忽略 + 未闭合短代码零丢失 */
test("容器内锚点注释被忽略，未闭合短代码按文本保留", () => {
  const md =
    "{{< poetry >}}\n\n<!-- paragraph-id:p-100000000001 -->\n\n山有木兮\n\n{{< /poetry >}}\n";
  const doc = parseMarkdown(md);
  assert.equal(doc.content[0].type, "poetry_block");
  assert.equal(doc.content[0].content[0].pid, null, "容器内段落不得有锚点");
  const unclosed = "{{< align center >}}\n\n未闭合内容\n";
  const out = serializeMarkdown(parseMarkdown(unclosed));
  assert.ok(out.includes("{{< align center >}}"), "未闭合短代码应按文本保留");
  assert.ok(out.includes("未闭合内容"));
});

/* 20. 超长文本（5 万字以上、1000 段、含三种格式） */
function buildLongText() {
  const parts = [];
  for (let index = 1; index <= 1000; index += 1) {
    const mark = index % 3 === 0 ? "***" : index % 3 === 1 ? "**" : "*";
    const head = index % 50 === 0 ? `## 虚构小节 ${index}\n\n` : "";
    parts.push(
      `${head}虚构测试正文第 ${index} 段：${mark}晴空之下，海面与云层在远处相接${mark}，这一整段文字只用于验证编辑器在超长文本下的稳定性、往返一致性与处理速度，不含任何真实作品内容。`,
    );
  }
  return parts.join("\n\n") + "\n";
}

test("超长文本（5万字/1000段/粗斜混合）往返一致且快速", () => {
  const md = buildLongText();
  const cjk = (md.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
  const paragraphs = md.split("\n\n").filter((block) => block.trim()).length;
  assert.ok(cjk >= 50000, `测试文稿汉字不足 5 万（实际 ${cjk}）`);
  assert.ok(paragraphs >= 1000, `测试文稿段落不足 1000（实际 ${paragraphs}）`);
  const started = Date.now();
  const out = serializeMarkdown(parseMarkdown(md));
  const elapsed = Date.now() - started;
  assert.equal(out, md);
  assert.ok(elapsed < 3000, `往返耗时过长：${elapsed}ms`);
  console.log(`  （${cjk} 汉字 / ${paragraphs} 段，往返 ${elapsed}ms）`);
});

/* 21. 可选深测：ProseMirror 层（本机有 node_modules 时执行） */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.existsSync(path.join(root, "node_modules", "prosemirror-model"))) {
  const editor = await import(path.join(root, "studio", "editor", "editor.mjs"));

  test("ProseMirror 层 JSON↔节点往返", () => {
    const md = "第一段**加粗**。\n\n<!-- paragraph-id:p-abc123 -->\n\n第二段*斜体*。\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n";
    const doc = editor._internals.jsonToPm(parseMarkdown(md));
    const json = editor._internals.pmToJson(doc);
    assert.equal(serializeMarkdown(json), md);
    const paragraph = json.content.find((block) => block.pid);
    assert.equal(paragraph.pid, "p-abc123");
  });

  test("光标偏移映射（保存后不丢光标的基础）", () => {
    const md = buildLongText().slice(0, 4000);
    const doc = editor._internals.jsonToPm(parseMarkdown(md));
    const size = doc.content.size;
    for (const pos of [0, 10, Math.floor(size / 2), size - 5, size]) {
      const offset = editor._internals.textOffsetAt(doc, pos);
      const restored = editor._internals.positionForTextOffset(doc, offset);
      assert.equal(editor._internals.textOffsetAt(doc, restored), offset);
    }
  });

  test("快捷键表与插件集合可构建（防未定义标识符回归）", () => {
    const keymapSpec = editor._internals.editorKeymap();
    assert.ok(keymapSpec["Mod-z"], "缺少撤销快捷键 Mod-z");
    assert.ok(keymapSpec["Shift-Mod-z"], "缺少重做快捷键 Shift-Mod-z");
    assert.ok(keymapSpec["Mod-y"], "缺少重做快捷键 Mod-y");
    assert.ok(keymapSpec["Mod-b"], "缺少加粗快捷键 Mod-b");
    assert.ok(keymapSpec["Mod-i"], "缺少斜体快捷键 Mod-i");
    const plugins = editor._internals.buildEditorPlugins();
    assert.equal(plugins.length, 3);
  });

  test("对齐与诗歌/尾注容器命令（PM 层）", async () => {
    const { EditorState, TextSelection } = await import("prosemirror-state");
    const doc = editor._internals.jsonToPm(parseMarkdown("第一段。\n\n第二段。\n\n第三段。\n"));
    let st = EditorState.create({ schema: editor._internals.schema, plugins: editor._internals.buildEditorPlugins(), doc });
    const firstEnd = st.doc.content.child(0).nodeSize;
    const secondEnd = firstEnd + st.doc.content.child(1).nodeSize;
    // 选中前两段 → 居中
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 1, secondEnd - 1)));
    let dispatched = false;
    const ok = editor._internals.setAlignmentCommand(st, (tr) => { st = st.apply(tr); dispatched = true; }, "center");
    assert.ok(ok && dispatched, "居中命令未生效");
    assert.deepEqual(st.doc.content.content.map((n) => n.attrs.align), ["center", "center", null]);
    const serialized = serializeMarkdown(editor._internals.pmToJson(st.doc));
    assert.ok(serialized.includes("{{< align center >}}"), "对齐未序列化为短代码");
    // 恢复左对齐
    editor._internals.setAlignmentCommand(st, (tr) => { st = st.apply(tr); }, "left");
    assert.deepEqual(st.doc.content.content.map((n) => n.attrs.align), [null, null, null]);
    // 诗歌块 wrap → 再 toggle lift
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 1)));
    const wrapped = editor._internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "poetry_block");
    assert.ok(wrapped, "诗歌 wrap 未生效");
    assert.equal(st.doc.content.child(0).type.name, "poetry_block");
    const lifted = editor._internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "poetry_block");
    assert.ok(lifted, "诗歌 lift 未生效");
    assert.equal(st.doc.content.child(0).type.name, "paragraph");
    // 容器内退出回车：诗歌块末尾空段回车 → 普通段
    const poetryDoc = editor._internals.jsonToPm(parseMarkdown("{{< poetry >}}\n\n一行\n\n{{< /poetry >}}\n"));
    st = EditorState.create({ schema: editor._internals.schema, plugins: editor._internals.buildEditorPlugins(), doc: poetryDoc });
    st = st.apply(st.tr.insert(st.doc.content.size - 1, editor._internals.schema.nodes.paragraph.create()));
    st = st.apply(st.tr.setSelection(TextSelection.near(st.doc.resolve(st.doc.content.size - 2))));
    const enterOk = editor._internals.containerExitEnter(st, (tr) => { st = st.apply(tr); });
    assert.ok(enterOk, "容器退出回车未生效");
    assert.equal(st.doc.content.child(0).type.name, "paragraph", "退出后应为普通段落");
    assert.equal(st.doc.content.content.length, 2, "诗行保留 + 新普通段");
  });
} else {
  console.log("跳过：本机未安装根依赖（node_modules），ProseMirror 层深测未运行。");
}

if (failures) {
  console.error(`Markdown 引擎测试失败 ${failures} 项。`);
  process.exit(1);
}
console.log("Markdown 引擎自动测试通过。");
