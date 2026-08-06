/* 文章管理首页 + 新建文章。 */
import { api, apiGet } from "./api.mjs";
import { $, debounce, globalError, hideError, showError, SECTION_LABELS, SLUG_PATTERN } from "./util.mjs";
import { state } from "./state.mjs";
import { loadFeedbackCard } from "./feedback.mjs";

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
    window.studioDeployDisabled = payload.deployDisabled === true;
    if (window.studioDeployDisabled) {
      const banner = document.getElementById("deployDevBanner");
      if (banner) banner.classList.remove("hidden");
    }
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

export { loadHome, prepareNewForm };

