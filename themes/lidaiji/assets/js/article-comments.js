"use strict";

// 章评：针对整篇文章的评论。与段评共用评论服务与审核流程，scope=article。
// 防御原则：评论服务不可用时只影响本区域，正文、段评与上下篇导航不受影响。

(() => {
  const article = document.querySelector("[data-comment-article-id]");
  const section = document.querySelector("[data-article-comments]");
  if (!article || !section) return;
  const articleId = article.dataset.commentArticleId;
  const mode = article.dataset.commentMode;
  if (!articleId || mode === "off") return;

  const total = section.querySelector("[data-ac-total]");
  const openButton = section.querySelector("[data-ac-open]");
  const moreButton = section.querySelector("[data-ac-more]");
  const list = section.querySelector("[data-ac-list]");
  const status = section.querySelector("[data-ac-status]");
  const form = section.querySelector("[data-ac-form]");
  const bodyInput = form.querySelector("[data-ac-body]");
  const counter = section.querySelector("[data-ac-count]");
  const cancelButton = form.querySelector("[data-ac-cancel]");
  const submitButton = form.querySelector("button[type=submit]");
  const PAGE_SIZE = 5;
  let loaded = 0;
  let knownTotal = 0;
  let loading = false;

  function clientId() {
    let value = localStorage.getItem("lidaiji-comment-client");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(value || "")) {
      const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      value = crypto.randomUUID ? crypto.randomUUID() : fallback;
      localStorage.setItem("lidaiji-comment-client", value);
    }
    return value;
  }

  function setStatus(message, tone = "") {
    status.textContent = message;
    if (tone) status.dataset.tone = tone;
    else status.removeAttribute("data-tone");
  }

  function commentNode(comment, index) {
    const item = document.createElement("article");
    item.className = "article-comment";
    const header = document.createElement("header");
    const name = document.createElement("strong");
    name.textContent = comment.displayName;
    const time = document.createElement("time");
    time.dateTime = comment.publicAt;
    time.textContent = new Date(comment.publicAt).toLocaleDateString("zh-CN");
    const floor = document.createElement("span");
    floor.className = "article-comment-floor";
    floor.textContent = `#${index + 1}`;
    header.append(name, time, floor);
    const body = document.createElement("p");
    body.textContent = comment.body;
    item.append(header, body);
    return item;
  }

  function updateSummary() {
    total.textContent = knownTotal > 0 ? ` ${knownTotal}` : "";
    moreButton.hidden = loading || loaded >= knownTotal;
  }

  function failToLoad() {
    setStatus("章评暂时无法加载，正文阅读不受影响。", "error");
    moreButton.hidden = true;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "article-comments-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", () => {
      retry.remove();
      setStatus("");
      loadSummary();
    }, { once: true });
    status.append(" ", retry);
  }

  async function loadSummary() {
    try {
      const response = await fetch(`/api/comments/v1/articles/${encodeURIComponent(articleId)}/counts`);
      if (!response.ok) throw new Error();
      const data = await response.json();
      knownTotal = Number(data.articleCount) || 0;
      updateSummary();
      if (mode === "open") openButton.hidden = false;
      if (mode === "locked") setStatus("本文章评已锁定，已公开内容仍可阅读。", "muted");
      if (knownTotal > 0 && loaded === 0) await loadPage();
      if (knownTotal === 0) {
        list.replaceChildren();
        const empty = document.createElement("p");
        empty.className = "comments-empty";
        empty.textContent = "这篇文章还没有公开章评。";
        list.append(empty);
      }
    } catch {
      failToLoad();
    }
  }

  async function loadPage() {
    if (loading) return;
    loading = true;
    updateSummary();
    try {
      const response = await fetch(`/api/comments/v1/articles/${encodeURIComponent(articleId)}/article-comments?offset=${loaded}&limit=${PAGE_SIZE}`);
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (loaded === 0) list.replaceChildren();
      list.append(...data.comments.map((comment, index) => commentNode(comment, loaded + index)));
      loaded += data.comments.length;
      knownTotal = Number(data.total) || knownTotal;
    } catch {
      failToLoad();
    } finally {
      loading = false;
      updateSummary();
    }
  }

  moreButton.addEventListener("click", loadPage);

  function openForm() {
    form.hidden = false;
    openButton.hidden = true;
    setStatus("");
    form.querySelector("input[name=displayName]").focus();
  }

  function closeForm() {
    form.hidden = true;
    if (mode === "open") openButton.hidden = false;
    openButton.focus();
  }

  openButton.addEventListener("click", openForm);
  cancelButton.addEventListener("click", closeForm);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeForm();
    }
  });
  bodyInput.addEventListener("input", () => {
    counter.textContent = `${bodyInput.value.length} / 3000`;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    submitButton.textContent = "正在提交……";
    setStatus("");
    const values = new FormData(form);
    try {
      const response = await fetch("/api/comments/v1/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "article",
          articleId,
          displayName: values.get("displayName"),
          body: values.get("body"),
          website: values.get("website"),
          clientId: clientId(),
        }),
      });
      const data = await response.json().catch(() => ({ error: "服务响应异常。" }));
      if (!response.ok) throw new Error(data.error || "提交失败，请稍后再试。");
      form.reset();
      counter.textContent = "0 / 3000";
      form.hidden = true;
      if (mode === "open") openButton.hidden = false;
      setStatus(data.message || "章评已提交，等待审核。", "success");
      openButton.focus();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "提交章评，等待审核";
    }
  });

  loadSummary();
})();
