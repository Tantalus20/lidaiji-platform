/*! Lidaiji Studio 工作台前端包（自动生成，请勿手改）。
 * 源码：studio/app/*.mjs；重新生成：npm run build:app。
 * 平台 0.2.1 · Studio 0.2.6。 */
(() => {
  // studio/app/util.mjs
  var SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  var MAX_SIZE = 100 * 1024 * 1024;
  var SECTION_LABELS = { works: "\u4F5C\u54C1", essays: "\u968F\u7B14", archives: "\u8D44\u6599" };
  var LIST_FIELDS = ["collections", "categories", "tags", "series", "period", "people", "places"];
  var $ = (selector) => document.querySelector(selector);
  var $$ = (selector) => Array.from(document.querySelectorAll(selector));
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

  // studio/app/theme.mjs
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("studio-theme", theme);
    $("#themeToggle").textContent = theme === "dark" ? "\u6D45\u8272" : "\u6DF1\u8272";
  }
  function initTheme() {
    const stored = localStorage.getItem("studio-theme");
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    applyTheme(stored || preferred);
    $("#themeToggle").addEventListener("click", () => {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    });
  }

  // studio/app/state.mjs
  var state = {
    articles: [],
    searchQuery: "",
    searchResults: null,
    // Word 导入向导状态
    file: null,
    token: "",
    report: null,
    plan: null,
    previewHtml: "",
    assetUrls: [],
    committed: null
  };
  var editState = {
    path: "",
    dirty: false,
    pendingHash: ""
  };

  // studio/app/api.mjs
  var csrfState = { token: "" };
  async function ensureCsrfToken() {
    if (csrfState.token) return csrfState.token;
    const response = await fetch("/api/system/status");
    const payload = await response.json().catch(() => ({ ok: false }));
    if (!payload.ok || !payload.csrfToken) {
      throw new Error("\u65E0\u6CD5\u53D6\u5F97\u672C\u5730\u4F1A\u8BDD\u4EE4\u724C\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u5DE5\u4F5C\u53F0\u3002");
    }
    csrfState.token = payload.csrfToken;
    return csrfState.token;
  }
  async function api(path, body) {
    const csrf = await ensureCsrfToken();
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Request": "1",
        "X-Studio-CSRF": csrf
      },
      body: JSON.stringify(body || {})
    });
    const payload = await response.json().catch(() => ({ ok: false, error: { code: "internal-error", message: "\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u7406\u89E3\u7684\u54CD\u5E94\u3002" } }));
    if (!payload.ok) {
      const error = new Error(payload.error && payload.error.message || "\u8BF7\u6C42\u5931\u8D25\u3002");
      error.code = payload.error && payload.error.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  async function apiRaw(path, body) {
    const csrf = await ensureCsrfToken();
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Studio-Request": "1",
        "X-Studio-CSRF": csrf
      },
      body: JSON.stringify(body || {})
    });
    const payload = await response.json().catch(() => ({ ok: false, error: { code: "internal-error", message: "\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u7406\u89E3\u7684\u54CD\u5E94\u3002" } }));
    return { ok: Boolean(payload.ok), payload, status: response.status };
  }
  async function apiGet(path) {
    const response = await fetch(path);
    const payload = await response.json().catch(() => ({ ok: false, error: { code: "internal-error", message: "\u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6CD5\u7406\u89E3\u7684\u54CD\u5E94\u3002" } }));
    if (!payload.ok) {
      const error = new Error(payload.error && payload.error.message || "\u8BF7\u6C42\u5931\u8D25\u3002");
      error.code = payload.error && payload.error.code;
      throw error;
    }
    return payload;
  }

  // studio/app/notes.mjs
  var notesState = {
    list: [],
    paragraphs: [],
    editing: null,
    // null=新增；否则为批注 id
    inlineComposer: null
  };
  async function loadNotes() {
    hideError($("#notesError"));
    notesState.editing = null;
    $("#noteForm").classList.add("hidden");
    if (!editState.path) {
      $("#notesList").textContent = "";
      return;
    }
    try {
      const [notesPayload, paragraphsPayload] = await Promise.all([
        apiGet(`/api/notes?path=${encodeURIComponent(editState.path)}`),
        apiGet(`/api/notes/paragraphs?path=${encodeURIComponent(editState.path)}`)
      ]);
      notesState.list = notesPayload.notes || [];
      notesState.paragraphs = paragraphsPayload.paragraphs || [];
      renderNotes();
      decoratePreviewNotes();
    } catch (error) {
      showError($("#notesError"), error.message);
    }
  }
  function closeInlineNoteComposer() {
    var _a;
    if ((_a = notesState.inlineComposer) == null ? void 0 : _a.isConnected) notesState.inlineComposer.remove();
    notesState.inlineComposer = null;
  }
  function openInlineNoteComposer(paragraphId, actions) {
    closeInlineNoteComposer();
    hideError($("#notesError"));
    const composer = document.createElement("div");
    composer.className = "inline-note-composer";
    const title = document.createElement("strong");
    title.textContent = "\u5199\u8FD9\u6BB5\u7684\u4F5C\u8005\u8BC4";
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.maxLength = 5e3;
    textarea.placeholder = "\u5199\u4E0B\u8865\u5145\u3001\u56DE\u5FC6\u6216\u8BF4\u660E\u2026\u2026";
    textarea.setAttribute("aria-label", "\u4F5C\u8005\u6BB5\u843D\u8BC4\u6B63\u6587");
    const status = document.createElement("span");
    status.className = "preview-status";
    const buttons = document.createElement("div");
    buttons.className = "actions";
    const save = async (noteStatus) => {
      const body = textarea.value.trim();
      if (!body) {
        status.textContent = "\u8BF7\u5148\u5199\u4E0B\u6279\u6CE8\u6B63\u6587\u3002";
        textarea.focus();
        return;
      }
      const allButtons = buttons.querySelectorAll("button");
      allButtons.forEach((button) => {
        button.disabled = true;
      });
      status.textContent = "\u6B63\u5728\u4FDD\u5B58\u2026";
      try {
        await api("/api/notes/save", {
          path: editState.path,
          note: { scope: "paragraph", paragraphId, body, status: noteStatus }
        });
        status.textContent = noteStatus === "published" ? "\u5DF2\u4FDD\u5B58\u5E76\u53D1\u5E03\u3002" : "\u5DF2\u4FDD\u5B58\u4E3A\u8349\u7A3F\u3002";
        await loadNotes();
      } catch (error) {
        status.textContent = error.message;
        allButtons.forEach((button) => {
          button.disabled = false;
        });
      }
    };
    const draft = document.createElement("button");
    draft.type = "button";
    draft.className = "secondary small";
    draft.textContent = "\u4FDD\u5B58\u8349\u7A3F";
    draft.addEventListener("click", () => save("draft"));
    const publish = document.createElement("button");
    publish.type = "button";
    publish.className = "primary small";
    publish.textContent = "\u4FDD\u5B58\u5E76\u53D1\u5E03";
    publish.addEventListener("click", () => save("published"));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary small";
    cancel.textContent = "\u53D6\u6D88";
    cancel.addEventListener("click", closeInlineNoteComposer);
    buttons.appendChild(draft);
    buttons.appendChild(publish);
    buttons.appendChild(cancel);
    buttons.appendChild(status);
    composer.appendChild(title);
    composer.appendChild(textarea);
    composer.appendChild(buttons);
    actions.after(composer);
    notesState.inlineComposer = composer;
    textarea.focus();
  }
  function decoratePreviewNotes() {
    const preview = $("#editorPreview");
    if (!preview) return;
    closeInlineNoteComposer();
    preview.querySelectorAll(".inline-note-actions").forEach((element) => element.remove());
    const validParagraphs = new Set(notesState.paragraphs.map((item) => item.paragraphId));
    for (const paragraph of preview.querySelectorAll("p[data-paragraph-id]")) {
      const paragraphId = paragraph.dataset.paragraphId;
      if (!validParagraphs.has(paragraphId)) continue;
      const count = notesState.list.filter(
        (note) => note.scope === "paragraph" && note.paragraphId === paragraphId
      ).length;
      const actions = document.createElement("div");
      actions.className = "inline-note-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "inline-note-button";
      button.textContent = count ? `\u4F5C\u8005\u8BC4 ${count} \xB7 \u518D\u5199` : "\u5199\u4F5C\u8005\u8BC4";
      button.setAttribute("aria-label", `\u4E3A\u6BB5\u843D ${paragraphId} \u5199\u4F5C\u8005\u8BC4`);
      button.addEventListener("click", () => openInlineNoteComposer(paragraphId, actions));
      actions.appendChild(button);
      paragraph.after(actions);
    }
  }
  function noteCard(note) {
    const card = document.createElement("div");
    card.className = "note-card";
    const head = document.createElement("div");
    head.className = "article-head";
    const badges = document.createElement("span");
    badges.className = "badges";
    const scope = document.createElement("span");
    scope.className = "badge badge-type";
    scope.textContent = note.scope === "paragraph" ? "\u6BB5\u843D\u8BC4" : "\u7BC7\u7AE0\u8BC4";
    badges.appendChild(scope);
    const status = document.createElement("span");
    status.className = note.status === "published" ? "badge badge-published" : "badge badge-draft";
    status.textContent = note.status === "published" ? "\u5DF2\u53D1\u5E03" : "\u8349\u7A3F";
    badges.appendChild(status);
    head.appendChild(badges);
    const updated = document.createElement("span");
    updated.className = "meta-text";
    updated.textContent = `\u66F4\u65B0\u4E8E ${note.updated}`;
    head.appendChild(updated);
    card.appendChild(head);
    if (note.scope === "paragraph") {
      const anchor = document.createElement("p");
      anchor.className = "meta-text";
      const found = notesState.paragraphs.find((item) => item.paragraphId === note.paragraphId);
      anchor.textContent = `\u6BB5\u843D ${note.paragraphId}${found ? `\uFF1A${found.excerpt}` : "\uFF08\u5F53\u524D\u6B63\u6587\u672A\u627E\u5230\u8BE5\u951A\u70B9\uFF09"}`;
      card.appendChild(anchor);
    }
    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = note.body;
    card.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary small";
    edit.textContent = "\u7F16\u8F91";
    edit.addEventListener("click", () => openNoteForm(note));
    actions.appendChild(edit);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger small";
    del.textContent = "\u5220\u9664";
    const confirmBar = document.createElement("div");
    confirmBar.className = "confirm-bar hidden";
    const hint = document.createElement("span");
    hint.textContent = "\u5C06\u771F\u6B63\u5220\u9664\u8FD9\u6761\u6279\u6CE8\uFF08\u6709 git \u4E0E\u4FDD\u5B58\u5907\u4EFD\u515C\u5E95\uFF09\u3002\u786E\u8BA4\u5220\u9664\uFF1F";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "danger small";
    yes.textContent = "\u786E\u8BA4\u5220\u9664";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "secondary small";
    no.textContent = "\u53D6\u6D88";
    del.addEventListener("click", () => confirmBar.classList.remove("hidden"));
    no.addEventListener("click", () => confirmBar.classList.add("hidden"));
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        await api("/api/notes/delete", { path: editState.path, id: note.id, confirm: true });
        loadNotes();
      } catch (error) {
        yes.disabled = false;
        confirmBar.classList.add("hidden");
        showError($("#notesError"), error.message);
      }
    });
    confirmBar.appendChild(hint);
    confirmBar.appendChild(yes);
    confirmBar.appendChild(no);
    actions.appendChild(del);
    card.appendChild(actions);
    card.appendChild(confirmBar);
    return card;
  }
  function renderNotes() {
    const list = $("#notesList");
    list.textContent = "";
    if (!notesState.list.length) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = "\u8FD9\u7BC7\u6587\u7AE0\u8FD8\u6CA1\u6709\u4F5C\u8005\u8BC4\u3002";
      list.appendChild(empty);
      return;
    }
    for (const note of notesState.list) {
      list.appendChild(noteCard(note));
    }
  }
  function fillParagraphSelect(selected) {
    const select = $("#noteParagraph");
    select.textContent = "";
    for (const item of notesState.paragraphs) {
      const option = document.createElement("option");
      option.value = item.paragraphId;
      option.textContent = item.excerpt ? `${item.excerpt}\uFF08${item.paragraphId}\uFF09` : item.paragraphId;
      select.appendChild(option);
    }
    if (selected) select.value = selected;
  }
  function openNoteForm(note) {
    hideError($("#notesError"));
    const isNew = !note;
    const scope = note ? note.scope : notesState.newScope;
    notesState.editing = note ? note.id : null;
    $("#noteFormTitle").textContent = note ? `\u7F16\u8F91${scope === "paragraph" ? "\u6BB5\u843D\u8BC4" : "\u7BC7\u7AE0\u8BC4"}\uFF08${note.id}\uFF09` : scope === "paragraph" ? "\u65B0\u589E\u6BB5\u843D\u8BC4" : "\u65B0\u589E\u7BC7\u7AE0\u8BC4";
    $("#noteParagraphWrap").classList.toggle("hidden", scope !== "paragraph");
    if (scope === "paragraph") fillParagraphSelect(note ? note.paragraphId : "");
    $("#noteBody").value = note ? note.body : "";
    $("#notePublished").checked = note ? note.status === "published" : false;
    $("#noteSaveStatus").textContent = "";
    $("#noteForm").classList.remove("hidden");
    $("#noteBody").focus();
    return isNew;
  }
  $("#noteAddParagraph").addEventListener("click", () => {
    if (!editState.path) return;
    notesState.newScope = "paragraph";
    openNoteForm(null);
  });
  $("#noteAddArticle").addEventListener("click", () => {
    if (!editState.path) return;
    notesState.newScope = "article";
    openNoteForm(null);
  });
  $("#noteCancel").addEventListener("click", () => {
    notesState.editing = null;
    $("#noteForm").classList.add("hidden");
  });
  $("#noteSave").addEventListener("click", async () => {
    hideError($("#notesError"));
    const status = $("#noteSaveStatus");
    const editing = notesState.editing ? notesState.list.find((note2) => note2.id === notesState.editing) : null;
    const scope = editing ? editing.scope : notesState.newScope;
    const note = {
      body: $("#noteBody").value,
      status: $("#notePublished").checked ? "published" : "draft"
    };
    if (editing) note.id = editing.id;
    note.scope = scope;
    if (scope === "paragraph") note.paragraphId = $("#noteParagraph").value;
    if (!note.body.trim()) {
      showError($("#notesError"), "\u6279\u6CE8\u6B63\u6587\u4E0D\u80FD\u4E3A\u7A7A\u3002");
      return;
    }
    status.textContent = "\u6B63\u5728\u4FDD\u5B58\u2026";
    $("#noteSave").disabled = true;
    try {
      await api("/api/notes/save", { path: editState.path, note });
      status.textContent = "\u5DF2\u4FDD\u5B58\u3002";
      notesState.editing = null;
      $("#noteForm").classList.add("hidden");
      loadNotes();
    } catch (error) {
      status.textContent = "";
      showError($("#notesError"), error.message);
    } finally {
      $("#noteSave").disabled = false;
    }
  });

  // studio/app/savestate.mjs
  function createSaveStateMachine() {
    let status = "saved";
    let dirtyDuringSave = false;
    const listeners = [];
    function emit(next) {
      for (const listener of listeners) listener(next);
    }
    return {
      get status() {
        return status;
      },
      onChange(listener) {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      /* 用户输入（或任何未保存修改）。返回变更后的状态。 */
      userInput() {
        if (status === "saving") {
          dirtyDuringSave = true;
          return status;
        }
        status = "dirty";
        emit(status);
        return status;
      },
      /* 发起保存请求。重复调用（并发防护）不改变状态、不重复通知。 */
      saving() {
        if (status === "saving") return status;
        dirtyDuringSave = false;
        status = "saving";
        emit(status);
        return status;
      },
      /* 服务端确认成功。若保存期间又有输入则回到 dirty。 */
      saved() {
        const next = dirtyDuringSave ? "dirty" : "saved";
        dirtyDuringSave = false;
        status = next;
        emit(status);
        return status;
      },
      /* 保存失败（仍是未保存状态）。 */
      failed() {
        status = "failed";
        emit(status);
        return status;
      },
      /* 重新打开文章：回到初始"已保存"。 */
      reset() {
        dirtyDuringSave = false;
        status = "saved";
        emit(status);
        return status;
      }
    };
  }

  // studio/app/editor-page.mjs
  function clientWordCount(text) {
    const plain = text.replace(/<!--[\s\S]*?-->/g, "");
    const cjk = (plain.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
    const latin = (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    return cjk + latin;
  }
  var studioEditor = null;
  var pendingDraft = "";
  var lastToolbarInfo = null;
  var AUTOSAVE_DELAY = 1200;
  var DRAFT_WRITE_DELAY = 1500;
  editState.articleId = "";
  editState.saving = false;
  editState.saveVersion = 0;
  editState.autosaveTimer = 0;
  editState.draftTimer = 0;
  var saveMachine = createSaveStateMachine();
  function draftKey() {
    const base = editState.articleId || editState.path.replace(/[^A-Za-z0-9_-]+/g, "_");
    return `lidaiji.studio.draft.${base}`;
  }
  function readLocalDraft() {
    if (!editState.path) return "";
    try {
      return localStorage.getItem(draftKey()) || "";
    } catch (e) {
      return "";
    }
  }
  function writeLocalDraft(markdown) {
    if (!editState.path) return;
    try {
      localStorage.setItem(draftKey(), markdown);
    } catch (e) {
    }
  }
  function clearLocalDraft() {
    if (!editState.path) return;
    try {
      localStorage.removeItem(draftKey());
    } catch (e) {
    }
  }
  function setSaveStatus(text, kind) {
    const el = $("#editSaveStatus");
    el.textContent = text;
    el.classList.toggle("saved", kind === "saved");
    el.classList.toggle("failed", kind === "failed");
    el.classList.toggle("saving", kind === "saving");
    el.classList.toggle("changed", kind === "changed");
    $("#editSaveRetry").classList.toggle("hidden", kind !== "failed");
  }
  function updateWordCount() {
    if (studioEditor) {
      $("#editWordCount").textContent = `\u7EA6 ${clientWordCount(studioEditor.getMarkdown())} \u5B57`;
    }
  }
  function markDirty() {
    editState.dirty = true;
    if (saveMachine.userInput() === "dirty") {
      setSaveStatus("\u6709\u672A\u4FDD\u5B58\u4FEE\u6539", "");
    }
    updateWordCount();
    scheduleDraftWrite();
  }
  function scheduleDraftWrite() {
    clearTimeout(editState.draftTimer);
    editState.draftTimer = setTimeout(() => {
      if (studioEditor) writeLocalDraft(studioEditor.getMarkdown());
    }, DRAFT_WRITE_DELAY);
  }
  function scheduleAutosave() {
    clearTimeout(editState.autosaveTimer);
    editState.autosaveTimer = setTimeout(() => {
      saveArticle();
    }, AUTOSAVE_DELAY);
  }
  var BLOCK_TYPE_LABELS = {
    paragraph: "\u6B63\u6587",
    heading: "\u6807\u9898",
    poetry: "\u8BD7\u6B4C",
    endnote: "\u9644\u8BB0",
    quote: "\u5F15\u7528",
    list: "\u5217\u8868",
    code: "\u4EE3\u7801\u5757",
    table: "\u8868\u683C",
    other: "\u5176\u4ED6",
    mixed: "\u591A\u79CD\u6BB5\u843D"
  };
  var BLOCK_TYPE_OPTIONS = /* @__PURE__ */ new Set(["paragraph", "heading", "poetry", "endnote", "quote", "mixed", "other"]);
  function updateToolbarState(info) {
    if (!info) return;
    lastToolbarInfo = info;
    $("#tbUndo").disabled = !info.canUndo;
    $("#tbRedo").disabled = !info.canRedo;
    $("#tbBold").setAttribute("aria-pressed", info.bold ? "true" : "false");
    $("#tbItalic").setAttribute("aria-pressed", info.em ? "true" : "false");
    const linkButton = $("#tbLink");
    linkButton.setAttribute("aria-pressed", info.link ? "true" : "false");
    linkButton.disabled = !info.enabled.link;
    const imageButton = $("#tbImage");
    imageButton.disabled = !info.enabled.image;
    const alignOk = info.enabled.align;
    for (const id of ["tbAlignLeft", "tbAlignCenter", "tbAlignRight"]) {
      $(`#${id}`).disabled = !alignOk;
    }
    $("#tbAlignLeft").setAttribute("aria-pressed", info.align === null || info.align === "left" ? "true" : "false");
    $("#tbAlignCenter").setAttribute("aria-pressed", info.align === "center" ? "true" : "false");
    $("#tbAlignRight").setAttribute("aria-pressed", info.align === "right" ? "true" : "false");
    const select = $("#tbBlockType");
    const enabledMap = {
      paragraph: info.enabled.paragraph,
      heading: info.enabled.heading,
      poetry: info.enabled.poetry,
      endnote: info.enabled.endnote,
      quote: info.enabled.quote
    };
    for (const option of select.options) {
      if (Object.prototype.hasOwnProperty.call(enabledMap, option.value)) {
        option.disabled = !enabledMap[option.value];
      }
    }
    select.value = BLOCK_TYPE_OPTIONS.has(info.blockType) ? info.blockType : "other";
    $("#stBlockType").textContent = BLOCK_TYPE_LABELS[info.blockType] || info.blockType;
    $("#stAlign").textContent = info.align === "center" ? "\u5C45\u4E2D" : info.align === "right" ? "\u53F3\u5BF9\u9F50" : "\u5DE6\u5BF9\u9F50";
    if (info.inPoetry) {
      $("#stNote").textContent = "\u8BD7\u6B4C\u5757\u4F1A\u4FDD\u7559\u4E13\u7528\u6392\u7248\uFF1B\u8BD7\u884C\u7F16\u8F91\u65B9\u5F0F\u5C06\u5728\u540E\u7EED\u7248\u672C\u6539\u8FDB\u3002";
    } else if (info.inEndnote) {
      $("#stNote").textContent = "\u201C\u9644\u8BB0\u201D\u662F\u65E0\u7F16\u53F7\u7684\u8865\u5145\u8BF4\u660E\u5757\uFF0C\u4E0D\u662F\u811A\u6CE8\u6216\u5C3E\u6CE8\u7CFB\u7EDF\u3002";
    } else {
      $("#stNote").textContent = "";
    }
  }
  function ensureEditor() {
    if (studioEditor) return studioEditor;
    studioEditor = LidaijiEditor.createStudioEditor($("#editorHost"), {
      onUpdate: () => {
        markDirty();
        scheduleAutosave();
      },
      onSelection: updateToolbarState
    });
    return studioEditor;
  }
  function showEditorMode(mode) {
    $("#editorHost").classList.toggle("hidden", mode !== "edit");
    $("#editorPreviewWrap").classList.toggle("hidden", mode !== "preview");
    $("#editorSourceWrap").classList.toggle("hidden", mode !== "source");
  }
  async function saveArticle() {
    if (!editState.path || !studioEditor) return;
    if (editState.saving) return;
    const body = studioEditor.getMarkdown();
    if (!body.trim()) {
      saveMachine.failed();
      setSaveStatus("\u6B63\u6587\u4E3A\u7A7A\uFF0C\u672A\u4FDD\u5B58", "failed");
      return;
    }
    editState.saving = true;
    editState.saveVersion = studioEditor.version();
    saveMachine.saving();
    try {
      const payload = await api("/api/article/save", {
        path: editState.path,
        frontMatter: readFmForm(),
        body
      });
      if (editState.saveVersion !== studioEditor.version()) {
        editState.dirty = true;
        saveMachine.userInput();
        setSaveStatus("\u6709\u672A\u4FDD\u5B58\u4FEE\u6539\uFF0C\u7A0D\u540E\u81EA\u52A8\u4FDD\u5B58", "saving");
        scheduleAutosave();
        return;
      }
      studioEditor.replaceDocKeepCursor(payload.body);
      editState.dirty = false;
      clearLocalDraft();
      $("#editDraftBadge").classList.toggle("hidden", !payload.article.draft);
      $("#fmArticleRevision").textContent = payload.article.articleRevision || "\u2014";
      saveMachine.saved();
      if (saveMachine.status === "dirty") {
        setSaveStatus("\u6709\u672A\u4FDD\u5B58\u4FEE\u6539", "");
        scheduleAutosave();
      } else {
        setSaveStatus(
          `\u5DF2\u4FDD\u5B58\uFF08\u65B0\u589E\u951A\u70B9 ${payload.anchors.created} \u4E2A\uFF0C\u4FDD\u7559 ${payload.anchors.retained} \u4E2A\uFF09`,
          "saved"
        );
      }
      refreshPublishStatus();
    } catch (error) {
      saveMachine.failed();
      setSaveStatus("\u4FDD\u5B58\u5931\u8D25", "failed");
      showError($("#editError"), error.message);
    } finally {
      editState.saving = false;
    }
  }
  function maybeOfferDraft(diskBody) {
    pendingDraft = "";
    const draft = readLocalDraft();
    if (!draft) return;
    if (draft === diskBody) {
      clearLocalDraft();
      return;
    }
    pendingDraft = draft;
    $("#draftBar").classList.remove("hidden");
  }
  function fillFmForm(fm) {
    var _a;
    const form2 = $("#fmForm");
    form2.title.value = fm.title || "";
    form2.subtitle.value = fm.subtitle || "";
    form2.description.value = fm.description || "";
    form2.date.value = String(fm.date || "").slice(0, 10);
    form2.weight.value = (_a = fm.weight) != null ? _a : 10;
    form2.draft.checked = Boolean(fm.draft);
    form2.featured.checked = Boolean(fm.featured);
    for (const key of LIST_FIELDS) {
      const value = fm[key];
      form2[key].value = Array.isArray(value) ? value.join("\uFF0C") : value || "";
    }
    $("#fmSlug").textContent = fm.slug || "\u2014";
    $("#fmArticleId").textContent = fm.articleId || "\u2014";
    $("#fmArticleRevision").textContent = fm.articleRevision || "\u2014";
  }
  function readFmForm() {
    const form2 = $("#fmForm");
    const fm = {
      title: form2.title.value.trim(),
      subtitle: form2.subtitle.value.trim(),
      description: form2.description.value.trim(),
      draft: form2.draft.checked,
      featured: form2.featured.checked,
      weight: Number(form2.weight.value || 10)
    };
    if (form2.date.value) fm.date = form2.date.value;
    for (const key of LIST_FIELDS) {
      fm[key] = form2[key].value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    }
    return fm;
  }
  var refreshEditorPreview = debounce(async () => {
    if (!studioEditor) return;
    const preview = $("#editorPreview");
    try {
      const payload = await api("/api/render", { markdown: studioEditor.getMarkdown() });
      preview.innerHTML = payload.html;
      decoratePreviewNotes();
    } catch (error) {
      preview.textContent = `\u9884\u89C8\u6E32\u67D3\u5931\u8D25\uFF1A${error.message}`;
    }
  }, 300);
  async function openEditor(path) {
    hideError($("#editError"));
    $("#draftBar").classList.add("hidden");
    pendingDraft = "";
    setSaveStatus("", "");
    editState.path = "";
    editState.articleId = "";
    editState.dirty = false;
    clearTimeout(editState.autosaveTimer);
    clearTimeout(editState.draftTimer);
    try {
      const payload = await apiGet(`/api/article?path=${encodeURIComponent(path)}`);
      const article = payload.article;
      editState.path = article.path;
      editState.articleId = article.frontMatter.articleId || "";
      const editor = ensureEditor();
      editor.setMarkdown(article.body);
      editState.dirty = false;
      saveMachine.reset();
      setSaveStatus("\u5DF2\u4FDD\u5B58", "saved");
      const fm = article.frontMatter;
      $("#editTitle").textContent = fm.subtitle ? `${fm.title} \xB7 ${fm.subtitle}` : fm.title || "\uFF08\u672A\u547D\u540D\uFF09";
      $("#editDraftBadge").classList.toggle("hidden", !fm.draft);
      fillFmForm(fm);
      showEditorMode("edit");
      updateWordCount();
      updateToolbarState(LidaijiEditor.selectionInfo(editor.view.state));
      loadNotes();
      refreshPublishStatus();
      maybeOfferDraft(article.body);
      editor.focus();
    } catch (error) {
      editState.path = "";
      showError($("#editError"), error.message);
    }
  }
  for (const id of [
    "tbUndo",
    "tbRedo",
    "tbBold",
    "tbItalic",
    "tbLink",
    "tbImage",
    "tbAlignLeft",
    "tbAlignCenter",
    "tbAlignRight",
    "tbBlockType"
  ]) {
    const element = $(`#${id}`);
    if (element) element.addEventListener("mousedown", (event) => event.preventDefault());
  }
  var CONTAINER_NODE_NAME = {
    poetry: "poetry_block",
    endnote: "endnote_block",
    quote: "blockquote"
  };
  $("#tbBlockType").addEventListener("change", () => {
    if (!studioEditor) return;
    const value = $("#tbBlockType").value;
    const current = lastToolbarInfo && lastToolbarInfo.blockType;
    if (value === current || value === "mixed" || value === "other") return;
    const inContainer = current === "poetry" || current === "endnote" || current === "quote";
    if (CONTAINER_NODE_NAME[value]) {
      studioEditor.convertContainerType(CONTAINER_NODE_NAME[value]);
    } else if (value === "paragraph") {
      if (inContainer) studioEditor.convertContainerType("paragraph");
      else studioEditor.setBlockType("paragraph");
    } else if (value === "heading") {
      studioEditor.setBlockType("heading", { level: 2 });
    }
    studioEditor.focus();
  });
  $("#tbUndo").addEventListener("click", () => {
    if (studioEditor) studioEditor.undo();
  });
  $("#tbRedo").addEventListener("click", () => {
    if (studioEditor) studioEditor.redo();
  });
  $("#tbBold").addEventListener("click", () => {
    if (studioEditor) {
      studioEditor.toggleBold();
      studioEditor.focus();
    }
  });
  $("#tbItalic").addEventListener("click", () => {
    if (studioEditor) {
      studioEditor.toggleEm();
      studioEditor.focus();
    }
  });
  $("#tbLink").addEventListener("click", () => {
    if (!studioEditor || !lastToolbarInfo || !lastToolbarInfo.enabled.link) return;
    if (lastToolbarInfo.link) {
      studioEditor.setLink("");
    } else {
      const url = window.prompt("\u94FE\u63A5\u5730\u5740\uFF08\u4EE5 https:// \u6216 / \u5F00\u5934\uFF09", "https://");
      if (url) {
        studioEditor.setLink(url.trim());
      }
    }
    studioEditor.focus();
  });
  $("#tbImage").addEventListener("click", () => {
    if (!studioEditor || !lastToolbarInfo || !lastToolbarInfo.enabled.image) return;
    const src = window.prompt("\u56FE\u7247\u5730\u5740\uFF08\u672C\u5730\u5A92\u4F53\u6216 https://\uFF09", "");
    if (src) {
      studioEditor.insertImage(src.trim(), "");
    }
    studioEditor.focus();
  });
  $("#tbAlignLeft").addEventListener("click", () => {
    if (studioEditor) {
      studioEditor.setAlignment("left");
      studioEditor.focus();
    }
  });
  $("#tbAlignCenter").addEventListener("click", () => {
    if (studioEditor) {
      studioEditor.setAlignment("center");
      studioEditor.focus();
    }
  });
  $("#tbAlignRight").addEventListener("click", () => {
    if (studioEditor) {
      studioEditor.setAlignment("right");
      studioEditor.focus();
    }
  });
  $("#tbPreview").addEventListener("click", async () => {
    showEditorMode("preview");
    await refreshEditorPreview();
  });
  $("#editorPreviewBack").addEventListener("click", () => showEditorMode("edit"));
  $("#tbSource").addEventListener("click", () => {
    $("#editorSource").textContent = studioEditor ? studioEditor.getMarkdown() : "";
    showEditorMode("source");
  });
  $("#editorSourceBack").addEventListener("click", () => showEditorMode("edit"));
  $("#draftRestore").addEventListener("click", () => {
    if (pendingDraft && studioEditor) {
      studioEditor.setMarkdown(pendingDraft);
      editState.dirty = true;
      setSaveStatus("\u5C1A\u672A\u4FDD\u5B58", "");
      updateWordCount();
      pendingDraft = "";
    }
    $("#draftBar").classList.add("hidden");
  });
  $("#draftDiscard").addEventListener("click", () => {
    clearLocalDraft();
    pendingDraft = "";
    $("#draftBar").classList.add("hidden");
  });
  $("#fmForm").addEventListener("input", markDirty);
  $("#editSave").addEventListener("click", async () => {
    hideError($("#editError"));
    await saveArticle();
  });
  $("#editSaveRetry").addEventListener("click", async () => {
    hideError($("#editError"));
    await saveArticle();
  });
  $("#editHugoPreview").addEventListener("click", async () => {
    const status = $("#editSaveStatus");
    status.textContent = "\u6B63\u5728\u6253\u5F00 Hugo \u9884\u89C8\u2026";
    status.classList.remove("saved", "failed", "saving");
    try {
      await api("/api/article/open-page", { path: editState.path });
      status.textContent = editState.dirty ? "\u5DF2\u5728\u6D4F\u89C8\u5668\u6253\u5F00\uFF08\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\u4E0D\u4F1A\u51FA\u73B0\u5728\u9884\u89C8\u4E2D\uFF09" : "\u5DF2\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u3002";
    } catch (error) {
      status.textContent = error.message;
    }
  });
  $("#editOpenFolder").addEventListener("click", async () => {
    try {
      await api("/api/system/open-folder", { path: editState.path });
    } catch (error) {
      showError($("#editError"), error.message);
    }
  });
  var publishState = {
    status: null,
    preview: null,
    pollTimer: 0,
    dialogData: null
  };
  var PUBLISH_STAGE_LABELS = {
    validating: "\u6B63\u5728\u6821\u9A8C",
    building: "\u6B63\u5728\u6784\u5EFA",
    "backing-up": "\u6B63\u5728\u5907\u4EFD",
    uploading: "\u6B63\u5728\u4E0A\u4F20",
    switching: "\u6B63\u5728\u5207\u6362\u7248\u672C",
    verifying: "\u6B63\u5728\u9A8C\u8BC1"
  };
  function fmtTime(seconds) {
    if (!seconds) return "\u2014";
    const date = new Date(seconds * 1e3);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  function renderPublishBar() {
    const bar = $("#publishBar");
    if (!publishState.status) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    const status = publishState.status;
    const live = status.publishedRevision;
    $("#pubDraftState").textContent = status.draft ? "\u8349\u7A3F" : "\u5DF2\u53D1\u5E03";
    $("#pubSavedAt").textContent = `\u6700\u540E\u4FDD\u5B58\uFF1A${fmtTime(status.lastSavedAt)}`;
    $("#pubPreviewState").textContent = status.previewFresh ? "\u9884\u89C8\uFF1A\u5DF2\u751F\u6210\uFF08\u6700\u65B0\uFF09" : "\u9884\u89C8\uFF1A\u672A\u751F\u6210\u6216\u5DF2\u8FC7\u671F";
    $("#pubLiveVersion").textContent = live ? `\u7EBF\u4E0A\u7248\u672C\uFF1A${live.slice(-8)}\uFF08${fmtTime(new Date(status.publishedAt || 0).getTime() / 1e3)}\uFF09` : "\u7EBF\u4E0A\u7248\u672C\uFF1A\u5C1A\u672A\u53D1\u5E03";
    const unsaved = $("#pubUnsaved");
    unsaved.classList.toggle("hidden", !editState.dirty);
    const preview = status.preview || {};
    $("#pubSnapshot").textContent = preview.snapshotId ? `\u5FEB\u7167 ${preview.snapshotId.slice(0, 8)}\u2026 \xB7 \u6E90SHA ${preview.sourceFileSha256 || "\u2014"}` : "\u5C1A\u672A\u751F\u6210\u5FEB\u7167";
    $("#pubBaseline").textContent = preview.baselineCommit ? `\u57FA\u7EBF ${preview.baselineCommit}\u2026` : "";
    const candidate = preview.candidate || {};
    $("#pubCandidate").textContent = candidate.candidateId ? candidate.blocked ? `\u5019\u9009\uFF1A\u5DF2\u963B\u65AD\uFF08${candidate.error || "\u654F\u611F\u626B\u63CF\u6216\u5206\u7C7B\u672A\u901A\u8FC7"}\uFF09` : `\u5019\u9009 ${candidate.candidateId} \xB7 \u6E05\u5355SHA ${String(candidate.manifestSha256 || "").slice(0, 12)} \xB7 ${candidate.fileCount || 0} \u6587\u4EF6 \xB7 \u5C1A\u672A\u90E8\u7F72` : "";
    const history = $("#publishHistory");
    const list = $("#publishHistoryList");
    list.textContent = "";
    if (status.history && status.history.length) {
      history.classList.remove("hidden");
      status.history.slice().reverse().forEach((entry) => {
        const item = document.createElement("li");
        const revision = document.createElement("strong");
        revision.textContent = String(entry.revision || "").slice(-8);
        item.appendChild(revision);
        const meta = document.createElement("span");
        meta.className = "meta-text";
        const statusText = entry.status === "ok" ? "\u6210\u529F" : entry.status === "running" ? "\u8FDB\u884C\u4E2D" : `\u5931\u8D25(${entry.status})`;
        meta.textContent = ` ${statusText} \xB7 ${entry.completedAt || entry.createdAt || ""} ${entry.releaseId ? "\xB7 " + entry.releaseId : ""}`;
        item.appendChild(meta);
        list.appendChild(item);
      });
    } else {
      history.classList.add("hidden");
    }
  }
  async function ensureDeployMode() {
    if (typeof window.studioDeployDisabled !== "boolean") {
      try {
        const payload = await apiGet("/api/system/status");
        window.studioDeployDisabled = payload.deployDisabled === true;
      } catch (error) {
        window.studioDeployDisabled = false;
      }
    }
    renderDeployMode();
  }
  function renderDeployMode() {
    if (!editState.path) return;
    const banner = $("#deployDevBanner");
    const disabled = window.studioDeployDisabled === true;
    banner.classList.toggle("hidden", !disabled);
    const publishBtn = $("#editPublish");
    if (publishBtn) {
      publishBtn.disabled = disabled;
      if (disabled) publishBtn.title = "\u5F00\u53D1\u6A21\u5F0F\uFF1A\u53D1\u5E03\u5230\u751F\u4EA7\u5DF2\u7981\u7528";
    }
  }
  function renderPublishStage() {
    const stage = $("#publishStage");
    const lock = publishState.status && publishState.status.lock;
    if (lock && lock.inFlight) {
      stage.classList.remove("hidden");
      $("#publishStageText").textContent = `${PUBLISH_STAGE_LABELS[lock.stage] || "\u6B63\u5728\u53D1\u5E03"}\u2026\uFF08\u540C\u4E00\u65F6\u95F4\u53EA\u5141\u8BB8\u4E00\u4E2A\u53D1\u5E03\u4EFB\u52A1\uFF09`;
    } else if (lock && lock.status === "failed_recovery") {
      stage.classList.remove("hidden");
      $("#publishStageText").textContent = "\u68C0\u6D4B\u5230\u4E0A\u6B21\u53D1\u5E03\u8FDB\u7A0B\u5F02\u5E38\u9000\u51FA\uFF1A\u72B6\u6001\u672A\u77E5\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u9A8C\u540E\u518D\u64CD\u4F5C\u3002";
    } else {
      stage.classList.add("hidden");
    }
  }
  function renderPublishResult() {
    const box = $("#publishResult");
    const result = publishState.status && publishState.status.result;
    if (!result || result.articleId !== (publishState.status && publishState.status.articleId)) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    if (result.ok) {
      $("#publishResultTitle").textContent = `\u53D1\u5E03\u6210\u529F\uFF1A${publishState.status.slug || ""}`;
      $("#publishResultMeta").textContent = `\u6B63\u5F0F\u7F51\u5740 ${result.canonicalUrl || ""} \xB7 \u53D1\u5E03\u65F6\u95F4 ${result.completedAt || ""} \xB7 release ${result.releaseId || "\u2014"} \xB7 \u6587\u7AE0\u7248\u672C ${String(result.revision || "").slice(-8)}`;
      $("#publishResultOpen").href = result.canonicalUrl || "#";
      $("#publishResultLog").textContent = result.output || "\uFF08\u65E0\u65E5\u5FD7\uFF09";
      const link = $("#publishResultLogLink");
      if (result.logUrl) {
        link.href = result.logUrl;
        link.classList.remove("hidden");
      } else {
        link.classList.add("hidden");
      }
    } else {
      $("#publishResultTitle").textContent = `\u53D1\u5E03\u5931\u8D25\uFF1A${result.error || "\u672A\u77E5\u539F\u56E0"}`;
      $("#publishResultMeta").textContent = "\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1B\u670D\u52A1\u5668\u4ECD\u505C\u7559\u5728\u65E7\u7248\u672C\u3002";
      $("#publishResultLog").textContent = result.output || result.logTail || "\uFF08\u65E0\u65E5\u5FD7\uFF09";
      $("#publishResultOpen").classList.add("hidden");
      $("#publishResultOpen").classList.add("hidden");
      const link = $("#publishResultLogLink");
      if (result.logUrl) {
        link.href = result.logUrl;
        link.classList.remove("hidden");
      } else {
        link.classList.add("hidden");
      }
    }
  }
  async function refreshPublishStatus() {
    if (!editState.path) return;
    try {
      const payload = await apiGet(`/api/article/publish-status?path=${encodeURIComponent(editState.path)}`);
      publishState.status = payload.status;
      renderPublishBar();
      renderDeployMode();
      ensureDeployMode();
      renderPublishStage();
      renderPublishResult();
      const lock = payload.status.lock;
      if (lock && lock.inFlight) {
        publishState.pollTimer = setTimeout(refreshPublishStatus, 2e3);
      }
    } catch (e) {
    }
  }
  async function ensureSavedBeforePublish(action) {
    if (editState.dirty) {
      showError($("#editError"), "\u5B58\u5728\u672A\u4FDD\u5B58\u4FEE\u6539\uFF1A\u8BF7\u5148\u4FDD\u5B58\u8349\u7A3F\uFF0C\u518D" + action + "\u3002");
      return false;
    }
    if (!editState.path) {
      showError($("#editError"), "\u8BF7\u5148\u6253\u5F00\u4E00\u7BC7\u6587\u7AE0\u3002");
      return false;
    }
    return true;
  }
  $("#editPublishPreview").addEventListener("click", async () => {
    var _a;
    hideError($("#editError"));
    if (!await ensureSavedBeforePublish("\u751F\u6210\u53D1\u5E03\u9884\u89C8")) return;
    const button = $("#editPublishPreview");
    const stage = $("#publishStage");
    button.disabled = true;
    stage.classList.remove("hidden");
    $("#publishStageText").textContent = "\u6B63\u5728\u6821\u9A8C\u5E76\u6784\u5EFA\uFF08\u53EF\u80FD\u9700\u8981\u4E00\u4E24\u5206\u949F\uFF09\u2026";
    try {
      const result = await apiRaw("/api/article/publish-preview", { path: editState.path });
      stage.classList.add("hidden");
      const payload = result.payload;
      if (!payload.ok && !payload.gateOnly) {
        const failed = payload.checks.filter((c) => c.status === "FAIL").map((c) => c.name).join("\u3001");
        showError($("#editError"), `\u53D1\u5E03\u9884\u89C8\u672A\u901A\u8FC7\uFF1A${failed || "\u68C0\u67E5\u5931\u8D25"}\uFF08\u8BE6\u89C1\u65E5\u5FD7\u5C3E\u90E8\uFF09\u3002`);
        $("#publishResultLog").textContent = payload.buildOutput || "";
        return;
      }
      if (payload.gateOnly) {
        showError($("#editError"), "\u53D1\u5E03\u9884\u89C8\u901A\u8FC7\uFF08\u89E6\u53D1\u5927\u89C4\u6A21\u6BB5\u843D\u8C03\u6574\u95E8\u7981\uFF1A\u8BF7\u786E\u8BA4\u540E\u53D1\u5E03\uFF09\u3002");
      }
      publishState.preview = payload;
      const anchor = payload.anchor || {};
      const affected = payload.affectedComments === null ? "\u672A\u77E5\uFF08\u8BC4\u8BBA\u670D\u52A1\u4E0D\u53EF\u8FBE\uFF09" : `${payload.affectedComments} \u6761`;
      showError($("#editError"), "");
      $("#editError").classList.add("hidden");
      $("#pubPreviewState").textContent = "\u9884\u89C8\uFF1A\u5DF2\u751F\u6210\uFF08\u6700\u65B0\uFF09";
      const pass = payload.checks.filter((c) => c.status === "PASS").length;
      const warn = payload.checks.filter((c) => c.status === "WARNING").length;
      const baseline = payload.baseline || {};
      const dirty = payload.unrelatedDirty || { count: 0 };
      const lines = [
        `\u53D1\u5E03\u9884\u89C8\u5DF2\u751F\u6210\uFF1A${payload.canonicalUrl}`,
        `\u6BB5\u843D\u53D8\u5316\uFF1A\u4FDD\u6301 ${anchor.retained} \xB7 \u65B0\u589E ${anchor.created} \xB7 \u8F6C\u5386\u53F2 ${anchor.deleted}`,
        `\u53D7\u5F71\u54CD\u6BB5\u8BC4\uFF1A${affected}`,
        `\u7EBF\u4E0A\u57FA\u7EBF\uFF1A\u5185\u5BB9\u63D0\u4EA4 ${baseline.privateContentCommit || "\u2014"}\uFF08\u6821\u9A8C ${(_a = baseline.verifiedArticles) != null ? _a : "?"} \u7BC7\uFF09`,
        `\u65E0\u5173\u6587\u7AE0\u5019\u9009\u5DEE\u5F02\uFF1A${payload.candidate ? payload.candidate.unrelatedChangedCount : "\u2014"}\uFF08\u5FC5\u987B\u4E3A 0\uFF09`,
        dirty.count ? `\u4F5C\u8005\u5DE5\u4F5C\u533A\u53E6\u6709 ${dirty.count} \u4E2A\u672A\u63D0\u4EA4\u6587\u4EF6\uFF0C\u4E0D\u4F1A\u8FDB\u5165\u672C\u6B21\u53D1\u5E03\u5019\u9009\u3002` : "\u4F5C\u8005\u5DE5\u4F5C\u533A\u65E0\u65E0\u5173\u672A\u63D0\u4EA4\u6587\u4EF6\u3002",
        `\u68C0\u67E5 ${pass} \u9879\u901A\u8FC7 / ${warn} \u9879\u8B66\u544A`
      ];
      $("#publishStageText").textContent = lines.join(" | ");
      stage.classList.remove("hidden");
      await refreshPublishStatus();
      window.open(payload.previewUrl, "_blank", "noopener");
    } catch (error) {
      stage.classList.add("hidden");
      showError($("#editError"), error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#editPublish").addEventListener("click", async () => {
    hideError($("#editError"));
    if (!await ensureSavedBeforePublish("\u786E\u8BA4\u53D1\u5E03")) return;
    await refreshPublishStatus();
    if (publishState.status && publishState.status.lock && publishState.status.lock.inFlight) {
      showError($("#editError"), "\u5DF2\u6709\u53D1\u5E03\u4EFB\u52A1\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u3002");
      return;
    }
    const status = publishState.status;
    if (!status || !status.previewFresh) {
      showError($("#editError"), "\u8BF7\u5148\u751F\u6210\u53D1\u5E03\u9884\u89C8\uFF08\u8349\u7A3F\u4FDD\u5B58\u540E\u9884\u89C8\u624D\u6709\u6548\uFF09\u3002");
      return;
    }
    if (status.draft) {
      showError($("#editError"), "\u6587\u7AE0\u4ECD\u4E3A\u8349\u7A3F\u72B6\u6001\uFF1A\u8BF7\u5148\u5728\u5143\u6570\u636E\u4E2D\u53D6\u6D88\u52FE\u9009\u300C\u8349\u7A3F\u300D\u5E76\u4FDD\u5B58\uFF0C\u518D\u751F\u6210\u9884\u89C8\u4E0E\u53D1\u5E03\u3002");
      return;
    }
    publishState.dialogData = status;
    const gate = publishState.preview && publishState.preview.largeRetireGate;
    $("#pdLargeRetireWrap").classList.toggle("hidden", !gate);
    $("#pdLargeRetire").checked = false;
    $("#pdTitle").textContent = status.slug || "\u2014";
    $("#pdUrl").textContent = status.canonicalUrl || "\u2014";
    $("#pdLiveAt").textContent = status.publishedAt ? fmtTime(new Date(status.publishedAt).getTime() / 1e3) : "\u5C1A\u672A\u53D1\u5E03";
    $("#pdDraftAt").textContent = fmtTime(status.lastSavedAt);
    $("#pdAnchor").textContent = "\u53D1\u5E03\u65F6\u5C06\u6309\u4FDD\u5B58\u8349\u7A3F\u7684\u6BB5\u843D\u7ED3\u6784\u540C\u6B65\uFF08\u4FDD\u6301/\u65B0\u589E/\u8F6C\u5386\u53F2\u4EE5\u9884\u89C8\u7ED3\u679C\u4E3A\u51C6\uFF09\u3002";
    $("#pdChecks").textContent = "\u53D1\u5E03\u524D\u5C06\u518D\u6B21\u6267\u884C\u5B8C\u6574\u6784\u5EFA\u68C0\u67E5\u4E0E\u670D\u52A1\u5668\u6821\u9A8C\u3002";
    $("#publishDialog").classList.remove("hidden");
  });
  $("#publishDialogNo").addEventListener("click", () => {
    $("#publishDialog").classList.add("hidden");
    publishState.dialogData = null;
  });
  $("#publishDialogYes").addEventListener("click", async () => {
    const status = publishState.dialogData;
    $("#publishDialog").classList.add("hidden");
    if (!status) return;
    publishState.dialogData = null;
    const idempotencyKey = `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const payload = await api("/api/article/publish", {
        path: editState.path,
        draftRevision: status.revision,
        previewBuildId: publishState.preview ? publishState.preview.previewBuildId : "",
        snapshotId: publishState.preview ? publishState.preview.snapshotId : "",
        idempotencyKey,
        allowLargeRetire: $("#pdLargeRetire").checked === true
      });
      $("#publishStage").classList.remove("hidden");
      $("#publishStageText").textContent = "\u6B63\u5728\u53D1\u5E03\u2026";
      await refreshPublishStatus();
      if (payload.task && payload.task.inFlight) {
        $("#publishStageText").textContent = `${PUBLISH_STAGE_LABELS[payload.task.stage] || "\u6B63\u5728\u53D1\u5E03"}\u2026`;
      }
    } catch (error) {
      showError($("#editError"), error.message);
    }
  });
  $("#publishResultCopy").addEventListener("click", async () => {
    const result = publishState.status && publishState.status.result;
    const url = result && result.canonicalUrl || "";
    try {
      await navigator.clipboard.writeText(url);
      $("#publishResultCopy").textContent = "\u5DF2\u590D\u5236";
      setTimeout(() => {
        $("#publishResultCopy").textContent = "\u590D\u5236\u6587\u7AE0\u7F51\u5740";
      }, 1500);
    } catch (e) {
    }
  });

  // studio/app/feedback.mjs
  var feedbackState = {
    loggedIn: false,
    username: "",
    serviceRunning: false,
    serviceSourceLabel: "",
    authMode: "local-bootstrap",
    credentialsConfigured: false,
    upstreamError: "",
    lockedNow: false,
    page: 1,
    pages: 1,
    serviceTimer: 0,
    quick: null
    // { queue: [], index: 0 }
  };
  var FEEDBACK_SCOPE_LABELS = { paragraph: "\u6BB5\u8BC4", article: "\u7AE0\u8BC4" };
  var FEEDBACK_STATUS_LABELS = {
    pending: "\u5F85\u5BA1\u6838",
    approved: "\u5DF2\u901A\u8FC7",
    rejected: "\u5DF2\u62D2\u7EDD",
    spam: "\u5783\u573E",
    hidden: "\u5DF2\u9690\u85CF",
    deleted: "\u5DF2\u5220\u9664",
    orphaned: "\u5386\u53F2\u6BB5\u8BC4"
  };
  function feedbackQuery() {
    const params = new URLSearchParams();
    params.set("status", $("#feedbackStatus").value);
    params.set("scope", $("#feedbackScope").value);
    params.set("page", String(feedbackState.page));
    const q = $("#feedbackSearch").value.trim();
    if (q) params.set("q", q);
    const articleId = $("#feedbackArticle").value;
    if (articleId) params.set("articleId", articleId);
    return params.toString();
  }
  function renderFeedbackPanels() {
    const { serviceRunning, loggedIn, authMode, locked } = feedbackState;
    const setupHint = $("#feedbackSetupHint");
    const upstreamError = $("#feedbackUpstreamError");
    const lockedScreen = $("#feedbackLocked");
    const lockedNow = Boolean(locked || feedbackState.lockedNow);
    if (lockedScreen) lockedScreen.classList.toggle("hidden", !lockedNow);
    if (lockedNow) return;
    $("#feedbackServiceOff").classList.toggle("hidden", serviceRunning);
    if (setupHint) {
      setupHint.classList.toggle(
        "hidden",
        !(serviceRunning && !loggedIn && authMode === "local-bootstrap" && !feedbackState.credentialsConfigured && !feedbackState.upstreamError)
      );
    }
    if (upstreamError) {
      const label = upstreamError.querySelector("[data-upstream-error]");
      if (label) label.textContent = feedbackState.upstreamError || "";
      upstreamError.classList.toggle(
        "hidden",
        !(serviceRunning && !loggedIn && authMode === "local-bootstrap" && feedbackState.upstreamError)
      );
    }
    $("#feedbackLoginForm").classList.toggle("hidden", !(serviceRunning && !loggedIn && authMode === "password"));
    $("#feedbackLoginPanel").classList.toggle("hidden", serviceRunning && loggedIn);
    $("#feedbackMain").classList.toggle("hidden", !(serviceRunning && loggedIn));
    $("#feedbackUser").textContent = loggedIn ? `\u7AD9\u4E3B\uFF1A${feedbackState.username}` : "";
    if (feedbackState.serviceSourceLabel) {
      $("#feedbackServiceStatus").textContent = feedbackState.serviceSourceLabel;
    }
  }
  async function refreshFeedbackStatus() {
    try {
      const payload = await apiGet("/api/feedback/status");
      feedbackState.serviceRunning = Boolean(payload.service && payload.service.running);
      feedbackState.serviceSourceLabel = payload.service && payload.service.sourceLabel || "";
      feedbackState.loggedIn = Boolean(payload.loggedIn);
      feedbackState.username = payload.username || "";
      feedbackState.authMode = payload.authMode || "local-bootstrap";
      const upstream = payload.upstream || {};
      feedbackState.credentialsConfigured = Boolean(upstream.credentialsConfigured);
      feedbackState.upstreamError = payload.upstreamError || "";
      renderFeedbackPanels();
      return payload;
    } catch (error) {
      showError($("#feedbackError"), error.message);
      return null;
    }
  }
  function pollFeedbackService(deadline) {
    clearTimeout(feedbackState.serviceTimer);
    feedbackState.serviceTimer = setTimeout(async () => {
      const payload = await refreshFeedbackStatus();
      if (payload && payload.service.running) {
        return;
      }
      if (Date.now() < deadline) {
        pollFeedbackService(deadline);
      } else {
        $("#feedbackServiceStatus").textContent = "\u7B49\u5F85\u8D85\u65F6\uFF1A\u8BC4\u8BBA\u670D\u52A1\u4ECD\u672A\u5C31\u7EEA\uFF0C\u8BF7\u68C0\u67E5 SSH \u96A7\u9053\u6216\u670D\u52A1\u5668\u72B6\u6001\u3002";
      }
    }, 3e3);
  }
  $("#feedbackServiceStart").addEventListener("click", async () => {
    hideError($("#feedbackError"));
    const status = $("#feedbackServiceStatus");
    status.textContent = "\u6B63\u5728\u8FDE\u63A5\u751F\u4EA7\u8BC4\u8BBA\u670D\u52A1\uFF08SSH \u96A7\u9053\uFF09\u2026";
    try {
      await api("/api/feedback/service", { action: "start" });
      pollFeedbackService(Date.now() + 6e4);
    } catch (error) {
      status.textContent = error.message;
    }
  });
  $("#feedbackServiceStop").addEventListener("click", async () => {
    hideError($("#feedbackError"));
    try {
      await api("/api/feedback/service", { action: "stop" });
      feedbackState.loggedIn = false;
      await refreshFeedbackStatus();
    } catch (error) {
      showError($("#feedbackError"), error.message);
    }
  });
  $("#feedbackLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    hideError($("#feedbackError"));
    const status = $("#feedbackLoginStatus");
    status.textContent = "\u6B63\u5728\u767B\u5F55\u2026";
    try {
      const form2 = event.target;
      const payload = await api("/api/feedback/login", {
        username: form2.username.value.trim(),
        password: form2.password.value
      });
      form2.password.value = "";
      feedbackState.loggedIn = true;
      feedbackState.username = payload.username || "";
      status.textContent = "";
      renderFeedbackPanels();
      prepareFeedbackFilters();
      feedbackState.page = 1;
      loadComments();
    } catch (error) {
      status.textContent = error.message;
    }
  });
  $("#feedbackLogout").addEventListener("click", async () => {
    hideError($("#feedbackError"));
    try {
      await api("/api/feedback/logout");
    } catch (error) {
    }
    feedbackState.loggedIn = false;
    feedbackState.username = "";
    feedbackState.quick = null;
    renderFeedbackPanels();
  });
  $("#feedbackLock").addEventListener("click", async () => {
    hideError($("#feedbackError"));
    try {
      await api("/api/system/lock");
    } catch (error) {
    }
    feedbackState.lockedNow = true;
    renderFeedbackPanels();
  });
  $("#feedbackLockedReauth").addEventListener("click", () => {
    location.reload();
  });
  var feedbackArticlesReady = false;
  async function prepareFeedbackFilters() {
    if (feedbackArticlesReady) return;
    try {
      const payload = await apiGet("/api/articles");
      const select = $("#feedbackArticle");
      select.textContent = "";
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "\u5168\u90E8\u6587\u7AE0";
      select.appendChild(all);
      for (const article of payload.articles) {
        if (!article.articleId) continue;
        const option = document.createElement("option");
        option.value = article.articleId;
        option.textContent = article.title || article.slug;
        select.appendChild(option);
      }
      feedbackArticlesReady = true;
    } catch (error) {
    }
  }
  function renderFeedbackStats(stats) {
    const box = $("#feedbackStats");
    box.textContent = "";
    const entries = [
      ["\u5F85\u5BA1\u6838", stats.pending || 0],
      ["\u5DF2\u901A\u8FC7", stats.approved || 0],
      ["\u5783\u573E", stats.spam || 0],
      ["\u5386\u53F2\u6BB5\u8BC4", stats.orphaned || 0]
    ];
    for (const [label, count] of entries) {
      const card = document.createElement("div");
      card.className = "stat-card";
      const number = document.createElement("strong");
      number.textContent = String(count);
      const text = document.createElement("span");
      text.textContent = label;
      card.appendChild(number);
      card.appendChild(text);
      box.appendChild(card);
    }
  }
  function commentExcerptBlock(comment) {
    if (comment.scope !== "paragraph") return null;
    const wrap = document.createElement("div");
    wrap.className = "comment-excerpts";
    const submitted = document.createElement("p");
    submitted.className = "meta-text";
    submitted.textContent = `\u63D0\u4EA4\u65F6\u6458\u5F55\uFF1A${comment.paragraph_excerpt || "\uFF08\u65E0\uFF09"}`;
    wrap.appendChild(submitted);
    const current = document.createElement("p");
    if (!comment.current_excerpt) {
      current.className = "warning-text";
      current.textContent = "\u8BE5\u6BB5\u843D\u5DF2\u5220\u9664\u6216\u951A\u70B9\u5931\u6548\uFF0C\u8BC4\u8BBA\u5DF2\u65E0\u6CD5\u5B9A\u4F4D\u3002";
    } else if (comment.current_excerpt !== comment.paragraph_excerpt) {
      current.className = "warning-text";
      current.textContent = `\u5F53\u524D\u6458\u5F55\uFF08\u4E0E\u63D0\u4EA4\u65F6\u4E0D\u4E00\u81F4\uFF09\uFF1A${comment.current_excerpt}`;
    } else {
      current.className = "meta-text";
      current.textContent = "\u5F53\u524D\u6458\u5F55\u4E0E\u63D0\u4EA4\u65F6\u4E00\u81F4\u3002";
    }
    wrap.appendChild(current);
    return wrap;
  }
  function moderateButton(label, className, action, comment, onDone) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${className} small`;
    button.textContent = label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("/api/feedback/moderate", { id: comment.id, action });
        onDone();
      } catch (error) {
        button.disabled = false;
        if (error.code === "not-logged-in") {
          feedbackState.loggedIn = false;
          renderFeedbackPanels();
        }
        showError($("#feedbackError"), error.message);
      }
    });
    return button;
  }
  function commentCard(comment, onDone) {
    const card = document.createElement("article");
    card.className = "article-card comment-card";
    const head = document.createElement("div");
    head.className = "article-head";
    const title = document.createElement("h3");
    title.textContent = comment.display_name || "\uFF08\u533F\u540D\uFF09";
    head.appendChild(title);
    const badges = document.createElement("span");
    badges.className = "badges";
    const scope = document.createElement("span");
    scope.className = "badge badge-type";
    scope.textContent = FEEDBACK_SCOPE_LABELS[comment.scope] || comment.scope;
    badges.appendChild(scope);
    const status = document.createElement("span");
    status.className = "badge badge-type";
    status.textContent = FEEDBACK_STATUS_LABELS[comment.status] || comment.status;
    badges.appendChild(status);
    head.appendChild(badges);
    card.appendChild(head);
    const meta = document.createElement("p");
    meta.className = "meta-text";
    meta.textContent = `${comment.title || comment.article_id} \xB7 ${String(comment.created_at || "").replace("T", " ").slice(0, 19)}`;
    card.appendChild(meta);
    const excerpts = commentExcerptBlock(comment);
    if (excerpts) card.appendChild(excerpts);
    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = comment.body || "";
    card.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "card-actions";
    if (comment.status !== "approved") actions.appendChild(moderateButton("\u901A\u8FC7", "primary", "approve", comment, onDone));
    if (comment.status !== "rejected") actions.appendChild(moderateButton("\u62D2\u7EDD", "secondary", "reject", comment, onDone));
    if (comment.status !== "spam") actions.appendChild(moderateButton("\u5783\u573E", "secondary", "spam", comment, onDone));
    if (comment.status !== "hidden") actions.appendChild(moderateButton("\u9690\u85CF", "secondary", "hide", comment, onDone));
    const statusText = document.createElement("span");
    statusText.className = "preview-status";
    if (comment.status !== "deleted") {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger small";
      del.textContent = "\u5220\u9664";
      const confirmBar = document.createElement("div");
      confirmBar.className = "confirm-bar hidden";
      const hint = document.createElement("span");
      hint.textContent = "\u5220\u9664\u540E\u524D\u53F0\u4E0E\u5217\u8868\u9ED8\u8BA4\u4E0D\u518D\u663E\u793A\uFF08\u670D\u52A1\u7AEF\u4E3A\u8F6F\u5220\u9664\uFF09\u3002\u786E\u8BA4\u5220\u9664\u8FD9\u6761\u8BC4\u8BBA\uFF1F";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "danger small";
      yes.textContent = "\u786E\u8BA4\u5220\u9664";
      const no = document.createElement("button");
      no.type = "button";
      no.className = "secondary small";
      no.textContent = "\u53D6\u6D88";
      del.addEventListener("click", () => confirmBar.classList.remove("hidden"));
      no.addEventListener("click", () => confirmBar.classList.add("hidden"));
      yes.addEventListener("click", async () => {
        yes.disabled = true;
        try {
          await api("/api/feedback/moderate", { id: comment.id, action: "delete", confirm: true });
          onDone();
        } catch (error) {
          yes.disabled = false;
          confirmBar.classList.add("hidden");
          if (error.code === "not-logged-in") {
            feedbackState.loggedIn = false;
            renderFeedbackPanels();
          }
          showError($("#feedbackError"), error.message);
        }
      });
      confirmBar.appendChild(hint);
      confirmBar.appendChild(yes);
      confirmBar.appendChild(no);
      actions.appendChild(del);
      card.appendChild(actions);
      card.appendChild(confirmBar);
    } else {
      card.appendChild(actions);
    }
    const locate = document.createElement("button");
    locate.type = "button";
    locate.className = "secondary small";
    locate.textContent = "\u67E5\u770B\u539F\u6587\u4F4D\u7F6E";
    locate.addEventListener("click", async () => {
      statusText.textContent = "\u6B63\u5728\u6253\u5F00\u2026";
      try {
        await api("/api/feedback/open-location", {
          canonicalPath: comment.canonical_path,
          paragraphId: comment.paragraph_id || "",
          scope: comment.scope
        });
        statusText.textContent = "\u5DF2\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u3002";
      } catch (error) {
        statusText.textContent = error.message;
      }
    });
    actions.appendChild(locate);
    actions.appendChild(statusText);
    return card;
  }
  function renderFeedbackPager(payload) {
    const pager = $("#feedbackPager");
    pager.textContent = "";
    feedbackState.pages = payload.pages || 1;
    if (feedbackState.pages <= 1) return;
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "secondary small";
    prev.textContent = "\u4E0A\u4E00\u9875";
    prev.disabled = feedbackState.page <= 1;
    prev.addEventListener("click", () => {
      feedbackState.page -= 1;
      loadComments();
    });
    const next = document.createElement("button");
    next.type = "button";
    next.className = "secondary small";
    next.textContent = "\u4E0B\u4E00\u9875";
    next.disabled = feedbackState.page >= feedbackState.pages;
    next.addEventListener("click", () => {
      feedbackState.page += 1;
      loadComments();
    });
    const info = document.createElement("span");
    info.className = "meta-text";
    info.textContent = `\u7B2C ${feedbackState.page} / ${feedbackState.pages} \u9875 \xB7 \u5171 ${payload.total} \u6761`;
    pager.appendChild(prev);
    pager.appendChild(info);
    pager.appendChild(next);
  }
  async function loadComments() {
    hideError($("#feedbackError"));
    try {
      const payload = await apiGet(`/api/feedback/comments?${feedbackQuery()}`);
      renderFeedbackStats(payload.stats || {});
      const list = $("#feedbackList");
      list.textContent = "";
      const comments = payload.comments || [];
      if (!comments.length) {
        const empty = document.createElement("p");
        empty.className = "meta-text";
        empty.textContent = "\u8FD9\u4E2A\u7B5B\u9009\u6761\u4EF6\u4E0B\u6CA1\u6709\u8BC4\u8BBA\u3002";
        list.appendChild(empty);
      }
      for (const comment of comments) {
        list.appendChild(commentCard(comment, () => loadComments()));
      }
      renderFeedbackPager(payload);
    } catch (error) {
      if (error.code === "not-logged-in") {
        feedbackState.loggedIn = false;
        renderFeedbackPanels();
      }
      showError($("#feedbackError"), error.message);
    }
  }
  ["feedbackStatus", "feedbackScope", "feedbackArticle"].forEach((id) => {
    $(`#${id}`).addEventListener("change", () => {
      feedbackState.page = 1;
      loadComments();
    });
  });
  $("#feedbackSearch").addEventListener("input", debounce(() => {
    feedbackState.page = 1;
    loadComments();
  }, 400));
  $("#feedbackRefresh").addEventListener("click", () => loadComments());
  function quickCard(item, index, total) {
    const box = $("#feedbackQuick");
    box.textContent = "";
    const heading = document.createElement("h2");
    heading.textContent = `\u5F85\u5BA1\u6838 ${index + 1} / ${total}\uFF08${FEEDBACK_SCOPE_LABELS[item.scope] || item.scope}\uFF09`;
    box.appendChild(heading);
    const meta = document.createElement("p");
    meta.className = "meta-text";
    meta.textContent = `${item.title || item.article_id} \xB7 ${item.display_name || "\uFF08\u533F\u540D\uFF09"} \xB7 ${String(item.created_at || "").replace("T", " ").slice(0, 19)}`;
    box.appendChild(meta);
    const excerpts = commentExcerptBlock(item);
    if (excerpts) box.appendChild(excerpts);
    const body = document.createElement("p");
    body.className = "comment-body quick-body";
    body.textContent = item.body || "";
    box.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const advance = () => {
      feedbackState.quick.index += 1;
      renderQuick();
    };
    actions.appendChild(moderateButton("\u901A\u8FC7\u5E76\u4E0B\u4E00\u6761", "primary", "approve", item, advance));
    actions.appendChild(moderateButton("\u62D2\u7EDD\u5E76\u4E0B\u4E00\u6761", "secondary", "reject", item, advance));
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "secondary small";
    skip.textContent = "\u8DF3\u8FC7";
    skip.addEventListener("click", advance);
    actions.appendChild(skip);
    const quit = document.createElement("button");
    quit.type = "button";
    quit.className = "secondary small";
    quit.textContent = "\u9000\u51FA\u5FEB\u6377\u5904\u7406";
    quit.addEventListener("click", () => {
      feedbackState.quick = null;
      $("#feedbackQuick").classList.add("hidden");
      loadComments();
    });
    actions.appendChild(quit);
    box.appendChild(actions);
  }
  function renderQuick() {
    const box = $("#feedbackQuick");
    const quick = feedbackState.quick;
    if (!quick) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    if (quick.index >= quick.queue.length) {
      box.textContent = "";
      const heading = document.createElement("h2");
      heading.textContent = "\u5F85\u5BA1\u6838\u961F\u5217\u5DF2\u6E05\u7A7A";
      box.appendChild(heading);
      const text = document.createElement("p");
      text.className = "ok-text";
      text.textContent = "\u6240\u6709\u5F85\u5BA1\u6838\u8BC4\u8BBA\u90FD\u5904\u7406\u5B8C\u4E86\u3002";
      box.appendChild(text);
      const quit = document.createElement("button");
      quit.type = "button";
      quit.className = "secondary small";
      quit.textContent = "\u8FD4\u56DE\u5217\u8868";
      quit.addEventListener("click", () => {
        feedbackState.quick = null;
        box.classList.add("hidden");
        loadComments();
      });
      box.appendChild(quit);
      return;
    }
    quickCard(quick.queue[quick.index], quick.index, quick.queue.length);
  }
  $("#feedbackQuickStart").addEventListener("click", async () => {
    hideError($("#feedbackError"));
    try {
      const [paragraph, article] = await Promise.all([
        apiGet("/api/feedback/comments?status=pending&scope=paragraph&page=1"),
        apiGet("/api/feedback/comments?status=pending&scope=article&page=1")
      ]);
      const queue = [...paragraph.comments || [], ...article.comments || []];
      feedbackState.quick = { queue, index: 0 };
      renderQuick();
    } catch (error) {
      if (error.code === "not-logged-in") {
        feedbackState.loggedIn = false;
        renderFeedbackPanels();
      }
      showError($("#feedbackError"), error.message);
    }
  });
  async function loadFeedback() {
    hideError($("#feedbackError"));
    clearTimeout(feedbackState.serviceTimer);
    const payload = await refreshFeedbackStatus();
    if (payload && payload.service.running && payload.loggedIn) {
      prepareFeedbackFilters();
      loadComments();
    }
  }
  async function loadFeedbackCard() {
    var _a, _b;
    const card = $("#feedbackCard");
    const body = $("#feedbackCardBody");
    body.textContent = "";
    try {
      const [statusPayload, notesPayload] = await Promise.all([
        apiGet("/api/feedback/status"),
        apiGet("/api/notes/summary")
      ]);
      card.classList.remove("hidden");
      const summary = notesPayload.summary || { totalDraft: 0 };
      if (!statusPayload.service.running) {
        const text = document.createElement("p");
        text.className = "meta-text";
        text.textContent = "\u8BC4\u8BBA\u670D\u52A1\u672A\u8FD0\u884C\u3002";
        body.appendChild(text);
        const start = document.createElement("button");
        start.type = "button";
        start.className = "primary small";
        start.textContent = "\u542F\u52A8";
        const statusText = document.createElement("span");
        statusText.className = "preview-status";
        start.addEventListener("click", async () => {
          start.disabled = true;
          statusText.textContent = "\u6B63\u5728\u542F\u52A8\uFF08\u9996\u6B21\u9700\u6784\u5EFA\uFF0C\u8BF7\u8010\u5FC3\u7B49\u5F85\uFF09\u2026";
          try {
            await api("/api/feedback/service", { action: "start" });
            pollFeedbackService(Date.now() + 18e4);
            setTimeout(loadFeedbackCard, 5e3);
          } catch (error) {
            start.disabled = false;
            statusText.textContent = error.message;
          }
        });
        body.appendChild(start);
        body.appendChild(statusText);
      } else if (!statusPayload.loggedIn) {
        const text = document.createElement("p");
        text.className = "meta-text";
        if (statusPayload.authMode === "local-bootstrap") {
          const upstream = statusPayload.upstream || {};
          if (!upstream.credentialsConfigured) {
            text.textContent = "\u672C\u673A\u6388\u6743\u5C1A\u672A\u914D\u7F6E\u3002\u8BF7\u5148\u8FD0\u884C npm run studio:setup\u3002";
          } else if (statusPayload.upstreamError) {
            text.textContent = `\u4E0A\u6E38\u8BA4\u8BC1\u5931\u8D25\uFF1A${statusPayload.upstreamError}`;
          } else {
            text.textContent = "\u8BC4\u8BBA\u670D\u52A1\u8FD0\u884C\u4E2D\uFF0C\u6B63\u5728\u7B49\u5F85\u672C\u673A\u6388\u6743\u2026";
          }
          body.appendChild(text);
        } else {
          text.textContent = "\u8BC4\u8BBA\u670D\u52A1\u8FD0\u884C\u4E2D\uFF0C\u5C1A\u672A\u767B\u5F55\u3002";
          body.appendChild(text);
          const link = document.createElement("a");
          link.className = "button primary small";
          link.href = "#/feedback";
          link.textContent = "\u767B\u5F55";
          body.appendChild(link);
        }
      } else {
        const stats = statusPayload.stats || {};
        const text = document.createElement("p");
        text.className = "meta-text";
        text.textContent = `\u5F85\u5BA1\u6838\u6BB5\u8BC4 ${(_a = stats.paragraphPending) != null ? _a : 0} \xB7 \u5F85\u5BA1\u6838\u7AE0\u8BC4 ${(_b = stats.articlePending) != null ? _b : 0} \xB7 \u4F5C\u8005\u8BC4\u8349\u7A3F ${summary.totalDraft}`;
        body.appendChild(text);
        const link = document.createElement("a");
        link.className = "button secondary small";
        link.href = "#/feedback";
        link.textContent = "\u8FDB\u5165\u9605\u8BFB\u53CD\u9988";
        body.appendChild(link);
      }
      if (!statusPayload.loggedIn && summary.totalDraft > 0) {
        const drafts = document.createElement("p");
        drafts.className = "meta-text";
        drafts.textContent = `\u4F5C\u8005\u8BC4\u8349\u7A3F ${summary.totalDraft} \u6761\uFF08\u7F16\u8F91\u9875\u300C\u4F5C\u8005\u8BC4\u300D\u9762\u677F\u7BA1\u7406\uFF09\u3002`;
        body.appendChild(drafts);
      }
      if (summary.brokenPublished > 0) {
        const broken = document.createElement("p");
        broken.className = "warning-text";
        broken.textContent = `\u5931\u6548\u6279\u6CE8 ${summary.brokenPublished} \u6761\uFF1A\u5DF2\u53D1\u5E03\u4F46\u5BF9\u5E94\u6BB5\u843D\u5DF2\u4E0D\u5B58\u5728\uFF0C\u53D1\u5E03\u524D\u68C0\u67E5\u4F1A\u88AB\u963B\u65AD\uFF0C\u8BF7\u5728\u7F16\u8F91\u9875\u300C\u4F5C\u8005\u8BC4\u300D\u9762\u677F\u5904\u7406\u3002`;
        body.appendChild(broken);
      }
    } catch (error) {
      card.classList.add("hidden");
    }
  }

  // studio/app/home.mjs
  function typeLabel(article) {
    if (article.section === "works") return article.collectionTitle || article.collectionSlug || "\u4F5C\u54C1";
    return SECTION_LABELS[article.section] || article.section;
  }
  function formatDate(value) {
    return value ? String(value).slice(0, 10) : "\u2014";
  }
  function articleCard(article, snippet) {
    const card = document.createElement("article");
    card.className = "article-card";
    const head = document.createElement("div");
    head.className = "article-head";
    const title = document.createElement("h3");
    title.textContent = article.subtitle ? `${article.title} \xB7 ${article.subtitle}` : article.title || "\uFF08\u672A\u547D\u540D\uFF09";
    head.appendChild(title);
    const badges = document.createElement("span");
    badges.className = "badges";
    const status = document.createElement("span");
    status.className = article.draft ? "badge badge-draft" : "badge badge-published";
    status.textContent = article.draft ? "\u8349\u7A3F" : "\u5DF2\u53D1\u5E03";
    badges.appendChild(status);
    const type = document.createElement("span");
    type.className = "badge badge-type";
    type.textContent = typeLabel(article);
    badges.appendChild(type);
    head.appendChild(badges);
    card.appendChild(head);
    const meta = document.createElement("p");
    meta.className = "meta-text";
    meta.textContent = `\u7EA6 ${article.wordCount} \u5B57 \xB7 \u53D1\u5E03 ${formatDate(article.date)} \xB7 \u6700\u540E\u4FEE\u6539 ${formatDate(article.lastmod) || formatDate(article.modified)}`;
    card.appendChild(meta);
    if (article.missingAnchors > 0) {
      const warn = document.createElement("p");
      warn.className = "warning-text";
      warn.textContent = `\u6709 ${article.missingAnchors} \u4E2A\u81EA\u7136\u6BB5\u7F3A\u5C11\u6BB5\u8BC4\u951A\u70B9\uFF0C\u4FDD\u5B58\u4E00\u6B21\u5373\u53EF\u81EA\u52A8\u8865\u9F50\u3002`;
      card.appendChild(warn);
    }
    if (snippet) {
      const snip = document.createElement("p");
      snip.className = "snippet";
      snip.textContent = snippet;
      card.appendChild(snip);
    }
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const edit = document.createElement("a");
    edit.className = "button primary small";
    edit.href = `#/edit?path=${encodeURIComponent(article.path)}`;
    edit.textContent = "\u7F16\u8F91";
    actions.appendChild(edit);
    const history = document.createElement("a");
    history.className = "button secondary small";
    history.href = `#/history?path=${encodeURIComponent(article.path)}`;
    history.textContent = "\u7248\u672C";
    actions.appendChild(history);
    const preview = document.createElement("button");
    preview.className = "secondary small";
    preview.type = "button";
    preview.textContent = "\u9884\u89C8";
    const statusText = document.createElement("span");
    statusText.className = "preview-status";
    preview.addEventListener("click", async () => {
      statusText.textContent = "\u6B63\u5728\u6253\u5F00\u2026";
      try {
        await api("/api/article/open-page", { path: article.path });
        statusText.textContent = "\u5DF2\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u3002";
      } catch (error) {
        statusText.textContent = error.message;
      }
    });
    actions.appendChild(preview);
    const folder = document.createElement("button");
    folder.className = "secondary small";
    folder.type = "button";
    folder.textContent = "\u6253\u5F00\u76EE\u5F55";
    folder.addEventListener("click", async () => {
      try {
        await api("/api/system/open-folder", { path: article.path });
      } catch (error) {
        globalError(error.message);
      }
    });
    actions.appendChild(folder);
    actions.appendChild(statusText);
    card.appendChild(actions);
    return card;
  }
  function renderGroups() {
    const container = $("#articleGroups");
    container.textContent = "";
    if (!state.articles.length) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = "\u8FD8\u6CA1\u6709\u6587\u7AE0\u3002\u53EF\u4EE5\u65B0\u5EFA\u6587\u7AE0\uFF0C\u6216\u4ECE Word \u5BFC\u5165\u3002";
      container.appendChild(empty);
      return;
    }
    const groups = /* @__PURE__ */ new Map();
    for (const article of state.articles) {
      const key = article.section === "works" ? `works:${article.collectionSlug}` : article.section;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(article);
    }
    for (const [key, items] of groups) {
      const section = document.createElement("section");
      section.className = "article-group";
      const heading = document.createElement("h2");
      if (key.startsWith("works:")) {
        heading.textContent = `\u6587\u96C6 \xB7 ${items[0].collectionTitle || items[0].collectionSlug}`;
      } else {
        heading.textContent = SECTION_LABELS[key] || key;
      }
      section.appendChild(heading);
      const drafts = items.filter((item) => item.draft);
      const published = items.filter((item) => !item.draft);
      for (const article of [...drafts, ...published]) {
        section.appendChild(articleCard(article));
      }
      container.appendChild(section);
    }
  }
  function renderSearchResults() {
    const box = $("#searchResults");
    const groups = $("#articleGroups");
    const results = state.searchResults;
    if (results === null) {
      box.classList.add("hidden");
      groups.classList.remove("hidden");
      return;
    }
    groups.classList.add("hidden");
    box.classList.remove("hidden");
    box.textContent = "";
    const title = document.createElement("h2");
    title.textContent = `\u201C${state.searchQuery}\u201D\u7684\u641C\u7D22\u7ED3\u679C\uFF08${results.length} \u7BC7\uFF09`;
    box.appendChild(title);
    if (!results.length) return;
    for (const item of results) {
      box.appendChild(articleCard(item, item.snippet || ""));
    }
  }
  var runSearch = debounce(async () => {
    const query = state.searchQuery.trim();
    if (!query) {
      state.searchResults = null;
      renderSearchResults();
      return;
    }
    try {
      const payload = await apiGet(`/api/articles/search?q=${encodeURIComponent(query)}`);
      state.searchResults = payload.results;
      renderSearchResults();
    } catch (error) {
      globalError(error.message);
    }
  }, 300);
  async function refreshPreviewStatus() {
    const status = $("#homePreviewStatus");
    try {
      const payload = await apiGet("/api/system/status");
      if (payload.workspace) {
        $("#workspaceTarget").textContent = payload.workspace.label;
        $("#workspaceTarget").dataset.mode = payload.workspace.mode;
        $("#workspaceTarget").title = `\u5185\u5BB9\u63D0\u4EA4\u76EE\u6807\uFF1A${payload.workspace.contentRepoRoot}
\u5E73\u53F0\u4EE3\u7801\uFF1A${payload.workspace.platformRoot}`;
      }
      status.textContent = payload.preview.running ? `\u9884\u89C8\u8FD0\u884C\u4E2D\uFF1A${payload.preview.url}` : "";
      window.studioDeployDisabled = payload.deployDisabled === true;
      if (window.studioDeployDisabled) {
        const banner = document.getElementById("deployDevBanner");
        if (banner) banner.classList.remove("hidden");
      }
    } catch (error) {
      status.textContent = "";
    }
  }
  async function loadHome() {
    try {
      const payload = await apiGet("/api/articles");
      state.articles = payload.articles;
      renderGroups();
      if (state.searchQuery.trim()) runSearch();
    } catch (error) {
      globalError(error.message);
    }
    refreshPreviewStatus();
    loadFeedbackCard();
  }
  $("#searchInput").addEventListener("input", () => {
    state.searchQuery = $("#searchInput").value;
    runSearch();
  });
  $("#homePreviewBtn").addEventListener("click", async () => {
    const status = $("#homePreviewStatus");
    status.textContent = "\u6B63\u5728\u542F\u52A8\u2026";
    try {
      const payload = await api("/api/system/preview", { action: "start" });
      status.textContent = payload.preview.running ? `\u9884\u89C8\u8FD0\u884C\u4E2D\uFF1A${payload.preview.url}` : "\u9884\u89C8\u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF0C\u8BF7\u68C0\u67E5 1313 \u7AEF\u53E3\u3002";
    } catch (error) {
      status.textContent = error.message;
    }
  });
  var slugTouched = false;
  var suggestSlug = debounce(async () => {
    const form2 = $("#newForm");
    if (slugTouched || !form2.title.value.trim()) return;
    try {
      const payload = await apiGet(`/api/articles/suggest-slug?title=${encodeURIComponent(form2.title.value.trim())}`);
      if (!slugTouched && payload.slug) form2.slug.value = payload.slug;
    } catch (error) {
    }
  }, 400);
  function toggleNewCollectionFields() {
    const form2 = $("#newForm");
    $("#newCollectionFields").classList.toggle("hidden", form2.section.value !== "works");
  }
  function prepareNewForm() {
    const form2 = $("#newForm");
    if (!form2.title.value) slugTouched = false;
    toggleNewCollectionFields();
    const select = form2.collectionExisting;
    if (select.options.length) return;
    const fill = async () => {
      try {
        const payload = await apiGet("/api/articles");
        const seen = /* @__PURE__ */ new Map();
        for (const article of payload.articles) {
          if (article.section === "works" && article.collectionSlug) {
            seen.set(article.collectionSlug, article.collectionTitle || article.collectionSlug);
          }
        }
        select.textContent = "";
        for (const [slug, title] of seen) {
          const option = document.createElement("option");
          option.value = slug;
          option.textContent = title;
          select.appendChild(option);
        }
        const fresh = document.createElement("option");
        fresh.value = "";
        fresh.textContent = "\u2014\u2014 \u65B0\u6587\u96C6 \u2014\u2014";
        select.appendChild(fresh);
        select.value = [...seen.keys()][0] || "";
        toggleNewCollectionName();
      } catch (error) {
        globalError(error.message);
      }
    };
    fill();
  }
  function toggleNewCollectionName() {
    const form2 = $("#newForm");
    $("#newCollectionNameWrap").classList.toggle("hidden", Boolean(form2.collectionExisting.value));
  }
  $("#newForm").title.addEventListener("input", suggestSlug);
  $("#newForm").slug.addEventListener("input", () => {
    slugTouched = true;
  });
  $("#newForm").section.addEventListener("change", toggleNewCollectionFields);
  $("#newForm").collectionExisting.addEventListener("change", toggleNewCollectionName);
  $("#newForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    hideError($("#newError"));
    const form2 = event.target;
    const fields = {
      title: form2.title.value.trim(),
      subtitle: form2.subtitle.value.trim(),
      section: form2.section.value,
      slug: form2.slug.value.trim(),
      collectionSlug: "",
      collectionTitle: ""
    };
    if (!fields.title) {
      showError($("#newError"), "\u8BF7\u586B\u5199\u6807\u9898\u3002");
      return;
    }
    if (!SLUG_PATTERN.test(fields.slug)) {
      showError($("#newError"), "slug \u53EA\u80FD\u4F7F\u7528\u5C0F\u5199\u82F1\u6587\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u8FDE\u5B57\u7B26\uFF0C\u4E14\u4E0D\u80FD\u4EE5\u8FDE\u5B57\u7B26\u5F00\u5934\u6216\u7ED3\u5C3E\u3002");
      return;
    }
    if (fields.section === "works") {
      fields.collectionSlug = form2.collectionExisting.value.trim();
      if (!fields.collectionSlug) {
        fields.collectionTitle = form2.collectionName.value.trim();
        if (!fields.collectionTitle) {
          showError($("#newError"), "\u65B0\u5EFA\u6587\u96C6\u5FC5\u987B\u586B\u5199\u6587\u96C6\u540D\u79F0\u3002");
          return;
        }
        try {
          const payload = await apiGet(`/api/articles/suggest-slug?title=${encodeURIComponent(fields.collectionTitle)}`);
          fields.collectionSlug = payload.slug || "";
        } catch (error) {
          fields.collectionSlug = "";
        }
        if (!SLUG_PATTERN.test(fields.collectionSlug)) {
          showError($("#newError"), "\u65E0\u6CD5\u4E3A\u6587\u96C6\u751F\u6210\u5408\u6CD5 slug\uFF0C\u8BF7\u6539\u9009\u65E2\u6709\u6587\u96C6\u6216\u8C03\u6574\u6587\u96C6\u540D\u79F0\u3002");
          return;
        }
      }
    }
    $("#newSubmit").disabled = true;
    try {
      const payload = await api("/api/article/new", fields);
      form2.reset();
      slugTouched = false;
      location.hash = `#/edit?path=${encodeURIComponent(payload.article.path)}`;
    } catch (error) {
      showError($("#newError"), error.message);
    } finally {
      $("#newSubmit").disabled = false;
    }
  });

  // studio/app/diff.mjs
  var DIFF_ANCHOR = /<!--\s*\/?\s*paragraph-id/;
  function parseUnifiedDiff(text) {
    const files = [];
    let current = null;
    let hunk = null;
    for (const line of String(text || "").split("\n")) {
      if (line.startsWith("diff --git ")) {
        const matched = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
        current = { name: matched ? matched[2] : line.slice(11), hunks: [] };
        files.push(current);
        hunk = null;
      } else if (line.startsWith("@@")) {
        const matched = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        hunk = { at: matched ? Number(matched[1]) : 0, lines: [] };
        if (current) current.hunks.push(hunk);
      } else if (hunk && /^[ +\\-]/.test(line)) {
        hunk.lines.push(line);
      }
    }
    return files;
  }
  function diffLineElement(line) {
    const element = document.createElement("div");
    element.className = "diff-line";
    const sign = line[0];
    if (sign === "+") element.classList.add("diff-add");
    else if (sign === "-") element.classList.add("diff-del");
    else if (sign === "\\") element.classList.add("diff-meta");
    element.textContent = line;
    return element;
  }
  function renderDiff(container, diffText, note) {
    container.textContent = "";
    container.classList.remove("hidden");
    if (note) {
      const hint = document.createElement("p");
      hint.className = "meta-text";
      hint.textContent = note;
      container.appendChild(hint);
    }
    if (!diffText || !diffText.trim()) {
      if (!note) {
        const empty = document.createElement("p");
        empty.className = "meta-text";
        empty.textContent = "\u6CA1\u6709\u5DEE\u5F02\u3002";
        container.appendChild(empty);
      }
      return;
    }
    const files = parseUnifiedDiff(diffText);
    for (const file of files) {
      const fileBox = document.createElement("div");
      fileBox.className = "diff-file";
      const name = document.createElement("div");
      name.className = "diff-file-name";
      name.textContent = file.name;
      fileBox.appendChild(name);
      for (const hunk of file.hunks) {
        const label = document.createElement("div");
        label.className = "diff-hunk";
        label.textContent = hunk.at ? `\u7B2C ${hunk.at} \u884C\u9644\u8FD1` : "\uFF08\u4F4D\u7F6E\u672A\u77E5\uFF09";
        fileBox.appendChild(label);
        let anchorRun = [];
        const flushAnchors = () => {
          if (!anchorRun.length) return;
          const hidden = anchorRun.map((line) => {
            const element = diffLineElement(line);
            element.classList.add("hidden");
            return element;
          });
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "diff-anchor-toggle";
          toggle.textContent = `\u6BB5\u8BC4\u951A\u70B9\uFF08\u5DF2\u9690\u85CF \xD7${anchorRun.length}\uFF09`;
          toggle.addEventListener("click", () => {
            const collapsed = hidden[0].classList.contains("hidden");
            hidden.forEach((element) => element.classList.toggle("hidden", !collapsed));
            toggle.textContent = collapsed ? `\u6BB5\u8BC4\u951A\u70B9\uFF08\u70B9\u51FB\u6298\u53E0 \xD7${anchorRun.length}\uFF09` : `\u6BB5\u8BC4\u951A\u70B9\uFF08\u5DF2\u9690\u85CF \xD7${anchorRun.length}\uFF09`;
          });
          fileBox.appendChild(toggle);
          hidden.forEach((element) => fileBox.appendChild(element));
          anchorRun = [];
        };
        for (const line of hunk.lines) {
          if (DIFF_ANCHOR.test(line.slice(1))) {
            anchorRun.push(line);
          } else {
            flushAnchors();
            fileBox.appendChild(diffLineElement(line));
          }
        }
        flushAnchors();
      }
      container.appendChild(fileBox);
    }
    const rawToggle = document.createElement("button");
    rawToggle.type = "button";
    rawToggle.className = "secondary small";
    rawToggle.textContent = "\u663E\u793A\u5B8C\u6574\u539F\u59CB diff";
    const raw = document.createElement("pre");
    raw.className = "log-box hidden";
    raw.textContent = diffText;
    rawToggle.addEventListener("click", () => {
      const show = raw.classList.contains("hidden");
      raw.classList.toggle("hidden", !show);
      rawToggle.textContent = show ? "\u9690\u85CF\u5B8C\u6574\u539F\u59CB diff" : "\u663E\u793A\u5B8C\u6574\u539F\u59CB diff";
    });
    container.appendChild(rawToggle);
    container.appendChild(raw);
  }

  // studio/app/versions.mjs
  var STATUS_LABELS = { M: "\u4FEE\u6539", A: "\u65B0\u589E", D: "\u5220\u9664", R: "\u6539\u540D", U: "\u51B2\u7A81", "?": "\u672A\u8DDF\u8E2A", T: "\u7C7B\u578B\u53D8\u66F4", C: "\u590D\u5236" };
  function statusLabel(status) {
    return STATUS_LABELS[status] || (status.length > 1 ? STATUS_LABELS[status[0]] || status : status);
  }
  function renderVersionsStatus(status) {
    const info = $("#versionsRepoInfo");
    info.textContent = "";
    const rows = [
      ["\u5206\u652F", status.branch || "\u2014"],
      ["\u72B6\u6001", status.clean ? "\u5E72\u51C0\uFF08\u6CA1\u6709\u672A\u63D0\u4EA4\u7684\u4FEE\u6539\uFF09" : `${status.files.length} \u4E2A\u672A\u63D0\u4EA4\u6587\u4EF6`]
    ];
    rows.forEach(([key, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      info.appendChild(dt);
      info.appendChild(dd);
    });
    const filesBox = $("#versionsFiles");
    filesBox.textContent = "";
    $("#versionsClean").classList.toggle("hidden", !status.clean);
    $("#versionsCommitBox").classList.toggle("hidden", Boolean(status.clean));
    $("#versionsConfirm").classList.add("hidden");
    $("#versionsCommitStatus").textContent = "";
    if (status.clean) return;
    const table = document.createElement("table");
    table.className = "file-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["", "\u8DEF\u5F84", "\u72B6\u6001", "\u4FEE\u6539\u65F6\u95F4"].forEach((text) => {
      const cell = document.createElement("th");
      cell.textContent = text;
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    for (const file of status.files) {
      const row = document.createElement("tr");
      const checkCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.path = file.path;
      checkCell.appendChild(checkbox);
      row.appendChild(checkCell);
      const pathCell = document.createElement("td");
      pathCell.className = "file-path";
      pathCell.textContent = file.originalPath ? `${file.originalPath} \u2192 ${file.path}` : file.path;
      row.appendChild(pathCell);
      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `badge badge-status-${file.status === "?" ? "new" : "mod"}`;
      badge.textContent = `${statusLabel(file.status)} ${file.status}`;
      statusCell.appendChild(badge);
      row.appendChild(statusCell);
      const timeCell = document.createElement("td");
      timeCell.className = "meta-text";
      timeCell.textContent = file.mtime ? file.mtime.replace("T", " ") : "\u2014";
      row.appendChild(timeCell);
      body.appendChild(row);
    }
    table.appendChild(body);
    filesBox.appendChild(table);
    $("#versionsMessage").value = status.suggestion || "";
  }
  function renderCommitList2(container, commits, emptyText) {
    container.textContent = "";
    if (!commits.length) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "commit-list";
    for (const commit of commits) {
      const item = document.createElement("li");
      const hash = document.createElement("code");
      hash.textContent = commit.short;
      const date = document.createElement("span");
      date.className = "meta-text";
      date.textContent = ` ${String(commit.date).slice(0, 10)} `;
      const subject = document.createElement("span");
      subject.textContent = commit.subject;
      item.appendChild(hash);
      item.appendChild(date);
      item.appendChild(subject);
      list.appendChild(item);
    }
    container.appendChild(list);
  }
  async function loadVersions() {
    hideError($("#versionsError"));
    try {
      const [statusPayload, logPayload] = await Promise.all([
        apiGet("/api/git/status"),
        apiGet("/api/git/log")
      ]);
      $("#versionsContent").classList.remove("hidden");
      renderVersionsStatus(statusPayload.status);
      renderCommitList2($("#versionsLog"), logPayload.commits, "\u4ED3\u5E93\u8FD8\u6CA1\u6709\u4EFB\u4F55\u63D0\u4EA4\u3002");
    } catch (error) {
      $("#versionsContent").classList.add("hidden");
      showError($("#versionsError"), error.message);
    }
  }
  $("#versionsCommitBtn").addEventListener("click", () => {
    const message = $("#versionsMessage").value.trim();
    if (!message) {
      $("#versionsCommitStatus").textContent = "\u8BF7\u586B\u5199\u63D0\u4EA4\u4FE1\u606F\u3002";
      return;
    }
    const checked = $$("#versionsFiles input[type=checkbox]:checked");
    if (!checked.length) {
      $("#versionsCommitStatus").textContent = "\u8BF7\u5148\u52FE\u9009\u8981\u63D0\u4EA4\u7684\u6587\u4EF6\u3002";
      return;
    }
    $("#versionsCommitStatus").textContent = "";
    $("#versionsConfirm").classList.remove("hidden");
  });
  $("#versionsConfirmNo").addEventListener("click", () => $("#versionsConfirm").classList.add("hidden"));
  $("#versionsConfirmYes").addEventListener("click", async () => {
    $("#versionsConfirm").classList.add("hidden");
    const files = $$("#versionsFiles input[type=checkbox]:checked").map((box) => box.dataset.path);
    const message = $("#versionsMessage").value.trim();
    const status = $("#versionsCommitStatus");
    status.textContent = "\u6B63\u5728\u63D0\u4EA4\u2026";
    $("#versionsConfirmYes").disabled = true;
    try {
      const payload = await api("/api/git/commit", { files, message });
      status.textContent = `\u5DF2\u521B\u5EFA\u63D0\u4EA4 ${payload.commit.short}\uFF1A${payload.commit.subject}`;
      await loadVersions();
    } catch (error) {
      status.textContent = "\u63D0\u4EA4\u5931\u8D25";
      showError($("#versionsError"), error.message);
    } finally {
      $("#versionsConfirmYes").disabled = false;
    }
  });
  var historyState = { path: "" };
  function renderHistoryLog(commits) {
    const container = $("#historyLog");
    container.textContent = "";
    if (!commits.length) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = "\u8FD9\u7BC7\u6587\u7AE0\u8FD8\u6CA1\u6709\u63D0\u4EA4\u5386\u53F2\uFF08\u53EF\u80FD\u5C1A\u672A\u63D0\u4EA4\u8FC7\uFF09\u3002";
      container.appendChild(empty);
      return;
    }
    for (const commit of commits) {
      const row = document.createElement("div");
      row.className = "history-row";
      const head = document.createElement("div");
      head.className = "history-head";
      const hash = document.createElement("code");
      hash.textContent = commit.short;
      const date = document.createElement("span");
      date.className = "meta-text";
      date.textContent = ` ${String(commit.date).slice(0, 10)} `;
      const subject = document.createElement("span");
      subject.textContent = commit.subject;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "secondary small";
      toggle.textContent = "\u67E5\u770B\u53D8\u66F4";
      head.appendChild(hash);
      head.appendChild(date);
      head.appendChild(subject);
      head.appendChild(toggle);
      row.appendChild(head);
      const diffBox = document.createElement("div");
      diffBox.className = "diff-box hidden";
      row.appendChild(diffBox);
      let loaded = false;
      toggle.addEventListener("click", async () => {
        if (!diffBox.classList.contains("hidden")) {
          diffBox.classList.add("hidden");
          toggle.textContent = "\u67E5\u770B\u53D8\u66F4";
          return;
        }
        if (!loaded) {
          toggle.textContent = "\u6B63\u5728\u52A0\u8F7D\u2026";
          try {
            const payload = await apiGet(
              `/api/git/diff?path=${encodeURIComponent(historyState.path)}&ref=${encodeURIComponent(commit.hash)}`
            );
            renderDiff(diffBox, payload.result.diff, payload.result.note);
            loaded = true;
          } catch (error) {
            diffBox.textContent = error.message;
            diffBox.classList.remove("hidden");
          }
        }
        diffBox.classList.remove("hidden");
        toggle.textContent = "\u6536\u8D77\u53D8\u66F4";
      });
      container.appendChild(row);
    }
  }
  async function loadHistory(path) {
    historyState.path = path;
    hideError($("#historyError"));
    $("#historyDiff").classList.add("hidden");
    $("#historyDiff").textContent = "";
    $("#historyTitle").textContent = path ? `\u7248\u672C\u5386\u53F2\uFF1A${path}` : "\u7248\u672C\u5386\u53F2";
    $("#historyLog").textContent = "";
    if (!path) {
      showError($("#historyError"), "\u7F3A\u5C11\u6587\u7AE0\u8DEF\u5F84\u3002");
      return;
    }
    try {
      const payload = await apiGet(`/api/git/log?path=${encodeURIComponent(path)}`);
      renderHistoryLog(payload.commits);
    } catch (error) {
      showError($("#historyError"), error.message);
    }
  }
  $("#historyWorktree").addEventListener("click", async () => {
    if (!historyState.path) return;
    hideError($("#historyError"));
    const box = $("#historyDiff");
    box.classList.remove("hidden");
    box.textContent = "\u6B63\u5728\u52A0\u8F7D\u2026";
    try {
      const payload = await apiGet(`/api/git/diff?path=${encodeURIComponent(historyState.path)}`);
      renderDiff(box, payload.result.diff, payload.result.note || "\u5F53\u524D\u76F8\u5BF9\u6700\u8FD1\u4E00\u6B21\u63D0\u4EA4\u7684\u672A\u63D0\u4EA4\u4FEE\u6539\uFF1A");
    } catch (error) {
      box.classList.add("hidden");
      showError($("#historyError"), error.message);
    }
  });

  // studio/app/publish.mjs
  function renderPublishStatus(status) {
    const info = $("#publishInfo");
    info.textContent = "";
    const settings = status.settings || {};
    const missing = [];
    if (!settings.hasSshTarget) missing.push("WRITING_SSH_TARGET");
    if (!settings.hasDomain) missing.push("WRITING_DOMAIN");
    const rows = [
      ["\u672C\u5730\u7248\u672C", status.version ? `V${status.version}` : "\u2014"],
      [
        "\u670D\u52A1\u5668\u914D\u7F6E",
        settings.configured ? "\u5DF2\u914D\u7F6E\uFF08.author-settings\uFF0C\u503C\u4E0D\u4F1A\u663E\u793A\uFF09" : settings.filePresent ? `\u672A\u914D\u7F6E\u5B8C\u6574\uFF1A\u7F3A\u5C11 ${missing.join("\u3001")}` : "\u672A\u914D\u7F6E\uFF08\u7F3A\u5C11 .author-settings \u6587\u4EF6\uFF09"
      ]
    ];
    rows.forEach(([key, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      info.appendChild(dt);
      info.appendChild(dd);
    });
    const changelog = $("#publishChangelog");
    changelog.textContent = "";
    if (!status.changelog || !status.changelog.length) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = "CHANGELOG.md \u4E2D\u8FD8\u6CA1\u6709\u53D1\u5E03\u8BB0\u5F55\u3002";
      changelog.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "commit-list";
      status.changelog.forEach((entry) => {
        const item = document.createElement("li");
        const version = document.createElement("strong");
        version.textContent = entry.version;
        item.appendChild(version);
        if (entry.date) {
          const date = document.createElement("span");
          date.className = "meta-text";
          date.textContent = ` ${entry.date} `;
          item.appendChild(date);
        }
        const title = document.createElement("span");
        title.textContent = entry.title ? ` ${entry.title}` : "";
        item.appendChild(title);
        list.appendChild(item);
      });
      changelog.appendChild(list);
    }
    renderCommitList($("#publishCommits"), status.commits || [], status.gitError || "\u6CA1\u6709\u63D0\u4EA4\u8BB0\u5F55\u3002");
  }
  async function loadPublish() {
    hideError($("#publishError"));
    $("#publishRunBtn").disabled = true;
    $("#publishConfirm").classList.add("hidden");
    $("#preflightStatus").textContent = "";
    $("#publishRunStatus").textContent = "";
    try {
      const payload = await apiGet("/api/publish/status");
      renderPublishStatus(payload.status);
    } catch (error) {
      showError($("#publishError"), error.message);
    }
  }
  $("#preflightBtn").addEventListener("click", async () => {
    hideError($("#publishError"));
    const button = $("#preflightBtn");
    const status = $("#preflightStatus");
    const full = $("#preflightFull").checked;
    button.disabled = true;
    status.textContent = full ? "\u6B63\u5728\u8FD0\u884C\u5B8C\u6574\u68C0\u67E5\uFF08\u53EF\u80FD\u6570\u5206\u949F\uFF09\u2026" : "\u6B63\u5728\u8FD0\u884C\u53D1\u5E03\u524D\u68C0\u67E5\u2026";
    $("#preflightLog").classList.add("hidden");
    try {
      const payload = await api("/api/publish/preflight", { full });
      const log = $("#preflightLog");
      log.textContent = payload.preflight.output || "\uFF08\u65E0\u8F93\u51FA\uFF09";
      log.classList.remove("hidden");
      if (payload.preflight.success) {
        status.textContent = `\u68C0\u67E5\u901A\u8FC7\uFF08${payload.preflight.script}\uFF0C\u8017\u65F6 ${payload.preflight.duration} \u79D2\uFF09\uFF0C30 \u5206\u949F\u5185\u53EF\u53D1\u5E03\u3002`;
        $("#publishRunBtn").disabled = false;
      } else {
        status.textContent = `\u68C0\u67E5\u672A\u901A\u8FC7\uFF08${payload.preflight.script}\uFF09\uFF0C\u8BF7\u6839\u636E\u65E5\u5FD7\u4FEE\u590D\u540E\u91CD\u8BD5\u3002`;
        $("#publishRunBtn").disabled = true;
      }
    } catch (error) {
      status.textContent = "\u68C0\u67E5\u8FD0\u884C\u5931\u8D25";
      showError($("#publishError"), error.message);
      $("#publishRunBtn").disabled = true;
    } finally {
      button.disabled = false;
    }
  });
  $("#publishRunBtn").addEventListener("click", () => {
    $("#publishConfirm").classList.remove("hidden");
  });
  $("#publishConfirmNo").addEventListener("click", () => $("#publishConfirm").classList.add("hidden"));
  $("#publishConfirmYes").addEventListener("click", async () => {
    $("#publishConfirm").classList.add("hidden");
    hideError($("#publishError"));
    const button = $("#publishRunBtn");
    const status = $("#publishRunStatus");
    button.disabled = true;
    status.textContent = "\u6B63\u5728\u53D1\u5E03\uFF08\u6784\u5EFA\u3001\u5907\u4EFD\u3001\u4E0A\u4F20\uFF0C\u53EF\u80FD\u9700\u8981\u51E0\u5206\u949F\uFF09\u2026";
    $("#publishLog").classList.add("hidden");
    try {
      const payload = await api("/api/publish/run", { confirm: true });
      const log = $("#publishLog");
      log.textContent = payload.publish.output || "\uFF08\u65E0\u8F93\u51FA\uFF09";
      log.classList.remove("hidden");
      if (payload.publish.success) {
        status.textContent = `\u53D1\u5E03\u6210\u529F\uFF08\u8017\u65F6 ${payload.publish.duration} \u79D2\uFF09\u3002`;
      } else {
        status.textContent = "\u53D1\u5E03\u5931\u8D25\uFF0C\u8BF7\u6839\u636E\u65E5\u5FD7\u6392\u67E5\uFF1B\u670D\u52A1\u5668\u53EF\u80FD\u4ECD\u505C\u7559\u5728\u65E7\u7248\u672C\u3002";
      }
    } catch (error) {
      status.textContent = error.message;
      if (error.code === "preflight-required") {
        status.textContent = "\u53D1\u5E03\u88AB\u62D2\u7EDD\uFF1A\u8BF7\u5148\u8FD0\u884C\u4E00\u6B21\u6210\u529F\u7684\u53D1\u5E03\u524D\u68C0\u67E5\uFF0830 \u5206\u949F\u5185\u6709\u6548\uFF09\u3002";
      }
    } finally {
      button.disabled = false;
    }
  });

  // studio/app/media.mjs
  async function copyText(text, statusEl) {
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = "\u5DF2\u590D\u5236\u3002";
    } catch (error) {
      statusEl.textContent = `\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u590D\u5236\uFF1A${text}`;
    }
  }
  function bundleReference(item) {
    if (item.articlePath && item.relPath.startsWith(item.articlePath.slice(0, -"index.md".length))) {
      return item.relPath.slice(item.articlePath.slice(0, -"index.md".length).length);
    }
    return item.relPath;
  }
  function mediaCard(item) {
    const card = document.createElement("div");
    card.className = "media-card";
    const img = document.createElement("img");
    img.src = `/api/media/file?path=${encodeURIComponent(item.relPath)}`;
    img.alt = item.name;
    img.loading = "lazy";
    card.appendChild(img);
    const name = document.createElement("p");
    name.className = "media-name";
    name.textContent = item.name;
    card.appendChild(name);
    const badges = document.createElement("p");
    badges.className = "badges";
    if (item.isCover) {
      const badge = document.createElement("span");
      badge.className = "badge badge-published";
      badge.textContent = "\u5C01\u9762";
      badges.appendChild(badge);
    }
    if (item.isOriginal) {
      const badge = document.createElement("span");
      badge.className = "badge badge-type";
      badge.textContent = "\u539F\u59CB\u56FE";
      badges.appendChild(badge);
    }
    if (badges.childNodes.length) card.appendChild(badges);
    const meta = document.createElement("p");
    meta.className = "meta-text";
    const dims = item.width && item.height ? `${item.width}\xD7${item.height} \xB7 ` : "";
    meta.textContent = `${dims}${describeSize(item.size)}`;
    card.appendChild(meta);
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const statusText = document.createElement("span");
    statusText.className = "preview-status";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary small";
    copy.textContent = "\u590D\u5236\u5F15\u7528";
    copy.addEventListener("click", () => {
      const alt = item.name.replace(/\.[^.]+$/, "");
      copyText(`![${alt}](${bundleReference(item)})`, statusText);
    });
    actions.appendChild(copy);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger small";
    remove.textContent = "\u5220\u9664";
    remove.addEventListener("click", async () => {
      if (!remove.dataset.armed) {
        remove.dataset.armed = "1";
        remove.textContent = "\u786E\u8BA4\u5220\u9664\uFF1F";
        statusText.textContent = "\u5C06\u79FB\u5165\u56DE\u6536\u7AD9\uFF08.cache/studio/trash/\uFF09\u3002";
        return;
      }
      remove.disabled = true;
      try {
        await api("/api/media/delete", { path: item.relPath });
        statusText.textContent = "\u5DF2\u79FB\u5165\u56DE\u6536\u7AD9\u3002";
        card.remove();
      } catch (error) {
        remove.disabled = false;
        remove.dataset.armed = "";
        remove.textContent = "\u5220\u9664";
        statusText.textContent = error.message;
      }
    });
    actions.appendChild(remove);
    actions.appendChild(statusText);
    card.appendChild(actions);
    return card;
  }
  function renderMediaGroups(items) {
    const container = $("#mediaGroups");
    container.textContent = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "meta-text";
      empty.textContent = "content/ \u91CC\u8FD8\u6CA1\u6709\u56FE\u7247\u3002\u53EF\u4EE5\u5728\u4E0A\u65B9\u9009\u62E9\u6587\u7AE0\u4E0A\u4F20\u3002";
      container.appendChild(empty);
      return;
    }
    const groups = /* @__PURE__ */ new Map();
    for (const item of items) {
      const key = item.articlePath || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [key, groupItems] of groups) {
      const section = document.createElement("section");
      section.className = "article-group";
      const heading = document.createElement("h2");
      heading.textContent = key ? `\u300A${groupItems[0].articleTitle || key}\u300B` : "\uFF08\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u6587\u7AE0\uFF09";
      section.appendChild(heading);
      const grid = document.createElement("div");
      grid.className = "media-grid";
      groupItems.forEach((item) => grid.appendChild(mediaCard(item)));
      section.appendChild(grid);
      container.appendChild(section);
    }
  }
  async function loadMedia() {
    hideError($("#mediaError"));
    try {
      const [mediaPayload, articlesPayload] = await Promise.all([
        apiGet("/api/media"),
        apiGet("/api/articles")
      ]);
      renderMediaGroups(mediaPayload.media);
      const select = $("#mediaArticleSelect");
      select.textContent = "";
      for (const article of articlesPayload.articles) {
        const option = document.createElement("option");
        option.value = article.path;
        option.textContent = `${article.title || article.slug}\uFF08${article.path}\uFF09`;
        select.appendChild(option);
      }
    } catch (error) {
      showError($("#mediaError"), error.message);
    }
  }
  $("#mediaFileInput").addEventListener("change", () => {
    $("#mediaUploadBtn").disabled = !$("#mediaFileInput").files.length;
  });
  $("#mediaUploadBtn").addEventListener("click", async () => {
    hideError($("#mediaError"));
    const file = $("#mediaFileInput").files[0];
    const articlePath = $("#mediaArticleSelect").value;
    const status = $("#mediaUploadStatus");
    if (!file || !articlePath) return;
    const form2 = new FormData();
    form2.append("articlePath", articlePath);
    form2.append("file", file, file.name);
    status.textContent = "\u6B63\u5728\u4E0A\u4F20\u2026";
    $("#mediaUploadBtn").disabled = true;
    try {
      const response = await fetch("/api/media/upload", {
        method: "POST",
        headers: { "X-Studio-Request": "1" },
        body: form2
      });
      const payload = await response.json();
      if (!payload.ok) {
        throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
      }
      status.textContent = "";
      const result = $("#mediaUploadResult");
      result.textContent = "";
      const text = document.createElement("p");
      text.textContent = `\u5DF2\u5199\u5165 ${payload.image.relPath}\uFF08${payload.image.width}\xD7${payload.image.height}\uFF09\uFF0C\u628A\u4E0B\u9762\u7684\u5F15\u7528\u7C98\u8D34\u5230\u7F16\u8F91\u5668\u6B63\u6587\u91CC\u5373\u53EF\uFF1A`;
      result.appendChild(text);
      const code = document.createElement("code");
      code.className = "media-markdown";
      code.textContent = payload.markdown;
      result.appendChild(code);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary small";
      copy.textContent = "\u590D\u5236\u5F15\u7528";
      const copyStatus = document.createElement("span");
      copyStatus.className = "preview-status";
      copy.addEventListener("click", () => copyText(payload.markdown, copyStatus));
      result.appendChild(copy);
      result.appendChild(copyStatus);
      (payload.warnings || []).forEach((warning) => {
        const line = document.createElement("p");
        line.className = "warning-text";
        line.textContent = warning;
        result.appendChild(line);
      });
      result.classList.remove("hidden");
      $("#mediaFileInput").value = "";
      loadMedia();
    } catch (error) {
      status.textContent = error.message;
      $("#mediaUploadBtn").disabled = false;
    }
  });

  // studio/app/router.mjs
  var revertHash = "";
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
  async function route() {
    const target = currentRoute();
    if (editState.dirty && !target.path.startsWith("/edit") && editState.path) {
      revertHash = `#/edit?path=${encodeURIComponent(editState.path)}`;
      location.hash = revertHash;
      $("#dirtyBar").classList.remove("hidden");
      return;
    }
    $("#dirtyBar").classList.add("hidden");
    if (target.path.startsWith("/edit")) {
      const path = target.params.get("path") || "";
      showView("edit");
      if (path && path !== editState.path) {
        await openEditor(path);
      }
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
    location.hash = "#/";
  });

  // studio/app/import-wizard.mjs
  function gotoStep(number) {
    $$("#view-import .panel").forEach((panel) => panel.classList.add("hidden"));
    $(`#step-${number}`).classList.remove("hidden");
    $$("#stepNav .step").forEach((button) => {
      const step = Number(button.dataset.step);
      button.classList.toggle("current", step === number);
      button.disabled = step > number;
    });
    globalError("");
    window.scrollTo({ top: 0 });
  }
  var dropzone = $("#dropzone");
  var fileInput = $("#fileInput");
  function describeSize2(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  function pickFile(file) {
    const info = $("#fileInfo");
    const button = $("#startParse");
    if (!file) {
      info.classList.add("hidden");
      button.disabled = true;
      state.file = null;
      return;
    }
    if (!file.name.toLowerCase().endsWith(".docx")) {
      info.textContent = "\u53EA\u63A5\u53D7 .docx \u6587\u4EF6\uFF08Word 2007 \u53CA\u4EE5\u540E\u7684\u65B0\u683C\u5F0F\uFF09\u3002";
      info.className = "file-info invalid";
      button.disabled = true;
      state.file = null;
      return;
    }
    if (file.size > MAX_SIZE) {
      info.textContent = `\u6587\u4EF6 ${describeSize2(file.size)}\uFF0C\u8D85\u8FC7 100MB \u4E0A\u9650\u3002`;
      info.className = "file-info invalid";
      button.disabled = true;
      state.file = null;
      return;
    }
    state.file = file;
    info.textContent = `${file.name}\uFF08${describeSize2(file.size)}\uFF09`;
    info.className = "file-info valid";
    button.disabled = false;
  }
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") fileInput.click();
  });
  fileInput.addEventListener("change", () => pickFile(fileInput.files[0]));
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
    pickFile(event.dataTransfer.files[0]);
  });
  function setProgress(doneKeys, failed) {
    $$("#progressList li").forEach((item) => {
      item.classList.toggle("done", doneKeys.includes(item.dataset.key));
      item.classList.toggle("failed", failed === item.dataset.key);
    });
  }
  $("#startParse").addEventListener("click", async () => {
    if (!state.file) return;
    gotoStep(2);
    hideError($("#parseError"));
    $("#parseBack").classList.add("hidden");
    setProgress(["read"], null);
    const form2 = new FormData();
    form2.append("file", state.file, state.file.name);
    try {
      const response = await fetch("/api/import/inspect", {
        method: "POST",
        headers: { "X-Studio-Request": "1" },
        body: form2
      });
      const payload = await response.json();
      if (!payload.ok) {
        throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
      }
      for (const key of ["body", "images", "report", "risk"]) {
        setProgress(["read", "body", "images", "report", "risk"].slice(0, ["read", "body", "images", "report", "risk"].indexOf(key) + 1), null);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      state.token = payload.token;
      state.report = payload.report;
      state.plan = null;
      state.committed = null;
      renderReport();
      prefillForm();
      gotoStep(3);
    } catch (error) {
      setProgress([], "read");
      showError($("#parseError"), error.message || "\u89E3\u6790\u5931\u8D25\uFF0C\u8BF7\u786E\u8BA4\u6587\u4EF6\u662F\u6709\u6548\u7684 .docx\u3002");
      $("#parseBack").classList.remove("hidden");
    }
  });
  $("#parseBack").addEventListener("click", () => gotoStep(1));
  function warningList(container, warnings) {
    container.textContent = "";
    if (!warnings || !warnings.length) {
      const p = document.createElement("p");
      p.className = "ok-text";
      p.textContent = "\u6CA1\u6709\u53D1\u73B0\u9700\u8981\u68C0\u67E5\u7684\u95EE\u9898\u3002";
      container.appendChild(p);
      return;
    }
    const title = document.createElement("h3");
    title.textContent = `\u9700\u8981\u68C0\u67E5\uFF08${warnings.length} \u9879\uFF09`;
    const list = document.createElement("ul");
    list.className = "warnings";
    warnings.forEach((warning) => {
      const item = document.createElement("li");
      item.textContent = warning.location ? `${warning.message}\uFF08\u4F4D\u7F6E\uFF1A${warning.location}\uFF09` : warning.message;
      list.appendChild(item);
    });
    container.appendChild(title);
    container.appendChild(list);
  }
  function conflictList(container, conflicts) {
    container.textContent = "";
    if (!conflicts || !conflicts.length) return;
    const box = document.createElement("div");
    box.className = "error-box";
    const title = document.createElement("strong");
    title.textContent = `\u53D1\u73B0 ${conflicts.length} \u5904\u51B2\u7A81\uFF1A`;
    const list = document.createElement("ul");
    conflicts.forEach((conflict) => {
      const item = document.createElement("li");
      item.textContent = conflict.message;
      list.appendChild(item);
    });
    box.appendChild(title);
    box.appendChild(list);
    container.appendChild(box);
  }
  function renderReport() {
    const report = state.report;
    const doc = report.document;
    const stats = [
      ["\u5EFA\u8BAE\u6807\u9898", doc.suggestedTitle || "\uFF08\u672A\u80FD\u63A8\u65AD\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\uFF09"],
      ["\u5EFA\u8BAE\u76EE\u5F55", report.suggested && report.suggested.url ? report.suggested.url : `${doc.suggestedSection || "essays"}/${doc.suggestedSlug || "?"}`],
      ["\u5B57\u6570", `\u7EA6 ${doc.wordCount} \u5B57`],
      ["\u6BB5\u843D\u6570", doc.paragraphCount],
      ["\u6807\u9898\u6570", doc.headingCount],
      ["\u56FE\u7247\u6570", doc.imageCount],
      ["\u811A\u6CE8\u6570", doc.footnoteCount],
      ["\u672A\u8BC6\u522B\u6837\u5F0F", report.warnings.filter((w) => w.code === "unknown-style").length]
    ];
    const dl = $("#reportStats");
    dl.textContent = "";
    stats.forEach(([key, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = String(value);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    warningList($("#reportWarnings"), report.warnings);
    conflictList($("#reportConflicts"), []);
  }
  var form = $("#metaForm");
  function prefillForm() {
    const doc = state.report.document;
    form.title.value = doc.suggestedTitle || "";
    form.slug.value = doc.suggestedSlug || "";
    form.section.value = doc.suggestedSection || "essays";
    form.collectionName.value = doc.suggestedCollection || "";
    form.collectionSlug.value = doc.suggestedCollectionSlug || "";
    form.description.value = "";
    form.date.value = "";
    form.weight.value = "10";
    form.articleId.value = "";
    form.draft.checked = true;
    const select = form.collectionExisting;
    select.textContent = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "\u2014\u2014 \u65B0\u5EFA\u6587\u96C6 \u2014\u2014";
    select.appendChild(empty);
    (state.report.collections || []).forEach((collection) => {
      const option = document.createElement("option");
      option.value = collection.slug;
      option.textContent = collection.title;
      option.dataset.title = collection.title;
      select.appendChild(option);
      if (collection.slug === doc.suggestedCollectionSlug) select.value = collection.slug;
    });
    toggleCollectionFields();
    toggleDraftWarning();
  }
  function toggleCollectionFields() {
    $("#collectionFields").classList.toggle("hidden", form.section.value !== "works");
  }
  function toggleDraftWarning() {
    $("#draftWarning").classList.toggle("hidden", form.draft.checked);
  }
  form.section.addEventListener("change", toggleCollectionFields);
  form.draft.addEventListener("change", toggleDraftWarning);
  form.collectionExisting.addEventListener("change", () => {
    const selected = form.collectionExisting.selectedOptions[0];
    if (selected && selected.value) {
      form.collectionName.value = selected.dataset.title || selected.textContent;
      form.collectionSlug.value = selected.value;
    }
  });
  $("#metaNext").addEventListener("click", async () => {
    hideError($("#metaError"));
    conflictList($("#metaConflicts"), []);
    const slug = form.slug.value.trim();
    if (!SLUG_PATTERN.test(slug)) {
      showError($("#metaError"), "slug \u53EA\u80FD\u4F7F\u7528\u5C0F\u5199\u82F1\u6587\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u8FDE\u5B57\u7B26\uFF0C\u4E14\u4E0D\u80FD\u4EE5\u8FDE\u5B57\u7B26\u5F00\u5934\u6216\u7ED3\u5C3E\u3002");
      return;
    }
    if (form.section.value === "works") {
      if (!form.collectionName.value.trim()) {
        showError($("#metaError"), "\u680F\u76EE\u4E3A\u201C\u4F5C\u54C1\u201D\u65F6\u5FC5\u987B\u586B\u5199\u6587\u96C6\u540D\u79F0\u3002");
        return;
      }
      if (form.collectionSlug.value.trim() && !SLUG_PATTERN.test(form.collectionSlug.value.trim())) {
        showError($("#metaError"), "\u6587\u96C6 slug \u683C\u5F0F\u4E0D\u6B63\u786E\u3002");
        return;
      }
    }
    const metadata = {
      title: form.title.value.trim(),
      subtitle: form.subtitle.value.trim(),
      slug,
      section: form.section.value,
      collections: form.section.value === "works" && form.collectionName.value.trim() ? [form.collectionName.value.trim()] : [],
      collectionSlug: form.section.value === "works" ? form.collectionSlug.value.trim() : "",
      description: form.description.value.trim(),
      date: form.date.value,
      weight: Number(form.weight.value || 10),
      draft: form.draft.checked,
      articleId: form.articleId.value.trim()
    };
    if (!metadata.title) {
      showError($("#metaError"), "\u8BF7\u586B\u5199\u6807\u9898\u3002");
      return;
    }
    try {
      const payload = await api("/api/import/plan", { token: state.token, metadata });
      state.plan = payload.plan;
      state.previewHtml = payload.previewHtml;
      state.assetUrls = payload.assetUrls;
      if (payload.plan.conflicts && payload.plan.conflicts.length) {
        conflictList($("#metaConflicts"), payload.plan.conflicts);
        showError($("#metaError"), "\u5B58\u5728\u51B2\u7A81\uFF0C\u7981\u6B62\u4E0B\u4E00\u6B65\u3002\u8BF7\u4FEE\u6539 slug \u6216\u6587\u96C6\u540E\u91CD\u8BD5\u3002");
        return;
      }
      renderPreview();
      renderConfirm();
      gotoStep(5);
    } catch (error) {
      showError($("#metaError"), error.message);
    }
  });
  function renderPreview() {
    $("#rendered").innerHTML = state.previewHtml;
    $("#markdownSource").textContent = state.plan.markdown;
    const wall = $("#imageWall");
    wall.textContent = "";
    if (!state.assetUrls.length) {
      const p = document.createElement("p");
      p.textContent = "\u672C\u6587\u6CA1\u6709\u56FE\u7247\u3002";
      wall.appendChild(p);
    }
    state.assetUrls.forEach((asset) => {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = asset.url;
      img.alt = asset.name;
      img.loading = "lazy";
      const caption = document.createElement("figcaption");
      caption.textContent = asset.name;
      figure.appendChild(img);
      figure.appendChild(caption);
      wall.appendChild(figure);
    });
    const box = $("#previewWarnings");
    box.textContent = "";
    if (state.plan.warnings && state.plan.warnings.length) {
      const title = document.createElement("h3");
      title.textContent = "\u9700\u8981\u68C0\u67E5\uFF08\u70B9\u51FB\u5B9A\u4F4D\u5230\u5BF9\u5E94\u6BB5\u843D\uFF09";
      const list = document.createElement("ul");
      list.className = "warnings clickable";
      state.plan.warnings.forEach((warning) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "link";
        button.textContent = warning.location ? `${warning.message}\uFF08\u4F4D\u7F6E\uFF1A${warning.location}\uFF09` : warning.message;
        button.addEventListener("click", () => locateWarning(warning));
        item.appendChild(button);
        list.appendChild(item);
      });
      box.appendChild(title);
      box.appendChild(list);
    }
  }
  function locateWarning(warning) {
    const matched = /第(\d+)段/.exec(warning.location || warning.message || "");
    switchTab("render");
    $$("#rendered .highlight").forEach((el) => el.classList.remove("highlight"));
    if (!matched) return;
    const target = Number(matched[1]);
    const blocks = $$("#rendered .block");
    let best = null;
    blocks.forEach((el) => {
      if (Number(el.dataset.block) <= target) best = el;
    });
    best = best || blocks[0];
    if (best) {
      best.classList.add("highlight");
      best.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
  function switchTab(name) {
    $$(".tab").forEach((tab) => tab.classList.toggle("current", tab.dataset.tab === name));
    $$(".tab-panel").forEach((panel) => panel.classList.add("hidden"));
    $(`#tab-${name}`).classList.remove("hidden");
  }
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));
  async function startHugoPreview(statusEl) {
    statusEl.textContent = "\u6B63\u5728\u542F\u52A8\u2026";
    try {
      const payload = await api("/api/system/preview", { action: "start" });
      if (payload.preview && payload.preview.running) {
        statusEl.textContent = `\u9884\u89C8\u5DF2\u542F\u52A8\uFF1A${payload.preview.url}\uFF08\u542B\u8349\u7A3F\uFF09`;
        window.open(payload.preview.url, "_blank");
      } else {
        statusEl.textContent = "\u9884\u89C8\u8FDB\u7A0B\u5DF2\u9000\u51FA\uFF0C\u8BF7\u68C0\u67E5 1313 \u7AEF\u53E3\u662F\u5426\u88AB\u5360\u7528\u3002";
      }
    } catch (error) {
      statusEl.textContent = error.message;
    }
  }
  $("#openHugoPreview").addEventListener("click", () => startHugoPreview($("#previewStatus")));
  function renderConfirm() {
    const list = $("#proposedFiles");
    list.textContent = "";
    (state.plan.proposedFiles || []).forEach((file) => {
      const item = document.createElement("li");
      item.textContent = file;
      list.appendChild(item);
    });
    const conflicts = state.plan && state.plan.conflicts || [];
    conflictList($("#commitConflicts"), conflicts);
    $("#commitButton").disabled = conflicts.length > 0;
    $("#commitSuccess").classList.add("hidden");
    $("#commitActions").classList.remove("hidden");
    hideError($("#commitError"));
  }
  $("#commitButton").addEventListener("click", async () => {
    hideError($("#commitError"));
    $("#commitButton").disabled = true;
    try {
      const payload = await api("/api/import/commit", { token: state.token });
      state.committed = payload.result;
      $("#commitResult").textContent = `\u300A${payload.result.title}\u300B\u5DF2\u5199\u5165 ${payload.result.target}/\uFF08\u7EA6 ${payload.result.wordCount} \u5B57\uFF0C${payload.result.imageCount} \u5F20\u56FE\u7247\uFF0C\u8349\u7A3F\u72B6\u6001\uFF09\u3002`;
      $("#commitActions").classList.add("hidden");
      $("#commitSuccess").classList.remove("hidden");
    } catch (error) {
      $("#commitButton").disabled = false;
      showError($("#commitError"), error.message);
    }
  });
  $("#abortButton").addEventListener("click", async () => {
    try {
      await api("/api/import/abort", { token: state.token });
    } catch (error) {
    }
    resetAll();
  });
  $("#openFolder").addEventListener("click", async () => {
    try {
      await api("/api/system/open-folder", { token: state.token });
    } catch (error) {
      globalError(error.message);
    }
  });
  $("#viewMarkdown").addEventListener("click", () => {
    gotoStep(5);
    switchTab("markdown");
  });
  $("#openPreview").addEventListener("click", () => startHugoPreview($("#previewStatus")));
  function resetAll() {
    state.file = null;
    state.token = "";
    state.report = null;
    state.plan = null;
    state.previewHtml = "";
    state.assetUrls = [];
    state.committed = null;
    pickFile(null);
    gotoStep(1);
  }
  $$("#view-import [data-goto]").forEach(
    (button) => button.addEventListener("click", () => gotoStep(Number(button.dataset.goto)))
  );

  // studio/app/main.mjs
  initTheme();
  route();
})();
