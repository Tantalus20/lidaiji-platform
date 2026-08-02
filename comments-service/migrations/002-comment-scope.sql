-- 002-comment-scope.sql
-- 为评论增加 scope：paragraph（段评，关联自然段）/ article（章评，只关联整篇文章）。
-- 采用 ADD COLUMN + 触发器而不是重建表：
--   1. 旧段评零拷贝，id/article_id/paragraph_id/状态/时间逐字节不变；
--   2. 旧代码 INSERT 不带 scope 时自动落默认值 'paragraph'，新旧代码可互读数据库；
--   3. 触发器提供与 CHECK 等价的强制约束，且可在不重建表的前提下加入。
-- paragraph_id 使用空字符串表示“不关联自然段”（与 rate_limit_events 的既有约定一致）。

ALTER TABLE comments ADD COLUMN scope TEXT NOT NULL DEFAULT 'paragraph';

CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(scope, article_id, status, public_at);

CREATE TRIGGER IF NOT EXISTS trg_comments_scope_insert BEFORE INSERT ON comments BEGIN
  SELECT CASE
    WHEN NEW.scope NOT IN ('paragraph', 'article') THEN RAISE(ABORT, '评论scope无效')
    WHEN NEW.scope = 'paragraph' AND NEW.paragraph_id = '' THEN RAISE(ABORT, '段评必须关联自然段')
    WHEN NEW.scope = 'article' AND NEW.paragraph_id != '' THEN RAISE(ABORT, '章评不得关联自然段')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_comments_scope_update BEFORE UPDATE OF scope, paragraph_id ON comments BEGIN
  SELECT CASE
    WHEN NEW.scope NOT IN ('paragraph', 'article') THEN RAISE(ABORT, '评论scope无效')
    WHEN NEW.scope = 'paragraph' AND NEW.paragraph_id = '' THEN RAISE(ABORT, '段评必须关联自然段')
    WHEN NEW.scope = 'article' AND NEW.paragraph_id != '' THEN RAISE(ABORT, '章评不得关联自然段')
  END;
END;
