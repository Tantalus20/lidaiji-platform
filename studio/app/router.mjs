/* 路由模块：hash 路由、视图切换、未保存修改拦截。 */
import { $, $$, globalError } from "./util.mjs";
import { editState } from "./state.mjs";
import { openEditor, studioEditor, writeLocalDraft } from "./editor-page.mjs";
import { loadHome, prepareNewForm } from "./home.mjs";
import { loadVersions, loadHistory } from "./versions.mjs";
import { loadPublish } from "./publish.mjs";
import { loadMedia } from "./media.mjs";
import { loadFeedback } from "./feedback.mjs";
import {
  loadShareHome,
  openShareEditor,
  prepareShareNew,
  routeShareConfirm,
} from "./share.mjs";

/* ---------------- hash 路由 ---------------- */

let revertHash = "";

function currentRoute() {
  const hash = location.hash || "#/";
  const queryIndex = hash.indexOf("?");
  const path = queryIndex < 0 ? hash.slice(1) : hash.slice(1, queryIndex);
  const query = queryIndex < 0 ? "" : hash.slice(queryIndex + 1);
  return { path: path || "/", params: new URLSearchParams(query) };
}

function showView(name) {
  $$(".view").forEach((view) => view.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$("[data-nav]").forEach((link) => link.classList.toggle("current", link.dataset.nav === name));
  globalError("");
  window.scrollTo({ top: 0 });
}

function editBackHash() {
  return editState.mode === "share"
    ? `#/share-edit?path=${encodeURIComponent(editState.path)}`
    : `#/edit?path=${encodeURIComponent(editState.path)}`;
}

async function route() {
  const target = currentRoute();
  // 未保存修改的页内拦截：先退回编辑页，等作者在拦截条里决定
  const editing = editState.dirty && editState.path;
  if (editing && !target.path.startsWith("/edit") && !target.path.startsWith("/share-edit") && !target.path.startsWith("/share-confirm")) {
    revertHash = editBackHash();
    location.hash = revertHash;
    $("#dirtyBar").classList.remove("hidden");
    return;
  }
  $("#dirtyBar").classList.add("hidden");
  if (target.path.startsWith("/edit")) {
    const path = target.params.get("path") || "";
    showView("edit");
    if (path && path !== editState.path) {
      await openEditor(path, "work");
    }
  } else if (target.path.startsWith("/share-edit")) {
    const path = target.params.get("path") || "";
    showView("edit");
    if (!path) {
      prepareShareNew();
    } else if (path !== editState.path || editState.mode !== "share") {
      await openShareEditor(path);
    }
  } else if (target.path === "/share-confirm") {
    showView("share-confirm");
  } else if (target.path === "/share") {
    showView("share");
    loadShareHome();
  } else if (target.path === "/new") {
    showView("new");
    prepareNewForm();
  } else if (target.path === "/import") {
    showView("import");
  } else if (target.path === "/versions") {
    showView("versions");
    loadVersions();
  } else if (target.path === "/history") {
    showView("history");
    loadHistory(target.params.get("path") || "");
  } else if (target.path === "/publish") {
    showView("publish");
    loadPublish();
  } else if (target.path === "/media") {
    showView("media");
    loadMedia();
  } else if (target.path === "/feedback") {
    showView("feedback");
    loadFeedback();
  } else {
    showView("home");
    loadHome();
  }
}

window.addEventListener("hashchange", () => {
  if (revertHash) {
    const expected = revertHash;
    revertHash = "";
    if (location.hash === expected) return;
  }
  route();
});

window.addEventListener("beforeunload", (event) => {
  if (editState.dirty) {
    if (studioEditor) writeLocalDraft(studioEditor.getMarkdown());
    event.preventDefault();
    event.returnValue = "";
  }
});

$("#dirtyStay").addEventListener("click", () => $("#dirtyBar").classList.add("hidden"));
$("#dirtyLeave").addEventListener("click", () => {
  editState.dirty = false;
  $("#dirtyBar").classList.add("hidden");
  location.hash = editState.mode === "share" ? "#/share" : "#/";
});

export { route, showView };
