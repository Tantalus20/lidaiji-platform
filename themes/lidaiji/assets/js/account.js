"use strict";

(() => {
  const slot = document.querySelector("[data-account-slot]");
  if (!slot) return;
  const returnUrl = () => `${location.pathname}${location.search}${location.hash}`;
  const render = (user) => {
    slot.replaceChildren();
    if (user) {
      const name = document.createElement("strong");
      name.className = "account-name";
      name.textContent = user.displayName || user.username || "已登录";
      const out = document.createElement("button");
      out.type = "button";
      out.className = "account-logout";
      out.textContent = "退出";
      out.addEventListener("click", async () => {
        await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
        location.reload();
      });
      slot.append(name, out);
    } else {
      const link = document.createElement("a");
      link.className = "account-link";
      link.textContent = "登录 / 注册";
      link.href = `/login/?return=${encodeURIComponent(returnUrl())}`;
      slot.append(link);
    }
  };
  fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => render(data?.user || null))
    .catch(() => render(null));
})();