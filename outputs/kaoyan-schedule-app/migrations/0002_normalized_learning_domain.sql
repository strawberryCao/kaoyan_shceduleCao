PRAGMA foreign_keys = ON;

-- Normalized learning-domain model. The legacy learning_state snapshot remains
-- available as a compatibility envelope and recovery checkpoint.
CREATE TABLE IF NOT EXISTS learning_entries (
  entry_id TEXT PRIMARY KEY,
  captured_date TEXT NOT NULL CHECK (captured_date GLOB '????-??-??'),
  kind TEXT NOT NULL CHECK (kind IN ('quick', 'note')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '默认文件夹',
  source_type TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'auto_applied', 'accepted', 'corrected', 'ignored')),
  classification_source TEXT NOT NULL DEFAULT 'ai'
    CHECK (classification_source IN ('ai', 'manual', 'fallback')),
  user_edited_fields_json TEXT NOT NULL DEFAULT '[]',
  generated_fields_json TEXT NOT NULL DEFAULT '{}',
  entity_revision INTEGER NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS learning_entries_active_date
  ON learning_entries (captured_date DESC, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS learning_entries_subject
  ON learning_entries (subject, captured_date DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS learning_entries_review_queue
  ON learning_entries (review_status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS learning_attachments (
  attachment_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES learning_entries(entry_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'word', 'html', 'file')),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  storage_path TEXT NOT NULL,
  preview_path TEXT NOT NULL DEFAULT '',
  source_image_hash TEXT NOT NULL DEFAULT '',
  source_batch_id TEXT NOT NULL DEFAULT '',
  source_split_index INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (entry_id, ordinal),
  UNIQUE (entry_id, storage_path)
);

CREATE INDEX IF NOT EXISTS learning_attachments_entry
  ON learning_attachments (entry_id, ordinal);
CREATE INDEX IF NOT EXISTS learning_attachments_source_hash
  ON learning_attachments (source_image_hash)
  WHERE source_image_hash <> '';

CREATE TABLE IF NOT EXISTS learning_cards (
  card_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES learning_entries(entry_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('memory', 'mistake')),
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  due_date TEXT NOT NULL DEFAULT '',
  interval_days INTEGER NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
  ease_factor REAL NOT NULL DEFAULT 2.5 CHECK (ease_factor >= 1.3),
  review_step INTEGER NOT NULL DEFAULT 0 CHECK (review_step >= 0),
  success_streak INTEGER NOT NULL DEFAULT 0 CHECK (success_streak >= 0),
  entity_revision INTEGER NOT NULL DEFAULT 1 CHECK (entity_revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (entry_id, source_key)
);

CREATE INDEX IF NOT EXISTS learning_cards_due
  ON learning_cards (status, due_date, updated_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS learning_cards_entry
  ON learning_cards (entry_id);

CREATE TABLE IF NOT EXISTS learning_review_events (
  review_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES learning_cards(card_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  rating TEXT NOT NULL CHECK (rating IN ('again', 'hard', 'good', 'easy')),
  previous_due_date TEXT NOT NULL DEFAULT '',
  next_due_date TEXT NOT NULL,
  interval_days INTEGER NOT NULL CHECK (interval_days >= 0),
  thought TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS learning_review_events_card
  ON learning_review_events (card_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS learning_study_notes (
  study_note_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES learning_entries(entry_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS learning_study_notes_entry
  ON learning_study_notes (entry_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS learning_tags (
  tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_entry_tags (
  entry_id TEXT NOT NULL REFERENCES learning_entries(entry_id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES learning_tags(tag_id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS learning_tombstones (
  entry_id TEXT PRIMARY KEY,
  deleted_revision INTEGER NOT NULL CHECK (deleted_revision > 0),
  deleted_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  restored_at TEXT
);

CREATE INDEX IF NOT EXISTS learning_tombstones_deleted
  ON learning_tombstones (deleted_at DESC);

CREATE TABLE IF NOT EXISTS learning_change_log (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('day', 'entry', 'attachment', 'card', 'review', 'tombstone')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'restore')),
  operation_id TEXT NOT NULL UNIQUE,
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS learning_change_log_entity
  ON learning_change_log (entity_type, entity_id, revision DESC);
