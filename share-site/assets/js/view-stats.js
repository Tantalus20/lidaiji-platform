// 逐篇浏览统计客户端（长文分享站 · stats V0.1）
// 原则：异步、绝不阻塞正文/目录；统计失败 → 「浏览 —」，绝不报错。
// Share 无评论/无 paragraph-id：统计身份仅为 shareId。
(function () {
  "use strict";
  var STATS_DELAY_MS = 1500;
  var DEDUP_MS = 30 * 60 * 1000;
  var LS_PREFIX = "lidaiji-share:views:";
  var article = document.querySelector("article.reading-layout[data-share-id]");
  var viewCount = document.querySelector("[data-view-count]");
  if (!article || !viewCount) return;

  var shareId = article.getAttribute("data-share-id");
  var endpoint = "/api/stats/views/share/" + encodeURIComponent(shareId);
  var key = LS_PREFIX + shareId;

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
    } catch (_e) { /* localStorage 不可用时仍可计数 */ }
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
