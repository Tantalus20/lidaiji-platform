/* 发布中心。 */
import { api, apiGet } from "./api.mjs";
import { $, hideError, showError } from "./util.mjs";

/* ---------------- 发布中心 ---------------- */

function renderPublishStatus(status) {
  const info = $("#publishInfo");
  info.textContent = "";
  const settings = status.settings || {};
  const missing = [];
  if (!settings.hasSshTarget) missing.push("WRITING_SSH_TARGET");
  if (!settings.hasDomain) missing.push("WRITING_DOMAIN");
  const rows = [
    ["本地版本", status.version ? `V${status.version}` : "—"],
    [
      "服务器配置",
      settings.configured
        ? "已配置（.author-settings，值不会显示）"
        : settings.filePresent
          ? `未配置完整：缺少 ${missing.join("、")}`
          : "未配置（缺少 .author-settings 文件）",
    ],
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
    empty.textContent = "CHANGELOG.md 中还没有发布记录。";
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
  renderCommitList($("#publishCommits"), status.commits || [], status.gitError || "没有提交记录。");
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
  status.textContent = full ? "正在运行完整检查（可能数分钟）…" : "正在运行发布前检查…";
  $("#preflightLog").classList.add("hidden");
  try {
    const payload = await api("/api/publish/preflight", { full });
    const log = $("#preflightLog");
    log.textContent = payload.preflight.output || "（无输出）";
    log.classList.remove("hidden");
    if (payload.preflight.success) {
      status.textContent = `检查通过（${payload.preflight.script}，耗时 ${payload.preflight.duration} 秒），30 分钟内可发布。`;
      $("#publishRunBtn").disabled = false;
    } else {
      status.textContent = `检查未通过（${payload.preflight.script}），请根据日志修复后重试。`;
      $("#publishRunBtn").disabled = true;
    }
  } catch (error) {
    status.textContent = "检查运行失败";
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
  status.textContent = "正在发布（构建、备份、上传，可能需要几分钟）…";
  $("#publishLog").classList.add("hidden");
  try {
    const payload = await api("/api/publish/run", { confirm: true });
    const log = $("#publishLog");
    log.textContent = payload.publish.output || "（无输出）";
    log.classList.remove("hidden");
    if (payload.publish.success) {
      status.textContent = `发布成功（耗时 ${payload.publish.duration} 秒）。`;
    } else {
      status.textContent = "发布失败，请根据日志排查；服务器可能仍停留在旧版本。";
    }
  } catch (error) {
    status.textContent = error.message;
    if (error.code === "preflight-required") {
      status.textContent = "发布被拒绝：请先运行一次成功的发布前检查（30 分钟内有效）。";
    }
  } finally {
    button.disabled = false;
  }
});

export { loadPublish };

