/* 阅读反馈（段评/章评审核）。 */
import { api, apiGet } from "./api.mjs";
import { $, debounce, hideError, showError } from "./util.mjs";

/* ---------------- 阅读反馈（段评/章评审核） ---------------- */

const feedbackState = {
  loggedIn: false,
  username: "",
  serviceRunning: false,
  serviceSourceLabel: "",
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
  if (feedbackState.serviceSourceLabel) {
    $("#feedbackServiceStatus").textContent = feedbackState.serviceSourceLabel;
  }
}

async function refreshFeedbackStatus() {
  try {
    const payload = await apiGet("/api/feedback/status");
    feedbackState.serviceRunning = Boolean(payload.service && payload.service.running);
    feedbackState.serviceSourceLabel = (payload.service && payload.service.sourceLabel) || "";
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
      return;
    }
    if (Date.now() < deadline) {
      pollFeedbackService(deadline);
    } else {
      $("#feedbackServiceStatus").textContent = "等待超时：评论服务仍未就绪，请检查 SSH 隧道或服务器状态。";
    }
  }, 3000);
}

$("#feedbackServiceStart").addEventListener("click", async () => {
  hideError($("#feedbackError"));
  const status = $("#feedbackServiceStatus");
  status.textContent = "正在连接生产评论服务（SSH 隧道）…";
  try {
    await api("/api/feedback/service", { action: "start" });
    pollFeedbackService(Date.now() + 60000);
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

export { loadFeedback, loadFeedbackCard };

