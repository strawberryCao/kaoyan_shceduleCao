const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SYNC_SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;
const DEFAULT_ASSET_LIMIT = 256 * 1024 * 1024;

class SyncProtocolError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message);
    this.name = 'SyncProtocolError';
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function operationPayloadHash(operation) {
  const { payloadHash: _ignored, ...rawPayload } = operation || {};
  const payload = clone(rawPayload);
  payload.schemaVersion = Number(payload.schemaVersion);
  payload.baseRevision = Number(payload.baseRevision);
  payload.clientSequence = Number(payload.clientSequence);
  payload.assetHashes = normalizeStringArray(payload.assetHashes).map((hash) => String(hash).toLowerCase());
  if (isObject(payload.mutation)) {
    payload.mutation.source = String(payload.mutation.source || 'human').trim();
    if (payload.mutation.kind === 'patch') {
      payload.mutation.fields = isObject(payload.mutation.fields) ? payload.mutation.fields : {};
      payload.mutation.unset = normalizeStringArray(payload.mutation.unset);
      payload.mutation.sets = isObject(payload.mutation.sets) ? payload.mutation.sets : {};
      for (const [key, delta] of Object.entries(payload.mutation.sets)) {
        payload.mutation.sets[key] = {
          add: normalizeStringArray(delta?.add),
          remove: normalizeStringArray(delta?.remove),
        };
      }
    }
  }
  return sha256(canonicalJson(payload));
}

function normalizeStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function assertIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!ID_PATTERN.test(normalized)) {
    throw new SyncProtocolError('INVALID_IDENTIFIER', `${label} is invalid.`);
  }
  return normalized;
}

function assertAssetHash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new SyncProtocolError('INVALID_ASSET_HASH', 'Asset hash must be a lowercase SHA-256 value.');
  }
  return normalized;
}

function validateOperation(input) {
  if (!isObject(input)) throw new SyncProtocolError('INVALID_OPERATION', 'Operation must be an object.');
  const calculatedHash = operationPayloadHash(input);
  const suppliedHash = String(input.payloadHash || '').trim().toLowerCase();
  if (suppliedHash && suppliedHash !== calculatedHash) {
    throw new SyncProtocolError('PAYLOAD_HASH_MISMATCH', 'Operation payload hash does not match its contents.');
  }
  const operation = clone(input);
  if (Number(operation.schemaVersion) !== SYNC_SCHEMA_VERSION) {
    throw new SyncProtocolError('UNSUPPORTED_SYNC_SCHEMA', `Unsupported sync schema: ${String(operation.schemaVersion)}.`);
  }
  operation.operationId = assertIdentifier(operation.operationId, 'operationId');
  operation.deviceId = assertIdentifier(operation.deviceId, 'deviceId');
  operation.entityType = assertIdentifier(operation.entityType, 'entityType');
  operation.entityId = assertIdentifier(operation.entityId, 'entityId');
  operation.baseRevision = Number(operation.baseRevision);
  operation.clientSequence = Number(operation.clientSequence);
  if (!Number.isInteger(operation.baseRevision) || operation.baseRevision < 0) {
    throw new SyncProtocolError('INVALID_BASE_REVISION', 'baseRevision must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(operation.clientSequence) || operation.clientSequence <= 0) {
    throw new SyncProtocolError('INVALID_CLIENT_SEQUENCE', 'clientSequence must be a positive safe integer.');
  }
  const createdAt = Date.parse(String(operation.createdAt || ''));
  if (!Number.isFinite(createdAt)) throw new SyncProtocolError('INVALID_CREATED_AT', 'createdAt must be an ISO timestamp.');
  operation.createdAt = new Date(createdAt).toISOString();
  operation.assetHashes = normalizeStringArray(operation.assetHashes).map(assertAssetHash);
  if (!isObject(operation.mutation)) throw new SyncProtocolError('INVALID_MUTATION', 'mutation must be an object.');
  const kind = String(operation.mutation.kind || '').trim();
  if (!['patch', 'delete', 'restore'].includes(kind)) {
    throw new SyncProtocolError('INVALID_MUTATION_KIND', `Unsupported mutation kind: ${kind || '(empty)'}.`);
  }
  const source = String(operation.mutation.source || 'human').trim();
  if (!['human', 'ai', 'system'].includes(source)) {
    throw new SyncProtocolError('INVALID_MUTATION_SOURCE', `Unsupported mutation source: ${source}.`);
  }
  operation.mutation.kind = kind;
  operation.mutation.source = source;
  if (kind === 'patch') {
    operation.mutation.fields = isObject(operation.mutation.fields) ? operation.mutation.fields : {};
    operation.mutation.unset = normalizeStringArray(operation.mutation.unset);
    operation.mutation.sets = isObject(operation.mutation.sets) ? operation.mutation.sets : {};
    for (const key of [...Object.keys(operation.mutation.fields), ...operation.mutation.unset, ...Object.keys(operation.mutation.sets)]) {
      assertIdentifier(key, 'field');
    }
    for (const [key, delta] of Object.entries(operation.mutation.sets)) {
      if (!isObject(delta)) throw new SyncProtocolError('INVALID_SET_DELTA', `Set delta for ${key} must be an object.`);
      operation.mutation.sets[key] = {
        add: normalizeStringArray(delta.add),
        remove: normalizeStringArray(delta.remove),
      };
    }
    const fieldGroups = [
      ...Object.keys(operation.mutation.fields),
      ...operation.mutation.unset,
      ...Object.keys(operation.mutation.sets),
    ];
    if (new Set(fieldGroups).size !== fieldGroups.length) {
      throw new SyncProtocolError('AMBIGUOUS_FIELD_MUTATION', 'A field may appear in only one patch operation group.');
    }
  }
  operation.payloadHash = calculatedHash;
  return operation;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : clone(fallback);
  } catch {
    return clone(fallback);
  }
}

function serializeEntityRow(row) {
  if (!row) return null;
  return {
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: Number(row.revision),
    deleted: Boolean(row.deleted),
    document: parseJson(row.document_json, {}),
    fieldClocks: parseJson(row.field_clocks_json, {}),
    assetHashes: parseJson(row.asset_hashes_json, []),
    updatedAt: row.updated_at,
  };
}

function conflictWinner(currentSource, incomingSource) {
  if (currentSource === 'human' && incomingSource !== 'human') return 'current';
  if (incomingSource === 'human' && currentSource !== 'human') return 'incoming';
  if (currentSource === 'system' && incomingSource === 'ai') return 'current';
  if (incomingSource === 'system' && currentSource === 'ai') return 'incoming';
  return currentSource === 'human' && incomingSource === 'human' ? 'conflict' : 'current';
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function atomicWriteBuffer(filePath, buffer) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function createSyncStore(options = {}) {
  const databasePath = path.resolve(options.databasePath || 'sync.sqlite');
  const assetsRoot = path.resolve(options.assetsRoot || path.join(path.dirname(databasePath), 'assets', 'sha256'));
  const maxAssetBytes = Number(options.maxAssetBytes || DEFAULT_ASSET_LIMIT);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  ensurePrivateDirectory(path.dirname(databasePath));
  ensurePrivateDirectory(assetsRoot);
  const database = new DatabaseSync(databasePath);
  const existingSchemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version || 0);
  if (existingSchemaVersion > SYNC_SCHEMA_VERSION) {
    database.close();
    throw new SyncProtocolError(
      'SYNC_DATABASE_TOO_NEW',
      `Sync database schema ${existingSchemaVersion} is newer than supported schema ${SYNC_SCHEMA_VERSION}.`,
      409,
    );
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_devices (
      device_id TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_entities (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      document_json TEXT NOT NULL,
      field_clocks_json TEXT NOT NULL,
      asset_hashes_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS sync_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      device_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      operation_id TEXT,
      device_id TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_json TEXT,
      asset_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_events_entity_idx ON sync_events(entity_type, entity_id, cursor);
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      conflict_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      current_json TEXT,
      incoming_json TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution_operation_id TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_assets (
      asset_hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const conflictColumns = new Set(database.prepare('PRAGMA table_info(sync_conflicts)').all().map((column) => column.name));
  if (!conflictColumns.has('resolved_at')) database.exec('ALTER TABLE sync_conflicts ADD COLUMN resolved_at TEXT');
  if (!conflictColumns.has('resolution_operation_id')) database.exec('ALTER TABLE sync_conflicts ADD COLUMN resolution_operation_id TEXT');
  if (existingSchemaVersion < SYNC_SCHEMA_VERSION) database.exec(`PRAGMA user_version = ${SYNC_SCHEMA_VERSION}`);

  const statements = {
    operation: database.prepare('SELECT payload_hash, receipt_json FROM sync_operations WHERE operation_id = ?'),
    entity: database.prepare('SELECT * FROM sync_entities WHERE entity_type = ? AND entity_id = ?'),
    entities: database.prepare('SELECT * FROM sync_entities ORDER BY entity_type, entity_id'),
    device: database.prepare('SELECT last_sequence FROM sync_devices WHERE device_id = ?'),
    upsertDevice: database.prepare(`INSERT INTO sync_devices(device_id, last_sequence, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence, updated_at=excluded.updated_at`),
    upsertEntity: database.prepare(`INSERT INTO sync_entities(entity_type, entity_id, revision, deleted, document_json, field_clocks_json, asset_hashes_json, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET revision=excluded.revision, deleted=excluded.deleted,
      document_json=excluded.document_json, field_clocks_json=excluded.field_clocks_json,
      asset_hashes_json=excluded.asset_hashes_json, updated_at=excluded.updated_at`),
    insertOperation: database.prepare('INSERT INTO sync_operations(operation_id, payload_hash, device_id, receipt_json, created_at) VALUES(?, ?, ?, ?, ?)'),
    insertEvent: database.prepare(`INSERT INTO sync_events(event_id, operation_id, device_id, event_type, entity_type, entity_id, entity_json, asset_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertConflict: database.prepare(`INSERT INTO sync_conflicts(conflict_id, operation_id, entity_type, entity_id, field_name, current_json, incoming_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`),
    asset: database.prepare('SELECT asset_hash, size, mime_type, created_at FROM sync_assets WHERE asset_hash = ?'),
    insertAsset: database.prepare('INSERT OR IGNORE INTO sync_assets(asset_hash, size, mime_type, created_at) VALUES(?, ?, ?, ?)'),
    events: database.prepare('SELECT * FROM sync_events WHERE cursor > ? ORDER BY cursor ASC LIMIT ?'),
    openConflicts: database.prepare("SELECT * FROM sync_conflicts WHERE status = 'open' AND entity_type = ? AND entity_id = ? ORDER BY created_at ASC"),
    conflict: database.prepare('SELECT * FROM sync_conflicts WHERE conflict_id = ?'),
    resolveConflict: database.prepare("UPDATE sync_conflicts SET status = 'resolved', resolved_at = ?, resolution_operation_id = ? WHERE conflict_id = ? AND status = 'open'"),
    status: database.prepare(`SELECT
      (SELECT COUNT(*) FROM sync_entities) AS entity_count,
      (SELECT COUNT(*) FROM sync_entities WHERE deleted = 1) AS tombstone_count,
      (SELECT COUNT(*) FROM sync_operations) AS operation_count,
      (SELECT COUNT(*) FROM sync_conflicts WHERE status = 'open') AS open_conflict_count,
      (SELECT COUNT(*) FROM sync_assets) AS asset_count,
      (SELECT COUNT(*) FROM sync_devices) AS device_count,
      (SELECT COALESCE(MAX(cursor), 0) FROM sync_events) AS latest_cursor`),
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
    const hash = assertAssetHash(assetHash);
    return path.join(assetsRoot, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  function hasAsset(assetHash) {
    const hash = assertAssetHash(assetHash);
    const record = statements.asset.get(hash);
    return Boolean(record && fs.existsSync(assetPath(hash)) && fs.statSync(assetPath(hash)).size === Number(record.size));
  }

  function missingAssets(hashes) {
    return normalizeStringArray(hashes).map(assertAssetHash).filter((hash) => !hasAsset(hash));
  }

  function getEntity(entityType, entityId) {
    return serializeEntityRow(statements.entity.get(assertIdentifier(entityType, 'entityType'), assertIdentifier(entityId, 'entityId')));
  }

  function listEntities() {
    return statements.entities.all().map(serializeEntityRow);
  }

  function queueLocalMutation(input) {
    const deviceId = assertIdentifier(input?.deviceId || 'mac-local', 'deviceId');
    const entityType = assertIdentifier(input?.entityType, 'entityType');
    const entityId = assertIdentifier(input?.entityId, 'entityId');
    const storedAssets = (Array.isArray(input?.assets) ? input.assets : []).map((asset) => {
      const bytes = asset?.bytes !== undefined ? Buffer.from(asset.bytes) : fs.readFileSync(path.resolve(String(asset?.filePath || '')));
      const hash = sha256(bytes);
      putAsset(hash, bytes, asset?.mimeType || 'application/octet-stream');
      return hash;
    });
    const device = statements.device.get(deviceId);
    const current = getEntity(entityType, entityId);
    const operation = validateOperation({
      schemaVersion: SYNC_SCHEMA_VERSION,
      operationId: String(input?.operationId || crypto.randomUUID()),
      deviceId,
      entityType,
      entityId,
      baseRevision: current?.revision || 0,
      clientSequence: Number(device?.last_sequence || 0) + 1,
      createdAt: now().toISOString(),
      assetHashes: normalizeStringArray([...(current?.assetHashes || []), ...storedAssets]),
      mutation: input?.mutation,
    });
    return { operation, receipt: applyOperation(operation), assets: storedAssets };
  }

  function recordConflict(operation, field, currentValue, incomingValue, createdAt) {
    const conflictId = sha256(`${operation.operationId}\0${field}`).slice(0, 32);
    statements.insertConflict.run(
      conflictId,
      operation.operationId,
      operation.entityType,
      operation.entityId,
      field,
      canonicalJson(currentValue) ?? 'null',
      canonicalJson(incomingValue) ?? 'null',
      createdAt,
    );
    return { conflictId, field, current: clone(currentValue), incoming: clone(incomingValue) };
  }

  function applyOperation(input) {
    const operation = validateOperation(input);
    return transaction(() => {
      const replay = statements.operation.get(operation.operationId);
      if (replay) {
        if (replay.payload_hash !== operation.payloadHash) {
          throw new SyncProtocolError('OPERATION_ID_REUSED', 'operationId was reused with different content.', 409);
        }
        return parseJson(replay.receipt_json, {});
      }

      const device = statements.device.get(operation.deviceId);
      if (device && operation.clientSequence <= Number(device.last_sequence)) {
        throw new SyncProtocolError('CLIENT_SEQUENCE_REPLAY', 'Unknown operation uses an already consumed client sequence.', 409, {
          lastSequence: Number(device.last_sequence),
        });
      }

      const current = serializeEntityRow(statements.entity.get(operation.entityType, operation.entityId));
      const previousRevision = current?.revision || 0;
      if (operation.baseRevision > previousRevision) {
        throw new SyncProtocolError('BASE_REVISION_AHEAD', 'baseRevision is newer than the Mac authority.', 409, {
          currentRevision: previousRevision,
        });
      }
      if (current?.deleted && operation.mutation.kind === 'patch') {
        throw new SyncProtocolError('ENTITY_DELETED', 'A deleted entity can only be changed after an explicit restore.', 409, {
          currentRevision: previousRevision,
        });
      }
      if (operation.mutation.kind === 'restore' && (!current?.deleted || operation.baseRevision !== previousRevision)) {
        throw new SyncProtocolError('RESTORE_REVISION_REQUIRED', 'Restore requires the current tombstone revision.', 409, {
          currentRevision: previousRevision,
        });
      }

      const timestamp = now().toISOString();
      const document = clone(current?.document || {});
      const clocks = clone(current?.fieldClocks || {});
      const conflicts = [];
      const protectedFields = [];
      let deleted = Boolean(current?.deleted);
      let changed = false;

      const applyField = (field, incomingValue, unset = false, mergeable = false) => {
        const currentClock = clocks[field];
        const currentValue = document[field];
        if (!mergeable && currentClock && Number(currentClock.revision) > operation.baseRevision && canonicalJson(currentValue) !== canonicalJson(incomingValue)) {
          const winner = conflictWinner(String(currentClock.source || 'system'), operation.mutation.source);
          if (winner === 'conflict') {
            conflicts.push(recordConflict(operation, field, currentValue, incomingValue, timestamp));
            return;
          }
          if (winner === 'current') {
            protectedFields.push(field);
            return;
          }
        }
        if (unset) {
          if (Object.hasOwn(document, field)) {
            delete document[field];
            changed = true;
          }
        } else if (canonicalJson(currentValue) !== canonicalJson(incomingValue)) {
          document[field] = clone(incomingValue);
          changed = true;
        }
        clocks[field] = {
          deviceId: operation.deviceId,
          clientSequence: operation.clientSequence,
          revision: previousRevision + 1,
          source: operation.mutation.source,
        };
      };

      if (operation.mutation.kind === 'delete') {
        if (!deleted) changed = true;
        deleted = true;
      } else if (operation.mutation.kind === 'restore') {
        deleted = false;
        changed = true;
      } else {
        for (const [field, value] of Object.entries(operation.mutation.fields)) applyField(field, value);
        for (const field of operation.mutation.unset) applyField(field, undefined, true);
        for (const [field, delta] of Object.entries(operation.mutation.sets)) {
          const values = new Set(normalizeStringArray(document[field]));
          for (const value of delta.add) values.add(value);
          for (const value of delta.remove) values.delete(value);
          applyField(field, [...values].sort((left, right) => left.localeCompare(right)), false, true);
        }
      }

      const assetHashes = normalizeStringArray([
        ...(current?.assetHashes || []),
        ...operation.assetHashes,
      ]).map(assertAssetHash);
      if (canonicalJson(assetHashes) !== canonicalJson(current?.assetHashes || [])) changed = true;
      let entity = current;
      let eventCursor = null;
      if (changed) {
        const revision = previousRevision + 1;
        for (const clock of Object.values(clocks)) {
          if (clock && clock.revision === previousRevision + 1 && clock.deviceId === operation.deviceId && clock.clientSequence === operation.clientSequence) {
            clock.revision = revision;
          }
        }
        entity = {
          entityType: operation.entityType,
          entityId: operation.entityId,
          revision,
          deleted,
          document,
          fieldClocks: clocks,
          assetHashes,
          updatedAt: timestamp,
        };
        statements.upsertEntity.run(
          entity.entityType,
          entity.entityId,
          entity.revision,
          entity.deleted ? 1 : 0,
          canonicalJson(entity.document),
          canonicalJson(entity.fieldClocks),
          canonicalJson(entity.assetHashes),
          entity.updatedAt,
        );
        const eventId = crypto.randomUUID();
        const eventResult = statements.insertEvent.run(
          eventId,
          operation.operationId,
          operation.deviceId,
          operation.mutation.kind === 'patch' ? 'entity.changed' : `entity.${operation.mutation.kind}d`,
          entity.entityType,
          entity.entityId,
          canonicalJson(entity),
          null,
          timestamp,
        );
        eventCursor = Number(eventResult.lastInsertRowid);
      }

      const receipt = {
        schemaVersion: SYNC_SCHEMA_VERSION,
        operationId: operation.operationId,
        payloadHash: operation.payloadHash,
        status: conflicts.length > 0 ? (changed ? 'applied_with_conflicts' : 'conflict') : 'applied',
        entityType: operation.entityType,
        entityId: operation.entityId,
        previousRevision,
        revision: entity?.revision || previousRevision,
        eventCursor,
        missingAssets: missingAssets(assetHashes),
        conflicts,
        protectedFields,
        acceptedAt: timestamp,
      };
      statements.upsertDevice.run(operation.deviceId, operation.clientSequence, timestamp);
      statements.insertOperation.run(operation.operationId, operation.payloadHash, operation.deviceId, canonicalJson(receipt), timestamp);
      return receipt;
    });
  }

  function putAsset(assetHash, body, mimeType = 'application/octet-stream') {
    const hash = assertAssetHash(assetHash);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buffer.length > maxAssetBytes) {
      throw new SyncProtocolError('ASSET_TOO_LARGE', `Asset exceeds the ${maxAssetBytes} byte limit.`, 413);
    }
    if (sha256(buffer) !== hash) {
      throw new SyncProtocolError('ASSET_HASH_MISMATCH', 'Uploaded bytes do not match the requested SHA-256 hash.', 422);
    }
    const target = assetPath(hash);
    if (!fs.existsSync(target)) atomicWriteBuffer(target, buffer);
    const timestamp = now().toISOString();
    return transaction(() => {
      const existing = statements.asset.get(hash);
      if (!existing) {
        statements.insertAsset.run(hash, buffer.length, String(mimeType || 'application/octet-stream').slice(0, 255), timestamp);
        const eventResult = statements.insertEvent.run(
          crypto.randomUUID(),
          null,
          null,
          'asset.available',
          'asset',
          hash,
          null,
          canonicalJson({ hash, size: buffer.length, mimeType: String(mimeType || 'application/octet-stream').slice(0, 255) }),
          timestamp,
        );
        return { hash, size: buffer.length, created: true, eventCursor: Number(eventResult.lastInsertRowid) };
      }
      if (Number(existing.size) !== buffer.length) {
        throw new SyncProtocolError('ASSET_RECORD_MISMATCH', 'Stored asset metadata does not match the uploaded bytes.', 409);
      }
      return { hash, size: buffer.length, created: false, eventCursor: null };
    });
  }

  function getAsset(assetHash) {
    const hash = assertAssetHash(assetHash);
    const record = statements.asset.get(hash);
    if (!record || !hasAsset(hash)) return null;
    return {
      hash,
      size: Number(record.size),
      mimeType: record.mime_type,
      createdAt: record.created_at,
      filePath: assetPath(hash),
    };
  }

  function readEvents(afterCursor = 0, requestedLimit = DEFAULT_EVENT_LIMIT) {
    const after = Number(afterCursor);
    const limit = Math.min(MAX_EVENT_LIMIT, Math.max(1, Number(requestedLimit) || DEFAULT_EVENT_LIMIT));
    if (!Number.isSafeInteger(after) || after < 0) throw new SyncProtocolError('INVALID_CURSOR', 'Cursor must be a non-negative integer.');
    const rows = statements.events.all(after, limit);
    const events = rows.map((row) => ({
      cursor: Number(row.cursor),
      eventId: row.event_id,
      operationId: row.operation_id || null,
      deviceId: row.device_id || null,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entity: parseJson(row.entity_json, null),
      asset: parseJson(row.asset_json, null),
      createdAt: row.created_at,
    }));
    const nextCursor = events.length > 0 ? events[events.length - 1].cursor : after;
    return { events, nextCursor, hasMore: events.length === limit };
  }

  function getOpenConflicts(entityType, entityId) {
    return statements.openConflicts.all(assertIdentifier(entityType, 'entityType'), assertIdentifier(entityId, 'entityId')).map((row) => ({
      conflictId: row.conflict_id,
      operationId: row.operation_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      field: row.field_name,
      current: parseJson(row.current_json, null),
      incoming: parseJson(row.incoming_json, null),
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  function getStatus() {
    const row = statements.status.get();
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      authority: true,
      role: 'mac-authority',
      entityCount: Number(row.entity_count),
      tombstoneCount: Number(row.tombstone_count),
      operationCount: Number(row.operation_count),
      openConflictCount: Number(row.open_conflict_count),
      assetCount: Number(row.asset_count),
      seenDeviceCount: Number(row.device_count),
      latestCursor: Number(row.latest_cursor),
    };
  }

  function resolveConflict(conflictId, input) {
    const id = assertIdentifier(conflictId, 'conflictId');
    const conflict = statements.conflict.get(id);
    if (!conflict || conflict.status !== 'open') {
      throw new SyncProtocolError('SYNC_CONFLICT_NOT_FOUND', 'Open sync conflict was not found.', 404);
    }
    const operation = validateOperation(input);
    const field = conflict.field_name;
    if (
      operation.entityType !== conflict.entity_type
      || operation.entityId !== conflict.entity_id
      || operation.mutation.kind !== 'patch'
      || operation.mutation.source !== 'human'
      || !Object.hasOwn(operation.mutation.fields, field)
    ) {
      throw new SyncProtocolError('INVALID_CONFLICT_RESOLUTION', `Resolution must explicitly set the conflicted field ${field}.`);
    }
    const receipt = applyOperation(operation);
    if (receipt.status.includes('conflict')) {
      throw new SyncProtocolError('CONFLICT_RESOLUTION_STALE', 'The entity changed again; reload the conflict before resolving it.', 409, {
        currentRevision: receipt.revision,
      });
    }
    transaction(() => statements.resolveConflict.run(now().toISOString(), operation.operationId, id));
    return { conflictId: id, receipt };
  }

  function close() {
    database.close();
  }

  return {
    applyOperation,
    assetPath,
    close,
    databasePath,
    getAsset,
    getEntity,
    getOpenConflicts,
    getStatus,
    hasAsset,
    missingAssets,
    listEntities,
    putAsset,
    queueLocalMutation,
    readEvents,
    resolveConflict,
  };
}

module.exports = {
  DEFAULT_ASSET_LIMIT,
  SYNC_SCHEMA_VERSION,
  SyncProtocolError,
  canonicalJson,
  createSyncStore,
  operationPayloadHash,
  sha256,
  validateOperation,
};
