-- 逐篇浏览统计（stats V0.1，独立数据库 stats.sqlite3）
-- 逻辑隔离：与评论库（comments.sqlite3）完全分离，事务/锁互不影响。

CREATE TABLE IF NOT EXISTS content_views (
  namespace   TEXT NOT NULL,
  content_id  TEXT NOT NULL,
  view_count  INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (namespace, content_id)
);

CREATE INDEX IF NOT EXISTS idx_content_views_namespace ON content_views(namespace, updated_at);
