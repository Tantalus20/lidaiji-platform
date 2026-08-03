/* 编辑页：所见即所得编辑器、自动保存、本地草稿恢复、预览/源码切换。 */
import { api, apiGet } from "./api.mjs";
import { $, debounce, hideError, showError, LIST_FIELDS } from "./util.mjs";
import { editState } from "./state.mjs";
import { decoratePreviewNotes, loadNotes } from "./notes.mjs";

/* ---------------- 编辑页 ---------------- */

function clientWordCount(text) {
  const plain = text.replace(/<!--[\s\S]*?-->/g, "");
  const cjk = (plain.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
  const latin = (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

/* 编辑器实例与保存状态（自动保存、本地草稿恢复都在这一层）。 */
let studioEditor = null;
let pendingDraft = "";
const AUTOSAVE_DELAY = 1200;
const DRAFT_WRITE_DELAY = 1500;

editState.articleId = "";
editState.saving = false;
editState.saveVersion = 0;
editState.autosaveTimer = 0;
editState.draftTimer = 0;

function draftKey() {
  const base = editState.articleId || editState.path.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `lidaiji.studio.draft.${base}`;
}

function readLocalDraft() {
  if (!editState.path) return "";
  try {
    return localStorage.getItem(draftKey()) || "";
  } catch {
    return "";
  }
}

function writeLocalDraft(markdown) {
  if (!editState.path) return;
  try {
    localStorage.setItem(draftKey(), markdown);
  } catch {
    // 本地存储不可用时忽略；不阻塞写作
  }
}

function clearLocalDraft() {
  if (!editState.path) return;
  try {
    localStorage.removeItem(draftKey());
  } catch {
    // 忽略
  }
}

function setSaveStatus(text, kind) {
  const el = $("#editSaveStatus");
  el.textContent = text;
  el.classList.toggle("saved", kind === "saved");
  el.classList.toggle("failed", kind === "failed");
  el.classList.toggle("saving", kind === "saving");
  $("#editSaveRetry").classList.toggle("hidden", kind !== "failed");
}

function updateWordCount() {
  if (studioEditor) {
    $("#editWordCount").textContent = `约 ${clientWordCount(studioEditor.getMarkdown())} 字`;
  }
}

function markDirty() {
  editState.dirty = true;
  setSaveStatus("尚未保存", "");
  updateWordCount();
  scheduleDraftWrite();
}

function scheduleDraftWrite() {
  clearTimeout(editState.draftTimer);
  editState.draftTimer = setTimeout(() => {
    if (studioEditor) writeLocalDraft(studioEditor.getMarkdown());
  }, DRAFT_WRITE_DELAY);
}

function scheduleAutosave() {
  clearTimeout(editState.autosaveTimer);
  editState.autosaveTimer = setTimeout(() => {
    saveArticle();
  }, AUTOSAVE_DELAY);
}

function updateToolbarState(info) {
  if (!info) return;
  $("#tbUndo").disabled = !info.canUndo;
  $("#tbRedo").disabled = !info.canRedo;
  $("#tbBold").setAttribute("aria-pressed", info.bold ? "true" : "false");
  $("#tbItalic").setAttribute("aria-pressed", info.em ? "true" : "false");
  $("#tbAlignLeft").setAttribute("aria-pressed", info.align === null || info.align === "left" ? "true" : "false");
  $("#tbAlignCenter").setAttribute("aria-pressed", info.align === "center" ? "true" : "false");
  $("#tbAlignRight").setAttribute("aria-pressed", info.align === "right" ? "true" : "false");
  $("#tbPoetry").setAttribute("aria-pressed", info.inPoetry ? "true" : "false");
  $("#tbEndnote").setAttribute("aria-pressed", info.inEndnote ? "true" : "false");
}

function ensureEditor() {
  if (studioEditor) return studioEditor;
  studioEditor = LidaijiEditor.createStudioEditor($("#editorHost"), {
    onUpdate: () => {
      markDirty();
      scheduleAutosave();
    },
    onSelection: updateToolbarState,
  });
  return studioEditor;
}

function showEditorMode(mode) {
  $("#editorHost").classList.toggle("hidden", mode !== "edit");
  $("#editorPreviewWrap").classList.toggle("hidden", mode !== "preview");
  $("#editorSourceWrap").classList.toggle("hidden", mode !== "source");
}

async function saveArticle() {
  if (!editState.path || !studioEditor) return;
  if (editState.saving) return;
  const body = studioEditor.getMarkdown();
  if (!body.trim()) {
    setSaveStatus("正文为空，未保存", "failed");
    return;
  }
  editState.saving = true;
  editState.saveVersion = studioEditor.version();
  setSaveStatus("正在保存", "saving");
  try {
    const payload = await api("/api/article/save", {
      path: editState.path,
      frontMatter: readFmForm(),
      body,
    });
    if (editState.saveVersion !== studioEditor.version()) {
      // 保存请求期间正文又发生了变化：文件里是旧内容，稍后自动再保存一次；
      // 不替换文档，避免覆盖作者正在输入的新内容。
      editState.dirty = true;
      setSaveStatus("内容已变化，正在再次保存…", "saving");
      scheduleAutosave();
      return;
    }
    studioEditor.replaceDocKeepCursor(payload.body);
    editState.dirty = false;
    clearLocalDraft();
    $("#editDraftBadge").classList.toggle("hidden", !payload.article.draft);
    $("#fmArticleRevision").textContent = payload.article.articleRevision || "—";
    setSaveStatus(
      `已保存（新增锚点 ${payload.anchors.created} 个，保留 ${payload.anchors.retained} 个）`,
      "saved",
    );
  } catch (error) {
    setSaveStatus("保存失败", "failed");
    showError($("#editError"), error.message);
  } finally {
    editState.saving = false;
  }
}

function maybeOfferDraft(diskBody) {
  pendingDraft = "";
  const draft = readLocalDraft();
  if (!draft) return;
  if (draft === diskBody) {
    // 磁盘内容与本地草稿一致，草稿已无价值
    clearLocalDraft();
    return;
  }
  pendingDraft = draft;
  $("#draftBar").classList.remove("hidden");
}

function fillFmForm(fm) {
  const form = $("#fmForm");
  form.title.value = fm.title || "";
  form.subtitle.value = fm.subtitle || "";
  form.description.value = fm.description || "";
  form.date.value = String(fm.date || "").slice(0, 10);
  form.weight.value = fm.weight ?? 10;
  form.draft.checked = Boolean(fm.draft);
  form.featured.checked = Boolean(fm.featured);
  for (const key of LIST_FIELDS) {
    const value = fm[key];
    form[key].value = Array.isArray(value) ? value.join("，") : value || "";
  }
  $("#fmSlug").textContent = fm.slug || "—";
  $("#fmArticleId").textContent = fm.articleId || "—";
  $("#fmArticleRevision").textContent = fm.articleRevision || "—";
}

function readFmForm() {
  const form = $("#fmForm");
  const fm = {
    title: form.title.value.trim(),
    subtitle: form.subtitle.value.trim(),
    description: form.description.value.trim(),
    draft: form.draft.checked,
    featured: form.featured.checked,
    weight: Number(form.weight.value || 10),
  };
  if (form.date.value) fm.date = form.date.value;
  for (const key of LIST_FIELDS) {
    fm[key] = form[key].value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  }
  return fm;
}

const refreshEditorPreview = debounce(async () => {
  if (!studioEditor) return;
  const preview = $("#editorPreview");
  try {
    const payload = await api("/api/render", { markdown: studioEditor.getMarkdown() });
    preview.innerHTML = payload.html;
    decoratePreviewNotes();
  } catch (error) {
    preview.textContent = `预览渲染失败：${error.message}`;
  }
}, 300);

async function openEditor(path) {
  hideError($("#editError"));
  $("#draftBar").classList.add("hidden");
  pendingDraft = "";
  setSaveStatus("", "");
  editState.path = "";
  editState.articleId = "";
  editState.dirty = false;
  clearTimeout(editState.autosaveTimer);
  clearTimeout(editState.draftTimer);
  try {
    const payload = await apiGet(`/api/article?path=${encodeURIComponent(path)}`);
    const article = payload.article;
    editState.path = article.path;
    editState.articleId = article.frontMatter.articleId || "";
    const editor = ensureEditor();
    editor.setMarkdown(article.body);
    editState.dirty = false;
    const fm = article.frontMatter;
    $("#editTitle").textContent = fm.subtitle ? `${fm.title} · ${fm.subtitle}` : fm.title || "（未命名）";
    $("#editDraftBadge").classList.toggle("hidden", !fm.draft);
    fillFmForm(fm);
    setSaveStatus("已保存", "saved");
    showEditorMode("edit");
    updateWordCount();
    updateToolbarState({ canUndo: false, canRedo: false, bold: false, em: false });
    loadNotes();
    maybeOfferDraft(article.body);
    editor.focus();
  } catch (error) {
    editState.path = "";
    showError($("#editError"), error.message);
  }
}

/* 工具栏：mousedown 阻止默认行为，避免点击按钮时丢失正文选区。 */
for (const id of [
  "tbUndo",
  "tbRedo",
  "tbBold",
  "tbItalic",
  "tbAlignLeft",
  "tbAlignCenter",
  "tbAlignRight",
  "tbPoetry",
  "tbEndnote",
]) {
  const button = $(`#${id}`);
  button.addEventListener("mousedown", (event) => event.preventDefault());
}

$("#tbUndo").addEventListener("click", () => {
  if (studioEditor) studioEditor.undo();
});
$("#tbRedo").addEventListener("click", () => {
  if (studioEditor) studioEditor.redo();
});
$("#tbBold").addEventListener("click", () => {
  if (studioEditor) {
    studioEditor.toggleBold();
    studioEditor.focus();
  }
});
$("#tbItalic").addEventListener("click", () => {
  if (studioEditor) {
    studioEditor.toggleEm();
    studioEditor.focus();
  }
});
$("#tbAlignLeft").addEventListener("click", () => {
  if (studioEditor) {
    studioEditor.setAlignment("left");
    studioEditor.focus();
  }
});
$("#tbAlignCenter").addEventListener("click", () => {
  if (studioEditor) {
    studioEditor.setAlignment("center");
    studioEditor.focus();
  }
});
$("#tbAlignRight").addEventListener("click", () => {
  if (studioEditor) {
    studioEditor.setAlignment("right");
    studioEditor.focus();
  }
});
$("#tbPoetry").addEventListener("click", () => {
  if (studioEditor) {
    studioEditor.togglePoetry();
    studioEditor.focus();
  }
});
$("#tbEndnote").addEventListener("click", () => {
  if (studioEditor) {
    studioEditor.toggleEndnote();
    studioEditor.focus();
  }
});
$("#tbPreview").addEventListener("click", async () => {
  showEditorMode("preview");
  await refreshEditorPreview();
});
$("#editorPreviewBack").addEventListener("click", () => showEditorMode("edit"));
$("#tbSource").addEventListener("click", () => {
  $("#editorSource").textContent = studioEditor ? studioEditor.getMarkdown() : "";
  showEditorMode("source");
});
$("#editorSourceBack").addEventListener("click", () => showEditorMode("edit"));

$("#draftRestore").addEventListener("click", () => {
  if (pendingDraft && studioEditor) {
    studioEditor.setMarkdown(pendingDraft);
    editState.dirty = true;
    setSaveStatus("尚未保存", "");
    updateWordCount();
    pendingDraft = "";
  }
  $("#draftBar").classList.add("hidden");
});
$("#draftDiscard").addEventListener("click", () => {
  clearLocalDraft();
  pendingDraft = "";
  $("#draftBar").classList.add("hidden");
});

$("#fmForm").addEventListener("input", markDirty);

$("#editSave").addEventListener("click", async () => {
  hideError($("#editError"));
  await saveArticle();
});

$("#editSaveRetry").addEventListener("click", async () => {
  hideError($("#editError"));
  await saveArticle();
});

$("#editHugoPreview").addEventListener("click", async () => {
  const status = $("#editSaveStatus");
  status.textContent = "正在打开 Hugo 预览…";
  status.classList.remove("saved", "failed", "saving");
  try {
    await api("/api/article/open-page", { path: editState.path });
    status.textContent = editState.dirty ? "已在浏览器打开（未保存的修改不会出现在预览中）" : "已在浏览器打开。";
  } catch (error) {
    status.textContent = error.message;
  }
});

$("#editOpenFolder").addEventListener("click", async () => {
  try {
    await api("/api/system/open-folder", { path: editState.path });
  } catch (error) {
    showError($("#editError"), error.message);
  }
});

export { openEditor, studioEditor, writeLocalDraft };

