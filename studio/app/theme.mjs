/* 主题模块：深浅色切换（localStorage 记忆）。 */
import { $ } from "./util.mjs";

/* ---------------- 主题（深浅色，localStorage 记忆） ---------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("studio-theme", theme);
  $("#themeToggle").textContent = theme === "dark" ? "浅色" : "深色";
}

function initTheme() {
  const stored = localStorage.getItem("studio-theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(stored || preferred);
  $("#themeToggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

export { applyTheme, initTheme };

