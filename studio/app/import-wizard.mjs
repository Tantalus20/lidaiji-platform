/* Word 导入向导：六步流程（选择/解析/报告/元数据/预览/确认）。 */
import { api } from "./api.mjs";
import { $, $$, globalError, hideError, showError, MAX_SIZE, SLUG_PATTERN } from "./util.mjs";
import { state } from "./state.mjs";

/* ---------------- Word 导入向导（迁入 #/import 路由） ---------------- */

function gotoStep(number) {
  $$("#view-import .panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#step-${number}`).classList.remove("hidden");
  $$("#stepNav .step").forEach((button) => {
    const step = Number(button.dataset.step);
    button.classList.toggle("current", step === number);
    button.disabled = step > number;
  });
  globalError("");
  window.scrollTo({ top: 0 });
}

/* 第 1 步：选择文件 */

const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

function describeSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pickFile(file) {
  const info = $("#fileInfo");
  const button = $("#startParse");
  if (!file) {
    info.classList.add("hidden");
    button.disabled = true;
    state.file = null;
    return;
  }
  if (!file.name.toLowerCase().endsWith(".docx")) {
    info.textContent = "只接受 .docx 文件（Word 2007 及以后的新格式）。";
    info.className = "file-info invalid";
    button.disabled = true;
    state.file = null;
    return;
  }
  if (file.size > MAX_SIZE) {
    info.textContent = `文件 ${describeSize(file.size)}，超过 100MB 上限。`;
    info.className = "file-info invalid";
    button.disabled = true;
    state.file = null;
    return;
  }
  state.file = file;
  info.textContent = `${file.name}（${describeSize(file.size)}）`;
  info.className = "file-info valid";
  button.disabled = false;
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => pickFile(fileInput.files[0]));
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  pickFile(event.dataTransfer.files[0]);
});

/* 第 2 步：解析 */

function setProgress(doneKeys, failed) {
  $$("#progressList li").forEach((item) => {
    item.classList.toggle("done", doneKeys.includes(item.dataset.key));
    item.classList.toggle("failed", failed === item.dataset.key);
  });
}

$("#startParse").addEventListener("click", async () => {
  if (!state.file) return;
  gotoStep(2);
  hideError($("#parseError"));
  $("#parseBack").classList.add("hidden");
  setProgress(["read"], null);
  const form = new FormData();
  form.append("file", state.file, state.file.name);
  try {
    const response = await fetch("/api/import/inspect", {
      method: "POST",
      headers: { "X-Studio-Request": "1" },
      body: form,
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
    }
    for (const key of ["body", "images", "report", "risk"]) {
      setProgress(["read", "body", "images", "report", "risk"].slice(0, ["read", "body", "images", "report", "risk"].indexOf(key) + 1), null);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    state.token = payload.token;
    state.report = payload.report;
    state.plan = null;
    state.committed = null;
    renderReport();
    prefillForm();
    gotoStep(3);
  } catch (error) {
    setProgress([], "read");
    showError($("#parseError"), error.message || "解析失败，请确认文件是有效的 .docx。");
    $("#parseBack").classList.remove("hidden");
  }
});

$("#parseBack").addEventListener("click", () => gotoStep(1));

/* 第 3 步：导入报告 */

function warningList(container, warnings) {
  container.textContent = "";
  if (!warnings || !warnings.length) {
    const p = document.createElement("p");
    p.className = "ok-text";
    p.textContent = "没有发现需要检查的问题。";
    container.appendChild(p);
    return;
  }
  const title = document.createElement("h3");
  title.textContent = `需要检查（${warnings.length} 项）`;
  const list = document.createElement("ul");
  list.className = "warnings";
  warnings.forEach((warning) => {
    const item = document.createElement("li");
    item.textContent = warning.location ? `${warning.message}（位置：${warning.location}）` : warning.message;
    list.appendChild(item);
  });
  container.appendChild(title);
  container.appendChild(list);
}

function conflictList(container, conflicts) {
  container.textContent = "";
  if (!conflicts || !conflicts.length) return;
  const box = document.createElement("div");
  box.className = "error-box";
  const title = document.createElement("strong");
  title.textContent = `发现 ${conflicts.length} 处冲突：`;
  const list = document.createElement("ul");
  conflicts.forEach((conflict) => {
    const item = document.createElement("li");
    item.textContent = conflict.message;
    list.appendChild(item);
  });
  box.appendChild(title);
  box.appendChild(list);
  container.appendChild(box);
}

function renderReport() {
  const report = state.report;
  const doc = report.document;
  const stats = [
    ["建议标题", doc.suggestedTitle || "（未能推断，请手动填写）"],
    ["建议目录", report.suggested && report.suggested.url ? report.suggested.url : `${doc.suggestedSection || "essays"}/${doc.suggestedSlug || "?"}`],
    ["字数", `约 ${doc.wordCount} 字`],
    ["段落数", doc.paragraphCount],
    ["标题数", doc.headingCount],
    ["图片数", doc.imageCount],
    ["脚注数", doc.footnoteCount],
    ["未识别样式", report.warnings.filter((w) => w.code === "unknown-style").length],
  ];
  const dl = $("#reportStats");
  dl.textContent = "";
  stats.forEach(([key, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = String(value);
    dl.appendChild(dt);
    dl.appendChild(dd);
  });
  warningList($("#reportWarnings"), report.warnings);
  conflictList($("#reportConflicts"), []);
}

/* 第 4 步：元数据 */

const form = $("#metaForm");

function prefillForm() {
  const doc = state.report.document;
  form.title.value = doc.suggestedTitle || "";
  form.slug.value = doc.suggestedSlug || "";
  form.section.value = doc.suggestedSection || "essays";
  form.collectionName.value = doc.suggestedCollection || "";
  form.collectionSlug.value = doc.suggestedCollectionSlug || "";
  form.description.value = "";
  form.date.value = "";
  form.weight.value = "10";
  form.articleId.value = "";
  form.draft.checked = true;
  const select = form.collectionExisting;
  select.textContent = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "—— 新建文集 ——";
  select.appendChild(empty);
  (state.report.collections || []).forEach((collection) => {
    const option = document.createElement("option");
    option.value = collection.slug;
    option.textContent = collection.title;
    option.dataset.title = collection.title;
    select.appendChild(option);
    if (collection.slug === doc.suggestedCollectionSlug) select.value = collection.slug;
  });
  toggleCollectionFields();
  toggleDraftWarning();
}

function toggleCollectionFields() {
  $("#collectionFields").classList.toggle("hidden", form.section.value !== "works");
}

function toggleDraftWarning() {
  $("#draftWarning").classList.toggle("hidden", form.draft.checked);
}

form.section.addEventListener("change", toggleCollectionFields);
form.draft.addEventListener("change", toggleDraftWarning);
form.collectionExisting.addEventListener("change", () => {
  const selected = form.collectionExisting.selectedOptions[0];
  if (selected && selected.value) {
    form.collectionName.value = selected.dataset.title || selected.textContent;
    form.collectionSlug.value = selected.value;
  }
});

$("#metaNext").addEventListener("click", async () => {
  hideError($("#metaError"));
  conflictList($("#metaConflicts"), []);
  const slug = form.slug.value.trim();
  if (!SLUG_PATTERN.test(slug)) {
    showError($("#metaError"), "slug 只能使用小写英文字母、数字和连字符，且不能以连字符开头或结尾。");
    return;
  }
  if (form.section.value === "works") {
    if (!form.collectionName.value.trim()) {
      showError($("#metaError"), "栏目为“作品”时必须填写文集名称。");
      return;
    }
    if (form.collectionSlug.value.trim() && !SLUG_PATTERN.test(form.collectionSlug.value.trim())) {
      showError($("#metaError"), "文集 slug 格式不正确。");
      return;
    }
  }
  const metadata = {
    title: form.title.value.trim(),
    subtitle: form.subtitle.value.trim(),
    slug,
    section: form.section.value,
    collections: form.section.value === "works" && form.collectionName.value.trim() ? [form.collectionName.value.trim()] : [],
    collectionSlug: form.section.value === "works" ? form.collectionSlug.value.trim() : "",
    description: form.description.value.trim(),
    date: form.date.value,
    weight: Number(form.weight.value || 10),
    draft: form.draft.checked,
    articleId: form.articleId.value.trim(),
  };
  if (!metadata.title) {
    showError($("#metaError"), "请填写标题。");
    return;
  }
  try {
    const payload = await api("/api/import/plan", { token: state.token, metadata });
    state.plan = payload.plan;
    state.previewHtml = payload.previewHtml;
    state.assetUrls = payload.assetUrls;
    if (payload.plan.conflicts && payload.plan.conflicts.length) {
      conflictList($("#metaConflicts"), payload.plan.conflicts);
      showError($("#metaError"), "存在冲突，禁止下一步。请修改 slug 或文集后重试。");
      return;
    }
    renderPreview();
    renderConfirm();
    gotoStep(5);
  } catch (error) {
    showError($("#metaError"), error.message);
  }
});

/* 第 5 步：预览 */

function renderPreview() {
  $("#rendered").innerHTML = state.previewHtml;
  $("#markdownSource").textContent = state.plan.markdown;
  const wall = $("#imageWall");
  wall.textContent = "";
  if (!state.assetUrls.length) {
    const p = document.createElement("p");
    p.textContent = "本文没有图片。";
    wall.appendChild(p);
  }
  state.assetUrls.forEach((asset) => {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.src = asset.url;
    img.alt = asset.name;
    img.loading = "lazy";
    const caption = document.createElement("figcaption");
    caption.textContent = asset.name;
    figure.appendChild(img);
    figure.appendChild(caption);
    wall.appendChild(figure);
  });
  // 警告可点击定位到对应段落（近似渲染中高亮）
  const box = $("#previewWarnings");
  box.textContent = "";
  if (state.plan.warnings && state.plan.warnings.length) {
    const title = document.createElement("h3");
    title.textContent = "需要检查（点击定位到对应段落）";
    const list = document.createElement("ul");
    list.className = "warnings clickable";
    state.plan.warnings.forEach((warning) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link";
      button.textContent = warning.location ? `${warning.message}（位置：${warning.location}）` : warning.message;
      button.addEventListener("click", () => locateWarning(warning));
      item.appendChild(button);
      list.appendChild(item);
    });
    box.appendChild(title);
    box.appendChild(list);
  }
}

function locateWarning(warning) {
  const matched = /第(\d+)段/.exec(warning.location || warning.message || "");
  switchTab("render");
  $$("#rendered .highlight").forEach((el) => el.classList.remove("highlight"));
  if (!matched) return;
  const target = Number(matched[1]);
  const blocks = $$("#rendered .block");
  let best = null;
  blocks.forEach((el) => {
    if (Number(el.dataset.block) <= target) best = el;
  });
  best = best || blocks[0];
  if (best) {
    best.classList.add("highlight");
    best.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function switchTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("current", tab.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));

async function startHugoPreview(statusEl) {
  statusEl.textContent = "正在启动…";
  try {
    const payload = await api("/api/system/preview", { action: "start" });
    if (payload.preview && payload.preview.running) {
      statusEl.textContent = `预览已启动：${payload.preview.url}（含草稿）`;
      window.open(payload.preview.url, "_blank");
    } else {
      statusEl.textContent = "预览进程已退出，请检查 1313 端口是否被占用。";
    }
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

$("#openHugoPreview").addEventListener("click", () => startHugoPreview($("#previewStatus")));

/* 第 6 步：确认写入 */

function renderConfirm() {
  const list = $("#proposedFiles");
  list.textContent = "";
  (state.plan.proposedFiles || []).forEach((file) => {
    const item = document.createElement("li");
    item.textContent = file;
    list.appendChild(item);
  });
  const conflicts = (state.plan && state.plan.conflicts) || [];
  conflictList($("#commitConflicts"), conflicts);
  $("#commitButton").disabled = conflicts.length > 0;
  $("#commitSuccess").classList.add("hidden");
  $("#commitActions").classList.remove("hidden");
  hideError($("#commitError"));
}

$("#commitButton").addEventListener("click", async () => {
  hideError($("#commitError"));
  $("#commitButton").disabled = true;
  try {
    const payload = await api("/api/import/commit", { token: state.token });
    state.committed = payload.result;
    $("#commitResult").textContent = `《${payload.result.title}》已写入 ${payload.result.target}/（约 ${payload.result.wordCount} 字，${payload.result.imageCount} 张图片，草稿状态）。`;
    $("#commitActions").classList.add("hidden");
    $("#commitSuccess").classList.remove("hidden");
  } catch (error) {
    $("#commitButton").disabled = false;
    showError($("#commitError"), error.message);
  }
});

$("#abortButton").addEventListener("click", async () => {
  try {
    await api("/api/import/abort", { token: state.token });
  } catch (error) {
    // 会话可能已过期，直接重置即可
  }
  resetAll();
});

$("#openFolder").addEventListener("click", async () => {
  try {
    await api("/api/system/open-folder", { token: state.token });
  } catch (error) {
    globalError(error.message);
  }
});

$("#viewMarkdown").addEventListener("click", () => {
  gotoStep(5);
  switchTab("markdown");
});

$("#openPreview").addEventListener("click", () => startHugoPreview($("#previewStatus")));

function resetAll() {
  state.file = null;
  state.token = "";
  state.report = null;
  state.plan = null;
  state.previewHtml = "";
  state.assetUrls = [];
  state.committed = null;
  pickFile(null);
  gotoStep(1);
}

$$("#view-import [data-goto]").forEach((button) =>
  button.addEventListener("click", () => gotoStep(Number(button.dataset.goto)))
);
