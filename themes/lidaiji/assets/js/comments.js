"use strict";

(() => {
  const article = document.querySelector("[data-comment-article-id]");
  if (!article || article.dataset.commentMode === "off") return;
  const articleId = article.dataset.commentArticleId;
  const revision = article.dataset.commentRevision;
  const mode = article.dataset.commentMode;
  const panel = document.querySelector("#paragraph-comments");
  if (!panel) return;
  const title = panel.querySelector("[data-comments-title]");
  const excerpt = panel.querySelector("[data-comments-excerpt]");
  const list = panel.querySelector("[data-comments-list]");
  const form = panel.querySelector("form");
  const status = panel.querySelector("[data-comments-status]");
  const close = panel.querySelector("[data-comments-close]");
  let trigger = null;
  let paragraphId = "";

  // 状态提示分三级：muted（读取中）、success（已提交待审）、error（失败/不可用）。
  function setStatus(message, tone = "") {
    status.textContent = message;
    if (tone) status.dataset.tone = tone;
    else status.removeAttribute("data-tone");
  }

  function clientId() {
    let value = localStorage.getItem("lidaiji-comment-client");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(value || "")) {
      const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      value = crypto.randomUUID ? crypto.randomUUID() : fallback;
      localStorage.setItem("lidaiji-comment-client", value);
    }
    return value;
  }

  function openPanel(button) {
    trigger = button;
    paragraphId = button.dataset.paragraphId;
    const paragraph = document.getElementById(paragraphId);
    title.textContent = `本段段评`;
    excerpt.textContent = (paragraph?.textContent || "").trim().slice(0, 180);
    list.replaceChildren();
    setStatus("正在读取已公开段评……", "muted");
    form.hidden = mode !== "open";
    if (mode === "locked") setStatus("本文段评已锁定，已公开内容仍可阅读。", "muted");
    panel.showModal();
    close.focus();
    fetchComments();
  }

  function commentNode(comment) {
    const item = document.createElement("article");
    item.className = "paragraph-comment";
    const header = document.createElement("header");
    const name = document.createElement("strong");
    name.textContent = comment.displayName;
    const time = document.createElement("time");
    time.dateTime = comment.publicAt;
    time.textContent = new Date(comment.publicAt).toLocaleDateString("zh-CN");
    header.append(name, time);
    const body = document.createElement("p");
    body.textContent = comment.body;
    item.append(header, body);
    if (comment.paragraphRevised) {
      const note = document.createElement("small");
      note.textContent = "此评论针对该段较早版本提交，正文后来有所修订。";
      item.append(note);
    }
    return item;
  }

  async function fetchComments() {
    list.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`/api/comments/v1/articles/${encodeURIComponent(articleId)}/paragraphs/${encodeURIComponent(paragraphId)}`);
      if (!response.ok) throw new Error();
      const data = await response.json();
      list.replaceChildren(...data.comments.map(commentNode));
      if (!data.comments.length) {
        const empty = document.createElement("p");
        empty.className = "comments-empty";
        empty.textContent = "这段还没有公开段评。";
        list.append(empty);
      }
      if (mode === "open") setStatus("");
    } catch {
      list.replaceChildren();
      setStatus("段评暂时无法读取，正文阅读不受影响。", "error");
    } finally {
      list.setAttribute("aria-busy", "false");
    }
  }

  function installButtons(counts = {}) {
    const paragraphs = article.querySelectorAll(".article-content > p[data-paragraph-id]");
    for (const paragraph of paragraphs) {
      const id = paragraph.dataset.paragraphId;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "paragraph-comment-button";
      button.dataset.paragraphId = id;
      // Visible label is rendered by CSS ::before from data-badge so that
      // selecting and copying the paragraph never includes the button text.
      button.dataset.badge = counts[id] ? ` ${counts[id]}` : "";
      button.setAttribute("aria-label", `查看或提交本段段评${counts[id] ? `，已有${counts[id]}条` : ""}`);
      paragraph.appendChild(button);
    }
  }

  fetch(`/api/comments/v1/articles/${encodeURIComponent(articleId)}/counts`)
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then((data) => installButtons(data.counts || {}))
    .catch(() => installButtons({}));

  article.addEventListener("click", (event) => {
    const button = event.target.closest(".paragraph-comment-button");
    if (button) openPanel(button);
  });
  close.addEventListener("click", () => panel.close());
  panel.addEventListener("close", () => {
    form.reset();
    setStatus("");
    trigger?.focus();
  });
  panel.addEventListener("click", (event) => {
    if (event.target === panel) panel.close();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    const values = new FormData(form);
    submit.disabled = true;
    submit.textContent = "正在提交……";
    setStatus("");
    try {
      const response = await fetch("/api/comments/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          articleId,
          articleRevision: revision,
          paragraphId,
          displayName: values.get("displayName"),
          body: values.get("body"),
          website: values.get("website"),
          clientId: clientId(),
        }),
      });
      const data = await response.json().catch(() => ({ error: "服务响应异常。" }));
      if (!response.ok) throw new Error(data.error || "提交失败，请稍后再试。");
      form.reset();
      setStatus(data.message, "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "提交段评，等待审核";
    }
  });
})();
