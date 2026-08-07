/* 长文分享：列表首页、新建/编辑入口、发布确认与发布任务管理。
 * 复用同一 ProseMirror 内核与同一编辑页（document mode = share），
 * 只新增分享专用的列表、元数据表单与发布确认流程。 */
import { api, apiGet } from "./api.mjs";
import { showView } from "./router.mjs";
import { $, debounce, hideError, showError } from "./util.mjs";
import { editState } from "./state.mjs";
import {
  openEditor,
  saveArticle,
  setEditMode,
  ensureEditor,
  resetShareForm,
  updateShareChars,
  studioEditor,
} from "./editor-page.mjs";

const SHARE_KIND_LABELS = {
  "original-writing": "我的文章", fiction: "小说", news: "新闻", paper: "论文",
  "public-domain-work": "公共领域作品", other: "其他",
};
const SHARE_RIGHTS_LABELS = {
  original: "原创", "public-domain": "公共领域", licensed: "已获授权", cc: "CC许可",
  excerpt: "摘录", "link-only": "仅链接",
};
const QQ_TEXT_MAX = 2000;

const shareState = {
  items: [],
  publications: [],
  baseUrl: "",
  qzoneEnabled: false,
  qzoneConfigured: false,
  pendingHash: "",
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

/* ---------------- 分享首页 ---------------- */

function renderShareGroups() {
  const container = $("#shareGroups");
  container.innerHTML = "";
  const filter = ($("#shareFilter").value || "").trim().toLowerCase();
  const visible = shareState.items.filter(
    (item) => !filter || item.title.toLowerCase().includes(filter) || (item.author || "").toLowerCase().includes(filter),
  );
  const publishedIds = new Set(
    shareState.publications.filter((pub) => pub.shareDraft === false).map((pub) => pub.share_id),
  );
  const groups = [
    { key: "draft", title: "草稿", items: visible.filter((item) => item.draft) },
    { key: "pending", title: "待发布", items: visible.filter((item) => !item.draft && !publishedIds.has(item.shareId)) },
    { key: "published", title: "已发布", items: visible.filter((item) => !item.draft && publishedIds.has(item.shareId)) },
  ];
  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "share-group";
    const heading = document.createElement("h2");
    heading.className = "group-title";
    heading.textContent = `${group.title}（${group.items.length}）`;
    section.appendChild(heading);
    if (!group.items.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "没有内容。";
      section.appendChild(empty);
    }
    for (const item of group.items) {
      const row = document.createElement("div");
      row.className = "share-row";
      const link = document.createElement("a");
      link.href = `#/share-edit?path=${encodeURIComponent(item.path)}`;
      const title = document.createElement("span");
      title.className = "share-row-title";
      title.textContent = item.title;
      const meta = document.createElement("span");
      meta.className = "share-row-meta";
      meta.textContent =
        `${SHARE_KIND_LABELS[item.shareKind] || item.shareKind} · ${SHARE_RIGHTS_LABELS[item.rightsMode] || item.rightsMode}` +
        ` · ${item.author || "佚名"} · ${String(item.date || "").slice(0, 10)} · ${item.wordCount} 字`;
      link.append(title, meta);
      row.appendChild(link);
      section.appendChild(row);
    }
    container.appendChild(section);
  }
}

function renderPublications() {
  const box = $("#sharePublications");
  box.innerHTML = "";
  if (!shareState.publications.length) {
    box.textContent = "（还没有发布任务）";
    return;
  }
  const table = document.createElement("table");
  table.className = "data-table";
  const head = document.createElement("thead");
  head.innerHTML = "<tr><th>任务</th><th>分享</th><th>网页</th><th>状态</th><th>发布时间</th><th>操作</th></tr>";
  table.appendChild(head);
  const tbody = document.createElement("tbody");
  const webText = (pub) =>
    pub.web_status === "verified" ? "已发布" : pub.web_status === "failed" ? "网页失败" : pub.web_status === "building" ? "构建中" : "待构建";
  const qzoneText = (pub) => ({
    scheduled: "待发布",
    publishing: "发布中",
    submitted_unverified: "已提交，待反查",
    published: "已发布",
    failed: "失败",
    cancelled: "已取消",
    skipped: "QQ 未启用",
  }[pub.qzone_status] || pub.qzone_status);
  for (const pub of shareState.publications) {
    const tr = document.createElement("tr");
    const canCancel = ["scheduled", "publishing"].includes(pub.qzone_status);
    tr.innerHTML = `
      <td><code>${pub.publication_id}</code></td>
      <td>${pub.shareTitle || pub.share_id}<br><small>${pub.share_revision}</small></td>
      <td>${pub.canonical_url || "—"}${pub.error_code ? `<br><small class="danger-text">${pub.error_code}</small>` : ""}</td>
      <td>${webText(pub)} / ${qzoneText(pub)}${pub.error_message ? `<br><small title="${escapeHtml(pub.error_message)}">${escapeHtml(String(pub.error_message).slice(0, 50))}</small>` : ""}</td>
      <td>${String(pub.scheduled_at).replace("T", " ").slice(0, 16)}</td>
      <td>${canCancel ? `<button class="secondary small" data-cancel="${pub.publication_id}" type="button">取消任务</button>` : ""}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  box.querySelectorAll("[data-cancel]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api("/api/share/publication/cancel", { publicationId: button.dataset.cancel });
        loadShareHome();
      } catch (error) {
        showError($("#shareError"), error.message);
      }
    });
  });
}

async function loadShareHome() {
  hideError($("#shareError"));
  try {
    const [items, publications, status] = await Promise.all([
      apiGet("/api/share/items"),
      apiGet("/api/share/publications"),
      apiGet("/api/share/publish-status"),
    ]);
    shareState.items = items.items;
    shareState.publications = publications.publications;
    shareState.baseUrl = status.status.baseUrl;
    shareState.qzoneEnabled = status.status.qzoneEnabled;
    shareState.qzoneConfigured = status.status.qzoneConfigured;
    window.shareBaseUrl = shareState.baseUrl;
    const note = shareState.qzoneEnabled
      ? (shareState.qzoneConfigured ? "QQ 自动发布：已启用" : "QQ 自动发布：已启用但未配置账号")
      : "QQ 自动发布：未启用";
    $("#sharePublishNote").textContent = note;
    renderShareGroups();
    renderPublications();
  } catch (error) {
    showError($("#shareError"), error.message);
  }
  refreshSharePreviewStatus();
}

async function refreshSharePreviewStatus() {
  try {
    const payload = await apiGet("/api/share/preview-status");
    const status = $("#sharePreviewStatus");
    status.textContent = payload.preview.running ? `分享站预览运行中：${payload.preview.url}` : "";
  } catch (error) {
    $("#sharePreviewStatus").textContent = "";
  }
}

function startSharePreview() {
  const status = $("#sharePreviewStatus");
  status.textContent = "正在启动…";
  api("/api/share/preview", { action: "start" })
    .then((payload) => {
      status.textContent = payload.preview.running
        ? `分享站预览运行中：${payload.preview.url}`
        : "预览进程已退出，请检查 1314 端口。";
    })
    .catch((error) => {
      status.textContent = error.message;
    });
}

$("#shareFilter").addEventListener("input", renderShareGroups);
$("#sharePreviewBtn").addEventListener("click", startSharePreview);

/* ---------------- 分享编辑（复用同一编辑页） ---------------- */

async function openShareEditor(path) {
  await openEditor(path, "share");
}

function prepareShareNew() {
  editState.path = "";
  editState.articleId = "";
  editState.dirty = false;
  editState.shareUrl = "";
  setEditMode("share");
  $("#editTitle").textContent = "（新建分享）";
  $("#editDraftBadge").classList.add("hidden");
  resetShareForm();
  ensureEditor().setMarkdown("");
  $("#editSaveStatus").textContent = "";
  $("#editWordCount").textContent = "";
  $("#draftBar").classList.add("hidden");
  hideError($("#editError"));
  showEditorModeForShare();
  if (studioEditor) studioEditor.focus();
}

function showEditorModeForShare() {
  const host = $("#editorHost");
  if (host) host.classList.remove("hidden");
  $("#editorPreviewWrap").classList.add("hidden");
  $("#editorSourceWrap").classList.add("hidden");
}

async function saveShareEditor(showStatus = true) {
  hideError($("#editError"));
  const fields = readShareFmFormForSave();
  if (!fields.title || !fields.author) {
    showError($("#editError"), "标题与作者不能为空。");
    return false;
  }
  if (!editState.path) {
    const status = $("#editSaveStatus");
    status.textContent = "正在创建…";
    try {
      const created = await api("/api/share/item/new", {
        title: fields.title,
        author: fields.author,
        shareKind: fields.shareKind,
        rightsMode: fields.rightsMode,
      });
      editState.path = created.share.path;
      editState.shareUrl = created.share.slug ? `/${created.share.slug}/` : "";
    } catch (error) {
      status.textContent = "创建失败";
      showError($("#editError"), error.message);
      return false;
    }
  }
  const ok = await saveArticle();
  return ok;
}

function readShareFmFormForSave() {
  const form = $("#shareFmForm");
  return {
    title: form.title.value.trim(),
    author: form.author.value.trim(),
    sourceName: form.sourceName.value.trim(),
    sourceUrl: form.sourceUrl.value.trim(),
    shareKind: form.shareKind.value,
    rightsMode: form.rightsMode.value,
    description: form.description.value.trim(),
    categories: form.categories.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
    qqSummary: $("#shareQqSummary").value,
  };
}

$("#editSave").addEventListener("click", async () => {
  if (editState.mode !== "share") return;
  hideError($("#editError"));
  await saveShareEditor();
});

$("#editBack").addEventListener("click", () => {
  editState.pendingHash = "";
});

$("#shareEditPreview").addEventListener("click", async () => {
  const status = $("#editSaveStatus");
  if (editState.dirty || !editState.path) {
    status.textContent = "请先保存，再打开网页预览。";
    return;
  }
  status.textContent = "正在打开分享站预览…";
  try {
    const payload = await api("/api/share/preview", { action: "start" });
    status.textContent = payload.preview.running
      ? `已打开：${payload.preview.url}（1314 端口，含草稿）`
      : "预览进程已退出，请检查 1314 端口。";
  } catch (error) {
    status.textContent = error.message;
  }
});

/* ---------------- 发布确认 ---------------- */

async function prepareShareConfirm() {
  hideError($("#shareConfirmError"));
  const status = $("#editSaveStatus");
  if (!editState.path || editState.dirty) {
    status.textContent = "正在保存…";
    const saved = await saveShareEditor(false);
    if (!saved) return;
  }
  try {
    const publishStatus = await apiGet("/api/share/publish-status");
    shareState.baseUrl = publishStatus.status.baseUrl;
    shareState.qzoneEnabled = publishStatus.status.qzoneEnabled;
    shareState.qzoneConfigured = publishStatus.status.qzoneConfigured;
    window.shareBaseUrl = shareState.baseUrl;
  } catch (error) {
    showError($("#editError"), error.message);
    return;
  }
  const item = await apiGet(`/api/share/item?path=${encodeURIComponent(editState.path)}`);
  const fm = item.share.frontMatter;
  editState.shareUrl = item.share.url;
  const base = (shareState.baseUrl || "http://localhost:1314/").replace(/\/$/, "");
  $("#shareConfirmUrl").textContent = `${base}${editState.shareUrl}`;
  $("#shareConfirmText").dataset.touched = "";
  updateShareChars();
  const enabledNote = $("#shareQqEnabledNote");
  enabledNote.textContent = shareState.qzoneEnabled
    ? (shareState.qzoneConfigured
      ? "QQ 自动发布：已启用。到时间后发布器会自动发送，并记录结果。"
      : "QQ 自动发布已启用，但 NapCat 地址/QQ 账号未配置，QQ 阶段会标记失败。")
    : "QQ 自动发布：未启用。确认后只生成网页候选并记录任务；QQ 阶段会标记「未启用」，不会向任何 QQ 号发送内容。";
  enabledNote.classList.toggle("danger-text", shareState.qzoneEnabled && !shareState.qzoneConfigured);
  const draftNotice = $("#shareConfirmDraftNote");
  if (draftNotice) {
    draftNotice.textContent = fm.draft
      ? "提示：确认发布时该分享会转为正式（非草稿）并出现在分享站首页。"
      : "";
  }
  $("#shareConfirmLog").classList.add("hidden");
  $("#shareConfirmStatus").textContent = "";
  $("#shareConfirmBtn").disabled = false;
  routeShareConfirm();
}

function routeShareConfirm() {
  showView("share-confirm");
}

$("#shareEditPrepare").addEventListener("click", prepareShareConfirm);

$("#shareConfirmBack").addEventListener("click", () => {
  /* 直接切回编辑视图；hash 未变时不触发路由，因此不依赖导航 */
  showView("edit");
  $("#editSaveStatus").textContent = editState.dirty ? "有未保存修改" : "";
});

$("#shareConfirmText").addEventListener("input", () => {
  $("#shareConfirmText").dataset.touched = "1";
  const length = [...$("#shareConfirmText").value].length;
  $("#shareConfirmTextInfo").textContent = `最终文案约 ${length} 字（上限约 ${QQ_TEXT_MAX} 字，最终以 QQ 接口为准）`;
  $("#shareConfirmTextInfo").classList.toggle("danger-text", length > 1900);
});

$("#shareConfirmBtn").addEventListener("click", async () => {
  hideError($("#shareConfirmError"));
  const status = $("#shareConfirmStatus");
  const button = $("#shareConfirmBtn");
  const finalText = $("#shareConfirmText").value.trim();
  if (!finalText) {
    showError($("#shareConfirmError"), "QQ 空间最终文案不能为空。");
    return;
  }
  const when = document.querySelector('input[name="shareWhen"]:checked').value;
  let scheduledAt = new Date().toISOString();
  if (when === "scheduled") {
    const value = $("#shareWhenAt").value;
    if (!value) {
      showError($("#shareConfirmError"), "请选择定时发布时间。");
      return;
    }
    scheduledAt = new Date(value).toISOString();
  }
  button.disabled = true;
  status.textContent = "正在创建发布任务并构建分享站候选（可能需要 1–2 分钟）…";
  $("#shareConfirmLog").classList.add("hidden");
  try {
    const payload = await api("/api/share/publication", {
      path: editState.path,
      finalText,
      scheduledAt,
    });
    const log = $("#shareConfirmLog");
    log.textContent = payload.webStage && payload.webStage.message
      ? `网页阶段：${payload.webStage.message}`
      : "";
    log.classList.remove("hidden");
    const pub = payload.publication;
    if (payload.webStage && payload.webStage.stage === "verified") {
      status.textContent =
        `已加入发布队列（${pub.publication_id}）` +
        (when === "scheduled" ? "，到时间后自动发布。" : "，已加入立即发布队列。");
    } else {
      status.textContent = "任务已建立，但网页阶段未完成（详见发布记录）；QQ 阶段仍会按时间执行。";
    }
    setTimeout(() => {
      location.hash = "#/share";
      loadShareHome();
    }, 1800);
  } catch (error) {
    status.textContent = "创建失败";
    showError($("#shareConfirmError"), error.message);
    button.disabled = false;
  }
});

/* 顶部导航直接进入确认页时，回到分享首页 */
if (document.querySelector("[data-nav='share']")) {
  document.querySelector("[data-nav='share']").addEventListener("click", () => {
    editState.pendingHash = "";
  });
}

export { loadShareHome, openShareEditor, prepareShareNew, routeShareConfirm };
