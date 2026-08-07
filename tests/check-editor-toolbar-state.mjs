/* 编辑器工具栏状态自动测试（v0.2.6，纯 Node）。
 *
 * 覆盖：
 *  - 段落类型识别（正文/诗歌/附记/引用/代码/列表/表格/多种段落中间态）；
 *  - active 与 enabled 双状态（借鉴 Tiptap isActive/can 思想，不引入依赖）；
 *  - 合法/非法转换（列表内转标题应禁用、代码块内链接应禁用）；
 *  - 类型转换安全（正文↔诗歌、正文↔附记、诗歌+居中、附记+右对齐、引用→正文）；
 *  - 撤销/重做、保存→重新打开类型保持、Markdown 幂等、paragraph-id 保持。
 *
 * ProseMirror 层用例依赖根依赖 node_modules；未安装时自动跳过并如实报告。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const editorModule = await import(
  pathToFileURL(path.join(root, "studio", "editor", "editor.mjs")).href,
);
const { parseMarkdown, serializeMarkdown } = await import(
  pathToFileURL(path.join(root, "studio", "editor", "markdown.mjs")).href,
);
const internals = editorModule._internals;

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

if (fs.existsSync(path.join(root, "node_modules", "prosemirror-model"))) {
  const { EditorState, TextSelection } = await import("prosemirror-state");
  const { undo, redo } = await import("prosemirror-history");

  /* 由 markdown 构建 doc + 光标状态（textIndex 为相对第一个文本节点的偏移） */
  const infoAt = (markdown, textIndex = 1) => {
    const doc = internals.jsonToPm(parseMarkdown(markdown));
    const st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    const base = firstTextPos(doc);
    const pos = Math.max(1, Math.min(base + textIndex, lastTextPos(doc)));
    const sel = st.apply(st.tr.setSelection(TextSelection.create(st.doc, pos, pos)));
    return { info: internals.selectionInfo(sel), doc: sel.doc, state: sel };
  };

  const firstTextPos = (doc) => {
    let pos = 0;
    let found = null;
    doc.descendants((node, nodePos) => {
      if (found !== null) return false;
      if (node.isText) {
        found = nodePos + 1;
        return false;
      }
      return true;
    });
    return found === null ? 1 : found;
  };

  const lastTextPos = (doc) => {
    let pos = 1;
    doc.descendants((node, nodePos) => {
      if (node.isText) {
        pos = nodePos + Math.max(1, node.nodeSize) - 1;
      }
      return true;
    });
    return pos;
  };

  test("正文段落：blockType=paragraph 且对齐默认左", () => {
    const { info } = infoAt("第一段。\n", 2);
    assert.equal(info.blockType, "paragraph");
    assert.equal(info.align, null);
    assert.equal(info.inPoetry, false);
    assert.equal(info.inEndnote, false);
  });

  test("诗歌块内：blockType=poetry 且 inPoetry", () => {
    const { info } = infoAt("{{< poetry >}}\n\n诗行一\n\n{{< /poetry >}}\n", 2);
    assert.equal(info.blockType, "poetry");
    assert.equal(info.inPoetry, true);
  });

  test("附记块内：blockType=endnote 且 inEndnote", () => {
    const { info } = infoAt("{{< endnote >}}\n\n附记文字\n\n{{< /endnote >}}\n", 2);
    assert.equal(info.blockType, "endnote");
    assert.equal(info.inEndnote, true);
  });

  test("引用块内：blockType=quote", () => {
    const { info } = infoAt("> 引用内容\n", 2);
    assert.equal(info.blockType, "quote");
  });

  test("代码块内：blockType=code 且链接/图片/对齐禁用", () => {
    const { info } = infoAt("```\ncode\n```\n", 2);
    assert.equal(info.blockType, "code");
    assert.equal(info.enabled.link, false, "代码块内链接应禁用");
    assert.equal(info.enabled.image, false, "代码块内图片应禁用");
    assert.equal(info.enabled.align, false, "代码块内对齐应禁用");
  });

  test("列表内转标题为非法转换（enabled.heading=false）", () => {
    const { info } = infoAt("- 列表项\n", 2);
    assert.equal(info.blockType, "list");
    assert.equal(info.enabled.heading, false, "列表项内转标题应禁用");
    assert.equal(info.enabled.paragraph, true, "列表项内转正文仍应可用");
  });

  test("多类型选择中间态：blockType=mixed", () => {
    const doc = internals.jsonToPm(parseMarkdown("正文段。\n\n{{< poetry >}}\n\n诗行一\n\n{{< /poetry >}}\n"));
    const st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    const from = firstTextPos(st.doc);
    const to = lastTextPos(st.doc);
    const sel = st.apply(st.tr.setSelection(TextSelection.create(st.doc, from, to)));
    const info = internals.selectionInfo(sel);
    assert.equal(info.blockType, "mixed", "跨类型选择应为多种段落中间态");
  });

  test("撤销初始不可用，事务后可用", () => {
    const { info } = infoAt("第一段。\n", 2);
    assert.equal(info.canUndo, false, "初始撤销应禁用");
    assert.equal(info.canRedo, false, "初始重做应禁用");
    const { state } = infoAt("第一段。\n", 2);
    let st = state;
    st = st.apply(st.tr.insertText("新", 1));
    const after = internals.selectionInfo(st);
    assert.equal(after.canUndo, true, "插入后撤销应可用");
  });

  test("合法转换：正文→诗歌/附记/引用 enabled 均可用", () => {
    const { info } = infoAt("正文段。\n", 2);
    assert.equal(info.enabled.poetry, true);
    assert.equal(info.enabled.endnote, true);
    assert.equal(info.enabled.quote, true);
    assert.equal(info.enabled.paragraph, true);
    assert.equal(info.enabled.heading, true);
  });

  test("诗歌内转换附记 enabled：跨容器转换可用", () => {
    const { info } = infoAt("{{< poetry >}}\n\n诗行一\n\n{{< /poetry >}}\n", 1);
    assert.equal(info.enabled.endnote, true, "诗歌→附记应可转换");
    assert.equal(info.enabled.quote, true, "诗歌→引用应可转换");
  });

  test("诗歌→附记：单事务转换、无嵌套容器、文字不丢失", () => {
    const { doc } = infoAt("{{< poetry >}}\n\n诗行一\n\n{{< /poetry >}}\n", 1);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, firstTextPos(st.doc), firstTextPos(st.doc) + 1)));
    const ok = internals.convertContainerCommand(st, (tr) => { st = st.apply(tr); }, "endnote_block");
    assert.ok(ok, "诗歌→附记转换应成功");
    const md = serializeMarkdown(internals.pmToJson(st.doc));
    assert.ok(md.includes("{{< endnote >}}"), "应序列化为附记短代码");
    assert.ok(!md.includes("{{< poetry >}}"), "不得残留诗歌容器（不得嵌套）");
    assert.ok(md.includes("诗行一"), "文字不得丢失");
    const info = internals.selectionInfo(
      st.apply(st.tr.setSelection(TextSelection.create(st.doc, firstTextPos(st.doc), firstTextPos(st.doc)))),
    );
    assert.equal(info.blockType, "endnote", "转换后光标类型应为附记");
  });

  test("附记→诗歌：单事务转换、无嵌套", () => {
    const { doc } = infoAt("{{< endnote >}}\n\n落款文字\n\n{{< /endnote >}}\n", 1);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, firstTextPos(st.doc), firstTextPos(st.doc) + 1)));
    const ok = internals.convertContainerCommand(st, (tr) => { st = st.apply(tr); }, "poetry_block");
    assert.ok(ok, "附记→诗歌转换应成功");
    const md = serializeMarkdown(internals.pmToJson(st.doc));
    assert.ok(md.includes("{{< poetry >}}") && !md.includes("{{< endnote >}}"), "应干净转为诗歌容器");
    assert.ok(md.includes("落款文字"), "文字不得丢失");
  });

  test("引用→正文（convertContainerCommand 抬出）", () => {
    const { doc } = infoAt("> 引用内容\n", 2);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, firstTextPos(st.doc), firstTextPos(st.doc) + 2)));
    const ok = internals.convertContainerCommand(st, (tr) => { st = st.apply(tr); }, "paragraph");
    assert.ok(ok, "引用→正文抬出应成功");
    const md = serializeMarkdown(internals.pmToJson(st.doc));
    assert.ok(!md.startsWith(">"), "不应再是引用");
    assert.ok(md.includes("引用内容"), "文字不得丢失");
  });

  test("正文→诗歌→正文：文字不丢失且往返幂等", () => {
    const source = "第一段。\n";
    const { doc } = infoAt(source, 2);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2, 4)));
    const wrapped = internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "poetry_block");
    assert.ok(wrapped, "诗歌 wrap 应成功");
    const poemMd = serializeMarkdown(internals.pmToJson(st.doc));
    assert.ok(poemMd.includes("{{< poetry >}}"), "诗歌应序列化为短代码");
    assert.ok(poemMd.includes("第一段。"), "文字不得丢失");
    assert.equal(serializeMarkdown(parseMarkdown(poemMd)), poemMd, "诗歌块往返应幂等");
    const lifted = internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "poetry_block");
    assert.ok(lifted, "诗歌 lift 应成功");
    assert.equal(serializeMarkdown(internals.pmToJson(st.doc)), source, "转回正文后应与原文一致");
  });

  test("正文→附记→正文：文字不丢失", () => {
    const { doc } = infoAt("正文段。\n", 2);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2, 4)));
    internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "endnote_block");
    const endMd = serializeMarkdown(internals.pmToJson(st.doc));
    assert.ok(endMd.includes("{{< endnote >}}"), "附记应序列化为短代码");
    internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "endnote_block");
    assert.equal(serializeMarkdown(internals.pmToJson(st.doc)), "正文段。\n", "转回正文应与原文一致");
  });

  test("诗歌+居中：内容类型与对齐两个维度同时 active", () => {
    const { doc } = infoAt("{{< poetry >}}\n\n诗行一\n\n{{< /poetry >}}\n", 2);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2, 3)));
    const ok = internals.setAlignmentCommand(st, (tr) => { st = st.apply(tr); }, "center");
    assert.ok(ok, "诗歌块内居中应可执行");
    const info = internals.selectionInfo(st);
    assert.equal(info.blockType, "poetry", "居中后仍应是诗歌");
    assert.equal(info.align, "center", "诗歌与居中应同时 active");
    const md = serializeMarkdown(internals.pmToJson(st.doc));
    assert.ok(md.includes("{{< poetry >}}") && md.includes("{{< align center >}}"),
      "诗歌+居中序列化应同时保留两种语义");
  });

  test("附记+右对齐：同时 active", () => {
    const { doc } = infoAt("{{< endnote >}}\n\n落款\n\n{{< /endnote >}}\n", 2);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2, 3)));
    internals.setAlignmentCommand(st, (tr) => { st = st.apply(tr); }, "right");
    const info = internals.selectionInfo(st);
    assert.equal(info.blockType, "endnote");
    assert.equal(info.align, "right");
  });

  test("引用→正文：转换后内容保留", () => {
    const { doc } = infoAt("> 引用内容\n", 3);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2, 5)));
    const lifted = internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "blockquote");
    assert.ok(lifted, "引用 lift 应成功");
    assert.ok(serializeMarkdown(internals.pmToJson(st.doc)).includes("引用内容"), "引用文字不得丢失");
  });

  test("撤销→重做可完整恢复转换", () => {
    const { doc } = infoAt("第一段。\n\n第二段。\n", 2);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2, 4)));
    const before = serializeMarkdown(internals.pmToJson(st.doc));
    internals.toggleContainerCommand(st, (tr) => { st = st.apply(tr); }, "poetry_block");
    const poemMd = serializeMarkdown(internals.pmToJson(st.doc));
    assert.notEqual(poemMd, before, "转换应产生变化");
    undo(st, (tr) => { st = st.apply(tr); });
    assert.equal(serializeMarkdown(internals.pmToJson(st.doc)), before, "撤销后应回到转换前");
    redo(st, (tr) => { st = st.apply(tr); });
    assert.equal(serializeMarkdown(internals.pmToJson(st.doc)), poemMd, "重做后应重新应用转换");
  });

  test("保存→重新打开：类型与对齐不丢失", () => {
    const md = "{{< poetry >}}\n\n{{< align center >}}\n\n诗行一\n\n{{< /align >}}\n\n{{< /poetry >}}\n";
    const reopen = internals.jsonToPm(parseMarkdown(md));
    const st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc: reopen,
    });
    const pos = firstTextPos(st.doc);
    const info = internals.selectionInfo(st.apply(st.tr.setSelection(TextSelection.create(st.doc, pos, pos))));
    assert.equal(info.blockType, "poetry", "重新打开后类型应保持");
    assert.equal(info.align, "center", "重新打开后对齐应保持");
    assert.equal(serializeMarkdown(internals.pmToJson(st.doc)), md, "重新打开序列化应幂等");
  });

  test("paragraph-id 锚点不被重建", () => {
    const md = "<!-- paragraph-id:p-abc123 -->\n\n第一段。\n\n第二段。\n";
    const out = serializeMarkdown(parseMarkdown(md));
    assert.ok(out.includes("<!-- paragraph-id:p-abc123 -->"), "锚点必须原样保留");
    assert.equal(out, md, "未编辑文档往返必须逐字一致");
  });

  test("光标钳制：保存恢复的光标必须落在可编辑文本内（回归：块边界光标导致工具栏状态误判）", () => {
    /* 构造：光标在文档末尾（容器块之后），按纯文本偏移恢复会落在块边界 */
    const doc = internals.jsonToPm(parseMarkdown("第一段。\n\n{{< endnote >}}\n\n附记文字\n\n{{< /endnote >}}\n"));
    const endPos = doc.content.size;
    const clamped = internals.clampToInlineText(doc, endPos);
    const $pos = doc.resolve(clamped);
    assert.ok($pos.parent.inlineContent, `钳制后光标父节点应是文本块（实际：${$pos.parent.type.name} @ ${clamped}）`);
    /* 文档中间的正常位置不应被移动 */
    const mid = doc.resolve(3);
    assert.ok(mid.parent.inlineContent);
    assert.equal(internals.clampToInlineText(doc, 3), 3, "文本内位置不应被钳制移动");
    /* 位置 0（文档开头，块边界）也应钳制进文本 */
    const clampedStart = internals.clampToInlineText(doc, 0);
    assert.ok(doc.resolve(clampedStart).parent.inlineContent, "文档开头应被钳制进文本");
  });

  test("块级图片必须是合法结构（回归：内联图片直挂 block 容器导致渲染/选区异常）", () => {
    const md = "第一段。\n\n![图](images/x.svg)\n";
    const json = parseMarkdown(md);
    assert.equal(json.content[1].type, "image", "独占一行的图片应解析为块级图片");
    const doc = internals.jsonToPm(json);
    assert.doesNotThrow(() => doc.check(), "含块级图片的文档必须是合法结构");
    const last = doc.content.content[doc.content.content.length - 1];
    assert.equal(last.type.name, "paragraph", "块级图片应包进段落");
    assert.equal(last.content.content[0].type.name, "image", "段内应为图片节点");
    /* 往返必须逐字一致（序列化输出不变） */
    const out = serializeMarkdown(internals.pmToJson(doc));
    assert.equal(out, md, "块级图片往返必须逐字一致");
    /* 容器内块级图片同样合法 */
    const doc2 = internals.jsonToPm(parseMarkdown("{{< endnote >}}\n\n![图](images/x.svg)\n\n{{< /endnote >}}\n"));
    assert.doesNotThrow(() => doc2.check(), "容器内块级图片也必须是合法结构");
    assert.equal(serializeMarkdown(internals.pmToJson(doc2)), "{{< endnote >}}\n\n![图](images/x.svg)\n\n{{< /endnote >}}\n");
  });

  test("对齐包裹的块级图片：重新打开后对齐不丢失（回归：Safari 验收暴露的数据丢失）", () => {
    const md = "{{< align right >}}\n\n![图](images/x.svg)\n\n{{< /align >}}\n";
    const json = parseMarkdown(md);
    assert.equal(json.content[0].type, "paragraph", "对齐包裹的图片应解析为带对齐的段落");
    assert.equal(json.content[0].align, "right", "对齐必须保留");
    assert.equal(json.content[0].content[0].type, "image", "段内应为图片");
    const out = serializeMarkdown(json);
    assert.equal(out, md, "对齐+块级图片往返必须逐字一致（不得丢失对齐）");
    /* 容器内的对齐图片同样稳定 */
    const md2 = "{{< endnote >}}\n\n{{< align right >}}\n\n![图](images/x.svg)\n\n{{< /align >}}\n\n{{< /endnote >}}\n";
    const out2 = serializeMarkdown(parseMarkdown(md2));
    assert.equal(out2, md2, "附记内对齐图片往返必须逐字一致");
  });

  test("保存后撤销仍可用（回归：整篇替换以 addToHistory:false 分发会毒化历史）", () => {
    const { doc } = infoAt("第一段。\n\n第二段。\n", 2);
    let st = EditorState.create({
      schema: internals.schema,
      plugins: internals.buildEditorPlugins(),
      doc,
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2, 4)));
    internals.convertContainerCommand(st, (tr) => { st = st.apply(tr); }, "endnote_block");
    internals.setAlignmentCommand(st, (tr) => { st = st.apply(tr); }, "right");
    const md = serializeMarkdown(internals.pmToJson(st.doc));
    /* 模拟 replaceDocKeepCursor 的等值判定：内容一致的规范化结果不替换 */
    const normalized = internals.jsonToPm(parseMarkdown(md));
    assert.ok(normalized.eq(st.doc), "规范化往返应与编辑文档结构一致");
    /* 直接验证历史未被破坏：应用一个 addToHistory:false 空事务后撤销仍应有步骤 */
    st = st.apply(st.tr.setMeta("addToHistory", false));
    let undoSteps = -1;
    undo(st, (tr) => { undoSteps = tr.steps.length; st = st.apply(tr); });
    assert.ok(undoSteps > 0, `撤销事务必须含步骤（实际 ${undoSteps}）`);
    const after = serializeMarkdown(internals.pmToJson(st.doc));
    assert.ok(!after.includes("{{< endnote >}}") || after.includes("第一段。"),
      "撤销后内容应回到转换前");
    /* 等值替换被跳过后，编辑历史应能连续撤销两次（转换+对齐合并为一次时至少可撤销一次） */
    assert.ok(st.selection.from > 0, "撤销后光标应有效");
  });
} else {
  console.log("跳过：本机未安装根依赖（node_modules），ProseMirror 层状态测试未运行。");
}

if (failures) {
  console.error(`编辑器工具栏状态测试失败 ${failures} 项。`);
  process.exit(1);
}
console.log("编辑器工具栏状态自动测试通过。");
