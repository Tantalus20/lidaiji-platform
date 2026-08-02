"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const source = document.querySelector(".author-notes-paragraph-source");
  if (!source) return;

  const anchors = new Map();
  source.querySelectorAll("[data-author-note-paragraph]").forEach((note) => {
    const paragraphId = note.dataset.authorNoteParagraph || "";
    if (!/^p-[0-9a-f]{12}$/.test(paragraphId)) return;
    const paragraph = document.getElementById(paragraphId);
    if (!paragraph) return;
    const anchor = anchors.get(paragraphId) || paragraph;
    anchor.insertAdjacentElement("afterend", note);
    anchors.set(paragraphId, note);
  });

  if (!source.querySelector("[data-author-note-paragraph]")) source.remove();
});
