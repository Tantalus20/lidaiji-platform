/* 媒体库。 */
import { api, apiGet } from "./api.mjs";
import { $, hideError, showError } from "./util.mjs";

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

export { loadMedia };

