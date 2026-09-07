const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  SYNC_SCHEMA_VERSION,
  SyncProtocolError,
  canonicalJson,
  operationPayloadHash,
  sha256,
  validateOperation,
} = require('./sync-core.cjs');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : structuredClone(fallback); } catch { return structuredClone(fallback); }
}

function normalizeStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function projectMutation(documentInput, deletedInput, mutation) {
  const document = structuredClone(isObject(documentInput) ? documentInput : {});
  let deleted = Boolean(deletedInput);
  if (mutation.kind === 'delete') return { document, deleted: true };
  if (mutation.kind === 'restore') return { document, deleted: false };
  if (deleted) throw new SyncProtocolError('LOCAL_ENTITY_DELETED', 'Restore a deleted local entity before changing it.', 409);
  for (const [field, value] of Object.entries(isObject(mutation.fields) ? mutation.fields : {})) document[field] = structuredClone(value);
  for (const field of normalizeStrings(mutation.unset)) delete document[field];
  for (const [field, delta] of Object.entries(isObject(mutation.sets) ? mutation.sets : {})) {
    const values = new Set(normalizeStrings(document[field]));
    for (const value of normalizeStrings(delta?.add)) values.add(value);
    for (const value of normalizeStrings(delta?.remove)) values.delete(value);
    document[field] = [...values].sort((left, right) => left.localeCompare(right));
  }
  return { document, deleted };
}

function createWindowsReplicaStore(options = {}) {
  const databasePath = path.resolve(options.databasePath || 'windows-replica.sqlite');
  const assetsRoot = path.resolve(options.assetsRoot || path.join(path.dirname(databasePath), 'assets', 'sha256'));
  const requestedDeviceId = String(options.deviceId || 'windows-main').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestedDeviceId)) throw new Error('Invalid Windows replica device ID.');
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  ensureDirectory(path.dirname(databasePath));
  ensureDirectory(assetsRoot);
  const database = new DatabaseSync(databasePath);
  const existingSchemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version || 0);
  if (existingSchemaVersion > SYNC_SCHEMA_VERSION) {
    database.close();
    throw new SyncProtocolError(
      'REPLICA_DATABASE_TOO_NEW',
      `Replica schema ${existingSchemaVersion} is newer than supported schema ${SYNC_SCHEMA_VERSION}.`,
      409,
    );
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS replica_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replica_entities (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      authority_revision INTEGER NOT NULL DEFAULT 0,
      authority_json TEXT,
      local_document_json TEXT NOT NULL,
      local_deleted INTEGER NOT NULL DEFAULT 0,
      local_revision INTEGER NOT NULL DEFAULT 0,
      asset_hashes_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS replica_outbox (
      operation_id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      client_sequence INTEGER NOT NULL UNIQUE,
      operation_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      last_error_message TEXT,
      receipt_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS replica_outbox_state_idx ON replica_outbox(state, client_sequence);
    CREATE TABLE IF NOT EXISTS replica_assets (
      asset_hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  if (existingSchemaVersion < SYNC_SCHEMA_VERSION) database.exec(`PRAGMA user_version = ${SYNC_SCHEMA_VERSION}`);
  const metaGet = database.prepare('SELECT value FROM replica_meta WHERE key = ?');
  const metaSet = database.prepare('INSERT INTO replica_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const existingDevice = metaGet.get('device_id')?.value;
  if (existingDevice && existingDevice !== requestedDeviceId) {
    database.close();
    throw new Error(`Replica belongs to ${existingDevice}; refusing to open it as ${requestedDeviceId}.`);
  }
  metaSet.run('device_id', requestedDeviceId);
  if (!metaGet.get('next_sequence')) metaSet.run('next_sequence', '1');
  if (!metaGet.get('remote_cursor')) metaSet.run('remote_cursor', '0');

  const statements = {
    entity: database.prepare('SELECT * FROM replica_entities WHERE entity_type = ? AND entity_id = ?'),
    entities: database.prepare('SELECT * FROM replica_entities ORDER BY entity_type, entity_id'),
    upsertEntity: database.prepare(`INSERT INTO replica_entities(entity_type, entity_id, authority_revision, authority_json, local_document_json, local_deleted, local_revision, asset_hashes_json, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET authority_revision=excluded.authority_revision,
      authority_json=excluded.authority_json, local_document_json=excluded.local_document_json,
      local_deleted=excluded.local_deleted, local_revision=excluded.local_revision,
      asset_hashes_json=excluded.asset_hashes_json, updated_at=excluded.updated_at`),
    insertOutbox: database.prepare(`INSERT INTO replica_outbox(operation_id, entity_type, entity_id, client_sequence, operation_json, state, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, 'pending', ?, ?)`),
    pending: database.prepare("SELECT * FROM replica_outbox WHERE state = 'pending' ORDER BY client_sequence ASC LIMIT ?"),
    overlays: database.prepare("SELECT operation_json FROM replica_outbox WHERE entity_type = ? AND entity_id = ? AND state IN ('pending','conflict') ORDER BY client_sequence ASC"),
    outboxById: database.prepare('SELECT * FROM replica_outbox WHERE operation_id = ?'),
    markReceipt: database.prepare("UPDATE replica_outbox SET state = ?, receipt_json = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE operation_id = ?"),
    markAttempt: database.prepare('UPDATE replica_outbox SET attempts = attempts + 1, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE operation_id = ?'),
    rebase: database.prepare("SELECT operation_id, operation_json FROM replica_outbox WHERE entity_type = ? AND entity_id = ? AND state = 'pending' ORDER BY client_sequence ASC"),
    updateOperation: database.prepare('UPDATE replica_outbox SET operation_json = ?, updated_at = ? WHERE operation_id = ?'),
    asset: database.prepare('SELECT * FROM replica_assets WHERE asset_hash = ?'),
    upsertAsset: database.prepare(`INSERT INTO replica_assets(asset_hash, size, mime_type, state, updated_at) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(asset_hash) DO UPDATE SET size=excluded.size, mime_type=excluded.mime_type, state=excluded.state, updated_at=excluded.updated_at`),
    countState: database.prepare('SELECT state, COUNT(*) AS count FROM replica_outbox GROUP BY state'),
    entityStates: database.prepare('SELECT state, COUNT(*) AS count FROM replica_outbox WHERE entity_type = ? AND entity_id = ? GROUP BY state'),
  };

  function transaction(work) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function assetPath(assetHash) {
    const hash = String(assetHash || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid asset hash.');
    return path.join(assetsRoot, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  function storeAssetBytes(bytes, mimeType = 'application/octet-stream') {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const hash = sha256(buffer);
    const target = assetPath(hash);
    ensureDirectory(path.dirname(target));
    if (!fs.existsSync(target)) {
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, buffer, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, target);
    }
    statements.upsertAsset.run(hash, buffer.length, String(mimeType || 'application/octet-stream'), 'local', now().toISOString());
    return { hash, size: buffer.length, mimeType: String(mimeType || 'application/octet-stream'), filePath: target };
  }

  function storeAssetFile(filePath, mimeType = 'application/octet-stream') {
    const source = path.resolve(String(filePath || ''));
    const bytes = fs.readFileSync(source);
    return storeAssetBytes(bytes, mimeType);
  }

  function getAsset(assetHash) {
    const hash = String(assetHash || '').trim().toLowerCase();
    const record = statements.asset.get(hash);
    const filePath = assetPath(hash);
    if (!record || !fs.existsSync(filePath) || fs.statSync(filePath).size !== Number(record.size)) return null;
    return { hash, size: Number(record.size), mimeType: record.mime_type, state: record.state, filePath };
  }

  function entityFromRow(row) {
    if (!row) return null;
    return {
      entityType: row.entity_type,
      entityId: row.entity_id,
      authorityRevision: Number(row.authority_revision),
      document: parseJson(row.local_document_json, {}),
      deleted: Boolean(row.local_deleted),
      localRevision: Number(row.local_revision),
      assetHashes: parseJson(row.asset_hashes_json, []),
      updatedAt: row.updated_at,
    };
  }

  function getEntity(entityType, entityId) {
    return entityFromRow(statements.entity.get(String(entityType), String(entityId)));
  }

  function listEntities() {
    return statements.entities.all().map(entityFromRow);
  }

  function queueMutation(input) {
    const entityType = String(input?.entityType || '').trim();
    const entityId = String(input?.entityId || '').trim();
    const mutation = structuredClone(input?.mutation || {});
    const suppliedAssets = Array.isArray(input?.assets) ? input.assets : [];
    const storedAssets = suppliedAssets.map((asset) => (
      asset?.bytes !== undefined
        ? storeAssetBytes(asset.bytes, asset.mimeType)
        : storeAssetFile(asset.filePath, asset.mimeType)
    ));
    return transaction(() => {
      const currentRow = statements.entity.get(entityType, entityId);
      const current = entityFromRow(currentRow) || {
        entityType,
        entityId,
        authorityRevision: 0,
        document: {},
        deleted: false,
        localRevision: 0,
        assetHashes: [],
      };
      const clientSequence = Number(metaGet.get('next_sequence')?.value || 1);
      const projected = projectMutation(current.document, current.deleted, mutation);
      const operation = validateOperation({
        schemaVersion: 1,
        operationId: String(input?.operationId || crypto.randomUUID()),
        deviceId: requestedDeviceId,
        entityType,
        entityId,
        baseRevision: current.authorityRevision,
        clientSequence,
        createdAt: now().toISOString(),
        assetHashes: normalizeStrings([...current.assetHashes, ...storedAssets.map((asset) => asset.hash)]),
        mutation,
      });
      statements.upsertEntity.run(
        entityType,
        entityId,
        current.authorityRevision,
        currentRow?.authority_json || null,
        canonicalJson(projected.document),
        projected.deleted ? 1 : 0,
        current.localRevision + 1,
        canonicalJson(operation.assetHashes),
        now().toISOString(),
      );
      statements.insertOutbox.run(
        operation.operationId,
        entityType,
        entityId,
        clientSequence,
        canonicalJson(operation),
        operation.createdAt,
        now().toISOString(),
      );
      metaSet.run('next_sequence', String(clientSequence + 1));
      return { operation, entity: getEntity(entityType, entityId), assets: storedAssets };
    });
  }

  function listPending(limit = 100) {
    return statements.pending.all(Math.min(100, Math.max(1, Number(limit) || 100))).map((row) => ({
      operation: parseJson(row.operation_json, null),
      attempts: Number(row.attempts),
      lastErrorCode: row.last_error_code || null,
      lastErrorMessage: row.last_error_message || null,
    }));
  }

  function recordAttempt(operationId, error) {
    statements.markAttempt.run(String(error?.code || 'NETWORK_ERROR'), String(error?.message || error || '').slice(0, 500), now().toISOString(), operationId);
  }

  function rebasePending(entityType, entityId, baseRevision) {
    const rows = statements.rebase.all(entityType, entityId);
    let revision = Number(baseRevision);
    for (const row of rows) {
      const operation = parseJson(row.operation_json, null);
      operation.baseRevision = revision;
      operation.payloadHash = operationPayloadHash(operation);
      statements.updateOperation.run(canonicalJson(operation), now().toISOString(), row.operation_id);
      revision += 1;
    }
  }

  function markReceipt(receipt) {
    return transaction(() => {
      const row = statements.outboxById.get(String(receipt?.operationId || ''));
      if (!row) return false;
      const state = String(receipt.status || '').includes('conflict') ? 'conflict' : 'acknowledged';
      statements.markReceipt.run(state, canonicalJson(receipt), now().toISOString(), row.operation_id);
      rebasePending(row.entity_type, row.entity_id, Number(receipt.revision));
      return true;
    });
  }

  function rebuildProjection(entityType, entityId, authorityEntity) {
    let projected = {
      document: structuredClone(authorityEntity?.document || {}),
      deleted: Boolean(authorityEntity?.deleted),
    };
    for (const row of statements.overlays.all(entityType, entityId)) {
      const operation = parseJson(row.operation_json, null);
      if (!operation) continue;
      try { projected = projectMutation(projected.document, projected.deleted, operation.mutation); } catch {}
    }
    return projected;
  }

  function applyRemoteEvents(events, nextCursor) {
    return transaction(() => {
      let cursor = Number(metaGet.get('remote_cursor')?.value || 0);
      for (const event of Array.isArray(events) ? events : []) {
        const eventCursor = Number(event?.cursor);
        if (!Number.isSafeInteger(eventCursor) || eventCursor <= cursor) continue;
        if (eventCursor !== cursor + 1) {
          throw new SyncProtocolError('REMOTE_CURSOR_GAP', `Expected event cursor ${cursor + 1} but received ${eventCursor}.`, 409);
        }
        if (event.entity && event.entityType !== 'asset') {
          const authority = event.entity;
          const current = entityFromRow(statements.entity.get(event.entityType, event.entityId));
          const projected = rebuildProjection(event.entityType, event.entityId, authority);
          statements.upsertEntity.run(
            event.entityType,
            event.entityId,
            Number(authority.revision),
            canonicalJson(authority),
            canonicalJson(projected.document),
            projected.deleted ? 1 : 0,
            current?.localRevision || 0,
            canonicalJson(authority.assetHashes || []),
            authority.updatedAt || now().toISOString(),
          );
        }
        cursor = eventCursor;
      }
      const claimedCursor = Number(nextCursor);
      if (Number.isSafeInteger(claimedCursor) && claimedCursor !== cursor) {
        throw new SyncProtocolError('REMOTE_CURSOR_MISMATCH', 'Event page cursor does not match its last event.', 409);
      }
      metaSet.run('remote_cursor', String(cursor));
      return cursor;
    });
  }

  function getRemoteCursor() {
    return Number(metaGet.get('remote_cursor')?.value || 0);
  }

  function getMaterializedCursor(scope = 'learning') {
    return Number(metaGet.get(`materialized_cursor:${String(scope)}`)?.value || 0);
  }

  function markMaterializedCursor(cursor, scope = 'learning') {
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0 || value > getRemoteCursor()) throw new Error('Invalid materialized cursor.');
    metaSet.run(`materialized_cursor:${String(scope)}`, String(value));
    return value;
  }

  function status() {
    const counts = Object.fromEntries(statements.countState.all().map((row) => [row.state, Number(row.count)]));
    return {
      deviceId: requestedDeviceId,
      remoteCursor: getRemoteCursor(),
      pending: counts.pending || 0,
      conflicts: counts.conflict || 0,
      acknowledged: counts.acknowledged || 0,
    };
  }

  function entityStatus(entityType, entityId) {
    const counts = Object.fromEntries(statements.entityStates.all(String(entityType), String(entityId)).map((row) => [row.state, Number(row.count)]));
    if (counts.conflict) return { state: 'conflict', pending: counts.pending || 0, conflicts: counts.conflict };
    if (counts.pending) return { state: 'queued', pending: counts.pending, conflicts: 0 };
    if (counts.acknowledged) return { state: 'acknowledged', pending: 0, conflicts: 0 };
    return { state: 'local', pending: 0, conflicts: 0 };
  }

  function close() {
    database.close();
  }

  return {
    applyRemoteEvents,
    assetPath,
    close,
    databasePath,
    deviceId: requestedDeviceId,
    entityStatus,
    getAsset,
    getEntity,
    getMaterializedCursor,
    listEntities,
    getRemoteCursor,
    listPending,
    markReceipt,
    markMaterializedCursor,
    queueMutation,
    recordAttempt,
    status,
    storeAssetBytes,
  };
}

module.exports = { createWindowsReplicaStore, projectMutation };
