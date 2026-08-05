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
    refreshPublishStatus();
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
    refreshPublishStatus();
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

/* ---------------- 文章发布闭环（v0.2.2） ---------------- */

const publishState = {
  status: null,
  preview: null,
  pollTimer: 0,
  dialogData: null,
};

const PUBLISH_STAGE_LABELS = {
  validating: "正在校验",
  building: "正在构建",
  "backing-up": "正在备份",
  uploading: "正在上传",
  switching: "正在切换版本",
  verifying: "正在验证",
};

function fmtTime(seconds) {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderPublishBar() {
  const bar = $("#publishBar");
  if (!publishState.status) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const status = publishState.status;
  const live = status.publishedRevision;
  $("#pubDraftState").textContent = status.draft ? "草稿" : "已发布";
  $("#pubSavedAt").textContent = `最后保存：${fmtTime(status.lastSavedAt)}`;
  $("#pubPreviewState").textContent = status.previewFresh ? "预览：已生成（最新）" : "预览：未生成或已过期";
  $("#pubLiveVersion").textContent = live
    ? `线上版本：${live.slice(-8)}（${fmtTime(new Date(status.publishedAt || 0).getTime() / 1000)}）`
    : "线上版本：尚未发布";
  const unsaved = $("#pubUnsaved");
  unsaved.classList.toggle("hidden", !editState.dirty);
  const history = $("#publishHistory");
  const list = $("#publishHistoryList");
  list.textContent = "";
  if (status.history && status.history.length) {
    history.classList.remove("hidden");
    status.history.slice().reverse().forEach((entry) => {
      const item = document.createElement("li");
      const revision = document.createElement("strong");
      revision.textContent = String(entry.revision || "").slice(-8);
      item.appendChild(revision);
      const meta = document.createElement("span");
      meta.className = "meta-text";
      const statusText = entry.status === "ok" ? "成功" : entry.status === "running" ? "进行中" : `失败(${entry.status})`;
      meta.textContent = ` ${statusText} · ${entry.completedAt || entry.createdAt || ""} ${entry.releaseId ? "· " + entry.releaseId : ""}`;
      item.appendChild(meta);
      list.appendChild(item);
    });
  } else {
    history.classList.add("hidden");
  }
}

function renderPublishStage() {
  const stage = $("#publishStage");
  const lock = publishState.status && publishState.status.lock;
  if (lock && lock.inFlight) {
    stage.classList.remove("hidden");
    $("#publishStageText").textContent = `${PUBLISH_STAGE_LABELS[lock.stage] || "正在发布"}…（同一时间只允许一个发布任务）`;
  } else if (lock && lock.status === "failed_recovery") {
    stage.classList.remove("hidden");
    $("#publishStageText").textContent = "检测到上次发布进程异常退出：状态未知，请人工核验后再操作。";
  } else {
    stage.classList.add("hidden");
  }
}

function renderPublishResult() {
  const box = $("#publishResult");
  const result = publishState.status && publishState.status.result;
  if (!result || result.articleId !== (publishState.status && publishState.status.articleId)) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  if (result.ok) {
    $("#publishResultTitle").textContent = `发布成功：${publishState.status.slug || ""}`;
    $("#publishResultMeta").textContent =
      `正式网址 ${result.canonicalUrl || ""} · 发布时间 ${result.completedAt || ""} · ` +
      `release ${result.releaseId || "—"} · 文章版本 ${String(result.revision || "").slice(-8)}`;
    $("#publishResultOpen").href = result.canonicalUrl || "#";
    $("#publishResultLog").textContent = result.output || "（无日志）";
  } else {
    $("#publishResultTitle").textContent = `发布失败：${result.error || "未知原因"}`;
    $("#publishResultMeta").textContent = "请查看日志；服务器仍停留在旧版本。";
    $("#publishResultLog").textContent = result.output || result.logTail || "（无日志）";
    $("#publishResultOpen").classList.add("hidden");
    $("#publishResultOpen").classList.add("hidden");
  }
}

async function refreshPublishStatus() {
  if (!editState.path) return;
  try {
    const payload = await apiGet(`/api/article/publish-status?path=${encodeURIComponent(editState.path)}`);
    publishState.status = payload.status;
    renderPublishBar();
    renderPublishStage();
    renderPublishResult();
    const lock = payload.status.lock;
    if (lock && lock.inFlight) {
      publishState.pollTimer = setTimeout(refreshPublishStatus, 2000);
    }
  } catch {
    // 状态读取失败不阻断编辑
  }
}

async function ensureSavedBeforePublish(action) {
  if (editState.dirty) {
    showError($("#editError"), "存在未保存修改：请先保存草稿，再" + action + "。");
    return false;
  }
  if (!editState.path) {
    showError($("#editError"), "请先打开一篇文章。");
    return false;
  }
  return true;
}

$("#editPublishPreview").addEventListener("click", async () => {
  hideError($("#editError"));
  if (!(await ensureSavedBeforePublish("生成发布预览"))) return;
  const button = $("#editPublishPreview");
  const stage = $("#publishStage");
  button.disabled = true;
  stage.classList.remove("hidden");
  $("#publishStageText").textContent = "正在校验并构建（可能需要一两分钟）…";
  try {
    const payload = await api("/api/article/publish-preview", { path: editState.path });
    stage.classList.add("hidden");
    if (!payload.ok && !payload.gateOnly) {
      const failed = payload.checks.filter((c) => c.status === "FAIL").map((c) => c.name).join("、");
      showError($("#editError"), `发布预览未通过：${failed || "检查失败"}（详见日志尾部）。`);
      $("#publishResultLog").textContent = payload.buildOutput || "";
      return;
    }
    if (payload.gateOnly) {
      showError($("#editError"), "发布预览通过（触发大规模段落调整门禁：请确认后发布）。");
    }
    publishState.preview = payload;
    const anchor = payload.anchor || {};
    const affected = payload.affectedComments === null ? "未知（评论服务不可达）" : `${payload.affectedComments} 条`;
    showError($("#editError"), "");
    $("#editError").classList.add("hidden");
    $("#pubPreviewState").textContent = "预览：已生成（最新）";
    const pass = payload.checks.filter((c) => c.status === "PASS").length;
    const warn = payload.checks.filter((c) => c.status === "WARNING").length;
    const baseline = payload.baseline || {};
    const dirty = payload.unrelatedDirty || { count: 0 };
    const lines = [
      `发布预览已生成：${payload.canonicalUrl}`,
      `段落变化：保持 ${anchor.retained} · 新增 ${anchor.created} · 转历史 ${anchor.deleted}`,
      `受影响段评：${affected}`,
      `线上基线：内容提交 ${baseline.privateContentCommit || "—"}（校验 ${baseline.verifiedArticles ?? "?"} 篇）`,
      `无关文章候选差异：${payload.candidate ? payload.candidate.unrelatedChangedCount : "—"}（必须为 0）`,
      dirty.count ? `作者工作区另有 ${dirty.count} 个未提交文件，不会进入本次发布候选。` : "作者工作区无无关未提交文件。",
      `检查 ${pass} 项通过 / ${warn} 项警告`,
    ];
    $("#publishStageText").textContent = lines.join(" | ");
    stage.classList.remove("hidden");
    window.open(payload.previewUrl, "_blank", "noopener");
  } catch (error) {
    stage.classList.add("hidden");
    showError($("#editError"), error.message);
  } finally {
    button.disabled = false;
  }
});

$("#editPublish").addEventListener("click", async () => {
  hideError($("#editError"));
  if (!(await ensureSavedBeforePublish("确认发布"))) return;
  await refreshPublishStatus();
  if (publishState.status && publishState.status.lock && publishState.status.lock.inFlight) {
    showError($("#editError"), "已有发布任务正在进行，请等待完成。");
    return;
  }
  const status = publishState.status;
  if (!status || !status.previewFresh) {
    showError($("#editError"), "请先生成发布预览（草稿保存后预览才有效）。");
    return;
  }
  if (status.draft) {
    showError($("#editError"), "文章仍为草稿状态：请先在元数据中取消勾选「草稿」并保存，再生成预览与发布。");
    return;
  }
  publishState.dialogData = status;
  const gate = publishState.preview && publishState.preview.largeRetireGate;
  $("#pdLargeRetireWrap").classList.toggle("hidden", !gate);
  $("#pdLargeRetire").checked = false;
  $("#pdTitle").textContent = status.slug || "—";
  $("#pdUrl").textContent = status.canonicalUrl || "—";
  $("#pdLiveAt").textContent = status.publishedAt ? fmtTime(new Date(status.publishedAt).getTime() / 1000) : "尚未发布";
  $("#pdDraftAt").textContent = fmtTime(status.lastSavedAt);
  $("#pdAnchor").textContent = "发布时将按保存草稿的段落结构同步（保持/新增/转历史以预览结果为准）。";
  $("#pdChecks").textContent = "发布前将再次执行完整构建检查与服务器校验。";
  $("#publishDialog").classList.remove("hidden");
});

$("#publishDialogNo").addEventListener("click", () => {
  $("#publishDialog").classList.add("hidden");
  publishState.dialogData = null;
});

$("#publishDialogYes").addEventListener("click", async () => {
  const status = publishState.dialogData;
  $("#publishDialog").classList.add("hidden");
  if (!status) return;
  publishState.dialogData = null;
  const idempotencyKey = `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const payload = await api("/api/article/publish", {
      path: editState.path,
      draftRevision: status.revision,
      previewBuildId: publishState.preview ? publishState.preview.previewBuildId : "",
      snapshotId: publishState.preview ? publishState.preview.snapshotId : "",
      idempotencyKey,
      allowLargeRetire: $("#pdLargeRetire").checked === true,
    });
    $("#publishStage").classList.remove("hidden");
    $("#publishStageText").textContent = "正在发布…";
    await refreshPublishStatus();
    if (payload.task && payload.task.inFlight) {
      // 轮询已由 refreshPublishStatus 在锁存在时启动
      $("#publishStageText").textContent = `${PUBLISH_STAGE_LABELS[payload.task.stage] || "正在发布"}…`;
    }
  } catch (error) {
    showError($("#editError"), error.message);
  }
});

$("#publishResultCopy").addEventListener("click", async () => {
  const result = publishState.status && publishState.status.result;
  const url = (result && result.canonicalUrl) || "";
  try {
    await navigator.clipboard.writeText(url);
    $("#publishResultCopy").textContent = "已复制";
    setTimeout(() => { $("#publishResultCopy").textContent = "复制文章网址"; }, 1500);
  } catch {
    // 剪贴板不可用时忽略
  }
});

