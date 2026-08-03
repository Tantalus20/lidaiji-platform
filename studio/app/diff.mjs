/* Diff 渲染器（版本/历史共用）。 */

/* ---------------- Diff 渲染器（版本/历史共用） ---------------- */

const DIFF_ANCHOR = /<!--\s*\/?\s*paragraph-id/;

function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let hunk = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const matched = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { name: matched ? matched[2] : line.slice(11), hunks: [] };
      files.push(current);
      hunk = null;
    } else if (line.startsWith("@@")) {
      const matched = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      hunk = { at: matched ? Number(matched[1]) : 0, lines: [] };
      if (current) current.hunks.push(hunk);
    } else if (hunk && /^[ +\\-]/.test(line)) {
      hunk.lines.push(line);
    }
  }
  return files;
}

function diffLineElement(line) {
  const element = document.createElement("div");
  element.className = "diff-line";
  const sign = line[0];
  if (sign === "+") element.classList.add("diff-add");
  else if (sign === "-") element.classList.add("diff-del");
  else if (sign === "\\") element.classList.add("diff-meta");
  element.textContent = line;
  return element;
}

function renderDiff(container, diffText, note) {
  container.textContent = "";
  container.classList.remove("hidden");
  if (note) {
    const hint = document.createElement("p");
    hint.className = "meta-text";
    hint.textContent = note;
    container.appendChild(hint);
  }
  if (!diffText || !diffText.trim()) {
    if (!note) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = "没有差异。";
      container.appendChild(empty);
    }
    return;
  }
  const files = parseUnifiedDiff(diffText);
  for (const file of files) {
    const fileBox = document.createElement("div");
    fileBox.className = "diff-file";
    const name = document.createElement("div");
    name.className = "diff-file-name";
    name.textContent = file.name;
    fileBox.appendChild(name);
    for (const hunk of file.hunks) {
      const label = document.createElement("div");
      label.className = "diff-hunk";
      label.textContent = hunk.at ? `第 ${hunk.at} 行附近` : "（位置未知）";
      fileBox.appendChild(label);
      let anchorRun = [];
      const flushAnchors = () => {
        if (!anchorRun.length) return;
        const hidden = anchorRun.map((line) => {
          const element = diffLineElement(line);
          element.classList.add("hidden");
          return element;
        });
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "diff-anchor-toggle";
        toggle.textContent = `段评锚点（已隐藏 ×${anchorRun.length}）`;
        toggle.addEventListener("click", () => {
          const collapsed = hidden[0].classList.contains("hidden");
          hidden.forEach((element) => element.classList.toggle("hidden", !collapsed));
          toggle.textContent = collapsed ? `段评锚点（点击折叠 ×${anchorRun.length}）` : `段评锚点（已隐藏 ×${anchorRun.length}）`;
        });
        fileBox.appendChild(toggle);
        hidden.forEach((element) => fileBox.appendChild(element));
        anchorRun = [];
      };
      for (const line of hunk.lines) {
        if (DIFF_ANCHOR.test(line.slice(1))) {
          anchorRun.push(line);
        } else {
          flushAnchors();
          fileBox.appendChild(diffLineElement(line));
        }
      }
      flushAnchors();
    }
    container.appendChild(fileBox);
  }
  const rawToggle = document.createElement("button");
  rawToggle.type = "button";
  rawToggle.className = "secondary small";
  rawToggle.textContent = "显示完整原始 diff";
  const raw = document.createElement("pre");
  raw.className = "log-box hidden";
  raw.textContent = diffText;
  rawToggle.addEventListener("click", () => {
    const show = raw.classList.contains("hidden");
    raw.classList.toggle("hidden", !show);
    rawToggle.textContent = show ? "隐藏完整原始 diff" : "显示完整原始 diff";
  });
  container.appendChild(rawToggle);
  container.appendChild(raw);
}

export { renderDiff };

