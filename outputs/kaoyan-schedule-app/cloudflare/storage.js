const EMPTY_SNAPSHOT = Object.freeze({
  version: 1,
  revision: 0,
  updatedAt: null,
  days: {},
  cards: [],
  deletedNotes: {},
});

export const SQL = Object.freeze({
  insertLearning: `INSERT OR IGNORE INTO learning_state (id, revision, snapshot_json, updated_at)
    VALUES (1, 0, ?1, NULL)`,
  selectLearning: `SELECT revision, snapshot_json, updated_at FROM learning_state WHERE id = 1`,
  updateLearning: `UPDATE learning_state
    SET revision = ?1, snapshot_json = ?2, updated_at = ?3
    WHERE id = 1 AND revision = ?4`,
  upsertSchedule: `INSERT INTO schedule_records
      (date, record_json, snapshot_revision, updated_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(date) DO UPDATE SET
      record_json = excluded.record_json,
      snapshot_revision = excluded.snapshot_revision,
      updated_at = excluded.updated_at
    WHERE excluded.snapshot_revision >= schedule_records.snapshot_revision`,
  selectReceipt: `SELECT scope, operation_id, entity_id, request_hash, result_json, created_at
    FROM operation_receipts WHERE scope = ?1 AND operation_id = ?2`,
  insertReceipt: `INSERT INTO operation_receipts
      (scope, operation_id, entity_id, request_hash, result_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  listCanvas: `SELECT id, title, revision, r2_key, r2_etag, created_at, updated_at, summary_json
    FROM canvas_projects ORDER BY updated_at DESC`,
  selectCanvas: `SELECT id, title, revision, r2_key, r2_etag, created_at, updated_at, summary_json
    FROM canvas_projects WHERE id = ?1`,
  insertCanvas: `INSERT INTO canvas_projects
      (id, title, revision, r2_key, r2_etag, created_at, updated_at, summary_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  updateCanvas: `UPDATE canvas_projects SET
      title = ?1, revision = ?2, r2_key = ?3, r2_etag = ?4,
      updated_at = ?5, summary_json = ?6
    WHERE id = ?7 AND revision = ?8`,
  deleteCanvas: `DELETE FROM canvas_projects WHERE id = ?1 AND revision = ?2`,
  upsertCanvasBootstrap: `INSERT INTO canvas_projects
      (id, title, revision, r2_key, r2_etag, created_at, updated_at, summary_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      revision = excluded.revision,
      r2_key = excluded.r2_key,
      r2_etag = excluded.r2_etag,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      summary_json = excluded.summary_json
    WHERE excluded.revision > canvas_projects.revision`,
  selectAppState: `SELECT key, value_json, revision, updated_at FROM app_state WHERE key = ?1`,
  upsertAppState: `INSERT INTO app_state (key, value_json, revision, updated_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      revision = excluded.revision,
      updated_at = excluded.updated_at`,
  selectNoteFile: `SELECT note_uid, r2_key, file_name, mime_type, size, created_at
    FROM note_files WHERE note_uid = ?1`,
  selectNoteFileByKey: `SELECT note_uid, r2_key, file_name, mime_type, size, created_at
    FROM note_files WHERE r2_key = ?1`,
  upsertNoteFile: `INSERT INTO note_files
      (note_uid, r2_key, file_name, mime_type, size, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(note_uid) DO UPDATE SET
      r2_key = excluded.r2_key,
      file_name = excluded.file_name,
      mime_type = excluded.mime_type,
      size = excluded.size`,
});

export function emptySnapshot() {
  return structuredClone(EMPTY_SNAPSHOT);
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

export async function readLearningState(env) {
  await env.DB.prepare(SQL.insertLearning).bind(JSON.stringify(EMPTY_SNAPSHOT)).run();
  const row = await env.DB.prepare(SQL.selectLearning).first();
  if (!row) throw new Error('D1 learning_state row is unavailable');
  const snapshot = parseJson(row.snapshot_json, null);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('D1 learning_state contains invalid JSON');
  }
  snapshot.version = Number.isFinite(Number(snapshot.version)) ? Number(snapshot.version) : 1;
  snapshot.revision = Number(row.revision) || 0;
  snapshot.updatedAt = typeof row.updated_at === 'string' ? row.updated_at : null;
  snapshot.days = snapshot.days && typeof snapshot.days === 'object' && !Array.isArray(snapshot.days)
    ? snapshot.days
    : {};
  snapshot.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  snapshot.deletedNotes = snapshot.deletedNotes
    && typeof snapshot.deletedNotes === 'object'
    && !Array.isArray(snapshot.deletedNotes)
    ? snapshot.deletedNotes
    : {};
  return { revision: snapshot.revision, snapshot };
}

export async function compareAndSwapLearningState(env, currentRevision, snapshot, updatedAt) {
  const nextRevision = currentRevision + 1;
  const stored = {
    ...snapshot,
    version: Number.isFinite(Number(snapshot.version)) ? Number(snapshot.version) : 1,
    revision: nextRevision,
    updatedAt,
  };
  const result = await env.DB.prepare(SQL.updateLearning)
    .bind(nextRevision, JSON.stringify(stored), updatedAt, currentRevision)
    .run();
  if (changes(result) !== 1) return null;
  return stored;
}

export async function mirrorScheduleRecords(env, snapshot, dates = Object.keys(snapshot.days ?? {})) {
  const uniqueDates = [...new Set(dates)].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  if (uniqueDates.length === 0) return;
  const updatedAt = snapshot.updatedAt || new Date().toISOString();
  const statements = uniqueDates.map((date) => env.DB.prepare(SQL.upsertSchedule).bind(
    date,
    JSON.stringify(snapshot.days?.[date]?.manual ?? {
      completedTaskIds: [], note: '', debt: '', mistakes: '',
    }),
    snapshot.revision,
    updatedAt,
  ));
  await env.DB.batch(statements);
}

export async function readReceipt(env, scope, operationId) {
  const row = await env.DB.prepare(SQL.selectReceipt).bind(scope, operationId).first();
  if (!row) return null;
  return {
    scope: String(row.scope),
    operationId: String(row.operation_id),
    entityId: String(row.entity_id),
    requestHash: String(row.request_hash),
    result: parseJson(row.result_json, null),
    createdAt: String(row.created_at),
  };
}

export async function writeReceipt(env, receipt) {
  await env.DB.prepare(SQL.insertReceipt).bind(
    receipt.scope,
    receipt.operationId,
    receipt.entityId,
    receipt.requestHash,
    JSON.stringify(receipt.result),
    receipt.createdAt,
  ).run();
}

export async function readAppState(env, key) {
  const row = await env.DB.prepare(SQL.selectAppState).bind(key).first();
  if (!row) return null;
  return {
    key: String(row.key),
    value: parseJson(row.value_json, null),
    revision: Number(row.revision) || 0,
    updatedAt: String(row.updated_at),
  };
}

export async function writeAppState(env, key, value, revision, updatedAt) {
  await env.DB.prepare(SQL.upsertAppState)
    .bind(key, JSON.stringify(value), revision, updatedAt)
    .run();
}

export function resultChanges(result) {
  return changes(result);
}
