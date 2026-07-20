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

function makeArrowRelation(overrides = {}) {
  return {
    id: 'arrow-a',
    kind: 'arrow',
    fromAnchorId: 'anchor-a',
    toAnchorId: 'anchor-b',
    relationType: '推导',
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

test('saves top-level arrow direction and relation type without creating a relation annotation', (t) => {
  const store = makeStore(t);
  const arrow = makeArrowRelation();
  const document = makeDocument({
    annotations: makeDocument().annotations.filter((annotation) => annotation.kind !== 'relation'),
    relations: [arrow],
  });

  const saved = store.saveDocument(document);
  assert.deepEqual(saved.relations, [arrow]);
  assert.equal(saved.relations[0].fromAnchorId, 'anchor-a');
  assert.equal(saved.relations[0].toAnchorId, 'anchor-b');
  assert.equal(saved.relations[0].relationType, '推导');
  assert.equal(saved.annotations.some((annotation) => annotation.kind === 'relation'), false);
  assert.deepEqual(store.readDocument(document.id).relations, [arrow]);
});

test('strictly validates arrow endpoints and relation type while preserving unknown legacy relations', () => {
  const base = makeDocument({
    annotations: makeDocument().annotations.filter((annotation) => annotation.kind !== 'relation'),
  });
  const invalidCases = [
    {
      relation: makeArrowRelation({ fromAnchorId: undefined }),
      issue: 'fromAnchorId must be a string',
    },
    {
      relation: makeArrowRelation({ toAnchorId: undefined }),
      issue: 'toAnchorId must be a string',
    },
    {
      relation: makeArrowRelation({ toAnchorId: 'anchor-a' }),
      issue: 'must be different',
    },
    {
      relation: makeArrowRelation({ relationType: '包含' }),
      issue: 'relationType must be one of the supported canvas relation types',
    },
    {
      relation: makeArrowRelation({ relationType: undefined }),
      issue: 'relationType must be a string',
    },
    {
      relation: makeArrowRelation({ toAnchorId: 'missing-anchor' }),
      issue: 'references a missing entity (missing-anchor)',
    },
  ];

  for (const { relation, issue } of invalidCases) {
    assert.throws(
      () => validateCanvasDocument({ ...base, relations: [relation] }),
      (error) => error instanceof CanvasDocumentValidationError
        && error.issues.some((entry) => entry.includes(issue)),
      issue,
    );
  }

  assert.doesNotThrow(() => validateCanvasDocument({
    ...base,
    relations: [{
      id: 'legacy-edge',
      kind: 'legacy-curve',
      sourceId: 'anchor-a',
      targetId: 'anchor-b',
      relationType: '历史自定义关系',
      futureField: true,
    }],
  }));
});

test('keeps relation counts compatible across old cards, new arrows and mixed documents', (t) => {
  const store = makeStore(t);
  const noteOnly = makeDocument().annotations.filter((annotation) => annotation.kind !== 'relation');
  store.saveDocument(makeDocument({ id: 'old-card', relations: undefined }));
  store.saveDocument(makeDocument({ id: 'new-arrow', annotations: noteOnly, relations: [makeArrowRelation()] }));
  store.saveDocument(makeDocument({ id: 'mixed', relations: [makeArrowRelation()] }));

  const summaries = new Map(store.listDocuments().map((summary) => [summary.id, summary]));
  assert.equal(summaries.get('old-card').relationCount, 1);
  assert.equal(summaries.get('new-arrow').relationCount, 1);
  assert.equal(summaries.get('new-arrow').annotationCount, 1);
  assert.equal(summaries.get('mixed').relationCount, 2);
  assert.equal(summaries.get('mixed').annotationCount, 2);
});

test('accepts and round-trips old documents that omit the relations array', (t) => {
  const store = makeStore(t);
  const oldDocument = makeDocument({ id: 'without-relations' });
  assert.equal(Object.hasOwn(oldDocument, 'relations'), false);
  assert.doesNotThrow(() => validateCanvasDocument(oldDocument));
  const saved = store.saveDocument(oldDocument);
  assert.equal(Object.hasOwn(saved, 'relations'), false);
  assert.equal(Object.hasOwn(store.readDocument(oldDocument.id), 'relations'), false);
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

test('deletes a canvas project from the list while keeping a recoverable trash copy', (t) => {
  const store = makeStore(t);
  const saved = store.saveDocument(makeDocument({ id: 'delete-me', syncRevision: 4 }));

  const deleted = store.deleteDocument(saved.id);

  assert.equal(deleted.document.id, saved.id);
  assert.equal(store.readDocument(saved.id), null);
  assert.deepEqual(store.listDocuments(), []);
  assert.equal(fs.existsSync(path.join(deleted.trashPath, 'document.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(deleted.trashPath, 'document.json'), 'utf8')).syncRevision, 4);
  assert.equal(store.deleteDocument(saved.id), null);
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

test('accepts an optional non-negative sync revision and includes it in summaries', (t) => {
  const store = makeStore(t);
  const legacy = store.saveDocument(makeDocument({ id: 'legacy-revision', syncRevision: undefined }));
  const synced = store.saveDocument(makeDocument({ id: 'synced-revision', syncRevision: 7 }));

  assert.equal(Object.hasOwn(legacy, 'syncRevision'), false);
  assert.equal(synced.syncRevision, 7);
  const summaries = new Map(store.listDocuments().map((summary) => [summary.id, summary]));
  assert.equal(summaries.get('legacy-revision').syncRevision, 0);
  assert.equal(summaries.get('synced-revision').syncRevision, 7);
  assert.throws(
    () => validateCanvasDocument(makeDocument({ syncRevision: 1.5 })),
    (error) => error instanceof CanvasDocumentValidationError
      && error.issues.some((issue) => issue.includes('syncRevision must be an integer')),
  );
  assert.throws(
    () => validateCanvasDocument(makeDocument({ syncRevision: -1 })),
    (error) => error instanceof CanvasDocumentValidationError
      && error.issues.some((issue) => issue.includes('syncRevision must be >= 0')),
  );
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

test('round-trips pressure-sensitive ink strokes and reports them in project summaries', (t) => {
  const store = makeStore(t);
  const stroke = {
    id: 'stroke-a',
    kind: 'ink',
    tool: 'pen',
    color: '#272522',
    width: 6,
    opacity: 0.98,
    z: 5,
    points: [
      { x: 120, y: 160, pressure: 0.18 },
      { x: 126, y: 166, pressure: 0.72 },
    ],
  };
  const saved = store.saveDocument(makeDocument({ strokes: [stroke] }));

  assert.deepEqual(saved.strokes, [stroke]);
  assert.deepEqual(store.readDocument(saved.id).strokes, [stroke]);
  assert.equal(store.listDocuments()[0].strokeCount, 1);
  assert.throws(
    () => validateCanvasDocument(makeDocument({ strokes: [{ ...stroke, points: [{ x: 1, y: 2, pressure: 1.2 }] }] })),
    (error) => error instanceof CanvasDocumentValidationError
      && error.issues.some((issue) => issue.includes('pressure must be <= 1')),
  );
});
