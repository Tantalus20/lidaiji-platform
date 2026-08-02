(() => {
  "use strict";

  const root = document.documentElement;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  /* ---------- 明暗主题 ---------- */
  const toggle = document.querySelector(".theme-toggle");
  const storedTheme = localStorage.getItem("writing-site-theme");
  const preferredDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const initialTheme = storedTheme || (preferredDark ? "dark" : "light");
  root.dataset.theme = initialTheme;

  if (toggle) {
    toggle.setAttribute("aria-pressed", String(initialTheme === "dark"));
    toggle.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      localStorage.setItem("writing-site-theme", next);
      toggle.setAttribute("aria-pressed", String(next === "dark"));
    });
  }

  /* ---------- 阅读进度（requestAnimationFrame 节流，避免高频滚动计算） ---------- */
  const progress = document.querySelector(".reading-progress");
  const article = document.querySelector(".article-content");
  if (progress && article) {
    const updateProgress = () => {
      const start = article.getBoundingClientRect().top + window.scrollY;
      const length = Math.max(article.offsetHeight - window.innerHeight * 0.5, 1);
      const value = Math.min(100, Math.max(0, ((window.scrollY - start) / length) * 100));
      progress.value = value;
    };
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        updateProgress();
      });
    };
    updateProgress();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  }

  /* ---------- 全站轻提示 ---------- */
  let toastTimer;
  const showToast = (message) => {
    let toast = document.querySelector(".site-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "site-toast";
      toast.setAttribute("role", "status");
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2000);
  };

  /* ---------- 标题锚点：点击复制本节链接，不支持剪贴板时退化为普通锚点 ---------- */
  const contentRoot = document.querySelector(".article-content");
  if (contentRoot) {
    contentRoot.addEventListener("click", async (event) => {
      const anchor = event.target.closest(".heading-anchor");
      if (!anchor) return;
      if (!navigator.clipboard?.writeText) return;
      event.preventDefault();
      const target = anchor.getAttribute("href");
      try {
        await navigator.clipboard.writeText(new URL(target, window.location.href).href);
        history.replaceState(null, "", target);
        showToast("已复制本节链接");
      } catch {
        window.location.hash = target;
      }
    });
  }

  /* ---------- 目录当前章节高亮（IntersectionObserver，不用滚动监听） ---------- */
  const tocLinks = [...document.querySelectorAll(".desktop-toc nav a, .mobile-toc nav a")];
  const contentHeadings = [...document.querySelectorAll(".article-content h2[id], .article-content h3[id], .article-content h4[id]")];
  if (tocLinks.length && contentHeadings.length && "IntersectionObserver" in window) {
    const linksByHeading = new Map();
    for (const link of tocLinks) {
      let id = "";
      try {
        id = decodeURIComponent((link.getAttribute("href") || "").replace(/^#/, ""));
      } catch {
        continue;
      }
      if (!id) continue;
      if (!linksByHeading.has(id)) linksByHeading.set(id, []);
      linksByHeading.get(id).push(link);
    }
    let activeId = "";
    const setActive = (id) => {
      if (!id || id === activeId) return;
      activeId = id;
      for (const [headingId, links] of linksByHeading) {
        const current = headingId === id;
        for (const link of links) {
          link.classList.toggle("toc-current", current);
          if (current) link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        }
      }
    };
    const visible = new Map();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      }
      if (visible.size) {
        const [topmost] = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
        setActive(topmost);
      }
    }, { rootMargin: "-12% 0px -72% 0px" });
    for (const heading of contentHeadings) {
      if (linksByHeading.has(heading.id)) observer.observe(heading);
    }
  }

  /* ---------- 正文字号调节（仅文章页，跨文章持久化，存储异常时安全回退） ---------- */
  const readerTools = document.querySelector(".reader-tools");
  const readingLayout = document.querySelector(".reading-layout");
  if (readerTools && readingLayout) {
    const FONT_KEY = "lidaiji-reader-font";
    const FONT_CHOICES = ["small", "standard", "large"];
    const fontButtons = [...readerTools.querySelectorAll("[data-reader-font]")];
    const readStoredFont = () => {
      try {
        const value = localStorage.getItem(FONT_KEY);
        return FONT_CHOICES.includes(value) ? value : "standard";
      } catch {
        return "standard";
      }
    };
    const applyFont = (choice) => {
      if (choice === "standard") delete readingLayout.dataset.readerFont;
      else readingLayout.dataset.readerFont = choice;
      for (const button of fontButtons) {
        button.setAttribute("aria-pressed", String(button.dataset.readerFont === choice));
      }
    };
    applyFont(readStoredFont());
    readerTools.hidden = false;
    for (const button of fontButtons) {
      button.addEventListener("click", () => {
        const choice = FONT_CHOICES.includes(button.dataset.readerFont) ? button.dataset.readerFont : "standard";
        applyFont(choice);
        try {
          localStorage.setItem(FONT_KEY, choice);
        } catch {
          /* 存储不可用时仅本次页面生效 */
        }
      });
    }
  }

  /* ---------- 移动端文章快捷切换条（滚动接近文末时出现，无 JS 不渲染） ---------- */
  const pagerNav = document.querySelector(".article-pager");
  const articleFooter = document.querySelector(".article-footer");
  const narrowScreen = window.matchMedia?.("(max-width: 960px)");
  if (pagerNav && articleFooter && narrowScreen && "IntersectionObserver" in window) {
    const buildItem = (link, direction) => {
      const label = document.createElement("small");
      label.textContent = direction === "prev" ? "‹ 上一篇" : "下一篇 ›";
      const name = document.createElement("span");
      if (link) {
        const item = document.createElement("a");
        item.href = link.getAttribute("href");
        item.className = direction === "prev" ? "bar-prev" : "bar-next";
        name.textContent = link.querySelector("span")?.textContent || "";
        item.append(label, name);
        return item;
      }
      const item = document.createElement("span");
      item.className = `bar-disabled ${direction === "prev" ? "bar-prev" : "bar-next"}`;
      item.setAttribute("aria-disabled", "true");
      name.textContent = direction === "prev" ? "已是第一篇" : "已是最后一篇";
      item.append(label, name);
      return item;
    };
    const bar = document.createElement("nav");
    bar.className = "reader-pager-bar";
    bar.setAttribute("aria-label", "切换文章");
    bar.hidden = true;
    bar.append(
      buildItem(pagerNav.querySelector('[rel="prev"]'), "prev"),
      buildItem(pagerNav.querySelector('[rel="next"]'), "next"),
    );
    document.body.append(bar);
    let nearEnd = false;
    const updateBarVisibility = () => {
      const show = nearEnd && narrowScreen.matches;
      bar.hidden = !show;
      document.body.classList.toggle("has-pager-bar", show);
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) nearEnd = entry.isIntersecting;
      updateBarVisibility();
    });
    observer.observe(articleFooter);
    narrowScreen.addEventListener?.("change", updateBarVisibility);
  }

  /* ---------- 阅读位置记忆：长文可续读，篇目页显示读至标记 ---------- */
  const POSITIONS_KEY = "lidaiji-reading-positions";
  const readPositions = () => {
    try {
      const value = JSON.parse(localStorage.getItem(POSITIONS_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const writePositions = (map) => {
    try {
      localStorage.setItem(POSITIONS_KEY, JSON.stringify(map));
    } catch {
      /* 存储不可用时仅本次会话有效 */
    }
  };

  if (article) {
    const blocks = [...article.querySelectorAll(":scope > p, :scope > h2, :scope > h3, :scope > h4, :scope > blockquote, :scope > figure, :scope > ol, :scope > ul")];
    const articleTop = () => article.getBoundingClientRect().top + window.scrollY;
    const measurePosition = () => {
      const currentY = window.scrollY + window.innerHeight * 0.35;
      const top = articleTop();
      const height = Math.max(article.offsetHeight, 1);
      const fraction = Math.min(1, Math.max(0, (currentY - top) / height));
      let index = 0;
      for (const block of blocks) {
        if (block.getBoundingClientRect().top + window.scrollY <= currentY) index += 1;
        else break;
      }
      return { fraction, index };
    };
    const key = window.location.pathname;
    const stored = readPositions()[key];
    let restored = false;

    // 续读提示：不自动跳转，由读者决定
    if (stored && stored.fraction > 0.05 && stored.fraction < 0.95 && stored.index > 0) {
      const bar = document.createElement("div");
      bar.className = "reading-resume";
      const label = document.createElement("span");
      label.textContent = `上次读到约第 ${stored.index} 段`;
      const go = document.createElement("button");
      go.type = "button";
      go.textContent = "继续阅读";
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "resume-dismiss";
      dismiss.textContent = "不再提示";
      dismiss.setAttribute("aria-label", "不再提示本次阅读位置");
      const close = () => { bar.hidden = true; restored = true; };
      go.addEventListener("click", () => {
        const target = articleTop() + stored.fraction * Math.max(article.offsetHeight, 1) - window.innerHeight * 0.3;
        window.scrollTo({ top: Math.max(0, target), behavior: reduceMotion?.matches ? "auto" : "smooth" });
        close();
      });
      dismiss.addEventListener("click", close);
      bar.append(label, go, dismiss);
      const header = document.querySelector(".article-header");
      (header || article).after(bar);
    }

    let dirty = false;
    window.addEventListener("scroll", () => { dirty = true; }, { passive: true });
    setInterval(() => {
      if (!dirty) return;
      dirty = false;
      const { fraction, index } = measurePosition();
      if (fraction < 0.02 && !restored) return;
      const map = readPositions();
      map[key] = { fraction: Math.round(fraction * 1000) / 1000, index, updatedAt: new Date().toISOString() };
      const keys = Object.keys(map).sort((a, b) => String(map[b].updatedAt).localeCompare(String(map[a].updatedAt)));
      for (const stale of keys.slice(50)) delete map[stale];
      writePositions(map);
    }, 1500);
  }

  // 篇目读至标记（文集目录页）
  const chapterLinks = document.querySelectorAll(".chapter-list a[href]");
  if (chapterLinks.length) {
    const map = readPositions();
    for (const link of chapterLinks) {
      const entry = map[new URL(link.getAttribute("href"), window.location.origin).pathname];
      if (!entry || entry.fraction < 0.05) continue;
      const marker = link.closest("li")?.querySelector("[data-read-state]");
      if (!marker) continue;
      if (entry.fraction >= 0.95) {
        marker.textContent = " · 已读";
        marker.classList.add("is-done");
      } else {
        marker.textContent = ` · 读至 ${Math.round(entry.fraction * 100)}%`;
        marker.classList.add("is-reading");
      }
    }
  }

  /* ---------- 浮动阅读控件：篇章目录 + 回到顶部（仅正文页注入） ---------- */
  if (article) {
    const fabs = document.createElement("div");
    fabs.className = "reader-fabs";
    document.body.append(fabs);

    const seriesNav = document.querySelector(".series-nav");
    if (seriesNav) {
      const tocButton = document.createElement("button");
      tocButton.type = "button";
      tocButton.className = "toc-fab";
      tocButton.textContent = "目录";
      tocButton.setAttribute("aria-expanded", "false");
      tocButton.setAttribute("aria-controls", "chapter-menu");
      const menu = document.createElement("nav");
      menu.className = "chapter-menu";
      menu.id = "chapter-menu";
      menu.setAttribute("aria-label", "篇章目录");
      menu.hidden = true;
      const menuTitle = document.createElement("p");
      menuTitle.textContent = seriesNav.querySelector("h2")?.textContent || "篇目";
      const list = document.createElement("ol");
      for (const item of seriesNav.querySelectorAll("li")) {
        const link = item.querySelector("a");
        if (!link) continue;
        const entry = document.createElement("li");
        const anchor = document.createElement("a");
        anchor.href = link.getAttribute("href");
        anchor.textContent = link.textContent;
        if (item.classList.contains("current")) {
          entry.className = "is-current";
          anchor.setAttribute("aria-current", "page");
        }
        entry.append(anchor);
        list.append(entry);
      }
      menu.append(menuTitle, list);
      fabs.append(menu, tocButton);
      const closeMenu = () => {
        menu.hidden = true;
        tocButton.setAttribute("aria-expanded", "false");
      };
      tocButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = menu.hidden;
        menu.hidden = !open;
        tocButton.setAttribute("aria-expanded", String(open));
      });
      menu.addEventListener("click", (event) => {
        if (event.target.closest("a")) closeMenu();
      });
      document.addEventListener("click", (event) => {
        if (!menu.hidden && !fabs.contains(event.target)) closeMenu();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !menu.hidden) {
          closeMenu();
          tocButton.focus();
        }
      });
    }

    const backToTop = document.createElement("button");
    backToTop.type = "button";
    backToTop.className = "back-to-top";
    backToTop.textContent = "回到顶部";
    backToTop.hidden = true;
    fabs.append(backToTop);
    backToTop.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: reduceMotion?.matches ? "auto" : "smooth" });
    });
    let queued = false;
    const updateVisibility = () => {
      backToTop.hidden = window.scrollY < window.innerHeight * 1.5;
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        updateVisibility();
      });
    };
    updateVisibility();
    window.addEventListener("scroll", schedule, { passive: true });
  }
})();
