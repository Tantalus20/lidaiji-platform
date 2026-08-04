"use strict";

// notify.js — 统一评论待审核通知：outbox 创建 + 单实例 worker。
// 事件：comment_pending_created（website_paragraph / website_article / qq_article）。
// 状态机：pending → sending → sent / retry_wait → … → failed_terminal。

const crypto = require("node:crypto");

const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
const SENDING_TIMEOUT_MS = 120_000;
const SNIPPET_MAX = 200;

function retryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, attempt - 1), RETRY_DELAYS_MS.length - 1)];
}

function snippetOf(text, max = SNIPPET_MAX) {
  const visible = String(text || "").replace(/\s+/g, " ");
  const trimmed = visible.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** 评论入库后在同一事务内创建通知任务（outbox）。 */
function createNotificationTask(db, { commentId, publicReviewId, now }) {
  const id = `ntf_${crypto.randomBytes(9).toString("hex")}`;
  const createdAt = new Date(now).toISOString();
  db.prepare(`
    INSERT INTO comment_notification_tasks(notification_id,comment_id,comment_public_id,event_type,status,
      attempt_count,next_attempt_at,last_error_code,relay_message_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, commentId, publicReviewId, "comment_pending_created", "pending", 0, createdAt,
    "", "", createdAt, createdAt);
  return id;
}

/** 发送给 relay；relay 失败时抛错并携带 errorCode。 */
function sendToRelay(config, task, comment, articleTitle) {
  const payload = {
    template: "comment_pending",
    notificationId: task.notification_id,
    commentPublicId: task.comment_public_id,
    articleTitle,
    commentType: comment.scope === "article" ? "章评" : "段评",
    displayName: comment.display_name,
    snippet: snippetOf(comment.body),
    submittedAt: comment.created_at,
    sourceType: comment.source_type === "qq" ? "QQ群" : "网站",
    paragraphLabel: comment.scope === "paragraph" ? snippetOf(comment.paragraph_excerpt, 40) : "",
    idempotencyKey: `lidaiji-comment-pending|${task.comment_public_id}`,
  };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorNotifyToken}` };
  const body = JSON.stringify(payload);
  return fetch(config.operatorNotifyUrl + "/lidaiji/operator-notification", { method: "POST", headers, body })
    .then(async (res) => {
      let data = {};
      try { data = await res.json(); } catch { /* 忽略 */ }
      if (res.status === 200 || res.status === 202) return { ok: true, messageId: String(data.messageId || data.relayMessageId || "") };
      const code = String(data.error || data.code || `HTTP_${res.status}`);
      const error = new Error(`relay 返回 ${res.status}`);
      error.errorCode = code;
      throw error;
    })
    .catch((error) => {
      if (!error.errorCode) error.errorCode = "RELAY_UNREACHABLE";
      throw error;
    });
}

/** 单实例扫描器：处理 pending / 到期的 retry_wait / 超时的 sending。 */
function startNotificationWorker({ db, config, logger = console, intervalMs = 5_000 }) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      // 超时遗留 sending → retry_wait
      db.prepare(`
        UPDATE comment_notification_tasks SET status='retry_wait', updated_at=?
        WHERE status='sending' AND updated_at<=?
      `).run(new Date(now - SENDING_TIMEOUT_MS).toISOString(), new Date(now - SENDING_TIMEOUT_MS).toISOString());
      const tasks = db.prepare(`
        SELECT * FROM comment_notification_tasks
        WHERE status IN ('pending','retry_wait') AND next_attempt_at<=?
        ORDER BY created_at ASC LIMIT 10
      `).all(new Date(now).toISOString());
      for (const task of tasks) {
        processTask(db, config, task, logger, now);
      }
    } catch (error) {
      logger.error(`[通知] worker 异常：${String(error.message || error).slice(0, 120)}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref && timer.unref();
  return timer;
}

function processTask(db, config, task, logger, now) {
  const comment = db.prepare("SELECT * FROM comments WHERE id=?").get(task.comment_id);
  if (!comment) {
    db.prepare("UPDATE comment_notification_tasks SET status='cancelled', updated_at=? WHERE notification_id=?")
      .run(new Date(now).toISOString(), task.notification_id);
    return;
  }
  const article = db.prepare("SELECT title FROM articles WHERE article_id=?").get(comment.article_id);
  const articleTitle = article ? article.title : "未知文章";
  // 租约：先标记 sending
  db.prepare("UPDATE comment_notification_tasks SET status='sending', updated_at=? WHERE notification_id=?").run(new Date(now).toISOString(), task.notification_id);
  if (!config.operatorNotifyUrl || !config.operatorNotifyToken) {
    markRetry(db, task, "NOTIFY_UNCONFIGURED", logger, now);
    return;
  }
  sendToRelay(config, task, comment, articleTitle).then((result) => {
    db.prepare(`
      UPDATE comment_notification_tasks SET status='sent', sent_at=?, relay_message_id=?, last_error_code='',
        attempt_count=attempt_count+1, updated_at=? WHERE notification_id=?
    `).run(new Date(now).toISOString(), result.messageId, new Date(now).toISOString(), task.notification_id);
  }).catch((error) => {
    markRetry(db, task, String(error.errorCode || "RELAY_ERROR").slice(0, 60), logger, now);
  });
}

function markRetry(db, task, code, logger, now) {
  const attempts = Number(task.attempt_count) + 1;
  const nextDelay = retryDelay(attempts);
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(`
      UPDATE comment_notification_tasks SET status='failed_terminal', attempt_count=?, last_error_code=?,
        next_attempt_at=?, updated_at=? WHERE notification_id=?
    `).run(attempts, code, new Date(now + 3600_000).toISOString(), new Date(now).toISOString(), task.notification_id);
    logger.warn(`[通知] 任务 ${task.comment_public_id} 已达终止状态（${code}）`);
  } else {
    db.prepare(`
      UPDATE comment_notification_tasks SET status='retry_wait', attempt_count=?, last_error_code=?,
        next_attempt_at=?, updated_at=? WHERE notification_id=?
    `).run(attempts, code, new Date(now + nextDelay).toISOString(), new Date(now).toISOString(), task.notification_id);
  }
}

function notificationHealth(db) {
  const failed = Number(db.prepare("SELECT COUNT(*) count FROM comment_notification_tasks WHERE status='failed_terminal'").get().count);
  const pending = Number(db.prepare("SELECT COUNT(*) count FROM comment_notification_tasks WHERE status IN ('pending','retry_wait')").get().count);
  return { failedTerminal: failed, pendingRetry: pending };
}

module.exports = { createNotificationTask, startNotificationWorker, notificationHealth, snippetOf, retryDelay };
