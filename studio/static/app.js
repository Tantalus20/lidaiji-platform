/* 《历代纪》作者工作台前端：原生 JS，无框架无构建，hash 路由多视图单页。
   视图：#/ 文章管理、#/edit?path= 编辑、#/new 新建、#/import Word 导入向导。
   所有 POST 都带 X-Studio-Request: 1（服务端 CSRF 防线要求）。
   错误一律显示在页面错误区，不使用浏览器弹窗。 */
"use strict";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SIZE = 100 * 1024 * 1024;
const SECTION_LABELS = { works: "作品", essays: "随笔", archives: "资料" };
const LIST_FIELDS = ["collections", "categories", "tags", "series", "period", "people", "places"];

const state = {
  articles: [],
  searchQuery: "",
  searchResults: null,
  // Word 导入向导状态
  file: null,
  token: "",
  report: null,
  plan: null,
  previewHtml: "",
  assetUrls: [],
  committed: null,
};

const editState = {
  path: "",
  dirty: false,
  pendingHash: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function showError(box, message) {
  box.textContent = message;
  box.classList.remove("hidden");
}

function hideError(box) {
  box.textContent = "";
  box.classList.add("hidden");
}

function globalError(message) {
  const box = $("#globalError");
  if (message) {
    showError(box, message);
  } else {
    hideError(box);
  }
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Studio-Request": "1" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: { code: "internal-error", message: "服务返回了无法理解的响应。" } }));
  if (!payload.ok) {
    const error = new Error((payload.error && payload.error.message) || "请求失败。");
    error.code = payload.error && payload.error.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function apiGet(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({ ok: false, error: { code: "internal-error", message: "服务返回了无法理解的响应。" } }));
  if (!payload.ok) {
    const error = new Error((payload.error && payload.error.message) || "请求失败。");
    error.code = payload.error && payload.error.code;
    throw error;
  }
  return payload;
}

function debounce(fn, delay) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/* ---------------- 主题（深浅色，localStorage 记忆） ---------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("studio-theme", theme);
  $("#themeToggle").textContent = theme === "dark" ? "浅色" : "深色";
}

function initTheme() {
  const stored = localStorage.getItem("studio-theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(stored || preferred);
  $("#themeToggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

/* ---------------- hash 路由 ---------------- */

let revertHash = "";

function currentRoute() {
  const hash = location.hash || "#/";
  const queryIndex = hash.indexOf("?");
  const path = queryIndex < 0 ? hash.slice(1) : hash.slice(1, queryIndex);
  const query = queryIndex < 0 ? "" : hash.slice(queryIndex + 1);
  return { path: path || "/", params: new URLSearchParams(query) };
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$("[data-nav]").forEach((link) => link.classList.toggle("current", link.dataset.nav === name));
  globalError("");
  window.scrollTo({ top: 0 });
}

async function route() {
  const target = currentRoute();
  // 未保存修改的页内拦截：先退回编辑页，等作者在拦截条里决定
  if (editState.dirty && !target.path.startsWith("/edit") && editState.path) {
    revertHash = `#/edit?path=${encodeURIComponent(editState.path)}`;
    location.hash = revertHash;
    $("#dirtyBar").classList.remove("hidden");
    return;
  }
  $("#dirtyBar").classList.add("hidden");
  if (target.path.startsWith("/edit")) {
    const path = target.params.get("path") || "";
    showView("edit");
    if (path && path !== editState.path) {
      await openEditor(path);
    }
  } else if (target.path === "/new") {
    showView("new");
    prepareNewForm();
  } else if (target.path === "/import") {
    showView("import");
  } else if (target.path === "/versions") {
    showView("versions");
    loadVersions();
  } else if (target.path === "/history") {
    showView("history");
    loadHistory(target.params.get("path") || "");
  } else if (target.path === "/publish") {
    showView("publish");
    loadPublish();
  } else if (target.path === "/media") {
    showView("media");
    loadMedia();
  } else if (target.path === "/feedback") {
    showView("feedback");
    loadFeedback();
  } else {
    showView("home");
    loadHome();
  }
}

window.addEventListener("hashchange", () => {
  if (revertHash) {
    const expected = revertHash;
    revertHash = "";
    if (location.hash === expected) return;
  }
  route();
});

window.addEventListener("beforeunload", (event) => {
  if (editState.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

$("#dirtyStay").addEventListener("click", () => $("#dirtyBar").classList.add("hidden"));
$("#dirtyLeave").addEventListener("click", () => {
  editState.dirty = false;
  $("#dirtyBar").classList.add("hidden");
  location.hash = "#/";
});

/* ---------------- 文章管理首页 ---------------- */

function typeLabel(article) {
  if (article.section === "works") return article.collectionTitle || article.collectionSlug || "作品";
  return SECTION_LABELS[article.section] || article.section;
}

function formatDate(value) {
  return value ? String(value).slice(0, 10) : "—";
}

function articleCard(article, snippet) {
  const card = document.createElement("article");
  card.className = "article-card";
  const head = document.createElement("div");
  head.className = "article-head";
  const title = document.createElement("h3");
  title.textContent = article.subtitle ? `${article.title} · ${article.subtitle}` : article.title || "（未命名）";
  head.appendChild(title);
  const badges = document.createElement("span");
  badges.className = "badges";
  const status = document.createElement("span");
  status.className = article.draft ? "badge badge-draft" : "badge badge-published";
  status.textContent = article.draft ? "草稿" : "已发布";
  badges.appendChild(status);
  const type = document.createElement("span");
  type.className = "badge badge-type";
  type.textContent = typeLabel(article);
  badges.appendChild(type);
  head.appendChild(badges);
  card.appendChild(head);

  const meta = document.createElement("p");
  meta.className = "meta-text";
  meta.textContent = `约 ${article.wordCount} 字 · 发布 ${formatDate(article.date)} · 最后修改 ${formatDate(article.lastmod) || formatDate(article.modified)}`;
  card.appendChild(meta);
  if (article.missingAnchors > 0) {
    const warn = document.createElement("p");
    warn.className = "warning-text";
    warn.textContent = `有 ${article.missingAnchors} 个自然段缺少段评锚点，保存一次即可自动补齐。`;
    card.appendChild(warn);
  }
  if (snippet) {
    const snip = document.createElement("p");
    snip.className = "snippet";
    snip.textContent = snippet;
    card.appendChild(snip);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const edit = document.createElement("a");
  edit.className = "button primary small";
  edit.href = `#/edit?path=${encodeURIComponent(article.path)}`;
  edit.textContent = "编辑";
  actions.appendChild(edit);
  const history = document.createElement("a");
  history.className = "button secondary small";
  history.href = `#/history?path=${encodeURIComponent(article.path)}`;
  history.textContent = "版本";
  actions.appendChild(history);
  const preview = document.createElement("button");
  preview.className = "secondary small";
  preview.type = "button";
  preview.textContent = "预览";
  const statusText = document.createElement("span");
  statusText.className = "preview-status";
  preview.addEventListener("click", async () => {
    statusText.textContent = "正在打开…";
    try {
      await api("/api/article/open-page", { path: article.path });
      statusText.textContent = "已在浏览器打开。";
    } catch (error) {
      statusText.textContent = error.message;
    }
  });
  actions.appendChild(preview);
  const folder = document.createElement("button");
  folder.className = "secondary small";
  folder.type = "button";
  folder.textContent = "打开目录";
  folder.addEventListener("click", async () => {
    try {
      await api("/api/system/open-folder", { path: article.path });
    } catch (error) {
      globalError(error.message);
    }
  });
  actions.appendChild(folder);
  actions.appendChild(statusText);
  card.appendChild(actions);
  return card;
}

function renderGroups() {
  const container = $("#articleGroups");
  container.textContent = "";
  if (!state.articles.length) {
    const empty = document.createElement("p");
    empty.className = "meta-text";
    empty.textContent = "还没有文章。可以新建文章，或从 Word 导入。";
    container.appendChild(empty);
    return;
  }
  const groups = new Map();
  for (const article of state.articles) {
    const key = article.section === "works" ? `works:${article.collectionSlug}` : article.section;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(article);
  }
  for (const [key, items] of groups) {
    const section = document.createElement("section");
    section.className = "article-group";
    const heading = document.createElement("h2");
    if (key.startsWith("works:")) {
      heading.textContent = `文集 · ${items[0].collectionTitle || items[0].collectionSlug}`;
    } else {
      heading.textContent = SECTION_LABELS[key] || key;
    }
    section.appendChild(heading);
    // 草稿排在每组最前（服务端已按此排序，这里再稳定兜底一次）
    const drafts = items.filter((item) => item.draft);
    const published = items.filter((item) => !item.draft);
    for (const article of [...drafts, ...published]) {
      section.appendChild(articleCard(article));
    }
    container.appendChild(section);
  }
}

function renderSearchResults() {
  const box = $("#searchResults");
  const groups = $("#articleGroups");
  const results = state.searchResults;
  if (results === null) {
    box.classList.add("hidden");
    groups.classList.remove("hidden");
    return;
  }
  groups.classList.add("hidden");
  box.classList.remove("hidden");
  box.textContent = "";
  const title = document.createElement("h2");
  title.textContent = `“${state.searchQuery}”的搜索结果（${results.length} 篇）`;
  box.appendChild(title);
  if (!results.length) return;
  for (const item of results) {
    box.appendChild(articleCard(item, item.snippet || ""));
  }
}

const runSearch = debounce(async () => {
  const query = state.searchQuery.trim();
  if (!query) {
    state.searchResults = null;
    renderSearchResults();
    return;
  }
  try {
    const payload = await apiGet(`/api/articles/search?q=${encodeURIComponent(query)}`);
    state.searchResults = payload.results;
    renderSearchResults();
  } catch (error) {
    globalError(error.message);
  }
}, 300);

async function refreshPreviewStatus() {
  const status = $("#homePreviewStatus");
  try {
    const payload = await apiGet("/api/system/status");
    if (payload.workspace) {
      $("#workspaceTarget").textContent = payload.workspace.label;
      $("#workspaceTarget").dataset.mode = payload.workspace.mode;
      $("#workspaceTarget").title = `内容提交目标：${payload.workspace.contentRepoRoot}\n平台代码：${payload.workspace.platformRoot}`;
    }
    status.textContent = payload.preview.running ? `预览运行中：${payload.preview.url}` : "";
  } catch (error) {
    status.textContent = "";
  }
}

async function loadHome() {
  try {
    const payload = await apiGet("/api/articles");
    state.articles = payload.articles;
    renderGroups();
    if (state.searchQuery.trim()) runSearch();
  } catch (error) {
    globalError(error.message);
  }
  refreshPreviewStatus();
  loadFeedbackCard();
}

$("#searchInput").addEventListener("input", () => {
  state.searchQuery = $("#searchInput").value;
  runSearch();
});

$("#homePreviewBtn").addEventListener("click", async () => {
  const status = $("#homePreviewStatus");
  status.textContent = "正在启动…";
  try {
    const payload = await api("/api/system/preview", { action: "start" });
    status.textContent = payload.preview.running ? `预览运行中：${payload.preview.url}` : "预览进程已退出，请检查 1313 端口。";
  } catch (error) {
    status.textContent = error.message;
  }
});

/* ---------------- 编辑页 ---------------- */

function clientWordCount(text) {
  const plain = text.replace(/<!--[\s\S]*?-->/g, "");
  const cjk = (plain.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
  const latin = (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

function markDirty() {
  editState.dirty = true;
  $("#editSaveStatus").textContent = "有未保存的修改";
  $("#editWordCount").textContent = `约 ${clientWordCount($("#editorBody").value)} 字`;
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
  const preview = $("#editorPreview");
  try {
    const payload = await api("/api/render", { markdown: $("#editorBody").value });
    preview.innerHTML = payload.html;
  } catch (error) {
    preview.textContent = `预览渲染失败：${error.message}`;
  }
}, 500);

async function openEditor(path) {
  hideError($("#editError"));
  $("#editSaveStatus").textContent = "";
  $("#editorBody").value = "";
  $("#editorPreview").textContent = "";
  try {
    const payload = await apiGet(`/api/article?path=${encodeURIComponent(path)}`);
    const article = payload.article;
    editState.path = article.path;
    editState.dirty = false;
    const fm = article.frontMatter;
    $("#editTitle").textContent = fm.subtitle ? `${fm.title} · ${fm.subtitle}` : fm.title || "（未命名）";
    $("#editDraftBadge").classList.toggle("hidden", !fm.draft);
    fillFmForm(fm);
    $("#editorBody").value = article.body;
    $("#editWordCount").textContent = `约 ${clientWordCount(article.body)} 字`;
    refreshEditorPreview();
    loadNotes();
  } catch (error) {
    editState.path = "";
    showError($("#editError"), error.message);
  }
}

$("#editorBody").addEventListener("input", () => {
  markDirty();
  refreshEditorPreview();
});

$("#editorBody").addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const area = event.target;
    const { selectionStart, selectionEnd, value } = area;
    area.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    area.selectionStart = area.selectionEnd = selectionStart + 2;
    markDirty();
  }
});

$("#fmForm").addEventListener("input", markDirty);

$("#editSave").addEventListener("click", async () => {
  hideError($("#editError"));
  const status = $("#editSaveStatus");
  status.textContent = "正在保存…";
  $("#editSave").disabled = true;
  try {
    const payload = await api("/api/article/save", {
      path: editState.path,
      frontMatter: readFmForm(),
      body: $("#editorBody").value,
    });
    editState.dirty = false;
    // 服务端已为新段落补好段评锚点，编辑器必须同步稳定化后的正文，
    // 否则下次保存会给同一段落再发新锚点，破坏段评身份。
    if (typeof payload.body === "string") $("#editorBody").value = payload.body;
    status.textContent = `已保存（新增锚点 ${payload.anchors.created} 个，保留 ${payload.anchors.retained} 个）`;
    const fm = payload.article;
    $("#editDraftBadge").classList.toggle("hidden", !fm.draft);
    $("#fmArticleRevision").textContent = fm.articleRevision || "—";
    refreshEditorPreview();
  } catch (error) {
    status.textContent = "保存失败";
    showError($("#editError"), error.message);
  } finally {
    $("#editSave").disabled = false;
  }
});

$("#editHugoPreview").addEventListener("click", async () => {
  const status = $("#editSaveStatus");
  status.textContent = "正在打开 Hugo 预览…";
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

/* ---------------- 新建文章 ---------------- */

let slugTouched = false;

const suggestSlug = debounce(async () => {
  const form = $("#newForm");
  if (slugTouched || !form.title.value.trim()) return;
  try {
    const payload = await apiGet(`/api/articles/suggest-slug?title=${encodeURIComponent(form.title.value.trim())}`);
    if (!slugTouched && payload.slug) form.slug.value = payload.slug;
  } catch (error) {
    // 建议失败不阻塞，手工填写即可
  }
}, 400);

function toggleNewCollectionFields() {
  const form = $("#newForm");
  $("#newCollectionFields").classList.toggle("hidden", form.section.value !== "works");
}

function prepareNewForm() {
  const form = $("#newForm");
  if (!form.title.value) slugTouched = false;
  toggleNewCollectionFields();
  const select = form.collectionExisting;
  if (select.options.length) return; // 文集清单只需填充一次
  const fill = async () => {
    try {
      const payload = await apiGet("/api/articles");
      const seen = new Map();
      for (const article of payload.articles) {
        if (article.section === "works" && article.collectionSlug) {
          seen.set(article.collectionSlug, article.collectionTitle || article.collectionSlug);
        }
      }
      select.textContent = "";
      for (const [slug, title] of seen) {
        const option = document.createElement("option");
        option.value = slug;
        option.textContent = title;
        select.appendChild(option);
      }
      const fresh = document.createElement("option");
      fresh.value = "";
      fresh.textContent = "—— 新文集 ——";
      select.appendChild(fresh);
      select.value = [...seen.keys()][0] || "";
      toggleNewCollectionName();
    } catch (error) {
      globalError(error.message);
    }
  };
  fill();
}

function toggleNewCollectionName() {
  const form = $("#newForm");
  $("#newCollectionNameWrap").classList.toggle("hidden", Boolean(form.collectionExisting.value));
}

$("#newForm").title.addEventListener("input", suggestSlug);
$("#newForm").slug.addEventListener("input", () => { slugTouched = true; });
$("#newForm").section.addEventListener("change", toggleNewCollectionFields);
$("#newForm").collectionExisting.addEventListener("change", toggleNewCollectionName);

$("#newForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError($("#newError"));
  const form = event.target;
  const fields = {
    title: form.title.value.trim(),
    subtitle: form.subtitle.value.trim(),
    section: form.section.value,
    slug: form.slug.value.trim(),
    collectionSlug: "",
    collectionTitle: "",
  };
  if (!fields.title) {
    showError($("#newError"), "请填写标题。");
    return;
  }
  if (!SLUG_PATTERN.test(fields.slug)) {
    showError($("#newError"), "slug 只能使用小写英文字母、数字和连字符，且不能以连字符开头或结尾。");
    return;
  }
  if (fields.section === "works") {
    fields.collectionSlug = form.collectionExisting.value.trim();
    if (!fields.collectionSlug) {
      fields.collectionTitle = form.collectionName.value.trim();
      if (!fields.collectionTitle) {
        showError($("#newError"), "新建文集必须填写文集名称。");
        return;
      }
      // 新文集的 slug 用拼音建议规则从文集名生成
      try {
        const payload = await apiGet(`/api/articles/suggest-slug?title=${encodeURIComponent(fields.collectionTitle)}`);
        fields.collectionSlug = payload.slug || "";
      } catch (error) {
        fields.collectionSlug = "";
      }
      if (!SLUG_PATTERN.test(fields.collectionSlug)) {
        showError($("#newError"), "无法为文集生成合法 slug，请改选既有文集或调整文集名称。");
        return;
      }
    }
  }
  $("#newSubmit").disabled = true;
  try {
    const payload = await api("/api/article/new", fields);
    form.reset();
    slugTouched = false;
    location.hash = `#/edit?path=${encodeURIComponent(payload.article.path)}`;
  } catch (error) {
    showError($("#newError"), error.message);
  } finally {
    $("#newSubmit").disabled = false;
  }
});

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

/* ---------------- 版本管理 ---------------- */

const STATUS_LABELS = { M: "修改", A: "新增", D: "删除", R: "改名", U: "冲突", "?": "未跟踪", T: "类型变更", C: "复制" };

function statusLabel(status) {
  return STATUS_LABELS[status] || (status.length > 1 ? STATUS_LABELS[status[0]] || status : status);
}

function renderVersionsStatus(status) {
  const info = $("#versionsRepoInfo");
  info.textContent = "";
  const rows = [
    ["分支", status.branch || "—"],
    ["状态", status.clean ? "干净（没有未提交的修改）" : `${status.files.length} 个未提交文件`],
  ];
  rows.forEach(([key, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    info.appendChild(dt);
    info.appendChild(dd);
  });

  const filesBox = $("#versionsFiles");
  filesBox.textContent = "";
  $("#versionsClean").classList.toggle("hidden", !status.clean);
  $("#versionsCommitBox").classList.toggle("hidden", Boolean(status.clean));
  $("#versionsConfirm").classList.add("hidden");
  $("#versionsCommitStatus").textContent = "";
  if (status.clean) return;

  const table = document.createElement("table");
  table.className = "file-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["", "路径", "状态", "修改时间"].forEach((text) => {
    const cell = document.createElement("th");
    cell.textContent = text;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement("tbody");
  for (const file of status.files) {
    const row = document.createElement("tr");
    const checkCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.path = file.path;
    checkCell.appendChild(checkbox);
    row.appendChild(checkCell);
    const pathCell = document.createElement("td");
    pathCell.className = "file-path";
    pathCell.textContent = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    row.appendChild(pathCell);
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge badge-status-${file.status === "?" ? "new" : "mod"}`;
    badge.textContent = `${statusLabel(file.status)} ${file.status}`;
    statusCell.appendChild(badge);
    row.appendChild(statusCell);
    const timeCell = document.createElement("td");
    timeCell.className = "meta-text";
    timeCell.textContent = file.mtime ? file.mtime.replace("T", " ") : "—";
    row.appendChild(timeCell);
    body.appendChild(row);
  }
  table.appendChild(body);
  filesBox.appendChild(table);
  $("#versionsMessage").value = status.suggestion || "";
}

function renderCommitList(container, commits, emptyText) {
  container.textContent = "";
  if (!commits.length) {
    const empty = document.createElement("p");
    empty.className = "meta-text";
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }
  const list = document.createElement("ul");
  list.className = "commit-list";
  for (const commit of commits) {
    const item = document.createElement("li");
    const hash = document.createElement("code");
    hash.textContent = commit.short;
    const date = document.createElement("span");
    date.className = "meta-text";
    date.textContent = ` ${String(commit.date).slice(0, 10)} `;
    const subject = document.createElement("span");
    subject.textContent = commit.subject;
    item.appendChild(hash);
    item.appendChild(date);
    item.appendChild(subject);
    list.appendChild(item);
  }
  container.appendChild(list);
}

async function loadVersions() {
  hideError($("#versionsError"));
  try {
    const [statusPayload, logPayload] = await Promise.all([
      apiGet("/api/git/status"),
      apiGet("/api/git/log"),
    ]);
    $("#versionsContent").classList.remove("hidden");
    renderVersionsStatus(statusPayload.status);
    renderCommitList($("#versionsLog"), logPayload.commits, "仓库还没有任何提交。");
  } catch (error) {
    $("#versionsContent").classList.add("hidden");
    showError($("#versionsError"), error.message);
  }
}

$("#versionsCommitBtn").addEventListener("click", () => {
  const message = $("#versionsMessage").value.trim();
  if (!message) {
    $("#versionsCommitStatus").textContent = "请填写提交信息。";
    return;
  }
  const checked = $$("#versionsFiles input[type=checkbox]:checked");
  if (!checked.length) {
    $("#versionsCommitStatus").textContent = "请先勾选要提交的文件。";
    return;
  }
  $("#versionsCommitStatus").textContent = "";
  $("#versionsConfirm").classList.remove("hidden");
});

$("#versionsConfirmNo").addEventListener("click", () => $("#versionsConfirm").classList.add("hidden"));

$("#versionsConfirmYes").addEventListener("click", async () => {
  $("#versionsConfirm").classList.add("hidden");
  const files = $$("#versionsFiles input[type=checkbox]:checked").map((box) => box.dataset.path);
  const message = $("#versionsMessage").value.trim();
  const status = $("#versionsCommitStatus");
  status.textContent = "正在提交…";
  $("#versionsConfirmYes").disabled = true;
  try {
    const payload = await api("/api/git/commit", { files, message });
    status.textContent = `已创建提交 ${payload.commit.short}：${payload.commit.subject}`;
    await loadVersions();
  } catch (error) {
    status.textContent = "提交失败";
    showError($("#versionsError"), error.message);
  } finally {
    $("#versionsConfirmYes").disabled = false;
  }
});

/* ---------------- 文章历史 ---------------- */

const historyState = { path: "" };

function renderHistoryLog(commits) {
  const container = $("#historyLog");
  container.textContent = "";
  if (!commits.length) {
    const empty = document.createElement("p");
    empty.className = "meta-text";
    empty.textContent = "这篇文章还没有提交历史（可能尚未提交过）。";
    container.appendChild(empty);
    return;
  }
  for (const commit of commits) {
    const row = document.createElement("div");
    row.className = "history-row";
    const head = document.createElement("div");
    head.className = "history-head";
    const hash = document.createElement("code");
    hash.textContent = commit.short;
    const date = document.createElement("span");
    date.className = "meta-text";
    date.textContent = ` ${String(commit.date).slice(0, 10)} `;
    const subject = document.createElement("span");
    subject.textContent = commit.subject;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary small";
    toggle.textContent = "查看变更";
    head.appendChild(hash);
    head.appendChild(date);
    head.appendChild(subject);
    head.appendChild(toggle);
    row.appendChild(head);
    const diffBox = document.createElement("div");
    diffBox.className = "diff-box hidden";
    row.appendChild(diffBox);
    let loaded = false;
    toggle.addEventListener("click", async () => {
      if (!diffBox.classList.contains("hidden")) {
        diffBox.classList.add("hidden");
        toggle.textContent = "查看变更";
        return;
      }
      if (!loaded) {
        toggle.textContent = "正在加载…";
        try {
          const payload = await apiGet(
            `/api/git/diff?path=${encodeURIComponent(historyState.path)}&ref=${encodeURIComponent(commit.hash)}`
          );
          renderDiff(diffBox, payload.result.diff, payload.result.note);
          loaded = true;
        } catch (error) {
          diffBox.textContent = error.message;
          diffBox.classList.remove("hidden");
        }
      }
      diffBox.classList.remove("hidden");
      toggle.textContent = "收起变更";
    });
    container.appendChild(row);
  }
}

async function loadHistory(path) {
  historyState.path = path;
  hideError($("#historyError"));
  $("#historyDiff").classList.add("hidden");
  $("#historyDiff").textContent = "";
  $("#historyTitle").textContent = path ? `版本历史：${path}` : "版本历史";
  $("#historyLog").textContent = "";
  if (!path) {
    showError($("#historyError"), "缺少文章路径。");
    return;
  }
  try {
    const payload = await apiGet(`/api/git/log?path=${encodeURIComponent(path)}`);
    renderHistoryLog(payload.commits);
  } catch (error) {
    showError($("#historyError"), error.message);
  }
}

$("#historyWorktree").addEventListener("click", async () => {
  if (!historyState.path) return;
  hideError($("#historyError"));
  const box = $("#historyDiff");
  box.classList.remove("hidden");
  box.textContent = "正在加载…";
  try {
    const payload = await apiGet(`/api/git/diff?path=${encodeURIComponent(historyState.path)}`);
    renderDiff(box, payload.result.diff, payload.result.note || "当前相对最近一次提交的未提交修改：");
  } catch (error) {
    box.classList.add("hidden");
    showError($("#historyError"), error.message);
  }
});

/* ---------------- 发布中心 ---------------- */

function renderPublishStatus(status) {
  const info = $("#publishInfo");
  info.textContent = "";
  const settings = status.settings || {};
  const missing = [];
  if (!settings.hasSshTarget) missing.push("WRITING_SSH_TARGET");
  if (!settings.hasDomain) missing.push("WRITING_DOMAIN");
  const rows = [
    ["本地版本", status.version ? `V${status.version}` : "—"],
    [
      "服务器配置",
      settings.configured
        ? "已配置（.author-settings，值不会显示）"
        : settings.filePresent
          ? `未配置完整：缺少 ${missing.join("、")}`
          : "未配置（缺少 .author-settings 文件）",
    ],
  ];
  rows.forEach(([key, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    info.appendChild(dt);
    info.appendChild(dd);
  });

  const changelog = $("#publishChangelog");
  changelog.textContent = "";
  if (!status.changelog || !status.changelog.length) {
    const empty = document.createElement("p");
    empty.className = "meta-text";
    empty.textContent = "CHANGELOG.md 中还没有发布记录。";
    changelog.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "commit-list";
    status.changelog.forEach((entry) => {
      const item = document.createElement("li");
      const version = document.createElement("strong");
      version.textContent = entry.version;
      item.appendChild(version);
      if (entry.date) {
        const date = document.createElement("span");
        date.className = "meta-text";
        date.textContent = ` ${entry.date} `;
        item.appendChild(date);
      }
      const title = document.createElement("span");
      title.textContent = entry.title ? ` ${entry.title}` : "";
      item.appendChild(title);
      list.appendChild(item);
    });
    changelog.appendChild(list);
  }
  renderCommitList($("#publishCommits"), status.commits || [], status.gitError || "没有提交记录。");
}

async function loadPublish() {
  hideError($("#publishError"));
  $("#publishRunBtn").disabled = true;
  $("#publishConfirm").classList.add("hidden");
  $("#preflightStatus").textContent = "";
  $("#publishRunStatus").textContent = "";
  try {
    const payload = await apiGet("/api/publish/status");
    renderPublishStatus(payload.status);
  } catch (error) {
    showError($("#publishError"), error.message);
  }
}

$("#preflightBtn").addEventListener("click", async () => {
  hideError($("#publishError"));
  const button = $("#preflightBtn");
  const status = $("#preflightStatus");
  const full = $("#preflightFull").checked;
  button.disabled = true;
  status.textContent = full ? "正在运行完整检查（可能数分钟）…" : "正在运行发布前检查…";
  $("#preflightLog").classList.add("hidden");
  try {
    const payload = await api("/api/publish/preflight", { full });
    const log = $("#preflightLog");
    log.textContent = payload.preflight.output || "（无输出）";
    log.classList.remove("hidden");
    if (payload.preflight.success) {
      status.textContent = `检查通过（${payload.preflight.script}，耗时 ${payload.preflight.duration} 秒），30 分钟内可发布。`;
      $("#publishRunBtn").disabled = false;
    } else {
      status.textContent = `检查未通过（${payload.preflight.script}），请根据日志修复后重试。`;
      $("#publishRunBtn").disabled = true;
    }
  } catch (error) {
    status.textContent = "检查运行失败";
    showError($("#publishError"), error.message);
    $("#publishRunBtn").disabled = true;
  } finally {
    button.disabled = false;
  }
});

$("#publishRunBtn").addEventListener("click", () => {
  $("#publishConfirm").classList.remove("hidden");
});

$("#publishConfirmNo").addEventListener("click", () => $("#publishConfirm").classList.add("hidden"));

$("#publishConfirmYes").addEventListener("click", async () => {
  $("#publishConfirm").classList.add("hidden");
  hideError($("#publishError"));
  const button = $("#publishRunBtn");
  const status = $("#publishRunStatus");
  button.disabled = true;
  status.textContent = "正在发布（构建、备份、上传，可能需要几分钟）…";
  $("#publishLog").classList.add("hidden");
  try {
    const payload = await api("/api/publish/run", { confirm: true });
    const log = $("#publishLog");
    log.textContent = payload.publish.output || "（无输出）";
    log.classList.remove("hidden");
    if (payload.publish.success) {
      status.textContent = `发布成功（耗时 ${payload.publish.duration} 秒）。`;
    } else {
      status.textContent = "发布失败，请根据日志排查；服务器可能仍停留在旧版本。";
    }
  } catch (error) {
    status.textContent = error.message;
    if (error.code === "preflight-required") {
      status.textContent = "发布被拒绝：请先运行一次成功的发布前检查（30 分钟内有效）。";
    }
  } finally {
    button.disabled = false;
  }
});

/* ---------------- 媒体库 ---------------- */

async function copyText(text, statusEl) {
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = "已复制。";
  } catch (error) {
    statusEl.textContent = `复制失败，请手动复制：${text}`;
  }
}

function bundleReference(item) {
  if (item.articlePath && item.relPath.startsWith(item.articlePath.slice(0, -"index.md".length))) {
    return item.relPath.slice(item.articlePath.slice(0, -"index.md".length).length);
  }
  return item.relPath;
}

function mediaCard(item) {
  const card = document.createElement("div");
  card.className = "media-card";
  const img = document.createElement("img");
  img.src = `/api/media/file?path=${encodeURIComponent(item.relPath)}`;
  img.alt = item.name;
  img.loading = "lazy";
  card.appendChild(img);
  const name = document.createElement("p");
  name.className = "media-name";
  name.textContent = item.name;
  card.appendChild(name);
  const badges = document.createElement("p");
  badges.className = "badges";
  if (item.isCover) {
    const badge = document.createElement("span");
    badge.className = "badge badge-published";
    badge.textContent = "封面";
    badges.appendChild(badge);
  }
  if (item.isOriginal) {
    const badge = document.createElement("span");
    badge.className = "badge badge-type";
    badge.textContent = "原始图";
    badges.appendChild(badge);
  }
  if (badges.childNodes.length) card.appendChild(badges);
  const meta = document.createElement("p");
  meta.className = "meta-text";
  const dims = item.width && item.height ? `${item.width}×${item.height} · ` : "";
  meta.textContent = `${dims}${describeSize(item.size)}`;
  card.appendChild(meta);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const statusText = document.createElement("span");
  statusText.className = "preview-status";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "secondary small";
  copy.textContent = "复制引用";
  copy.addEventListener("click", () => {
    const alt = item.name.replace(/\.[^.]+$/, "");
    copyText(`![${alt}](${bundleReference(item)})`, statusText);
  });
  actions.appendChild(copy);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger small";
  remove.textContent = "删除";
  remove.addEventListener("click", async () => {
    if (!remove.dataset.armed) {
      remove.dataset.armed = "1";
      remove.textContent = "确认删除？";
      statusText.textContent = "将移入回收站（.cache/studio/trash/）。";
      return;
    }
    remove.disabled = true;
    try {
      await api("/api/media/delete", { path: item.relPath });
      statusText.textContent = "已移入回收站。";
      card.remove();
    } catch (error) {
      remove.disabled = false;
      remove.dataset.armed = "";
      remove.textContent = "删除";
      statusText.textContent = error.message;
    }
  });
  actions.appendChild(remove);
  actions.appendChild(statusText);
  card.appendChild(actions);
  return card;
}

function renderMediaGroups(items) {
  const container = $("#mediaGroups");
  container.textContent = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "meta-text";
    empty.textContent = "content/ 里还没有图片。可以在上方选择文章上传。";
    container.appendChild(empty);
    return;
  }
  const groups = new Map();
  for (const item of items) {
    const key = item.articlePath || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, groupItems] of groups) {
    const section = document.createElement("section");
    section.className = "article-group";
    const heading = document.createElement("h2");
    heading.textContent = key ? `《${groupItems[0].articleTitle || key}》` : "（不属于任何文章）";
    section.appendChild(heading);
    const grid = document.createElement("div");
    grid.className = "media-grid";
    groupItems.forEach((item) => grid.appendChild(mediaCard(item)));
    section.appendChild(grid);
    container.appendChild(section);
  }
}

async function loadMedia() {
  hideError($("#mediaError"));
  try {
    const [mediaPayload, articlesPayload] = await Promise.all([
      apiGet("/api/media"),
      apiGet("/api/articles"),
    ]);
    renderMediaGroups(mediaPayload.media);
    const select = $("#mediaArticleSelect");
    select.textContent = "";
    for (const article of articlesPayload.articles) {
      const option = document.createElement("option");
      option.value = article.path;
      option.textContent = `${article.title || article.slug}（${article.path}）`;
      select.appendChild(option);
    }
  } catch (error) {
    showError($("#mediaError"), error.message);
  }
}

$("#mediaFileInput").addEventListener("change", () => {
  $("#mediaUploadBtn").disabled = !$("#mediaFileInput").files.length;
});

$("#mediaUploadBtn").addEventListener("click", async () => {
  hideError($("#mediaError"));
  const file = $("#mediaFileInput").files[0];
  const articlePath = $("#mediaArticleSelect").value;
  const status = $("#mediaUploadStatus");
  if (!file || !articlePath) return;
  const form = new FormData();
  form.append("articlePath", articlePath);
  form.append("file", file, file.name);
  status.textContent = "正在上传…";
  $("#mediaUploadBtn").disabled = true;
  try {
    const response = await fetch("/api/media/upload", {
      method: "POST",
      headers: { "X-Studio-Request": "1" },
      body: form,
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
    }
    status.textContent = "";
    const result = $("#mediaUploadResult");
    result.textContent = "";
    const text = document.createElement("p");
    text.textContent = `已写入 ${payload.image.relPath}（${payload.image.width}×${payload.image.height}），把下面的引用粘贴到编辑器正文里即可：`;
    result.appendChild(text);
    const code = document.createElement("code");
    code.className = "media-markdown";
    code.textContent = payload.markdown;
    result.appendChild(code);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary small";
    copy.textContent = "复制引用";
    const copyStatus = document.createElement("span");
    copyStatus.className = "preview-status";
    copy.addEventListener("click", () => copyText(payload.markdown, copyStatus));
    result.appendChild(copy);
    result.appendChild(copyStatus);
    (payload.warnings || []).forEach((warning) => {
      const line = document.createElement("p");
      line.className = "warning-text";
      line.textContent = warning;
      result.appendChild(line);
    });
    result.classList.remove("hidden");
    $("#mediaFileInput").value = "";
    loadMedia();
  } catch (error) {
    status.textContent = error.message;
    $("#mediaUploadBtn").disabled = false;
  }
});

/* ---------------- 阅读反馈（段评/章评审核） ---------------- */

const feedbackState = {
  loggedIn: false,
  username: "",
  serviceRunning: false,
  page: 1,
  pages: 1,
  serviceTimer: 0,
  quick: null, // { queue: [], index: 0 }
};

const FEEDBACK_SCOPE_LABELS = { paragraph: "段评", article: "章评" };
const FEEDBACK_STATUS_LABELS = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
  spam: "垃圾",
  hidden: "已隐藏",
  deleted: "已删除",
  orphaned: "孤立",
};

function feedbackQuery() {
  const params = new URLSearchParams();
  params.set("status", $("#feedbackStatus").value);
  params.set("scope", $("#feedbackScope").value);
  params.set("page", String(feedbackState.page));
  const q = $("#feedbackSearch").value.trim();
  if (q) params.set("q", q);
  const articleId = $("#feedbackArticle").value;
  if (articleId) params.set("articleId", articleId);
  return params.toString();
}

function renderFeedbackPanels() {
  const { serviceRunning, loggedIn } = feedbackState;
  $("#feedbackServiceOff").classList.toggle("hidden", serviceRunning);
  $("#feedbackLoginForm").classList.toggle("hidden", !serviceRunning || loggedIn);
  $("#feedbackLoginPanel").classList.toggle("hidden", serviceRunning && loggedIn);
  $("#feedbackMain").classList.toggle("hidden", !(serviceRunning && loggedIn));
  $("#feedbackUser").textContent = loggedIn ? `站主：${feedbackState.username}` : "";
}

async function refreshFeedbackStatus() {
  try {
    const payload = await apiGet("/api/feedback/status");
    feedbackState.serviceRunning = Boolean(payload.service && payload.service.running);
    feedbackState.loggedIn = Boolean(payload.loggedIn);
    feedbackState.username = payload.username || "";
    renderFeedbackPanels();
    return payload;
  } catch (error) {
    showError($("#feedbackError"), error.message);
    return null;
  }
}

function pollFeedbackService(deadline) {
  clearTimeout(feedbackState.serviceTimer);
  feedbackState.serviceTimer = setTimeout(async () => {
    const payload = await refreshFeedbackStatus();
    if (payload && payload.service.running) {
      $("#feedbackServiceStatus").textContent = "评论服务已运行。";
      return;
    }
    if (Date.now() < deadline) {
      pollFeedbackService(deadline);
    } else {
      $("#feedbackServiceStatus").textContent = "等待超时：服务仍未就绪，请查看终端输出。";
    }
  }, 3000);
}

$("#feedbackServiceStart").addEventListener("click", async () => {
  hideError($("#feedbackError"));
  const status = $("#feedbackServiceStatus");
  status.textContent = "正在启动评论服务（首次启动需先完整构建网站，可能要一两分钟，请耐心等待）…";
  try {
    await api("/api/feedback/service", { action: "start" });
    pollFeedbackService(Date.now() + 180000);
  } catch (error) {
    status.textContent = error.message;
  }
});

$("#feedbackServiceStop").addEventListener("click", async () => {
  hideError($("#feedbackError"));
  try {
    await api("/api/feedback/service", { action: "stop" });
    feedbackState.loggedIn = false;
    await refreshFeedbackStatus();
  } catch (error) {
    showError($("#feedbackError"), error.message);
  }
});

$("#feedbackLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError($("#feedbackError"));
  const status = $("#feedbackLoginStatus");
  status.textContent = "正在登录…";
  try {
    const form = event.target;
    const payload = await api("/api/feedback/login", {
      username: form.username.value.trim(),
      password: form.password.value,
    });
    form.password.value = "";
    feedbackState.loggedIn = true;
    feedbackState.username = payload.username || "";
    status.textContent = "";
    renderFeedbackPanels();
    prepareFeedbackFilters();
    feedbackState.page = 1;
    loadComments();
  } catch (error) {
    status.textContent = error.message;
  }
});

$("#feedbackLogout").addEventListener("click", async () => {
  hideError($("#feedbackError"));
  try {
    await api("/api/feedback/logout");
  } catch (error) {
    // 即使服务端会话已失效，也按退出处理
  }
  feedbackState.loggedIn = false;
  feedbackState.username = "";
  feedbackState.quick = null;
  renderFeedbackPanels();
});

let feedbackArticlesReady = false;

async function prepareFeedbackFilters() {
  if (feedbackArticlesReady) return;
  try {
    const payload = await apiGet("/api/articles");
    const select = $("#feedbackArticle");
    select.textContent = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "全部文章";
    select.appendChild(all);
    for (const article of payload.articles) {
      if (!article.articleId) continue;
      const option = document.createElement("option");
      option.value = article.articleId;
      option.textContent = article.title || article.slug;
      select.appendChild(option);
    }
    feedbackArticlesReady = true;
  } catch (error) {
    // 文章清单加载失败不阻塞，仍可按状态/类型筛选
  }
}

function renderFeedbackStats(stats) {
  const box = $("#feedbackStats");
  box.textContent = "";
  const entries = [
    ["待审核", stats.pending || 0],
    ["已通过", stats.approved || 0],
    ["垃圾", stats.spam || 0],
    ["孤立", stats.orphaned || 0],
  ];
  for (const [label, count] of entries) {
    const card = document.createElement("div");
    card.className = "stat-card";
    const number = document.createElement("strong");
    number.textContent = String(count);
    const text = document.createElement("span");
    text.textContent = label;
    card.appendChild(number);
    card.appendChild(text);
    box.appendChild(card);
  }
}

function commentExcerptBlock(comment) {
  if (comment.scope !== "paragraph") return null;
  const wrap = document.createElement("div");
  wrap.className = "comment-excerpts";
  const submitted = document.createElement("p");
  submitted.className = "meta-text";
  submitted.textContent = `提交时摘录：${comment.paragraph_excerpt || "（无）"}`;
  wrap.appendChild(submitted);
  const current = document.createElement("p");
  if (!comment.current_excerpt) {
    current.className = "warning-text";
    current.textContent = "该段落已删除或锚点失效，评论已无法定位。";
  } else if (comment.current_excerpt !== comment.paragraph_excerpt) {
    current.className = "warning-text";
    current.textContent = `当前摘录（与提交时不一致）：${comment.current_excerpt}`;
  } else {
    current.className = "meta-text";
    current.textContent = "当前摘录与提交时一致。";
  }
  wrap.appendChild(current);
  return wrap;
}

function moderateButton(label, className, action, comment, onDone) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className} small`;
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api("/api/feedback/moderate", { id: comment.id, action });
      onDone();
    } catch (error) {
      button.disabled = false;
      if (error.code === "not-logged-in") {
        feedbackState.loggedIn = false;
        renderFeedbackPanels();
      }
      showError($("#feedbackError"), error.message);
    }
  });
  return button;
}

function commentCard(comment, onDone) {
  const card = document.createElement("article");
  card.className = "article-card comment-card";
  const head = document.createElement("div");
  head.className = "article-head";
  const title = document.createElement("h3");
  title.textContent = comment.display_name || "（匿名）";
  head.appendChild(title);
  const badges = document.createElement("span");
  badges.className = "badges";
  const scope = document.createElement("span");
  scope.className = "badge badge-type";
  scope.textContent = FEEDBACK_SCOPE_LABELS[comment.scope] || comment.scope;
  badges.appendChild(scope);
  const status = document.createElement("span");
  status.className = "badge badge-type";
  status.textContent = FEEDBACK_STATUS_LABELS[comment.status] || comment.status;
  badges.appendChild(status);
  head.appendChild(badges);
  card.appendChild(head);

  const meta = document.createElement("p");
  meta.className = "meta-text";
  meta.textContent = `${comment.title || comment.article_id} · ${String(comment.created_at || "").replace("T", " ").slice(0, 19)}`;
  card.appendChild(meta);

  const excerpts = commentExcerptBlock(comment);
  if (excerpts) card.appendChild(excerpts);

  const body = document.createElement("p");
  body.className = "comment-body";
  body.textContent = comment.body || "";
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (comment.status !== "approved") actions.appendChild(moderateButton("通过", "primary", "approve", comment, onDone));
  if (comment.status !== "rejected") actions.appendChild(moderateButton("拒绝", "secondary", "reject", comment, onDone));
  if (comment.status !== "spam") actions.appendChild(moderateButton("垃圾", "secondary", "spam", comment, onDone));
  if (comment.status !== "hidden") actions.appendChild(moderateButton("隐藏", "secondary", "hide", comment, onDone));
  const statusText = document.createElement("span");
  statusText.className = "preview-status";
  if (comment.status !== "deleted") {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger small";
    del.textContent = "删除";
    const confirmBar = document.createElement("div");
    confirmBar.className = "confirm-bar hidden";
    const hint = document.createElement("span");
    hint.textContent = "删除后前台与列表默认不再显示（服务端为软删除）。确认删除这条评论？";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "danger small";
    yes.textContent = "确认删除";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "secondary small";
    no.textContent = "取消";
    del.addEventListener("click", () => confirmBar.classList.remove("hidden"));
    no.addEventListener("click", () => confirmBar.classList.add("hidden"));
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        await api("/api/feedback/moderate", { id: comment.id, action: "delete", confirm: true });
        onDone();
      } catch (error) {
        yes.disabled = false;
        confirmBar.classList.add("hidden");
        if (error.code === "not-logged-in") {
          feedbackState.loggedIn = false;
          renderFeedbackPanels();
        }
        showError($("#feedbackError"), error.message);
      }
    });
    confirmBar.appendChild(hint);
    confirmBar.appendChild(yes);
    confirmBar.appendChild(no);
    actions.appendChild(del);
    card.appendChild(actions);
    card.appendChild(confirmBar);
  } else {
    card.appendChild(actions);
  }
  const locate = document.createElement("button");
  locate.type = "button";
  locate.className = "secondary small";
  locate.textContent = "查看原文位置";
  locate.addEventListener("click", async () => {
    statusText.textContent = "正在打开…";
    try {
      await api("/api/feedback/open-location", {
        canonicalPath: comment.canonical_path,
        paragraphId: comment.paragraph_id || "",
        scope: comment.scope,
      });
      statusText.textContent = "已在浏览器打开。";
    } catch (error) {
      statusText.textContent = error.message;
    }
  });
  actions.appendChild(locate);
  actions.appendChild(statusText);
  return card;
}

function renderFeedbackPager(payload) {
  const pager = $("#feedbackPager");
  pager.textContent = "";
  feedbackState.pages = payload.pages || 1;
  if (feedbackState.pages <= 1) return;
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "secondary small";
  prev.textContent = "上一页";
  prev.disabled = feedbackState.page <= 1;
  prev.addEventListener("click", () => { feedbackState.page -= 1; loadComments(); });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "secondary small";
  next.textContent = "下一页";
  next.disabled = feedbackState.page >= feedbackState.pages;
  next.addEventListener("click", () => { feedbackState.page += 1; loadComments(); });
  const info = document.createElement("span");
  info.className = "meta-text";
  info.textContent = `第 ${feedbackState.page} / ${feedbackState.pages} 页 · 共 ${payload.total} 条`;
  pager.appendChild(prev);
  pager.appendChild(info);
  pager.appendChild(next);
}

async function loadComments() {
  hideError($("#feedbackError"));
  try {
    const payload = await apiGet(`/api/feedback/comments?${feedbackQuery()}`);
    renderFeedbackStats(payload.stats || {});
    const list = $("#feedbackList");
    list.textContent = "";
    const comments = payload.comments || [];
    if (!comments.length) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = "这个筛选条件下没有评论。";
      list.appendChild(empty);
    }
    for (const comment of comments) {
      list.appendChild(commentCard(comment, () => loadComments()));
    }
    renderFeedbackPager(payload);
  } catch (error) {
    if (error.code === "not-logged-in") {
      feedbackState.loggedIn = false;
      renderFeedbackPanels();
    }
    showError($("#feedbackError"), error.message);
  }
}

["feedbackStatus", "feedbackScope", "feedbackArticle"].forEach((id) => {
  $(`#${id}`).addEventListener("change", () => { feedbackState.page = 1; loadComments(); });
});
$("#feedbackSearch").addEventListener("input", debounce(() => { feedbackState.page = 1; loadComments(); }, 400));
$("#feedbackRefresh").addEventListener("click", () => loadComments());

/* 快捷处理：逐条审核待审核队列（先段评后章评） */

function quickCard(item, index, total) {
  const box = $("#feedbackQuick");
  box.textContent = "";
  const heading = document.createElement("h2");
  heading.textContent = `待审核 ${index + 1} / ${total}（${FEEDBACK_SCOPE_LABELS[item.scope] || item.scope}）`;
  box.appendChild(heading);
  const meta = document.createElement("p");
  meta.className = "meta-text";
  meta.textContent = `${item.title || item.article_id} · ${item.display_name || "（匿名）"} · ${String(item.created_at || "").replace("T", " ").slice(0, 19)}`;
  box.appendChild(meta);
  const excerpts = commentExcerptBlock(item);
  if (excerpts) box.appendChild(excerpts);
  const body = document.createElement("p");
  body.className = "comment-body quick-body";
  body.textContent = item.body || "";
  box.appendChild(body);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const advance = () => {
    feedbackState.quick.index += 1;
    renderQuick();
  };
  actions.appendChild(moderateButton("通过并下一条", "primary", "approve", item, advance));
  actions.appendChild(moderateButton("拒绝并下一条", "secondary", "reject", item, advance));
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "secondary small";
  skip.textContent = "跳过";
  skip.addEventListener("click", advance);
  actions.appendChild(skip);
  const quit = document.createElement("button");
  quit.type = "button";
  quit.className = "secondary small";
  quit.textContent = "退出快捷处理";
  quit.addEventListener("click", () => {
    feedbackState.quick = null;
    $("#feedbackQuick").classList.add("hidden");
    loadComments();
  });
  actions.appendChild(quit);
  box.appendChild(actions);
}

function renderQuick() {
  const box = $("#feedbackQuick");
  const quick = feedbackState.quick;
  if (!quick) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  if (quick.index >= quick.queue.length) {
    box.textContent = "";
    const heading = document.createElement("h2");
    heading.textContent = "待审核队列已清空";
    box.appendChild(heading);
    const text = document.createElement("p");
    text.className = "ok-text";
    text.textContent = "所有待审核评论都处理完了。";
    box.appendChild(text);
    const quit = document.createElement("button");
    quit.type = "button";
    quit.className = "secondary small";
    quit.textContent = "返回列表";
    quit.addEventListener("click", () => {
      feedbackState.quick = null;
      box.classList.add("hidden");
      loadComments();
    });
    box.appendChild(quit);
    return;
  }
  quickCard(quick.queue[quick.index], quick.index, quick.queue.length);
}

$("#feedbackQuickStart").addEventListener("click", async () => {
  hideError($("#feedbackError"));
  try {
    const [paragraph, article] = await Promise.all([
      apiGet("/api/feedback/comments?status=pending&scope=paragraph&page=1"),
      apiGet("/api/feedback/comments?status=pending&scope=article&page=1"),
    ]);
    const queue = [...(paragraph.comments || []), ...(article.comments || [])];
    feedbackState.quick = { queue, index: 0 };
    renderQuick();
  } catch (error) {
    if (error.code === "not-logged-in") {
      feedbackState.loggedIn = false;
      renderFeedbackPanels();
    }
    showError($("#feedbackError"), error.message);
  }
});

async function loadFeedback() {
  hideError($("#feedbackError"));
  clearTimeout(feedbackState.serviceTimer);
  const payload = await refreshFeedbackStatus();
  if (payload && payload.service.running && payload.loggedIn) {
    prepareFeedbackFilters();
    loadComments();
  }
}

/* 首页「阅读反馈」卡片 */

async function loadFeedbackCard() {
  const card = $("#feedbackCard");
  const body = $("#feedbackCardBody");
  body.textContent = "";
  try {
    const [statusPayload, notesPayload] = await Promise.all([
      apiGet("/api/feedback/status"),
      apiGet("/api/notes/summary"),
    ]);
    card.classList.remove("hidden");
    const summary = notesPayload.summary || { totalDraft: 0 };
    if (!statusPayload.service.running) {
      const text = document.createElement("p");
      text.className = "meta-text";
      text.textContent = "评论服务未运行。";
      body.appendChild(text);
      const start = document.createElement("button");
      start.type = "button";
      start.className = "primary small";
      start.textContent = "启动";
      const statusText = document.createElement("span");
      statusText.className = "preview-status";
      start.addEventListener("click", async () => {
        start.disabled = true;
        statusText.textContent = "正在启动（首次需构建，请耐心等待）…";
        try {
          await api("/api/feedback/service", { action: "start" });
          pollFeedbackService(Date.now() + 180000);
          setTimeout(loadFeedbackCard, 5000);
        } catch (error) {
          start.disabled = false;
          statusText.textContent = error.message;
        }
      });
      body.appendChild(start);
      body.appendChild(statusText);
    } else if (!statusPayload.loggedIn) {
      const text = document.createElement("p");
      text.className = "meta-text";
      text.textContent = "评论服务运行中，尚未登录。";
      body.appendChild(text);
      const link = document.createElement("a");
      link.className = "button primary small";
      link.href = "#/feedback";
      link.textContent = "登录";
      body.appendChild(link);
    } else {
      const stats = statusPayload.stats || {};
      const text = document.createElement("p");
      text.className = "meta-text";
      text.textContent = `待审核段评 ${stats.paragraphPending ?? 0} · 待审核章评 ${stats.articlePending ?? 0} · 作者评草稿 ${summary.totalDraft}`;
      body.appendChild(text);
      const link = document.createElement("a");
      link.className = "button secondary small";
      link.href = "#/feedback";
      link.textContent = "进入阅读反馈";
      body.appendChild(link);
    }
    if (!statusPayload.loggedIn && summary.totalDraft > 0) {
      const drafts = document.createElement("p");
      drafts.className = "meta-text";
      drafts.textContent = `作者评草稿 ${summary.totalDraft} 条（编辑页「作者评」面板管理）。`;
      body.appendChild(drafts);
    }
    if (summary.brokenPublished > 0) {
      const broken = document.createElement("p");
      broken.className = "warning-text";
      broken.textContent = `失效批注 ${summary.brokenPublished} 条：已发布但对应段落已不存在，发布前检查会被阻断，请在编辑页「作者评」面板处理。`;
      body.appendChild(broken);
    }
  } catch (error) {
    card.classList.add("hidden");
  }
}

/* ---------------- 作者评（data/author-notes/<articleId>.yaml） ---------------- */

const notesState = {
  list: [],
  paragraphs: [],
  editing: null, // null=新增；否则为批注 id
};

async function loadNotes() {
  hideError($("#notesError"));
  notesState.editing = null;
  $("#noteForm").classList.add("hidden");
  if (!editState.path) {
    $("#notesList").textContent = "";
    return;
  }
  try {
    const [notesPayload, paragraphsPayload] = await Promise.all([
      apiGet(`/api/notes?path=${encodeURIComponent(editState.path)}`),
      apiGet(`/api/notes/paragraphs?path=${encodeURIComponent(editState.path)}`),
    ]);
    notesState.list = notesPayload.notes || [];
    notesState.paragraphs = paragraphsPayload.paragraphs || [];
    renderNotes();
  } catch (error) {
    showError($("#notesError"), error.message);
  }
}

function noteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";
  const head = document.createElement("div");
  head.className = "article-head";
  const badges = document.createElement("span");
  badges.className = "badges";
  const scope = document.createElement("span");
  scope.className = "badge badge-type";
  scope.textContent = note.scope === "paragraph" ? "段落评" : "篇章评";
  badges.appendChild(scope);
  const status = document.createElement("span");
  status.className = note.status === "published" ? "badge badge-published" : "badge badge-draft";
  status.textContent = note.status === "published" ? "已发布" : "草稿";
  badges.appendChild(status);
  head.appendChild(badges);
  const updated = document.createElement("span");
  updated.className = "meta-text";
  updated.textContent = `更新于 ${note.updated}`;
  head.appendChild(updated);
  card.appendChild(head);
  if (note.scope === "paragraph") {
    const anchor = document.createElement("p");
    anchor.className = "meta-text";
    const found = notesState.paragraphs.find((item) => item.paragraphId === note.paragraphId);
    anchor.textContent = `段落 ${note.paragraphId}${found ? `：${found.excerpt}` : "（当前正文未找到该锚点）"}`;
    card.appendChild(anchor);
  }
  const body = document.createElement("p");
  body.className = "comment-body";
  body.textContent = note.body;
  card.appendChild(body);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "secondary small";
  edit.textContent = "编辑";
  edit.addEventListener("click", () => openNoteForm(note));
  actions.appendChild(edit);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger small";
  del.textContent = "删除";
  const confirmBar = document.createElement("div");
  confirmBar.className = "confirm-bar hidden";
  const hint = document.createElement("span");
  hint.textContent = "将真正删除这条批注（有 git 与保存备份兜底）。确认删除？";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "danger small";
  yes.textContent = "确认删除";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "secondary small";
  no.textContent = "取消";
  del.addEventListener("click", () => confirmBar.classList.remove("hidden"));
  no.addEventListener("click", () => confirmBar.classList.add("hidden"));
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    try {
      await api("/api/notes/delete", { path: editState.path, id: note.id, confirm: true });
      loadNotes();
    } catch (error) {
      yes.disabled = false;
      confirmBar.classList.add("hidden");
      showError($("#notesError"), error.message);
    }
  });
  confirmBar.appendChild(hint);
  confirmBar.appendChild(yes);
  confirmBar.appendChild(no);
  actions.appendChild(del);
  card.appendChild(actions);
  card.appendChild(confirmBar);
  return card;
}

function renderNotes() {
  const list = $("#notesList");
  list.textContent = "";
  if (!notesState.list.length) {
    const empty = document.createElement("p");
    empty.className = "meta-text";
    empty.textContent = "这篇文章还没有作者评。";
    list.appendChild(empty);
    return;
  }
  for (const note of notesState.list) {
    list.appendChild(noteCard(note));
  }
}

function fillParagraphSelect(selected) {
  const select = $("#noteParagraph");
  select.textContent = "";
  for (const item of notesState.paragraphs) {
    const option = document.createElement("option");
    option.value = item.paragraphId;
    option.textContent = item.excerpt ? `${item.excerpt}（${item.paragraphId}）` : item.paragraphId;
    select.appendChild(option);
  }
  if (selected) select.value = selected;
}

function openNoteForm(note) {
  hideError($("#notesError"));
  const isNew = !note;
  const scope = note ? note.scope : notesState.newScope;
  notesState.editing = note ? note.id : null;
  $("#noteFormTitle").textContent = note
    ? `编辑${scope === "paragraph" ? "段落评" : "篇章评"}（${note.id}）`
    : scope === "paragraph" ? "新增段落评" : "新增篇章评";
  $("#noteParagraphWrap").classList.toggle("hidden", scope !== "paragraph");
  if (scope === "paragraph") fillParagraphSelect(note ? note.paragraphId : "");
  $("#noteBody").value = note ? note.body : "";
  $("#notePublished").checked = note ? note.status === "published" : false;
  $("#noteSaveStatus").textContent = "";
  $("#noteForm").classList.remove("hidden");
  $("#noteBody").focus();
  return isNew;
}

$("#noteAddParagraph").addEventListener("click", () => {
  if (!editState.path) return;
  notesState.newScope = "paragraph";
  openNoteForm(null);
});

$("#noteAddArticle").addEventListener("click", () => {
  if (!editState.path) return;
  notesState.newScope = "article";
  openNoteForm(null);
});

$("#noteCancel").addEventListener("click", () => {
  notesState.editing = null;
  $("#noteForm").classList.add("hidden");
});

$("#noteSave").addEventListener("click", async () => {
  hideError($("#notesError"));
  const status = $("#noteSaveStatus");
  const editing = notesState.editing ? notesState.list.find((note) => note.id === notesState.editing) : null;
  const scope = editing ? editing.scope : notesState.newScope;
  const note = {
    body: $("#noteBody").value,
    status: $("#notePublished").checked ? "published" : "draft",
  };
  if (editing) note.id = editing.id;
  note.scope = scope;
  if (scope === "paragraph") note.paragraphId = $("#noteParagraph").value;
  if (!note.body.trim()) {
    showError($("#notesError"), "批注正文不能为空。");
    return;
  }
  status.textContent = "正在保存…";
  $("#noteSave").disabled = true;
  try {
    await api("/api/notes/save", { path: editState.path, note });
    status.textContent = "已保存。";
    notesState.editing = null;
    $("#noteForm").classList.add("hidden");
    loadNotes();
  } catch (error) {
    status.textContent = "";
    showError($("#notesError"), error.message);
  } finally {
    $("#noteSave").disabled = false;
  }
});

/* ---------------- 启动 ---------------- */

initTheme();
route();
