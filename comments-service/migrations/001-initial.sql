PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  article_id TEXT PRIMARY KEY,
  current_revision TEXT NOT NULL,
  title TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  paragraph_comments_mode TEXT NOT NULL CHECK (paragraph_comments_mode IN ('open','locked','off')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  published_at TEXT,
  paragraph_count INTEGER NOT NULL,
  source_checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(article_id, revision)
);

CREATE TABLE IF NOT EXISTS paragraphs (
  article_id TEXT NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  paragraph_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  heading_context TEXT NOT NULL DEFAULT '',
  text_excerpt TEXT NOT NULL,
  text_checksum TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current','historical')),
  PRIMARY KEY(article_id, revision, paragraph_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(article_id),
  article_revision TEXT NOT NULL,
  paragraph_id TEXT NOT NULL,
  paragraph_excerpt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','spam','hidden','deleted','orphaned')),
  source_fingerprint TEXT NOT NULL,
  browser_fingerprint TEXT NOT NULL DEFAULT '',
  contains_link INTEGER NOT NULL DEFAULT 0,
  duplicate_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  public_at TEXT
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT NOT NULL REFERENCES comments(id),
  admin_id TEXT NOT NULL REFERENCES admins(id),
  action TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_fingerprint TEXT NOT NULL,
  browser_fingerprint TEXT NOT NULL DEFAULT '',
  article_id TEXT NOT NULL DEFAULT '',
  paragraph_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_public ON comments(article_id, paragraph_id, status, public_at);
CREATE INDEX IF NOT EXISTS idx_comments_moderation ON comments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_source ON comments(source_fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_source ON rate_limit_events(source_fingerprint, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_paragraph_current ON paragraphs(article_id, status, paragraph_id);
