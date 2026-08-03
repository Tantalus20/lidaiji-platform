/* 版本管理 + 文章历史。 */
import { api, apiGet } from "./api.mjs";
import { $, $$, hideError, showError } from "./util.mjs";
import { renderDiff } from "./diff.mjs";

/* ---------------- 版本管理 ---------------- */

const STATUS_LABELS = { M: "修改", A: "新增", D: "删除", R: "改名", U: "冲突", "?": "未跟踪", T: "类型变更", C: "复制" };

function statusLabel(status) {
  return STATUS_LABELS[status] || (status.length > 1 ? STATUS_LABELS[status[0]] || status : status);
}

function renderVersionsStatus(status) {
  const info = $("#versionsRepoInfo");
  info.textContent = "";
  const rows = [
    ["分支", status.branch || "—"],
    ["状态", status.clean ? "干净（没有未提交的修改）" : `${status.files.length} 个未提交文件`],
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
  ["", "路径", "状态", "修改时间"].forEach((text) => {
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
    pathCell.textContent = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    row.appendChild(pathCell);
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge badge-status-${file.status === "?" ? "new" : "mod"}`;
    badge.textContent = `${statusLabel(file.status)} ${file.status}`;
    statusCell.appendChild(badge);
    row.appendChild(statusCell);
    const timeCell = document.createElement("td");
    timeCell.className = "meta-text";
    timeCell.textContent = file.mtime ? file.mtime.replace("T", " ") : "—";
    row.appendChild(timeCell);
    body.appendChild(row);
  }
  table.appendChild(body);
  filesBox.appendChild(table);
  $("#versionsMessage").value = status.suggestion || "";
}

function renderCommitList(container, commits, emptyText) {
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
      apiGet("/api/git/log"),
    ]);
    $("#versionsContent").classList.remove("hidden");
    renderVersionsStatus(statusPayload.status);
    renderCommitList($("#versionsLog"), logPayload.commits, "仓库还没有任何提交。");
  } catch (error) {
    $("#versionsContent").classList.add("hidden");
    showError($("#versionsError"), error.message);
  }
}

$("#versionsCommitBtn").addEventListener("click", () => {
  const message = $("#versionsMessage").value.trim();
  if (!message) {
    $("#versionsCommitStatus").textContent = "请填写提交信息。";
    return;
  }
  const checked = $$("#versionsFiles input[type=checkbox]:checked");
  if (!checked.length) {
    $("#versionsCommitStatus").textContent = "请先勾选要提交的文件。";
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
  status.textContent = "正在提交…";
  $("#versionsConfirmYes").disabled = true;
  try {
    const payload = await api("/api/git/commit", { files, message });
    status.textContent = `已创建提交 ${payload.commit.short}：${payload.commit.subject}`;
    await loadVersions();
  } catch (error) {
    status.textContent = "提交失败";
    showError($("#versionsError"), error.message);
  } finally {
    $("#versionsConfirmYes").disabled = false;
  }
});

/* ---------------- 文章历史 ---------------- */

const historyState = { path: "" };

function renderHistoryLog(commits) {
  const container = $("#historyLog");
  container.textContent = "";
  if (!commits.length) {
    const empty = document.createElement("p");
    empty.className = "meta-text";
    empty.textContent = "这篇文章还没有提交历史（可能尚未提交过）。";
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
    toggle.textContent = "查看变更";
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
        toggle.textContent = "查看变更";
        return;
      }
      if (!loaded) {
        toggle.textContent = "正在加载…";
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
      toggle.textContent = "收起变更";
    });
    container.appendChild(row);
  }
}

async function loadHistory(path) {
  historyState.path = path;
  hideError($("#historyError"));
  $("#historyDiff").classList.add("hidden");
  $("#historyDiff").textContent = "";
  $("#historyTitle").textContent = path ? `版本历史：${path}` : "版本历史";
  $("#historyLog").textContent = "";
  if (!path) {
    showError($("#historyError"), "缺少文章路径。");
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
  box.textContent = "正在加载…";
  try {
    const payload = await apiGet(`/api/git/diff?path=${encodeURIComponent(historyState.path)}`);
    renderDiff(box, payload.result.diff, payload.result.note || "当前相对最近一次提交的未提交修改：");
  } catch (error) {
    box.classList.add("hidden");
    showError($("#historyError"), error.message);
  }
});

export { loadVersions, loadHistory };

