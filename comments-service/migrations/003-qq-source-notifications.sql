-- 003-qq-source-notifications.sql
-- QQ章评来源、脱敏身份、幂等与通知任务。
-- 只增加列与表，不改动现有列/触发器/索引；旧代码可继续运行。

ALTER TABLE comments ADD COLUMN source_type TEXT NOT NULL DEFAULT 'website';
ALTER TABLE comments ADD COLUMN actor_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN source_group_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN source_message_key TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN public_review_id TEXT NOT NULL DEFAULT '';
ALTER TABLE comments ADD COLUMN normalized_body_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_comments_qq_actor ON comments(actor_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_qq_group ON comments(source_group_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_qq_msgkey ON comments(source_type, source_message_key);
CREATE INDEX IF NOT EXISTS idx_comments_qq_dedup ON comments(actor_hash, article_id, normalized_body_hash, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_comments_qq_msgkey ON comments(source_type, source_message_key)
  WHERE source_message_key != '';

CREATE TABLE IF NOT EXISTS comment_notification_tasks (
  notification_id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  comment_public_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('comment_pending_created')),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','retry_wait','failed_terminal','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL DEFAULT '',
  relay_message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notify_scan ON comment_notification_tasks(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notify_comment ON comment_notification_tasks(comment_id);
