/* 作者评（data/author-notes/<articleId>.yaml）。 */
import { api, apiGet } from "./api.mjs";
import { $, hideError, showError } from "./util.mjs";
import { editState } from "./state.mjs";

/* ---------------- 作者评（data/author-notes/<articleId>.yaml） ---------------- */

const notesState = {
  list: [],
  paragraphs: [],
  editing: null, // null=新增；否则为批注 id
  inlineComposer: null,
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
      apiGet(`/api/notes/paragraphs?path=${encodeURIComponent(editState.path)}`),
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
  if (notesState.inlineComposer?.isConnected) notesState.inlineComposer.remove();
  notesState.inlineComposer = null;
}

function openInlineNoteComposer(paragraphId, actions) {
  closeInlineNoteComposer();
  hideError($("#notesError"));

  const composer = document.createElement("div");
  composer.className = "inline-note-composer";
  const title = document.createElement("strong");
  title.textContent = "写这段的作者评";
  const textarea = document.createElement("textarea");
  textarea.rows = 4;
  textarea.maxLength = 5000;
  textarea.placeholder = "写下补充、回忆或说明……";
  textarea.setAttribute("aria-label", "作者段落评正文");
  const status = document.createElement("span");
  status.className = "preview-status";
  const buttons = document.createElement("div");
  buttons.className = "actions";

  const save = async (noteStatus) => {
    const body = textarea.value.trim();
    if (!body) {
      status.textContent = "请先写下批注正文。";
      textarea.focus();
      return;
    }
    const allButtons = buttons.querySelectorAll("button");
    allButtons.forEach((button) => { button.disabled = true; });
    status.textContent = "正在保存…";
    try {
      await api("/api/notes/save", {
        path: editState.path,
        note: { scope: "paragraph", paragraphId, body, status: noteStatus },
      });
      status.textContent = noteStatus === "published" ? "已保存并发布。" : "已保存为草稿。";
      await loadNotes();
    } catch (error) {
      status.textContent = error.message;
      allButtons.forEach((button) => { button.disabled = false; });
    }
  };

  const draft = document.createElement("button");
  draft.type = "button";
  draft.className = "secondary small";
  draft.textContent = "保存草稿";
  draft.addEventListener("click", () => save("draft"));
  const publish = document.createElement("button");
  publish.type = "button";
  publish.className = "primary small";
  publish.textContent = "保存并发布";
  publish.addEventListener("click", () => save("published"));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary small";
  cancel.textContent = "取消";
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
      (note) => note.scope === "paragraph" && note.paragraphId === paragraphId,
    ).length;
    const actions = document.createElement("div");
    actions.className = "inline-note-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inline-note-button";
    button.textContent = count ? `作者评 ${count} · 再写` : "写作者评";
    button.setAttribute("aria-label", `为段落 ${paragraphId} 写作者评`);
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
  scope.textContent = note.scope === "paragraph" ? "段落评" : "篇章评";
  badges.appendChild(scope);
  const status = document.createElement("span");
  status.className = note.status === "published" ? "badge badge-published" : "badge badge-draft";
  status.textContent = note.status === "published" ? "已发布" : "草稿";
  badges.appendChild(status);
  head.appendChild(badges);
  const updated = document.createElement("span");
  updated.className = "meta-text";
  updated.textContent = `更新于 ${note.updated}`;
  head.appendChild(updated);
  card.appendChild(head);
  if (note.scope === "paragraph") {
    const anchor = document.createElement("p");
    anchor.className = "meta-text";
    const found = notesState.paragraphs.find((item) => item.paragraphId === note.paragraphId);
    anchor.textContent = `段落 ${note.paragraphId}${found ? `：${found.excerpt}` : "（当前正文未找到该锚点）"}`;
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
  edit.textContent = "编辑";
  edit.addEventListener("click", () => openNoteForm(note));
  actions.appendChild(edit);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "danger small";
  del.textContent = "删除";
  const confirmBar = document.createElement("div");
  confirmBar.className = "confirm-bar hidden";
  const hint = document.createElement("span");
  hint.textContent = "将真正删除这条批注（有 git 与保存备份兜底）。确认删除？";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "danger small";
  yes.textContent = "确认删除";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "secondary small";
  no.textContent = "取消";
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
    empty.textContent = "这篇文章还没有作者评。";
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
    option.textContent = item.excerpt ? `${item.excerpt}（${item.paragraphId}）` : item.paragraphId;
    select.appendChild(option);
  }
  if (selected) select.value = selected;
}

function openNoteForm(note) {
  hideError($("#notesError"));
  const isNew = !note;
  const scope = note ? note.scope : notesState.newScope;
  notesState.editing = note ? note.id : null;
  $("#noteFormTitle").textContent = note
    ? `编辑${scope === "paragraph" ? "段落评" : "篇章评"}（${note.id}）`
    : scope === "paragraph" ? "新增段落评" : "新增篇章评";
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
  const editing = notesState.editing ? notesState.list.find((note) => note.id === notesState.editing) : null;
  const scope = editing ? editing.scope : notesState.newScope;
  const note = {
    body: $("#noteBody").value,
    status: $("#notePublished").checked ? "published" : "draft",
  };
  if (editing) note.id = editing.id;
  note.scope = scope;
  if (scope === "paragraph") note.paragraphId = $("#noteParagraph").value;
  if (!note.body.trim()) {
    showError($("#notesError"), "批注正文不能为空。");
    return;
  }
  status.textContent = "正在保存…";
  $("#noteSave").disabled = true;
  try {
    await api("/api/notes/save", { path: editState.path, note });
    status.textContent = "已保存。";
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

export { loadNotes, decoratePreviewNotes };

