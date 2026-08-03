/* 公共工具模块：常量、DOM 选择器、错误提示与防抖。 */

/* 《历代纪》工作台前端公共工具：常量、DOM 选择器、错误提示与防抖。 */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SIZE = 100 * 1024 * 1024;
const SECTION_LABELS = { works: "作品", essays: "随笔", archives: "资料" };
const LIST_FIELDS = ["collections", "categories", "tags", "series", "period", "people", "places"];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function showError(box, message) {
  box.textContent = message;
  box.classList.remove("hidden");
}

function hideError(box) {
  box.textContent = "";
  box.classList.add("hidden");
}

function globalError(message) {
  const box = $("#globalError");
  if (message) {
    showError(box, message);
  } else {
    hideError(box);
  }
}

function debounce(fn, delay) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export {
  SLUG_PATTERN, MAX_SIZE, SECTION_LABELS, LIST_FIELDS,
  $, $$, showError, hideError, globalError, debounce,
};

