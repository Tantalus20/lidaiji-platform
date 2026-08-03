/* 《历代纪》正文所见即所得编辑器（ProseMirror）。
 *
 * 职责：
 * - 把 markdown.mjs 的结构化 JSON 映射为 ProseMirror 文档（编辑状态），
 *   编辑后映射回 JSON 再由 markdown.mjs 序列化为标准 Markdown 落盘；
 * - 段落节点携带 pid 属性，保证段评锚点注释在「编辑器 ↔ Markdown」之间往返；
 * - 提供 createStudioEditor：大面积编辑、加粗/斜体（含 Cmd/Ctrl+B/I）、
 *   撤销/重做、表格、列表、引用、标题、图片、硬换行；
 * - 不承载业务逻辑（自动保存、草稿恢复等由 app.js 负责）。
 *
 * 本文件由 esbuild 打进 studio/static/vendor/prosemirror-bundle.js，
 * 通过全局变量 LidaijiEditor 暴露给 app.js。
 */

import { Schema } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  baseKeymap,
  chainCommands,
  splitBlock,
  toggleMark,
  wrapIn,
} from "prosemirror-commands";
import { history, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { tableEditing, tableNodes } from "prosemirror-tables";
import { parseMarkdown, serializeMarkdown } from "./markdown.mjs";

/* ---------------- Schema ---------------- */

const tableSpec = tableNodes({
  tableGroup: "block",
  cellContent: "block+",
  cellAttributes: {},
});

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: { pid: { default: null }, align: { default: null } },
      parseDOM: [
        {
          tag: "p",
          getAttrs: (dom) => ({
            pid: dom.getAttribute("data-studio-pid"),
            align: dom.getAttribute("data-align") || null,
          }),
        },
      ],
      toDOM: (node) => {
        // 注意：attrs 必须是对象，不能是 null——renderSpec 会把 null 当成子节点处理
        const attrs = {};
        if (node.attrs.pid) attrs["data-studio-pid"] = node.attrs.pid;
        if (node.attrs.align) attrs["data-align"] = node.attrs.align;
        return ["p", attrs, 0];
      },
    },
    heading: {
      content: "inline*",
      group: "block",
      attrs: { level: { default: 1 } },
      parseDOM: [
        { tag: "h1", attrs: { level: 1 } },
        { tag: "h2", attrs: { level: 2 } },
        { tag: "h3", attrs: { level: 3 } },
      ],
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },
    blockquote: {
      content: "block+",
      group: "block",
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    /* 诗歌块：整体居中、诗句内部左对齐（CSS .poetry-block 控制） */
    poetry_block: {
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "div.poetry-block" }],
      toDOM: () => ["div", { class: "poetry-block" }, 0],
    },
    /* 尾注块：右对齐、小字号（CSS .end-note 控制） */
    endnote_block: {
      content: "block+",
      group: "block",
      defining: true,
      parseDOM: [{ tag: "div.end-note" }],
      toDOM: () => ["div", { class: "end-note" }, 0],
    },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      attrs: { info: { default: "" } },
      parseDOM: [{ tag: "pre" }],
      toDOM: () => ["pre", ["code", 0]],
    },
    bullet_list: {
      content: "list_item+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },
    ordered_list: {
      content: "list_item+",
      group: "block",
      attrs: { order: { default: 1 } },
      parseDOM: [{ tag: "ol" }],
      toDOM: (node) => ["ol", node.attrs.order === 1 ? {} : { start: node.attrs.order }, 0],
    },
    list_item: {
      content: "paragraph block*",
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },
    ...tableSpec,
    image: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { src: {}, alt: { default: "" } },
      parseDOM: [
        {
          tag: "img[src]",
          getAttrs: (dom) => ({ src: dom.getAttribute("src") || "", alt: dom.getAttribute("alt") || "" }),
        },
      ],
      toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt }],
    },
    hard_break: {
      inline: true,
      group: "inline",
      atom: true,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    text: { group: "inline" },
  },
  marks: {
    strong: {
      parseDOM: [
        { tag: "strong" },
        { tag: "b" },
        { tag: "span", style: "font-weight", getAttrs: (value) => /^(bold|(?:[1-9]\d*00))$/.test(value) && null },
      ],
      toDOM: () => ["strong", 0],
    },
    em: {
      parseDOM: [
        { tag: "em" },
        { tag: "i" },
        { tag: "span", style: "font-style", getAttrs: (value) => /^(italic|oblique)$/i.test(value) && null },
      ],
      toDOM: () => ["em", 0],
    },
    link: {
      attrs: { href: {}, title: { default: "" } },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => ({
            href: dom.getAttribute("href") || "",
            title: dom.getAttribute("title") || "",
          }),
        },
      ],
      toDOM: (mark) => {
        const attrs = { href: mark.attrs.href };
        if (mark.attrs.title) attrs.title = mark.attrs.title;
        return ["a", attrs, 0];
      },
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0],
    },
  },
});

/* ---------------- JSON ↔ ProseMirror ---------------- */

function marksFromJson(names) {
  const result = [];
  for (const name of names || []) {
    if (name === "strong") result.push(schema.marks.strong.create());
    else if (name === "em") result.push(schema.marks.em.create());
  }
  return result;
}

function inlineToPm(node) {
  if (node.type === "text") return schema.text(node.text ?? "", marksFromJson(node.marks));
  if (node.type === "hard_break") return schema.nodes.hard_break.create();
  if (node.type === "image") return schema.nodes.image.create({ src: node.src ?? "", alt: node.alt ?? "" });
  if (node.type === "code") return schema.text(node.text ?? "", [schema.marks.code.create()]);
  if (node.type === "link") {
    const linkMark = schema.marks.link.create({ href: node.href ?? "", title: node.title ?? "" });
    const parts = [];
    for (const child of node.content || []) {
      if (child.type === "text") {
        parts.push(schema.text(child.text ?? "", [...marksFromJson(child.marks), linkMark]));
      } else if (child.type === "code") {
        parts.push(schema.text(child.text ?? "", [schema.marks.code.create(), linkMark]));
      } else if (child.type === "hard_break") {
        parts.push(schema.nodes.hard_break.create());
      }
    }
    return parts;
  }
  return schema.text("");
}

function inlinesFromPm(node) {
  const result = [];
  let linkBuffer = null;
  const flushLink = () => {
    if (linkBuffer) {
      result.push(linkBuffer);
      linkBuffer = null;
    }
  };
  for (const child of node.content.content) {
    if (child.type.name === "text") {
      const linkMark = child.marks.find((mark) => mark.type.name === "link");
      if (linkMark) {
        if (
          !linkBuffer ||
          linkBuffer.href !== linkMark.attrs.href ||
          linkBuffer.title !== linkMark.attrs.title
        ) {
          flushLink();
          linkBuffer = { type: "link", href: linkMark.attrs.href, title: linkMark.attrs.title || "", content: [] };
        }
        const rest = child.marks.filter((mark) => mark.type.name !== "link");
        if (rest.some((mark) => mark.type.name === "code")) {
          linkBuffer.content.push({ type: "code", text: child.text ?? "" });
        } else {
          const names = rest.map((mark) => mark.type.name).sort();
          const entry = { type: "text", text: child.text ?? "" };
          if (names.length) entry.marks = names;
          linkBuffer.content.push(entry);
        }
        continue;
      }
      flushLink();
      if (child.marks.some((mark) => mark.type.name === "code")) {
        result.push({ type: "code", text: child.text ?? "" });
      } else {
        const names = child.marks.map((mark) => mark.type.name).sort();
        const entry = { type: "text", text: child.text ?? "" };
        if (names.length) entry.marks = names;
        result.push(entry);
      }
    } else if (child.type.name === "hard_break") {
      flushLink();
      result.push({ type: "hard_break" });
    } else if (child.type.name === "image") {
      flushLink();
      result.push({ type: "image", src: child.attrs.src ?? "", alt: child.attrs.alt ?? "" });
    }
  }
  flushLink();
  return result;
}

function blockToPm(block) {
  switch (block.type) {
    case "paragraph": {
      const attrs = {};
      if (block.pid) attrs.pid = block.pid;
      if (block.align === "center" || block.align === "right") attrs.align = block.align;
      return schema.nodes.paragraph.create(
        Object.keys(attrs).length ? attrs : null,
        (block.content || []).flatMap(inlineToPm),
      );
    }
    case "heading":
      return schema.nodes.heading.create(
        { level: Math.min(3, Math.max(1, block.level || 1)) },
        (block.content || []).flatMap(inlineToPm),
      );
    case "blockquote":
      return schema.nodes.blockquote.create(
        null,
        schema.nodes.paragraph.create(null, (block.content || []).flatMap(inlineToPm)),
      );
    case "poetry_block": {
      const inner = (block.content || []).map(blockToPm);
      return schema.nodes.poetry_block.create(null, inner.length ? inner : [schema.nodes.paragraph.create()]);
    }
    case "endnote_block": {
      const inner = (block.content || []).map(blockToPm);
      return schema.nodes.endnote_block.create(null, inner.length ? inner : [schema.nodes.paragraph.create()]);
    }
    case "bullet_list":
      return schema.nodes.bullet_list.create(
        null,
        (block.content || []).map((item) =>
          schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, (item.content || []).flatMap(inlineToPm))),
        ),
      );
    case "ordered_list":
      return schema.nodes.ordered_list.create(
        null,
        (block.content || []).map((item) =>
          schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, (item.content || []).flatMap(inlineToPm))),
        ),
      );
    case "table": {
      const rows = (block.content || []).map((row) =>
        schema.nodes.table_row.create(
          null,
          (row.content || []).map((cell) => {
            const type = cell.header ? schema.nodes.table_header : schema.nodes.table_cell;
            return type.create(null, schema.nodes.paragraph.create(null, (cell.content || []).flatMap(inlineToPm)));
          }),
        ),
      );
      return schema.nodes.table.create(null, rows);
    }
    case "image":
      return schema.nodes.image.create({ src: block.src ?? "", alt: block.alt ?? "" });
    case "code_block":
      return schema.nodes.code_block.create(
        { info: block.info ?? "" },
        block.text ? schema.text(block.text) : null,
      );
    default:
      return schema.nodes.paragraph.create(null, (block.content || []).flatMap(inlineToPm));
  }
}

function flattenInlines(parentNode) {
  const result = [];
  for (const child of parentNode.content.content) {
    if (child.type.name === "paragraph") {
      result.push(...inlinesFromPm(child));
    } else if (child.type.name === "image") {
      result.push({ type: "image", src: child.attrs.src ?? "", alt: child.attrs.alt ?? "" });
    }
  }
  return result;
}

function jsonToPm(jsonDoc) {
  let content = (jsonDoc?.content || []).map(blockToPm);
  if (!content.length) content = [schema.nodes.paragraph.create()];
  return schema.nodes.doc.create(null, content);
}

function blockToJson(node) {
  switch (node.type.name) {
    case "paragraph": {
      const entry = { type: "paragraph", pid: node.attrs.pid || null, content: inlinesFromPm(node) };
      if (node.attrs.align) entry.align = node.attrs.align;
      return entry;
    }
    case "heading":
      return { type: "heading", level: node.attrs.level, content: inlinesFromPm(node) };
    case "blockquote":
      return { type: "blockquote", content: flattenInlines(node) };
    case "poetry_block":
      return { type: "poetry_block", content: node.content.content.map(blockToJson) };
    case "endnote_block":
      return { type: "endnote_block", content: node.content.content.map(blockToJson) };
    case "bullet_list":
      return { type: "bullet_list", content: node.content.content.map(blockToJson) };
    case "ordered_list":
      return { type: "ordered_list", content: node.content.content.map(blockToJson) };
    case "list_item":
      return { type: "list_item", content: flattenInlines(node) };
    case "table":
      return {
        type: "table",
        content: node.content.content.map((row) => ({
          type: "table_row",
          content: row.content.content.map((cell) => ({
            type: "table_cell",
            header: cell.type.name === "table_header",
            content: flattenInlines(cell),
          })),
        })),
      };
    case "image":
      return { type: "image", src: node.attrs.src ?? "", alt: node.attrs.alt ?? "" };
    case "code_block":
      return { type: "code_block", info: node.attrs.info ?? "", text: node.textContent };
    default:
      return { type: "paragraph", pid: null, content: inlinesFromPm(node) };
  }
}

function pmToJson(doc) {
  return { type: "doc", content: doc.content.content.map(blockToJson) };
}

/* ---------------- 光标恢复（按纯文本偏移） ---------------- */

function textOffsetAt(doc, pos) {
  const target = Math.max(0, Math.min(pos, doc.content.size));
  let offset = 0;
  doc.nodesBetween(0, target, (node, nodeStart) => {
    if (node.isText) {
      offset += Math.max(0, Math.min(target, nodeStart + node.nodeSize) - nodeStart);
    } else if (node.type.name === "hard_break") {
      if (nodeStart < target) offset += 1;
    } else if (node.type.name === "image") {
      if (nodeStart < target) offset += (node.attrs.alt || "").length;
    }
  });
  return offset;
}

function positionForTextOffset(doc, target) {
  const size = doc.content.size;
  if (target <= 0) return 0;
  let low = 0;
  let high = size;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (textOffsetAt(doc, mid) < target) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, size);
}

/* ---------------- 编辑器 ---------------- */

function selectionInfo(state) {
  const marks = state.storedMarks || state.selection.$from.marks();
  const $from = state.selection.$from;
  let align = null;
  let inPoetry = false;
  let inEndnote = false;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "poetry_block") inPoetry = true;
    if (node.type.name === "endnote_block") inEndnote = true;
  }
  const block = $from.node($from.depth);
  if (block.type.name === "paragraph" && block.attrs.align) align = block.attrs.align;
  return {
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
    bold: Boolean(schema.marks.strong.isInSet(marks)),
    em: Boolean(schema.marks.em.isInSet(marks)),
    align,
    inPoetry,
    inEndnote,
  };
}

/* ---------------- 段落对齐与容器命令 ---------------- */

/* 对选中范围内的所有段落设置对齐（"left" 恢复默认）。 */
function setAlignmentCommand(state, dispatch, name) {
  const target = name === "left" ? null : name;
  const tr = state.tr;
  let changed = false;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
    if (node.type.name === "paragraph" && node.attrs.align !== target) {
      tr.setNodeMarkup(pos, null, { ...node.attrs, align: target });
      changed = true;
    }
  });
  if (!changed) return false;
  if (dispatch) dispatch(tr);
  return true;
}

function selectionInContainer(state, typeName) {
  const inContainerAt = ($pos) => {
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      if ($pos.node(depth).type.name === typeName) return true;
    }
    return false;
  };
  return inContainerAt(state.selection.$from) && inContainerAt(state.selection.$to);
}

/* 把选中范围内命中的容器替换为其内容（转回普通正文）。 */
function liftOutOfContainerCommand(state, dispatch, typeName) {
  const tr = state.tr;
  const positions = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
    if (node.type.name === typeName && node.content.childCount) positions.push(pos);
  });
  if (!positions.length) return false;
  if (dispatch) {
    for (const pos of positions.sort((a, b) => b - a)) {
      const node = state.doc.nodeAt(pos);
      tr.replaceWith(pos, pos + node.nodeSize, node.content);
    }
    dispatch(tr);
  }
  return true;
}

function toggleContainerCommand(state, dispatch, typeName) {
  if (selectionInContainer(state, typeName)) {
    return liftOutOfContainerCommand(state, dispatch, typeName);
  }
  return wrapIn(schema.nodes[typeName])(state, dispatch);
}

/* 容器内空段退出：在诗歌/尾注块末尾的空段按回车 → 生成容器外的普通段落。 */
function containerExitEnter(state, dispatch) {
  const $from = state.selection.$from;
  const parent = $from.parent;
  // 空段 = 无文本且无其他内容（图片等）
  if (parent.type.name !== "paragraph" || parent.textContent || parent.content.size > 0) return false;
  const container = $from.node(-1);
  if (!container || (container.type.name !== "poetry_block" && container.type.name !== "endnote_block")) return false;
  if (container.lastChild !== parent) return false;
  if (!dispatch) return true;
  const containerPos = $from.before($from.depth - 1);
  const remaining = [];
  for (let i = 0; i < container.childCount - 1; i += 1) remaining.push(container.child(i));
  remaining.push(schema.nodes.paragraph.create());
  const tr = state.tr.replaceWith(containerPos, containerPos + container.nodeSize, remaining);
  const endPos = containerPos + remaining.reduce((sum, node) => sum + node.nodeSize, 0);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(containerPos + 1, endPos - 1))));
  dispatch(tr.scrollIntoView());
  return true;
}

/* 容器内唯一空段开头按退格 → 容器转回普通空段，不留下空壳节点。 */
function containerEmptyBackspace(state, dispatch) {
  const $from = state.selection.$from;
  if ($from.parentOffset !== 0) return false;
  const parent = $from.parent;
  if (parent.type.name !== "paragraph" || parent.textContent || parent.content.size > 0) return false;
  const container = $from.node(-1);
  if (!container || (container.type.name !== "poetry_block" && container.type.name !== "endnote_block")) return false;
  if (container.childCount !== 1) return false;
  if (!dispatch) return true;
  const containerPos = $from.before($from.depth - 1);
  const tr = state.tr.replaceWith(containerPos, containerPos + container.nodeSize, [schema.nodes.paragraph.create()]);
  tr.setSelection(TextSelection.near(tr.doc.resolve(containerPos + 1)));
  dispatch(tr);
  return true;
}

/* 编辑器快捷键表：撤销/重做、加粗/斜体、列表操作。
 * 注意：prosemirror-history 1.5 起不再导出 historyKeymap，撤销/重做必须显式绑定。 */
function editorKeymap() {
  return {
    ...baseKeymap,
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Ctrl-b": toggleMark(schema.marks.strong),
    "Ctrl-i": toggleMark(schema.marks.em),
    // 列表内回车=新列表项，列表外回车=分段（不能只绑 splitListItem，
    // 否则普通段落里回车无效）；诗歌/尾注块末尾空段回车=退出容器
    Enter: chainCommands(containerExitEnter, splitListItem(schema.nodes.list_item), splitBlock),
    "Mod-Enter": chainCommands(splitListItem(schema.nodes.list_item), splitBlock),
    Tab: sinkListItem(schema.nodes.list_item),
    "Shift-Tab": liftListItem(schema.nodes.list_item),
    Backspace: chainCommands(containerEmptyBackspace, baseKeymap.Backspace),
    "Shift-Enter": (state, dispatch) => {
      if (!dispatch) return true;
      dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
      return true;
    },
  };
}

/* 不依赖编辑器的插件集合（history + keymap + 表格）；独立成函数便于自动测试。 */
function buildEditorPlugins() {
  return [history(), keymap(editorKeymap()), tableEditing()];
}

export function createStudioEditor(host, options = {}) {
  const { onUpdate, onSelection } = options;
  let version = 0;
  let replacing = false;

  const listenerPlugin = new Plugin({
    view: () => ({
      update: (view, prevState) => {
        const docChanged = !view.state.doc.eq(prevState.doc);
        if (docChanged && !replacing) {
          version += 1;
          if (onUpdate) onUpdate({ version, markdown: serializeMarkdown(pmToJson(view.state.doc)) });
        }
        if (onSelection) onSelection(selectionInfo(view.state));
      },
    }),
  });

  const state = EditorState.create({
    schema,
    plugins: [...buildEditorPlugins(), listenerPlugin],
  });

  const view = new EditorView(host, { state });

  const dispatchReplace = (tr) => {
    tr.setMeta("addToHistory", false);
    replacing = true;
    try {
      view.dispatch(tr);
    } finally {
      replacing = false;
    }
  };

  const editor = {
    view,

    getMarkdown() {
      return serializeMarkdown(pmToJson(view.state.doc));
    },

    setMarkdown(markdown) {
      const doc = jsonToPm(parseMarkdown(markdown));
      // 注意：replace 需要 Slice；用 replaceWith 传入 Fragment（等价 open 0/0 的 Slice）
      dispatchReplace(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    },

    replaceDocKeepCursor(markdown) {
      const { from, to } = view.state.selection;
      const anchorOffset = textOffsetAt(view.state.doc, from);
      const headOffset = textOffsetAt(view.state.doc, to);
      const doc = jsonToPm(parseMarkdown(markdown));
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
      const newFrom = positionForTextOffset(tr.doc, anchorOffset);
      const newTo = positionForTextOffset(tr.doc, headOffset);
      if (newFrom !== newTo || tr.selection.from !== newFrom) {
        tr.setSelection(TextSelection.create(tr.doc, newFrom, newTo));
      }
      dispatchReplace(tr);
    },

    undo() {
      undo(view.state, view.dispatch);
    },

    redo() {
      redo(view.state, view.dispatch);
    },

    toggleBold() {
      toggleMark(schema.marks.strong)(view.state, view.dispatch);
    },

    toggleEm() {
      toggleMark(schema.marks.em)(view.state, view.dispatch);
    },

    setAlignment(name) {
      setAlignmentCommand(view.state, view.dispatch, name);
    },

    togglePoetry() {
      toggleContainerCommand(view.state, view.dispatch, "poetry_block");
    },

    toggleEndnote() {
      toggleContainerCommand(view.state, view.dispatch, "endnote_block");
    },

    focus() {
      view.focus();
    },

    version() {
      return version;
    },

    destroy() {
      view.destroy();
    },
  };

  return editor;
}

export { parseMarkdown, serializeMarkdown, selectionInfo };

/* 内部函数：供自动测试校验 JSON↔节点、光标偏移映射、快捷键表与插件集合（非公开 API）。 */
export const _internals = {
  jsonToPm,
  pmToJson,
  textOffsetAt,
  positionForTextOffset,
  editorKeymap,
  buildEditorPlugins,
  schema,
  setAlignmentCommand,
  toggleContainerCommand,
  selectionInContainer,
  containerExitEnter,
  containerEmptyBackspace,
};
