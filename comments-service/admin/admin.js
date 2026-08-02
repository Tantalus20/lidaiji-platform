"use strict";

const state = { csrf: "", page: 1, status: "pending", q: "", scope: "all" };
const $ = (selector) => document.querySelector(selector);
const loginPanel = $("#login-panel");
const dashboard = $("#dashboard");
const statusNode = $("#dashboard-status");

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(state.csrf ? { "X-CSRF-Token": state.csrf } : {}), ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({ error: "服务响应格式异常。" }));
  if (!response.ok) throw new Error(body.error || "操作失败。");
  return body;
}

function text(tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function showDashboard(session) {
  state.csrf = session.csrfToken;
  loginPanel.hidden = true;
  dashboard.hidden = false;
  $("#logout").hidden = false;
  loadComments();
}

function renderStats(stats) {
  const labels = { pending: "待审核", approved: "已通过", spam: "垃圾", orphaned: "孤立段评" };
  const container = $("#stats");
  container.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const card = document.createElement("div");
    card.className = "stat";
    card.append(text("strong", String(stats[key] || 0)), text("span", label));
    container.append(card);
  }
}

function actionButton(label, action, className = "") {
  const button = text("button", label, className);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

function renderComment(item) {
  const isArticle = item.scope === "article";
  const card = document.createElement("article");
  card.className = "comment-card";
  card.dataset.commentId = item.id;
  const selection = document.createElement("label");
  selection.className = "comment-select";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.name = "selectedComment";
  checkbox.value = item.id;
  selection.append(checkbox, document.createTextNode(" 选择此评论"));
  card.append(selection);
  const meta = document.createElement("div");
  meta.className = "comment-meta";
  const badge = text("span", isArticle ? "章评" : "段评", isArticle ? "scope-badge article" : "scope-badge");
  meta.append(badge, text("span", item.display_name), text("time", new Date(item.created_at).toLocaleString("zh-CN")));
  if (!isArticle) meta.append(text("code", item.paragraph_id));
  card.append(meta, text("h2", item.title));
  const link = text("a", isArticle ? "查看文章章评区" : "查看文章对应段落");
  link.href = isArticle ? `${item.canonical_path}#article-comments` : `${item.canonical_path}#${item.paragraph_id}`;
  link.target = "_blank";
  link.rel = "noopener";
  card.append(link);
  if (!isArticle) {
    card.append(text("p", item.current_excerpt || "原段落已从当前版本删除。", "excerpt"));
    if (item.current_excerpt !== item.paragraph_excerpt) {
      card.append(text("p", `提交时摘录：${item.paragraph_excerpt}`, "excerpt old-excerpt"));
    }
  }
  card.append(text("p", item.body, "comment-body"));
  const actions = document.createElement("div");
  actions.className = "actions";
  if (item.status !== "approved") actions.append(actionButton("审核通过", "approve"));
  actions.append(actionButton("拒绝", "reject", "secondary"), actionButton("标记垃圾", "spam", "danger"));
  if (item.status === "approved") actions.append(actionButton("隐藏", "hide", "secondary"));
  actions.append(actionButton("逻辑删除", "delete", "secondary"));
  card.append(actions);
  return card;
}

async function loadComments() {
  statusNode.textContent = "正在读取评论……";
  try {
    const params = new URLSearchParams({ status: state.status, page: state.page, q: state.q, articleId: state.articleId || "", scope: state.scope });
    if (state.containsLink) params.set("containsLink", "1");
    if (state.duplicatesOnly) params.set("duplicatesOnly", "1");
    const data = await api(`/api/comments/v1/admin/comments?${params}`);
    renderStats(data.stats);
    const list = $("#comment-list");
    list.replaceChildren(...data.comments.map(renderComment));
    if (!data.comments.length) list.append(text("p", "当前筛选下没有评论。"));
    const pagination = $("#pagination");
    pagination.replaceChildren();
    if (data.page > 1) pagination.append(actionButton("上一页", "previous", "secondary"));
    pagination.append(text("span", `第 ${data.page} / ${data.pages} 页`));
    if (data.page < data.pages) pagination.append(actionButton("下一页", "next", "secondary"));
    statusNode.textContent = `共 ${data.total} 条。`;
  } catch (error) {
    statusNode.textContent = error.message;
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formStatus = form.querySelector(".form-status");
  const submit = form.querySelector("button");
  submit.disabled = true;
  formStatus.textContent = "正在登录……";
  try {
    const values = new FormData(form);
    showDashboard(await api("/api/comments/v1/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: values.get("username"), password: values.get("password") }),
    }));
    form.reset();
  } catch (error) {
    formStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#filters").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  state.status = values.get("status");
  state.scope = values.get("scope");
  state.q = values.get("q").trim();
  state.articleId = values.get("articleId").trim();
  state.containsLink = values.get("containsLink") === "1";
  state.duplicatesOnly = values.get("duplicatesOnly") === "1";
  state.page = 1;
  loadComments();
});

$("#comment-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest("[data-comment-id]");
  const action = button.dataset.action;
  if (action === "approve" && !window.confirm("确认公开这条段评？公开后读者将立即可见。")) return;
  button.disabled = true;
  try {
    await api(`/api/comments/v1/admin/comments/${card.dataset.commentId}/${action}`, { method: "POST", body: "{}" });
    card.remove();
    statusNode.textContent = "审核状态已更新。";
    loadComments();
  } catch (error) {
    statusNode.textContent = error.message;
    button.disabled = false;
  }
});

$("#pagination").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  state.page += button.dataset.action === "next" ? 1 : -1;
  loadComments();
});

document.querySelector(".batch-actions").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-batch]");
  if (!button) return;
  const ids = [...document.querySelectorAll("input[name=selectedComment]:checked")].map((item) => item.value);
  if (!ids.length) {
    statusNode.textContent = "请先选择至少一条段评。";
    return;
  }
  const action = button.dataset.batch;
  if (!window.confirm(`确认对所选 ${ids.length} 条段评执行批量操作？`)) return;
  button.disabled = true;
  try {
    await api("/api/comments/v1/admin/comments/batch", { method: "POST", body: JSON.stringify({ ids, action }) });
    statusNode.textContent = "批量审核完成。";
    loadComments();
  } catch (error) {
    statusNode.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  try { await api("/api/comments/v1/admin/logout", { method: "POST", body: "{}" }); } catch {}
  state.csrf = "";
  dashboard.hidden = true;
  loginPanel.hidden = false;
  $("#logout").hidden = true;
});

api("/api/comments/v1/admin/session").then(showDashboard).catch(() => {});
