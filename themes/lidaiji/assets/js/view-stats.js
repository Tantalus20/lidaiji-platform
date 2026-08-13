// 逐篇浏览统计客户端（正式站 · stats V0.1）
// 原则：异步、绝不阻塞正文/目录/评论；统计失败 → 「浏览 —」，绝不报错。
// 隐私：仅浏览器 localStorage 存 lastCountedAt，无 Cookie、无指纹、无 IP 上报。
(function () {
  "use strict";
  var STATS_DELAY_MS = 1500;            // 页面可见后延迟再计数（减少瞬开瞬关/预加载）
  var DEDUP_MS = 30 * 60 * 1000;        // 同一浏览器同一篇文章 30 分钟内最多计一次
  var LS_PREFIX = "lidaiji:views:works:";
  var article = document.querySelector("article.reading-layout[data-article-id]");
  var viewCount = document.querySelector("[data-view-count]");
  if (!article || !viewCount) return;

  var contentId = article.getAttribute("data-article-id");
  var endpoint = "/api/stats/views/works/" + encodeURIComponent(contentId);
  var key = LS_PREFIX + contentId;

  function readLastCounted() {
    try {
      var raw = JSON.parse(localStorage.getItem(key) || "null");
      return raw && raw.lastCountedAt ? new Date(raw.lastCountedAt).getTime() : 0;
    } catch (_e) {
      return 0;
    }
  }

  function markCounted() {
    try {
      localStorage.setItem(key, JSON.stringify({ lastCountedAt: new Date().toISOString() }));
    } catch (_e) { /* localStorage 不可用时仍可计数，只是无法去重 */ }
  }

  function render(views) {
    if (typeof views === "number") viewCount.textContent = String(views);
  }

  function countedWithinWindow() {
    return Date.now() - readLastCounted() < DEDUP_MS;
  }

  function report() {
    var shouldCount = !countedWithinWindow();
    var options = { method: shouldCount ? "POST" : "GET", credentials: "same-origin" };
    fetch(endpoint, options)
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (data && typeof data.views === "number") {
          if (shouldCount) markCounted();
          render(data.views);
        }
      })
      .catch(function () { /* 统计失败：保持「浏览 —」 */ });
  }

  function start() {
    if (document.visibilityState === "visible") {
      setTimeout(report, STATS_DELAY_MS);
    } else {
      document.addEventListener("visibilitychange", function onVisible() {
        if (document.visibilityState === "visible") {
          document.removeEventListener("visibilitychange", onVisible);
          setTimeout(report, STATS_DELAY_MS);
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
