(() => {
  "use strict";

  const form = document.querySelector("[data-search-form]");
  const input = form?.querySelector("input[type='search']");
  const output = document.querySelector("[data-search-results]");
  if (!form || !input || !output) return;

  let indexPromise;
  const loadIndex = () => {
    if (!indexPromise) {
      indexPromise = fetch("/search-index.json", { credentials: "same-origin" })
        .then((response) => {
          if (!response.ok) throw new Error("搜索索引暂时不可用");
          return response.json();
        });
    }
    return indexPromise;
  };

  const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
  const appendText = (element, value) => {
    element.textContent = String(value || "");
    return element;
  };

  const matchingExcerpt = (item, query) => {
    const content = String(item.content || "");
    const normalizedContent = normalize(content);
    const firstTerm = normalize(query).split(/\s+/).find(Boolean) || "";
    const position = firstTerm ? normalizedContent.indexOf(firstTerm) : -1;
    if (position < 0) return item.description || content.slice(0, 180);
    const start = Math.max(0, position - 70);
    const end = Math.min(content.length, position + firstTerm.length + 110);
    return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
  };

  const renderResults = (items, query) => {
    output.replaceChildren();
    output.setAttribute("aria-busy", "false");

    const heading = document.createElement("p");
    heading.className = "search-count";
    appendText(heading, items.length ? `找到 ${items.length} 篇与“${query}”相关的文章` : `没有找到与“${query}”相关的文章`);
    output.append(heading);

    items.forEach((item) => {
      const article = document.createElement("article");
      article.className = "search-result";

      const title = document.createElement("h2");
      const link = document.createElement("a");
      const safeUrl = typeof item.url === "string" && item.url.startsWith("/") ? item.url : "/";
      link.href = safeUrl;
      appendText(link, item.title);
      title.append(link);

      const summary = document.createElement("p");
      appendText(summary, matchingExcerpt(item, query));

      const meta = document.createElement("small");
      appendText(meta, [item.collection, item.date, ...(Array.isArray(item.tags) ? item.tags : [])].filter(Boolean).join(" · "));

      article.append(title, summary, meta);
      output.append(article);
    });
  };

  const runSearch = async (rawQuery) => {
    const query = normalize(rawQuery).trim().slice(0, 120);
    if (!query) {
      output.replaceChildren(appendText(document.createElement("p"), "请输入要搜索的文字。"));
      return;
    }
    output.setAttribute("aria-busy", "true");
    try {
      const data = await loadIndex();
      const terms = query.split(/\s+/).filter(Boolean);
      const matches = data
        .map((item) => {
          const title = normalize(item.title);
          const collection = normalize(item.collection);
          const tags = normalize(Array.isArray(item.tags) ? item.tags.join(" ") : "");
          const content = normalize(`${item.subtitle || ""} ${item.description || ""} ${item.content || ""}`);
          const score = terms.reduce((sum, term) => {
            if (!`${title} ${collection} ${tags} ${content}`.includes(term)) return -1000;
            return sum + (title.includes(term) ? 8 : 0) + (collection.includes(term) ? 5 : 0) + (tags.includes(term) ? 4 : 0) + (content.includes(term) ? 1 : 0);
          }, 0);
          return { item, score };
        })
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score || String(b.item.date).localeCompare(String(a.item.date)))
        .slice(0, 30)
        .map((entry) => entry.item);
      renderResults(matches, rawQuery.trim());
    } catch {
      output.setAttribute("aria-busy", "false");
      output.replaceChildren(appendText(document.createElement("p"), "搜索索引读取失败，请稍后刷新页面重试。"));
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value;
    const params = new URLSearchParams(window.location.search);
    params.set("q", query);
    history.replaceState(null, "", `${window.location.pathname}?${params}`);
    runSearch(query);
  });

  const initial = new URLSearchParams(window.location.search).get("q");
  if (initial) {
    input.value = initial;
    runSearch(initial);
  }
})();
