const crypto = require('node:crypto');
const path = require('node:path');
const { canonicalJson } = require('./sync-core.cjs');

const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/;
const SYNC_ASSET_PATTERN = /^sync-asset:\/\/sha256\/([a-f0-9]{64})\?mime=(.+)$/;

function portableCanvas(value, assets = [], key = '') {
  if (typeof value === 'string') {
    const dataUrl = DATA_URL_PATTERN.exec(value);
    if (dataUrl) {
      const bytes = Buffer.from(dataUrl[2].replace(/\s/g, ''), 'base64');
      const hash = require('./sync-core.cjs').sha256(bytes);
      assets.push({ bytes, mimeType: dataUrl[1] });
      return `sync-asset://sha256/${hash}?mime=${encodeURIComponent(dataUrl[1])}`;
    }
    if (/path$/i.test(key) && (path.isAbsolute(value) || path.win32.isAbsolute(value))) return undefined;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => portableCanvas(item, assets)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    const portable = portableCanvas(child, assets, childKey);
    if (portable !== undefined) result[childKey] = portable;
  }
  return result;
}

function hydrateCanvas(value, source) {
  if (typeof value === 'string') {
    const match = SYNC_ASSET_PATTERN.exec(value);
    if (!match) return value;
    const asset = source.getAsset(match[1]);
    if (!asset) {
      const error = new Error(`Synchronized canvas asset is missing: ${match[1]}`);
      error.code = 'SYNC_CANVAS_ASSET_MISSING';
      throw error;
    }
    const bytes = require('node:fs').readFileSync(asset.filePath);
    return `data:${decodeURIComponent(match[2])};base64,${bytes.toString('base64')}`;
  }
  if (Array.isArray(value)) return value.map((item) => hydrateCanvas(item, source));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, hydrateCanvas(child, source)]));
}

function changedFields(previous, next) {
  const fields = {};
  const unset = [];
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  for (const key of keys) {
    if (!Object.hasOwn(next || {}, key)) unset.push(key);
    else if (canonicalJson(previous?.[key]) !== canonicalJson(next[key])) fields[key] = structuredClone(next[key]);
  }
  return { fields, unset };
}

function createCanvasSyncBridge(options) {
  const target = options.target;
  const deviceId = options.deviceId || null;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  if (!target) throw new Error('Canvas sync bridge requires a mutation target.');
  const queue = (input) => deviceId && typeof target.queueLocalMutation === 'function'
    ? target.queueLocalMutation({ ...input, deviceId })
    : target.queueMutation(input);

  function captureSave(previous, next, saveOptions = {}) {
    if (saveOptions.skipSyncCapture === true) return null;
    try {
      const previousPortable = portableCanvas(previous || {});
      const assets = [];
      const nextPortable = portableCanvas(next, assets);
      const entityId = String(next.id);
      const existing = target.getEntity('canvas-project', entityId);
      if (!previous && existing?.deleted) {
        queue({ entityType: 'canvas-project', entityId, mutation: { kind: 'restore', source: 'human' } });
      }
      const patch = changedFields(previousPortable, nextPortable);
      if (!Object.keys(patch.fields).length && !patch.unset.length) return null;
      return queue({
        operationId: crypto.randomUUID(),
        entityType: 'canvas-project',
        entityId,
        mutation: { kind: 'patch', source: saveOptions.syncSource === 'ai' ? 'ai' : 'human', ...patch },
        assets,
      });
    } catch (error) {
      onError(error);
      throw error;
    }
  }

  function captureDelete(result) {
    try {
      return queue({
        operationId: crypto.randomUUID(),
        entityType: 'canvas-project',
        entityId: String(result.document.id),
        mutation: { kind: 'delete', source: 'human' },
      });
    } catch (error) {
      onError(error);
      throw error;
    }
  }

  return { captureDelete, captureSave };
}

function createCanvasMaterializer(options) {
  const source = options.source;
  const canvasStore = options.canvasStore;
  const cursorScope = options.cursorScope || '';
  if (!source || !canvasStore) throw new Error('Canvas materializer requires source and canvas store.');

  function reconcile(force = false) {
    const remoteCursor = cursorScope ? source.getRemoteCursor() : null;
    if (cursorScope && !force && source.getMaterializedCursor(cursorScope) === remoteCursor) {
      return { changed: 0, entities: 0, cursor: remoteCursor };
    }
    const entities = source.listEntities().filter((entity) => entity.entityType === 'canvas-project');
    let changed = 0;
    const events = [];
    for (const entity of entities) {
      const current = canvasStore.readDocument(entity.entityId, { validate: false });
      if (entity.deleted) {
        if (current) {
          canvasStore.deleteDocument(entity.entityId, { skipSyncCapture: true, syncSource: 'system' });
          changed += 1;
          events.push({
            type: 'deleted',
            projectId: entity.entityId,
            revision: Number(current.syncRevision || entity.revision || 0),
            updatedAt: entity.updatedAt,
          });
        }
        continue;
      }
      const document = hydrateCanvas({
        ...entity.document,
        id: entity.entityId,
        syncRevision: entity.revision,
        updatedAt: entity.updatedAt || entity.document?.updatedAt,
      }, source);
      if (canonicalJson(current) === canonicalJson(document)) continue;
      const saved = canvasStore.saveDocument(document, { canvasId: entity.entityId, skipSyncCapture: true, syncSource: 'system' });
      changed += 1;
      events.push({
        type: 'saved',
        projectId: entity.entityId,
        revision: Number(saved.syncRevision || entity.revision || 0),
        updatedAt: saved.updatedAt,
      });
    }
    if (cursorScope) source.markMaterializedCursor(remoteCursor, cursorScope);
    return { changed, entities: entities.length, events, ...(cursorScope ? { cursor: remoteCursor } : {}) };
  }

  return { reconcile };
}

module.exports = {
  createCanvasMaterializer,
  createCanvasSyncBridge,
  hydrateCanvas,
  portableCanvas,
};
