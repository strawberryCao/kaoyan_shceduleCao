import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';
import { SQL } from './storage.js';

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    const db = this.database;
    if (this.sql === SQL.selectLearning) return db.learning ? { ...db.learning } : null;
    if (this.sql === SQL.selectReceipt) return db.receipts.get(`${this.args[0]}:${this.args[1]}`) ?? null;
    if (this.sql === SQL.selectCanvas) return db.canvases.get(this.args[0]) ?? null;
    if (this.sql === SQL.selectAppState) return db.appState.get(this.args[0]) ?? null;
    if (this.sql === SQL.selectNoteFile) return db.noteFiles.get(this.args[0]) ?? null;
    if (this.sql === SQL.selectNoteFileByKey) {
      return [...db.noteFiles.values()].find((row) => row.r2_key === this.args[0]) ?? null;
    }
    throw new Error(`Unsupported first SQL: ${this.sql}`);
  }

  async all() {
    if (this.sql === SQL.listCanvas) {
      return { results: [...this.database.canvases.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) };
    }
    throw new Error(`Unsupported all SQL: ${this.sql}`);
  }

  async run() {
    const db = this.database;
    const changed = (changes) => ({ success: true, meta: { changes } });
    if (this.sql === SQL.insertLearning) {
      if (db.learning) return changed(0);
      db.learning = { revision: 0, snapshot_json: this.args[0], updated_at: null };
      return changed(1);
    }
    if (this.sql === SQL.updateLearning) {
      const [revision, snapshotJson, updatedAt, expected] = this.args;
      if (!db.learning || db.learning.revision !== expected) return changed(0);
      db.learning = { revision, snapshot_json: snapshotJson, updated_at: updatedAt };
      return changed(1);
    }
    if (this.sql === SQL.upsertSchedule) {
      const [date, recordJson, snapshotRevision, updatedAt] = this.args;
      const current = db.schedule.get(date);
      if (current && current.snapshot_revision > snapshotRevision) return changed(0);
      db.schedule.set(date, {
        date, record_json: recordJson, snapshot_revision: snapshotRevision, updated_at: updatedAt,
      });
      return changed(1);
    }
    if (this.sql === SQL.insertReceipt) {
      const [scope, operationId, entityId, requestHash, resultJson, createdAt] = this.args;
      const key = `${scope}:${operationId}`;
      if (db.receipts.has(key)) throw new Error('UNIQUE constraint failed: operation_receipts');
      db.receipts.set(key, {
        scope,
        operation_id: operationId,
        entity_id: entityId,
        request_hash: requestHash,
        result_json: resultJson,
        created_at: createdAt,
      });
      return changed(1);
    }
    if (this.sql === SQL.insertCanvas) {
      const [id, title, revision, r2Key, r2Etag, createdAt, updatedAt, summaryJson] = this.args;
      if (db.canvases.has(id)) throw new Error('UNIQUE constraint failed: canvas_projects');
      db.canvases.set(id, {
        id, title, revision, r2_key: r2Key, r2_etag: r2Etag,
        created_at: createdAt, updated_at: updatedAt, summary_json: summaryJson,
      });
      return changed(1);
    }
    if (this.sql === SQL.updateCanvas) {
      if (db.failNextCanvasUpdate) {
        db.failNextCanvasUpdate = false;
        return changed(0);
      }
      const [title, revision, r2Key, r2Etag, updatedAt, summaryJson, id, expected] = this.args;
      const current = db.canvases.get(id);
      if (!current || current.revision !== expected) return changed(0);
      db.canvases.set(id, {
        ...current, title, revision, r2_key: r2Key, r2_etag: r2Etag,
        updated_at: updatedAt, summary_json: summaryJson,
      });
      return changed(1);
    }
    if (this.sql === SQL.deleteCanvas) {
      const [id, revision] = this.args;
      const current = db.canvases.get(id);
      if (!current || current.revision !== revision) return changed(0);
      db.canvases.delete(id);
      return changed(1);
    }
    if (this.sql === SQL.upsertCanvasBootstrap) {
      const [id, title, revision, r2Key, r2Etag, createdAt, updatedAt, summaryJson] = this.args;
      const current = db.canvases.get(id);
      if (current && current.revision >= revision) return changed(0);
      db.canvases.set(id, {
        id, title, revision, r2_key: r2Key, r2_etag: r2Etag,
        created_at: createdAt, updated_at: updatedAt, summary_json: summaryJson,
      });
      return changed(1);
    }
    if (this.sql === SQL.upsertAppState) {
      const [key, valueJson, revision, updatedAt] = this.args;
      db.appState.set(key, { key, value_json: valueJson, revision, updated_at: updatedAt });
      return changed(1);
    }
    if (this.sql === SQL.upsertNoteFile) {
      const [noteUid, r2Key, fileName, mimeType, size, createdAt] = this.args;
      db.noteFiles.set(noteUid, {
        note_uid: noteUid, r2_key: r2Key, file_name: fileName,
        mime_type: mimeType, size, created_at: createdAt,
      });
      return changed(1);
    }
    throw new Error(`Unsupported run SQL: ${this.sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.learning = null;
    this.schedule = new Map();
    this.receipts = new Map();
    this.canvases = new Map();
    this.appState = new Map();
    this.noteFiles = new Map();
    this.failScheduleOnce = false;
    this.failNextCanvasUpdate = false;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    if (this.failScheduleOnce && statements.some((statement) => statement.sql === SQL.upsertSchedule)) {
      this.failScheduleOnce = false;
      throw new Error('simulated schedule mirror failure');
    }
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
    this.sequence = 0;
  }

  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    if (options.onlyIf?.etagDoesNotMatch === '*' && existing) return null;
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array ? value
        : new Uint8Array(value);
    const etag = `etag-${++this.sequence}`;
    const stored = {
      key,
      bytes: new Uint8Array(bytes),
      size: bytes.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    };
    this.objects.set(key, stored);
    return this.metadata(stored);
  }

  metadata(stored) {
    return {
      key: stored.key,
      size: stored.size,
      etag: stored.etag,
      httpEtag: stored.httpEtag,
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
    };
  }

  async head(key) {
    const stored = this.objects.get(key);
    return stored ? this.metadata(stored) : null;
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      ...this.metadata(stored),
      body: new Response(stored.bytes).body,
      text: async () => new TextDecoder().decode(stored.bytes),
    };
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

const auth = `Basic ${Buffer.from('tester:secret').toString('base64')}`;

function makeEnv(overrides = {}) {
  return {
    APP_USERNAME: 'tester',
    APP_PASSWORD: 'secret',
    DB: new FakeD1(),
    BUCKET: new FakeR2(),
    ASSETS: { fetch: async () => new Response('<main>study</main>', { headers: { 'Content-Type': 'text/html' } }) },
    ...overrides,
  };
}

function request(path, init = {}) {
  return new Request(`https://study.example${path}`, {
    ...init,
    headers: { authorization: auth, ...(init.headers ?? {}) },
  });
}

async function call(env, path, init = {}) {
  return worker.fetch(request(path, init), env, {});
}

async function body(response) {
  return response.json();
}

test('health is public while static assets and API require fully configured Basic auth', async () => {
  const env = makeEnv();
  const health = await worker.fetch(new Request('https://study.example/api/health'), env, {});
  assert.equal(health.status, 200);
  assert.equal((await body(health)).authConfigured, true);

  const unauthorized = await worker.fetch(new Request('https://study.example/api/learning-data'), env, {});
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get('www-authenticate'), /^Basic /);

  const missingSecret = await worker.fetch(request('/api/learning-data'), { ...env, APP_PASSWORD: undefined }, {});
  assert.equal(missingSecret.status, 503);
  assert.equal((await body(missingSecret)).code, 'AUTH_NOT_CONFIGURED');

  const asset = await call(env, '/');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'private, no-cache');
});

test('GET starts empty and bootstrap from R2 is re-entrant without overwriting later edits', async () => {
  const env = makeEnv();
  const initial = await call(env, '/api/learning-data');
  assert.equal(initial.status, 200);
  assert.equal((await body(initial)).revision, 0);

  const note = {
    noteUid: 'note-1', capturedDate: '2026-07-22', title: '题目', subject: '数学', remark: '',
    filePath: 'r2://note-assets/hash.jpg', organizationStatus: 'pending', classificationSource: 'local',
    reviewStatus: 'pending', decisionRevision: 0, cards: [],
  };
  await env.BUCKET.put('bootstrap/learning-data.json', JSON.stringify({
    version: 1,
    revision: 44,
    days: { '2026-07-22': { manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' }, autoNotes: [note] } },
    cards: [],
    deletedNotes: {},
  }));
  await env.BUCKET.put('bootstrap/canvas-index.json', JSON.stringify({ projects: [{
    id: 'canvas-1', title: '画布', revision: 3,
    r2Key: 'bootstrap/canvases/canvas-1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
  }] }));
  await env.BUCKET.put('bootstrap/canvases/canvas-1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json', JSON.stringify({
    version: 1, id: 'canvas-1', title: '画布', syncRevision: 3,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
    images: [], texts: [], anchors: [], annotations: [], relations: [], strokes: [],
    viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
  }));

  const bootstrap = await call(env, '/api/admin/bootstrap', { method: 'POST' });
  assert.equal(bootstrap.status, 200);
  const imported = await body(bootstrap);
  assert.equal(imported.notes, 1);
  assert.equal(imported.canvases, 1);
  assert.equal(imported.learningImported, true);
  assert.equal(env.DB.canvases.get('canvas-1').r2_key, 'bootstrap/canvases/canvas-1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json');
  assert.equal((await body(await call(env, '/api/canvas-projects/canvas-1'))).document.syncRevision, 3);

  const loaded = await body(await call(env, '/api/learning-data'));
  assert.equal(loaded.days['2026-07-22'].autoNotes[0].filePath, 'r2://note-assets/hash.jpg');
  assert.equal(loaded.revision, 1);

  // Simulate a crash after the snapshot commit but before its bootstrap marker.
  env.DB.appState.delete('bootstrap-learning');
  const recoveredBootstrap = await call(env, '/api/admin/bootstrap', { method: 'POST' });
  assert.equal(recoveredBootstrap.status, 200);
  assert.equal((await body(recoveredBootstrap)).replayed, true);
  assert.equal((await body(await call(env, '/api/learning-data'))).revision, 1);

  const patched = await call(env, '/api/learning-data/day', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: '云端新增' }, expectedRevision: 1 }),
  });
  assert.equal(patched.status, 200);
  const replay = await call(env, '/api/admin/bootstrap', { method: 'POST' });
  assert.equal(replay.status, 200);
  assert.equal((await body(replay)).replayed, true);
  const afterReplay = await body(await call(env, '/api/learning-data'));
  assert.equal(afterReplay.days['2026-07-22'].manual.note, '云端新增');
  assert.equal(afterReplay.revision, 2);
});

test('bootstrap rejects non-content-addressed or live canvas keys before importing learning data', async () => {
  const env = makeEnv();
  await env.BUCKET.put('bootstrap/learning-data.json', JSON.stringify({
    version: 1,
    days: { '2026-07-22': { manual: { completedTaskIds: [], note: 'must-not-import', debt: '', mistakes: '' }, autoNotes: [] } },
    cards: [],
    deletedNotes: {},
  }));
  await env.BUCKET.put('bootstrap/canvas-index.json', JSON.stringify([{
    id: 'unsafe-canvas',
    title: 'invalid',
    revision: 0,
    r2Key: 'canvases/unsafe-canvas/revisions/0-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',
  }]));
  const response = await call(env, '/api/admin/bootstrap', { method: 'POST' });
  assert.equal(response.status, 400);
  assert.equal((await body(response)).code, 'INVALID_BOOTSTRAP');
  const learning = await body(await call(env, '/api/learning-data'));
  assert.equal(learning.revision, 0);
  assert.deepEqual(learning.days, {});
});

test('save-note stores an R2 image and replays the same noteUid without another learning revision', async () => {
  const env = makeEnv();
  const payload = {
    noteUid: 'captured-1',
    kind: 'single',
    subject: '数学',
    remark: '一道题',
    imageDataUrl: 'data:image/png;base64,AQID',
  };
  const saved = await call(env, '/api/save-note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(saved.status, 202);
  const savedBody = await body(saved);
  assert.equal(savedBody.filePath, 'r2://note-assets/captured-1.png');
  assert.equal(savedBody.aiStatus, 'unavailable');
  assert.equal(savedBody.aiAvailable, false);
  assert.equal((await body(await call(env, '/api/learning-data'))).revision, 1);

  // Simulate a lost receipt, then verify a retry cannot change the extension.
  env.DB.receipts.delete('save-note:captured-1');
  const changedExtension = await call(env, '/api/save-note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, imageDataUrl: 'data:image/jpeg;base64,BAUG' }),
  });
  assert.equal(changedExtension.status, 409);
  assert.equal((await body(changedExtension)).code, 'SAVE_OPERATION_REUSED');
  assert.equal(env.DB.noteFiles.get('captured-1').r2_key, 'note-assets/captured-1.png');

  const replay = await call(env, '/api/save-note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(replay.status, 200);
  assert.equal((await body(replay)).idempotentReplay, true);
  assert.equal((await body(await call(env, '/api/learning-data'))).revision, 1);

  const reused = await call(env, '/api/save-note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, imageDataUrl: 'data:image/png;base64,BAUG' }),
  });
  assert.equal(reused.status, 409);
  assert.equal((await body(reused)).code, 'SAVE_OPERATION_REUSED');
});

test('desktop layout round-trips through D1 and the cloud event route returns a polling snapshot', async () => {
  const env = makeEnv();
  const layout = [{ id: 'clock', type: 'clock', x: 1, y: 2 }];
  const saved = await call(env, '/api/layout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await body(saved)).layout, layout);
  assert.deepEqual((await body(await call(env, '/api/layout'))).layout, layout);
  const events = await call(env, '/api/layout/events');
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  assert.match(await events.text(), /event: layout/);
});

test('note-file accepts stable R2 URIs and bare keys but rejects traversal', async () => {
  const env = makeEnv();
  await env.BUCKET.put('note-assets/hash.jpg', new Uint8Array([1, 2, 3]), {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  const uri = await call(env, '/api/note-file?path=r2%3A%2F%2Fnote-assets%2Fhash.jpg');
  assert.equal(uri.status, 200);
  assert.equal(uri.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual([...new Uint8Array(await uri.arrayBuffer())], [1, 2, 3]);

  const bare = await call(env, '/api/note-file?path=note-assets%2Fhash.jpg');
  assert.equal(bare.status, 200);

  const traversal = await call(env, '/api/note-file?path=r2%3A%2F%2Fnote-assets%2F..%2Fbootstrap%2Flearning-data.json');
  assert.equal(traversal.status, 403);
  assert.equal((await body(traversal)).code, 'NOTE_PATH_FORBIDDEN');
});

test('learning mutations reject stale expectedRevision and mirror schedule records', async () => {
  const env = makeEnv();
  const conflict = await call(env, '/api/learning-data/day', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: 'x' }, expectedRevision: 9 }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await body(conflict)).code, 'REVISION_CONFLICT');

  const saved = await call(env, '/api/learning-data/day', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: '复习' }, expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await body(saved)).revision, 1);
  assert.equal(JSON.parse(env.DB.schedule.get('2026-07-22').record_json).note, '复习');
});

test('a failed schedule mirror does not turn an already committed learning write into a retryable failure', async () => {
  const env = makeEnv();
  env.DB.failScheduleOnce = true;
  const messages = [];
  const originalError = console.error;
  console.error = (message) => messages.push(String(message));
  let saved;
  try {
    saved = await call(env, '/api/learning-data/day', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-07-23', manual: { note: '主写已提交' }, expectedRevision: 0 }),
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(saved.status, 200);
  assert.equal((await body(saved)).revision, 1);
  assert.equal(env.DB.schedule.has('2026-07-23'), false);
  assert.ok(messages.some((message) => message.includes('schedule_mirror_failed')));
  const snapshot = await body(await call(env, '/api/learning-data'));
  assert.equal(snapshot.days['2026-07-23'].manual.note, '主写已提交');

  const staleRetry = await call(env, '/api/learning-data/day', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-23', manual: { note: '主写已提交' }, expectedRevision: 0 }),
  });
  assert.equal(staleRetry.status, 409);
});

test('manual cards inherit omitted source and classification fields from their parent note', async () => {
  const env = makeEnv();
  const snapshot = {
    version: 1, revision: 0, updatedAt: null, cards: [], deletedNotes: {},
    days: { '2026-07-22': { manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' }, autoNotes: [{
      noteUid: 'parent-note', capturedDate: '2026-07-22', title: '母题', subject: '数学',
      knowledgePath: ['数学', '高数'], tags: ['重点'], pageRefs: [{ raw: 'P12', page: 12 }],
      filePath: 'r2://note-assets/parent.png', reviewStatus: 'corrected', organizationStatus: 'confirmed',
      classificationSource: 'manual', decisionRevision: 1, cardIds: [],
    }] } },
  };
  assert.equal((await call(env, '/api/learning-data/seed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, expectedRevision: 0 }),
  })).status, 200);
  const created = await call(env, '/api/learning-data/cards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { noteUid: 'parent-note', kind: 'memory', front: '问', back: '答' }, expectedRevision: 1 }),
  });
  assert.equal(created.status, 201);
  const card = (await body(created)).cards.find((item) => item.front === '问');
  assert.equal(card.subject, '数学');
  assert.deepEqual(card.knowledgePath, ['数学', '高数']);
  assert.deepEqual(card.tags, ['重点']);
  assert.deepEqual(card.pageRefs, [{ raw: 'P12', page: 12 }]);
  assert.equal(card.sourceTitle, '母题');
  assert.equal(card.sourceFilePath, 'r2://note-assets/parent.png');
});

test('card review dueDate applies the same historical-error penalty as the local store', async () => {
  const env = makeEnv();
  const snapshot = {
    version: 1, revision: 0, updatedAt: null, deletedNotes: {},
    days: { '2026-07-22': { manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' }, autoNotes: [{
      noteUid: 'review-parent', capturedDate: '2026-07-22', title: '复习题', subject: '数学',
      knowledgePath: ['数学'], reviewStatus: 'corrected', organizationStatus: 'confirmed',
      classificationSource: 'manual', decisionRevision: 1, cardIds: ['review-card'],
    }] } },
    cards: [{
      id: 'review-card', noteUid: 'review-parent', sourceKey: 'test', kind: 'memory',
      front: '问', back: '答', subject: '数学', knowledgePath: ['数学'], tags: [], pageRefs: [],
      sourceTitle: '复习题', sourceFilePath: '', status: 'active', dueDate: '2026-07-22',
      reviewStep: 3, reviewCount: 2, lastReviewedAt: '', lastReviewResult: 'forgotten',
      correctCount: 0, incorrectCount: 2, correctStreak: 0, masteredAt: '',
      reviewHistory: [
        { id: 'r1', reviewedAt: '2026-07-20T00:00:00.000Z', result: 'forgotten', thought: '' },
        { id: 'r2', reviewedAt: '2026-07-21T00:00:00.000Z', result: 'forgotten', thought: '' },
      ],
      createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z', userEdited: false,
    }],
  };
  assert.equal((await call(env, '/api/learning-data/seed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, expectedRevision: 0 }),
  })).status, 200);
  const reviewed = await call(env, '/api/learning-data/cards/review-card', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: { reviewResult: 'remembered' }, expectedRevision: 1 }),
  });
  assert.equal(reviewed.status, 200);
  const card = (await body(reviewed)).cards.find((item) => item.id === 'review-card');
  // base 14 days / (1 + 2*0.45 + (2/3)*0.8) rounds to 6 days.
  const expectedDueDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(new Date(card.lastReviewedAt).getTime() + 6 * 86400000));
  assert.equal(card.dueDate, expectedDueDate);
  assert.equal(card.reviewStep, 4);
  assert.equal(card.correctCount, 1);
  assert.equal(card.incorrectCount, 2);
});

test('write APIs reject cross-site requests and non-JSON mutation bodies', async () => {
  const env = makeEnv();
  const crossSite = await call(env, '/api/admin/bootstrap', {
    method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await body(crossSite)).code, 'CSRF_REJECTED');

  const wrongType = await call(env, '/api/learning-data/day', {
    method: 'PATCH', body: JSON.stringify({ date: '2026-07-22', manual: {} }),
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await body(wrongType)).code, 'JSON_CONTENT_TYPE_REQUIRED');

  const sameOrigin = await call(env, '/api/learning-data/day', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'https://study.example', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: 'ok' }, expectedRevision: 0 }),
  });
  assert.equal(sameOrigin.status, 200);
});

test('note review actions are durable, idempotent, and conflict-aware', async () => {
  const env = makeEnv();
  const snapshot = {
    version: 1, revision: 0, updatedAt: null, cards: [], deletedNotes: {},
    days: { '2026-07-22': { manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' }, autoNotes: [{
      noteUid: 'pending-1', capturedDate: '2026-07-22', title: '待确认', subject: '数学',
      knowledgePath: ['数学'], reviewStatus: 'pending', organizationStatus: 'pending',
      classificationSource: 'ai', decisionRevision: 0, proposalId: 'proposal-1',
      userEditedFields: [], cardIds: [],
    }] } },
  };
  const seed = await call(env, '/api/learning-data/seed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, expectedRevision: 0 }),
  });
  assert.equal(seed.status, 200);
  const action = {
    noteUid: 'pending-1', action: 'accept', operationId: 'review-op-1',
    expectedDecisionRevision: 0, proposalId: 'proposal-1',
  };
  const accepted = await call(env, '/api/learning-data/note-review-actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: [action] }),
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await body(accepted);
  assert.equal(acceptedBody.results[0].durable, true);
  assert.equal(acceptedBody.results[0].decisionRevision, 1);
  assert.equal(acceptedBody.snapshot.revision, 2);

  // Simulate the receipt write being lost after the snapshot was committed.
  env.DB.receipts.delete('note-review:review-op-1');
  const replay = await call(env, '/api/learning-data/note-review-actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: [action] }),
  });
  assert.equal(replay.status, 200);
  const replayBody = await body(replay);
  assert.equal(replayBody.results[0].replayed, true);
  assert.equal(replayBody.snapshot.revision, 2);

  const reused = await call(env, '/api/learning-data/note-review-actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions: [{ ...action, action: 'ignore' }] }),
  });
  assert.equal(reused.status, 409);
  assert.equal((await body(reused)).results[0].code, 'REVIEW_OPERATION_REUSED');

  const stale = await call(env, '/api/learning-data/note-review-actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions: [{ ...action, operationId: 'review-op-2' }] }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await body(stale)).results[0].code, 'NOTE_REVIEW_CONFLICT');
});

test('canvas save/load uses R2 and rejects a stale canvas revision', async () => {
  const env = makeEnv();
  const document = {
    version: 1,
    id: 'canvas-test',
    title: '数学画布',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    syncRevision: 0,
    images: [], texts: [], anchors: [], annotations: [], relations: [], strokes: [],
    viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
  };
  const saved = await call(env, '/api/canvas-projects/canvas-test', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, expectedRevision: 0, clientId: 'test' }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await body(saved)).document.syncRevision, 1);
  const firstPointer = env.DB.canvases.get('canvas-test').r2_key;
  assert.match(firstPointer, /^canvases\/canvas-test\/revisions\/1-[a-f0-9]{64}\.json$/);
  assert.ok(env.BUCKET.objects.has(firstPointer));

  env.DB.failNextCanvasUpdate = true;
  const failedCas = await call(env, '/api/canvas-projects/canvas-test', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: { ...document, title: '不应生效', syncRevision: 1 }, expectedRevision: 1, clientId: 'test' }),
  });
  assert.equal(failedCas.status, 409);
  assert.equal(env.DB.canvases.get('canvas-test').r2_key, firstPointer);
  const afterFailedCas = await body(await call(env, '/api/canvas-projects/canvas-test'));
  assert.equal(afterFailedCas.document.title, '数学画布');
  assert.ok(env.BUCKET.objects.has(firstPointer));
  const failedCasOrphans = [...env.BUCKET.objects.keys()].filter((key) => (
    key.startsWith('canvases/canvas-test/revisions/2-') && key !== firstPointer
  ));
  assert.equal(failedCasOrphans.length, 1);

  const committed = await call(env, '/api/canvas-projects/canvas-test', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: { ...document, title: '新增版', syncRevision: 1 }, expectedRevision: 1, clientId: 'test' }),
  });
  assert.equal(committed.status, 200);
  const secondPointer = env.DB.canvases.get('canvas-test').r2_key;
  assert.match(secondPointer, /^canvases\/canvas-test\/revisions\/2-[a-f0-9]{64}\.json$/);
  assert.equal(env.BUCKET.objects.has(firstPointer), false);
  assert.ok(env.BUCKET.objects.has(secondPointer));
  assert.ok(env.BUCKET.objects.has(failedCasOrphans[0]));

  const stale = await call(env, '/api/canvas-projects/canvas-test', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, expectedRevision: 0, clientId: 'test' }),
  });
  assert.equal(stale.status, 409);
  const staleBody = await body(stale);
  assert.equal(staleBody.code, 'CANVAS_REVISION_CONFLICT');
  assert.equal(staleBody.actualRevision, 2);

  const loaded = await call(env, '/api/canvas-projects/canvas-test');
  assert.equal(loaded.status, 200);
  assert.equal((await body(loaded)).document.title, '新增版');
});
