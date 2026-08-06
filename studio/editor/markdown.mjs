/* 《历代纪》正文 Markdown 引擎（纯函数，零依赖）。
 *
 * 职责：把正文在「标准 Markdown」与「结构化 JSON 文档」之间转换。
 * - 结构化 JSON 只作为编辑器内部状态与传输中转，最终落盘永远是 Markdown；
 * - 支持项目实际使用的全部语法：段落锚点注释、h1–h3、段落、引用、
 *   无序/有序列表、表格、图片、加粗/斜体/粗斜体、段内硬换行、* 转义；
 * - 段落级排版用 Hugo 短代码表达（unsafe=false 下受控 HTML 会被转义）：
 *   `{{< align center|right >}}` 包单段（段落 align 属性）、
 *   `{{< poetry >}}…{{< /poetry >}}` 诗歌块、`{{< endnote >}}…{{< /endnote >}}` 附记块（无编号补充说明，非脚注/尾注系统）；
 *   块内仍可写普通 Markdown（加粗/斜体可用），块内不挂段评锚点；
 * - 段落锚点 `<!-- paragraph-id:p-... -->` 必须原样往返，否则段评身份会断裂；
 * - 不认识的块按纯文本段落保留，保证旧文章零丢失迁移。
 *
 * 本文件被 Node 测试直接 import，也被 esbuild 打进前端 bundle；禁止依赖
 * 任何浏览器 API 或第三方包。
 */

const ANCHOR = /^<!--\s*paragraph-id:([\w-]+)\s*-->$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;
const TABLE_SEP = /^\|?[\s:\-|]+\|?$/;
const IMAGE_BLOCK = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const IMAGE_INLINE = /^!\[([^\]]*)\]\(([^)\s]+)\)/;
/* 短代码块：{{< align center >}} / {{< align right >}} / {{< poetry >}} / {{< endnote >}} */
const SHORTCODE_OPEN = /^\{\{< (align) (?:"?)(left|center|right)("?) >\}\}$|^\{\{< (poetry|endnote) >\}\}$/;

function isTableStart(lines, index) {
  const line = lines[index];
  if (!line || !line.trim().startsWith("|")) return false;
  const next = lines[index + 1];
  return Boolean(next && TABLE_SEP.test(next.trim()));
}

function isBlockStart(lines, index) {
  const stripped = lines[index].trim();
  if (!stripped) return false;
  if (ANCHOR.test(stripped)) return true;
  if (SHORTCODE_OPEN.test(stripped)) return true;
  if (HEADING.test(lines[index])) return true;
  if (lines[index].startsWith(">")) return true;
  if (BULLET.test(lines[index]) || NUMBERED.test(lines[index])) return true;
  if (IMAGE_BLOCK.test(stripped)) return true;
  if (/^(```+|~~~+)/.test(lines[index])) return true;
  return isTableStart(lines, index);
}

/* ---------------- 行内解析 ---------------- */

/* Unicode 单词字符（字母/数字），用于 _ 强调的“词内”判定：
 * 与 CommonMark 一致，_ 位于两个单词字符之间时不作为强调标记。 */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const LINK_INLINE = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\)/;

function isWordChar(char) {
  return char !== undefined && WORD_CHAR.test(char);
}

/* 把一段文本解析为行内节点数组。
 * 节点类型：text（可带 marks: strong/em）、hard_break、image、
 * link（content 为行内节点数组，href/title 可选）、code（纯文本）。 */
function parseInline(text) {
  const inline = [];
  let buffer = "";
  const marks = new Set();

  const flush = () => {
    if (!buffer) return;
    const node = { type: "text", text: buffer };
    if (marks.size) node.marks = Array.from(marks).sort();
    inline.push(node);
    buffer = "";
  };
  const toggle = (name) => {
    if (marks.has(name)) marks.delete(name);
    else marks.add(name);
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      buffer += text[index + 1] ?? "\\";
      index += 2;
      continue;
    }
    const triple = text.slice(index, index + 3);
    if (triple === "***" || triple === "___") {
      flush();
      const both = marks.has("strong") && marks.has("em");
      const none = !marks.has("strong") && !marks.has("em");
      if (both) {
        marks.delete("strong");
        marks.delete("em");
      } else if (none) {
        marks.add("strong");
        marks.add("em");
      } else {
        marks.clear();
        marks.add(marks.has("strong") ? "em" : "strong");
      }
      index += 3;
      continue;
    }
    const double = text.slice(index, index + 2);
    if (double === "**" || double === "__") {
      flush();
      toggle("strong");
      index += 2;
      continue;
    }
    if (char === "*" || char === "_") {
      // 词内下划线不参与强调（与 CommonMark 一致，避免 foo_bar 被误伤）
      if (char === "_" && isWordChar(text[index - 1]) && isWordChar(text[index + 1])) {
        buffer += char;
        index += 1;
        continue;
      }
      flush();
      toggle(char === "*" ? "em" : "em");
      index += 1;
      continue;
    }
    if (char === "`") {
      let run = 0;
      while (text[index + run] === "`") run += 1;
      let close = -1;
      let cursor = index + run;
      while (cursor < text.length) {
        if (text[cursor] === "`") {
          let closeRun = 0;
          while (text[cursor + closeRun] === "`") closeRun += 1;
          if (closeRun === run) {
            close = cursor;
            break;
          }
          cursor += closeRun;
        } else {
          cursor += 1;
        }
      }
      if (close < 0) {
        buffer += "`".repeat(run);
        index += run;
        continue;
      }
      flush();
      const content = text.slice(index + run, close);
      if (content) {
        inline.push({ type: "code", text: content });
      } else {
        buffer += "`".repeat(run * 2);
      }
      index = close + run;
      continue;
    }
    const image = IMAGE_INLINE.exec(text.slice(index));
    if (image) {
      flush();
      inline.push({ type: "image", src: image[2], alt: image[1] });
      index += image[0].length;
      continue;
    }
    const link = LINK_INLINE.exec(text.slice(index));
    if (link) {
      flush();
      inline.push({
        type: "link",
        href: link[2],
        title: link[3] ?? link[4] ?? "",
        content: parseInline(link[1]),
      });
      index += link[0].length;
      continue;
    }
    if (char === "\n") {
      flush();
      inline.push({ type: "hard_break" });
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return inline;
}

/* ---------------- 块级解析 ---------------- */

/* 解析一段行区间为块数组。
 * inContainer 为真时：段评锚点注释被忽略（容器内段落不挂锚点）。 */
function parseBlocks(lines, start, end, inContainer = false) {
  const content = [];
  let index = start;
  let pendingPid = "";

  const noteParagraph = (pid, textLines) => {
    content.push({
      type: "paragraph",
      pid: pid || null,
      content: parseInline(textLines.join("\n")),
    });
  };

  while (index < end) {
    const line = lines[index];
    const stripped = line.trim();
    if (!stripped) {
      index += 1;
      continue;
    }
    const anchor = ANCHOR.exec(stripped);
    if (anchor) {
      if (!inContainer) pendingPid = anchor[1];
      index += 1;
      continue;
    }
    const shortcode = SHORTCODE_OPEN.exec(stripped);
    if (shortcode) {
      pendingPid = "";
      const isAlign = shortcode[1] === "align";
      const name = isAlign ? "align" : shortcode[4];
      const closePattern = new RegExp(`^\\{\\{< \\/${name} >\\}\\}$`);
      let closeIndex = -1;
      for (let cursor = index + 1; cursor < end; cursor += 1) {
        if (closePattern.test(lines[cursor].trim())) {
          closeIndex = cursor;
          break;
        }
      }
      if (closeIndex < 0) {
        // 未闭合：按普通文本段落保留（零丢失）
        noteParagraph("", [line]);
        index += 1;
        continue;
      }
      const inner = parseBlocks(lines, index + 1, closeIndex, true);
      if (isAlign) {
        const align = shortcode[2];
        // 容器内每个顶层段落都应用该对齐
        for (const block of inner.content) {
          if (block.type === "paragraph") {
            block.align = align;
            content.push(block);
          } else {
            content.push(block);
          }
        }
      } else {
        content.push({ type: name === "poetry" ? "poetry_block" : "endnote_block", content: inner.content });
      }
      index = closeIndex + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      pendingPid = "";
      content.push({
        type: "heading",
        level: heading[1].length,
        content: parseInline(heading[2].trim()),
      });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      pendingPid = "";
      const quoteLines = [];
      while (index < end && lines[index].startsWith(">")) {
        const rest = lines[index].replace(/^>\s?/, "");
        quoteLines.push(rest);
        index += 1;
      }
      content.push({ type: "blockquote", content: parseInline(quoteLines.join("\n")) });
      continue;
    }
    if (BULLET.test(line)) {
      pendingPid = "";
      const items = [];
      while (index < end && BULLET.test(lines[index])) {
        items.push({ type: "list_item", content: parseInline(BULLET.exec(lines[index])[1]) });
        index += 1;
      }
      content.push({ type: "bullet_list", content: items });
      continue;
    }
    if (NUMBERED.test(line)) {
      pendingPid = "";
      const items = [];
      while (index < end && NUMBERED.test(lines[index])) {
        items.push({ type: "list_item", content: parseInline(NUMBERED.exec(lines[index])[1]) });
        index += 1;
      }
      content.push({ type: "ordered_list", content: items });
      continue;
    }
    if (isTableStart(lines, index)) {
      pendingPid = "";
      const rows = [];
      while (index < end && lines[index].trim().startsWith("|")) {
        const isSeparator = TABLE_SEP.test(lines[index].trim());
        if (isSeparator && rows.length === 1) {
          index += 1;
          continue;
        }
        if (!isSeparator) {
          const cells = splitTableRow(lines[index]);
          rows.push(
            cells.map((cell) => ({
              type: "table_cell",
              header: false,
              content: parseInline(cell),
            })),
          );
        }
        index += 1;
      }
      if (rows.length >= 2) {
        rows[0].forEach((cell) => {
          cell.header = true;
        });
      }
      content.push({
        type: "table",
        content: rows.map((row) => ({ type: "table_row", content: row })),
      });
      continue;
    }
    const imageBlock = IMAGE_BLOCK.exec(stripped);
    if (imageBlock) {
      pendingPid = "";
      content.push({ type: "image", src: imageBlock[2], alt: imageBlock[1] });
      index += 1;
      continue;
    }
    const fence = /^(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      pendingPid = "";
      const marker = fence[1][0];
      const fenceLength = fence[1].length;
      const info = fence[2].trim();
      const body = [];
      index += 1;
      const closePattern = new RegExp(`^\\s*${marker}{${fenceLength},}\\s*$`);
      while (index < end) {
        if (closePattern.test(lines[index])) {
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      content.push({ type: "code_block", info, text: body.join("\n") });
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < end && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    if (paragraphLines.join("\n").trim()) {
      noteParagraph(pendingPid, paragraphLines);
    }
    pendingPid = "";
  }
  return { content, index };
}

function parseMarkdown(body) {
  const source = String(body ?? "");
  const lines = source.split("\n");
  const { content } = parseBlocks(lines, 0, lines.length, false);
  return { type: "doc", content };
}

function splitTableRow(line) {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let buffer = "";
  for (let index = 0; index < withoutEdges.length; index += 1) {
    const char = withoutEdges[index];
    if (char === "\\" && withoutEdges[index + 1] === "|") {
      buffer += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(buffer);
      buffer = "";
    } else {
      buffer += char;
    }
  }
  cells.push(buffer);
  return cells.map((cell) => cell.trim());
}

/* ---------------- 序列化 ---------------- */

/* 转义正文里的字面字符，避免与链接/强调/行内代码标记冲突。
 * `[` 必须转义：否则“字面 [text](url)”会在下次解析时变成链接。 */
function escapeInline(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/`/g, "\\`");
}

function escapeCell(text) {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/* 行内代码：内容含反引号时用更长的一串反引号包裹。 */
function codeDelimiter(text) {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    if (char === "`") {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return "`".repeat(longest + 1);
}

function serializeInline(nodes) {
  let output = "";
  for (const node of nodes || []) {
    if (node.type === "hard_break") {
      output += "\n";
    } else if (node.type === "image") {
      output += `![${node.alt ?? ""}](${node.src})`;
    } else if (node.type === "code") {
      const delimiter = codeDelimiter(node.text ?? "");
      output += `${delimiter}${node.text ?? ""}${delimiter}`;
    } else if (node.type === "link") {
      const inner = serializeInline(node.content);
      const title = node.title ? ` "${node.title}"` : "";
      output += `[${inner}](${node.href}${title})`;
    } else {
      const text = escapeInline(node.text ?? "");
      const marks = node.marks || [];
      const strong = marks.includes("strong");
      const em = marks.includes("em");
      if (strong && em) output += `***${text}***`;
      else if (strong) output += `**${text}**`;
      else if (em) output += `*${text}*`;
      else output += text;
    }
  }
  return output;
}

function serializeBlock(block, options = {}) {
  switch (block.type) {
    case "paragraph": {
      const prefix = block.pid && !options.stripPid ? `<!-- paragraph-id:${block.pid} -->\n\n` : "";
      const body = serializeInline(block.content);
      if (block.align === "center" || block.align === "right") {
        return `${prefix}{{< align ${block.align} >}}\n\n${body}\n\n{{< /align >}}`;
      }
      return prefix + body;
    }
    case "heading":
      return `${"#".repeat(block.level || 1)} ${serializeInline(block.content)}`;
    case "blockquote":
      return serializeInline(block.content)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "bullet_list":
      return (block.content || []).map((item) => `- ${serializeInline(item.content)}`).join("\n");
    case "ordered_list":
      return (block.content || []).map((item) => `1. ${serializeInline(item.content)}`).join("\n");
    case "table": {
      const rows = (block.content || []).map((row) =>
        (row.content || []).map((cell) => escapeCell(serializeInline(cell.content))),
      );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const padded = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
      const lines = [`| ${padded[0].join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
      for (const row of padded.slice(1)) {
        lines.push(`| ${row.join(" | ")} |`);
      }
      return lines.join("\n");
    }
    case "image":
      return `![${block.alt ?? ""}](${block.src})`;
    case "code_block": {
      let longest = 0;
      let run = 0;
      for (const char of block.text || "") {
        if (char === "`") {
          run += 1;
          longest = Math.max(longest, run);
        } else {
          run = 0;
        }
      }
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `${fence}${block.info || ""}\n${block.text || ""}\n${fence}`;
    }
    case "poetry_block":
    case "endnote_block": {
      const name = block.type === "poetry_block" ? "poetry" : "endnote";
      // 容器内段落不挂段评锚点（stripPid）
      const inner = (block.content || [])
        .map((child) => serializeBlock(child, { stripPid: true }))
        .filter((part) => part !== "")
        .join("\n\n");
      return inner
        ? `{{< ${name} >}}\n\n${inner}\n\n{{< /${name} >}}`
        : `{{< ${name} >}}\n\n{{< /${name} >}}`;
    }
    default:
      return "";
  }
}

function serializeMarkdown(jsonDoc) {
  const parts = (jsonDoc?.content || []).map(serializeBlock).filter((part) => part !== "");
  return parts.length ? parts.join("\n\n") + "\n" : "";
}

export { parseMarkdown, serializeMarkdown };
