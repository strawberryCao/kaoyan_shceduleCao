PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS learning_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  snapshot_json TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule_records (
  date TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_receipts (
  scope TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, operation_id)
);

CREATE INDEX IF NOT EXISTS operation_receipts_entity
  ON operation_receipts (scope, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS canvas_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  r2_key TEXT NOT NULL UNIQUE,
  r2_etag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS canvas_projects_updated
  ON canvas_projects (updated_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note_files (
  note_uid TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO learning_state (id, revision, snapshot_json, updated_at)
VALUES (
  1,
  0,
  '{"version":1,"revision":0,"updatedAt":null,"days":{},"cards":[],"deletedNotes":{}}',
  NULL
);
