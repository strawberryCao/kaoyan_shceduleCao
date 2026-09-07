const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCanvasDocumentStore } = require('../canvas-document-store.cjs');
const { createCanvasMaterializer, createCanvasSyncBridge } = require('../replica-canvas-sync.cjs');
const { createSyncStore } = require('../sync-core.cjs');
const { createWindowsReplicaStore } = require('../windows-replica-store.cjs');

function document(overrides = {}) {
  return {
    id: 'canvas-sync-1',
    version: 1,
    title: '离线画布',
    createdAt: '2026-09-05T08:00:00.000Z',
    updatedAt: '2026-09-05T08:01:00.000Z',
    syncRevision: 1,
    images: [{
      id: 'image-a',
      src: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
      name: '题目.png',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      naturalWidth: 600,
      naturalHeight: 400,
      z: 1,
    }],
    texts: [],
    anchors: [],
    annotations: [],
    strokes: [],
    groups: [],
    relations: [],
    viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
    futureField: { preserved: true },
    ...overrides,
  };
}

test('canvas images become immutable assets and materialize losslessly on Mac', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-canvas-sync-'));
  const replica = createWindowsReplicaStore({
    databasePath: path.join(root, 'replica.sqlite'),
    assetsRoot: path.join(root, 'replica-assets'),
    deviceId: 'windows-main',
  });
  const bridge = createCanvasSyncBridge({ target: replica });
  const windowsCanvas = createCanvasDocumentStore({
    rootDir: path.join(root, 'windows-canvas'),
    onSaved: bridge.captureSave,
    onDeleted: bridge.captureDelete,
  });
  const authority = createSyncStore({
    databasePath: path.join(root, 'authority.sqlite'),
    assetsRoot: path.join(root, 'authority-assets'),
  });
  const macCanvas = createCanvasDocumentStore({ rootDir: path.join(root, 'mac-canvas') });
  const materializer = createCanvasMaterializer({ source: authority, canvasStore: macCanvas });
  t.after(() => {
    replica.close();
    authority.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  windowsCanvas.saveDocument(document());
  const pending = replica.listPending()[0].operation;
  assert.equal(pending.assetHashes.length, 1);
  assert.doesNotMatch(JSON.stringify(pending), /aW1hZ2UtYnl0ZXM=/);
  assert.match(pending.mutation.fields.images[0].src, /^sync-asset:\/\/sha256\//);
  for (const hash of pending.assetHashes) {
    const asset = replica.getAsset(hash);
    authority.putAsset(hash, fs.readFileSync(asset.filePath), asset.mimeType);
  }
  authority.applyOperation(pending);
  const materialized = materializer.reconcile();
  assert.equal(materialized.changed, 1);
  assert.deepEqual(materialized.events.map((event) => ({ type: event.type, projectId: event.projectId, revision: event.revision })), [
    { type: 'saved', projectId: 'canvas-sync-1', revision: 1 },
  ]);
  const restored = macCanvas.readDocument('canvas-sync-1');
  assert.equal(restored.images[0].src, document().images[0].src);
  assert.deepEqual(restored.futureField, { preserved: true });
  assert.equal(materializer.reconcile().changed, 0);
});

test('canvas callback failures do not roll back the durable local project', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-canvas-callback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failures = [];
  const store = createCanvasDocumentStore({
    rootDir: path.join(root, 'canvas'),
    onSaved() { throw Object.assign(new Error('replica full'), { code: 'CANVAS_REPLICA_FULL' }); },
    onCallbackError(error) { failures.push(error.code); },
  });
  store.saveDocument(document());
  assert.equal(store.readDocument('canvas-sync-1').title, '离线画布');
  assert.deepEqual(failures, ['CANVAS_REPLICA_FULL']);
});
