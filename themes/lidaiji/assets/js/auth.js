"use strict";

(() => {
  const page = document.querySelector("[data-auth-page]");
  if (!page) return;
  const status = page.querySelector("[data-auth-status]");
  const returnUrl = (() => {
    const value = new URLSearchParams(location.search).get("return") || "/";
    return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
  })();
  page.querySelector("[data-auth-return]").href = returnUrl;
  const setStatus = (message, tone = "") => {
    status.textContent = message;
    status.dataset.tone = tone;
  };
  const usernamePattern = /^[a-z0-9_]{3,24}$/;
  fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => { if (data?.user) location.replace(returnUrl); })
    .catch(() => {});
  const tabs = [...page.querySelectorAll("[data-auth-tab]")];
  const forms = [...page.querySelectorAll("[data-auth-form]")];
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    const mode = tab.dataset.authTab;
    tabs.forEach((item) => item.classList.toggle("is-active", item === tab));
    forms.forEach((form) => { form.hidden = form.dataset.authForm !== mode; });
    setStatus("");
  }));
  forms.forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button[type=submit]");
    const values = Object.fromEntries(new FormData(form));
    values.username = String(values.username || "").trim().toLowerCase();
    if (!usernamePattern.test(values.username)) {
      setStatus("用户名须为3—24位英文字母、数字或下划线。", "error");
      return;
    }
    if (String(values.password || "").length < 8) {
      setStatus("密码至少需要8个字符。", "error");
      return;
    }
    const endpoint = form.dataset.authForm === "register" ? "/api/auth/register" : "/api/auth/login";
    submit.disabled = true;
    setStatus("正在处理……", "muted");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": location.origin },
        credentials: "same-origin",
        body: JSON.stringify(values),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || "账号操作失败，请稍后重试。");
      location.assign(returnUrl);
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  }));
})();