const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CANVAS_DOCUMENT_VERSION,
  CanvasDocumentStoreError,
  CanvasDocumentValidationError,
  createCanvasDocumentStore,
  validateCanvasDocument,
} = require('../canvas-document-store.cjs');

function makeStore(t, options = {}) {
  const notesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-canvas-store-'));
  t.after(() => fs.rmSync(notesRoot, { recursive: true, force: true }));
  return createCanvasDocumentStore({
    notesRoot,
    now: () => new Date('2026-07-17T10:20:30.000Z'),
    ...options,
  });
}

function makeDocument(overrides = {}) {
  return {
    id: 'canvas-001',
    version: 1,
    title: '函数极限错题关系',
    createdAt: '2026-07-17T09:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
    images: [{
      id: 'image-a',
      src: 'data:image/png;base64,iVBORw0KGgo=',
      name: 'p108.png',
      x: 100,
      y: 80,
      width: 800,
      height: 600,
      naturalWidth: 1600,
      naturalHeight: 1200,
      z: 1,
    }],
    texts: [{
      id: 'text-a',
      text: '先看定义域',
      x: 960,
      y: 100,
      width: 220,
      fontSize: 18,
      color: '#f3d39c',
      z: 2,
    }],
    anchors: [
      { id: 'anchor-a', imageId: 'image-a', shape: 'point', x: 0.25, y: 0.4, width: 0, height: 0, label: 'A1' },
      { id: 'anchor-b', imageId: 'image-a', shape: 'rect', x: 0.5, y: 0.5, width: 0.2, height: 0.1, label: 'A2' },
    ],
    annotations: [
      {
        id: 'note-a',
        kind: 'annotation',
        text: '这里漏看了条件',
        x: 900,
        y: 300,
        width: 260,
        anchorIds: ['anchor-a'],
        color: '#f3d39c',
        z: 3,
      },
      {
        id: 'relation-a',
        kind: 'relation',
        text: '错因 → 改法',
        x: 900,
        y: 500,
        width: 260,
        anchorIds: ['anchor-a', 'anchor-b'],
        relationType: '错因→改法',
        color: '#efbf72',
        z: 4,
      },
    ],
    viewport: { zoom: 0.9, scrollLeft: 40, scrollTop: 20 },
    futureField: { preserved: true },
    ...overrides,
  };
}

test('saves atomically at the stable project path and preserves unknown fields', (t) => {
  const store = makeStore(t);
  const saved = store.saveDocument(makeDocument());
  const expectedPath = path.join(store.notesRoot, '.canvas-documents', 'canvas-001', 'document.json');

  assert.equal(store.getDocumentPath('canvas-001'), expectedPath);
  assert.equal(fs.existsSync(expectedPath), true);
  assert.deepEqual(saved.futureField, { preserved: true });
  assert.deepEqual(store.readDocument('canvas-001'), saved);
  assert.deepEqual(
    fs.readdirSync(path.dirname(expectedPath)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('uses an explicit canvas-projects root directly for the new server integration', (t) => {
  const assistantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-assistant-root-'));
  t.after(() => fs.rmSync(assistantRoot, { recursive: true, force: true }));
  const projectsRoot = path.join(assistantRoot, 'canvas-projects');
  const store = createCanvasDocumentStore({ rootDir: projectsRoot });

  store.saveDocument(makeDocument());

  assert.equal(store.rootPath, projectsRoot);
  assert.equal(store.projectsRoot, projectsRoot);
  assert.equal(store.notesRoot, null);
  assert.equal(fs.existsSync(path.join(projectsRoot, 'canvas-001', 'document.json')), true);
  assert.equal(fs.existsSync(path.join(projectsRoot, '.canvas-documents')), false);
});

test('fills compatible defaults for id, version and timestamps when the caller supplies canvasId', (t) => {
  const store = makeStore(t);
  const document = makeDocument({
    id: undefined,
    version: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  });
  const saved = store.saveDocument(document, { canvasId: 'draft-7' });

  assert.equal(saved.id, 'draft-7');
  assert.equal(saved.version, CANVAS_DOCUMENT_VERSION);
  assert.equal(saved.createdAt, '2026-07-17T10:20:30.000Z');
  assert.equal(saved.updatedAt, '2026-07-17T10:20:30.000Z');
});

test('validates normalized anchors and references while allowing incomplete drafts', () => {
  assert.throws(
    () => validateCanvasDocument(makeDocument({
      anchors: [{ id: 'outside', imageId: 'image-a', shape: 'rect', x: 0.9, y: 0.1, width: 0.2, height: 0.3 }],
      annotations: [{ id: 'broken', kind: 'relation', text: '关系', x: 1, y: 1, width: 20, anchorIds: ['outside', 'missing'] }],
    })),
    (error) => error instanceof CanvasDocumentValidationError
      && error.issues.some((issue) => issue.includes('extends beyond the image width'))
      && error.issues.some((issue) => issue.includes('missing anchor')),
  );

  assert.doesNotThrow(() => validateCanvasDocument(makeDocument({
    annotations: [
      { id: 'empty-note', kind: 'annotation', text: '', x: 0, y: 0, width: 10, anchorIds: [] },
      { id: 'one-end', kind: 'relation', text: '', x: 0, y: 0, width: 10, anchorIds: ['anchor-a'] },
    ],
  })));
});

test('rejects missing images, duplicate ids and invalid schema versions', () => {
  const invalid = makeDocument({
    version: 2,
    texts: [{ id: 'image-a', text: 'duplicate', x: 0, y: 0 }],
    anchors: [{ id: 'anchor-a', imageId: 'missing-image', shape: 'point', x: 0.1, y: 0.2 }],
    annotations: [{ id: 'note-a', kind: 'annotation', text: '', x: 0, y: 0, anchorIds: ['anchor-a'] }],
  });

  assert.throws(
    () => validateCanvasDocument(invalid),
    (error) => error instanceof CanvasDocumentValidationError
      && error.issues.some((issue) => issue.includes('version must be 1'))
      && error.issues.some((issue) => issue.includes('duplicates'))
      && error.issues.some((issue) => issue.includes('missing image')),
  );
});

test('enforces entity count, text, dimensions and embedded data URL byte limits', (t) => {
  const store = makeStore(t, {
    limits: {
      maxImages: 1,
      maxTextLength: 8,
      maxDimension: 1000,
      maxDocumentBytes: 4096,
      maxDataUrlBytes: 40,
      maxDataUrlBytesTotal: 40,
    },
  });
  const invalid = makeDocument({
    images: [
      { ...makeDocument().images[0], height: 1001, src: `data:image/png;base64,${'A'.repeat(50)}` },
      { ...makeDocument().images[0], id: 'image-b' },
    ],
    texts: [{ id: 'long-text', text: '123456789', x: 0, y: 0 }],
  });

  assert.throws(
    () => store.saveDocument(invalid),
    (error) => error instanceof CanvasDocumentValidationError
      && error.issues.some((issue) => issue.includes('images/nodes exceed 1'))
      && error.issues.some((issue) => issue.includes('exceeds 8 characters'))
      && error.issues.some((issue) => issue.includes('height must be <= 1000'))
      && error.issues.some((issue) => issue.includes('data URL exceeds 40 bytes')),
  );
  assert.equal(fs.existsSync(store.rootPath), false, 'validation happens before any project directory is created');
});

test('lists compact summaries sorted by update time and counts relation annotations', (t) => {
  const store = makeStore(t);
  store.saveDocument(makeDocument({ id: 'older', title: '旧画布', updatedAt: '2026-07-16T10:00:00.000Z' }));
  store.saveDocument(makeDocument({ id: 'newer', title: '新画布', updatedAt: '2026-07-17T10:00:00.000Z' }));

  const summaries = store.listDocuments();
  assert.deepEqual(summaries.map((item) => item.id), ['newer', 'older']);
  assert.equal(summaries[0].imageCount, 1);
  assert.equal(summaries[0].anchorCount, 2);
  assert.equal(summaries[0].annotationCount, 2);
  assert.equal(summaries[0].relationCount, 1);
  assert.equal(summaries[0].dataUrlCount, 1);
  assert.equal(Object.hasOwn(summaries[0], 'images'), false);
});

test('list is resilient to corrupt projects and can report them explicitly', (t) => {
  const store = makeStore(t);
  store.saveDocument(makeDocument());
  const corruptDir = path.join(store.rootPath, 'corrupt-project');
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'document.json'), '{not-json', 'utf8');

  assert.deepEqual(store.listDocuments().map((item) => item.id), ['canvas-001']);
  const withInvalid = store.listDocuments({ includeInvalid: true });
  assert.equal(withInvalid.length, 2);
  assert.equal(withInvalid.find((item) => item.id === 'corrupt-project').invalid, true);
});

test('read returns null for a missing document and rejects unsafe ids', (t) => {
  const store = makeStore(t);
  assert.equal(store.readDocument('missing-canvas'), null);
  assert.throws(() => store.readDocument('../escape'), CanvasDocumentValidationError);
  assert.throws(() => store.getDocumentPath('CON'), CanvasDocumentValidationError);
});

test('read surfaces stored JSON and validation failures with stable error codes', (t) => {
  const store = makeStore(t);
  const invalidDir = path.join(store.rootPath, 'invalid-v1');
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(path.join(invalidDir, 'document.json'), JSON.stringify({ id: 'invalid-v1', version: 9, title: '' }), 'utf8');

  assert.throws(
    () => store.readDocument('invalid-v1'),
    (error) => error instanceof CanvasDocumentStoreError && error.code === 'CANVAS_DOCUMENT_STORED_INVALID',
  );
  fs.writeFileSync(path.join(invalidDir, 'document.json'), '{', 'utf8');
  assert.throws(
    () => store.readDocument('invalid-v1'),
    (error) => error instanceof CanvasDocumentStoreError && error.code === 'CANVAS_DOCUMENT_READ_FAILED',
  );
});
