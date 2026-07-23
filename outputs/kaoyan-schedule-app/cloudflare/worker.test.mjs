import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import worker from './worker.js';

class FakeGitHub {
  constructor() {
    this.counter = 1;
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.failRefUpdates = 0;
    const treeSha = this.nextSha();
    this.trees.set(treeSha, new Map());
    const commitSha = this.nextSha();
    this.commits.set(commitSha, { tree: treeSha, parent: null });
    this.head = commitSha;
  }

  nextSha() {
    return (this.counter++).toString(16).padStart(40, '0');
  }

  bytes(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  }

  treeFor(ref = 'main') {
    const commitSha = ref === 'main' ? this.head : ref;
    const commit = this.commits.get(commitSha);
    if (!commit) return null;
    return this.trees.get(commit.tree) ?? null;
  }

  seed(path, value) {
    const current = new Map(this.treeFor());
    current.set(path, this.bytes(value));
    const treeSha = this.nextSha();
    this.trees.set(treeSha, current);
    const commitSha = this.nextSha();
    this.commits.set(commitSha, { tree: treeSha, parent: this.head });
    this.head = commitSha;
    return commitSha;
  }

  remove(path) {
    const current = new Map(this.treeFor());
    current.delete(path);
    const treeSha = this.nextSha();
    this.trees.set(treeSha, current);
    const commitSha = this.nextSha();
    this.commits.set(commitSha, { tree: treeSha, parent: this.head });
    this.head = commitSha;
  }

  file(path, ref = 'main') {
    const value = this.treeFor(ref)?.get(path);
    return value ? new Uint8Array(value) : null;
  }

  json(path, ref = 'main') {
    const value = this.file(path, ref);
    return value ? JSON.parse(new TextDecoder().decode(value)) : null;
  }

  contentSha(bytes) {
    return crypto.createHash('sha1').update(bytes).digest('hex');
  }

  response(value, status = 200) {
    return Response.json(value, { status });
  }

  async fetch(input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(options.method || 'GET').toUpperCase();

    if (url.hostname === 'raw.githubusercontent.com') {
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const ref = parts[2];
      const path = parts.slice(3).join('/');
      const bytes = this.file(path, ref);
      if (!bytes) return new Response('not found', { status: 404 });
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
        },
      });
    }

    assert.equal(url.hostname, 'api.github.com');
    const prefix = '/repos/owner/repo';
    assert.ok(url.pathname.startsWith(prefix), `Unexpected GitHub path: ${url.pathname}`);
    const endpoint = url.pathname.slice(prefix.length);

    if (method === 'GET' && endpoint === '/git/ref/heads/main') {
      return this.response({ object: { sha: this.head } });
    }

    if (method === 'GET' && endpoint.startsWith('/contents/')) {
      const path = endpoint.slice('/contents/'.length).split('/').map(decodeURIComponent).join('/');
      const ref = url.searchParams.get('ref') || 'main';
      const bytes = this.file(path, ref);
      if (!bytes) return this.response({ message: 'Not Found' }, 404);
      return this.response({
        type: 'file',
        sha: this.contentSha(bytes),
        size: bytes.byteLength,
        encoding: 'base64',
        content: Buffer.from(bytes).toString('base64'),
      });
    }

    if (method === 'GET' && endpoint.startsWith('/git/commits/')) {
      const sha = endpoint.slice('/git/commits/'.length);
      const commit = this.commits.get(sha);
      if (!commit) return this.response({ message: 'Not Found' }, 404);
      return this.response({ sha, tree: { sha: commit.tree }, parents: commit.parent ? [{ sha: commit.parent }] : [] });
    }

    if (method === 'POST' && endpoint === '/git/blobs') {
      const payload = JSON.parse(options.body);
      const bytes = payload.encoding === 'base64'
        ? new Uint8Array(Buffer.from(payload.content, 'base64'))
        : this.bytes(payload.content);
      const sha = this.nextSha();
      this.blobs.set(sha, bytes);
      return this.response({ sha }, 201);
    }

    if (method === 'POST' && endpoint === '/git/trees') {
      const payload = JSON.parse(options.body);
      const base = this.trees.get(payload.base_tree);
      if (!base) return this.response({ message: 'Base tree not found' }, 422);
      const next = new Map(base);
      for (const item of payload.tree || []) {
        if (item.sha === null) next.delete(item.path);
        else {
          const bytes = this.blobs.get(item.sha);
          if (!bytes) return this.response({ message: 'Blob not found' }, 422);
          next.set(item.path, new Uint8Array(bytes));
        }
      }
      const sha = this.nextSha();
      this.trees.set(sha, next);
      return this.response({ sha }, 201);
    }

    if (method === 'POST' && endpoint === '/git/commits') {
      const payload = JSON.parse(options.body);
      if (!this.trees.has(payload.tree)) return this.response({ message: 'Tree not found' }, 422);
      const sha = this.nextSha();
      this.commits.set(sha, { tree: payload.tree, parent: payload.parents?.[0] ?? null });
      return this.response({ sha }, 201);
    }

    if (method === 'PATCH' && endpoint === '/git/refs/heads/main') {
      const payload = JSON.parse(options.body);
      const commit = this.commits.get(payload.sha);
      if (!commit || payload.force !== false) return this.response({ message: 'Invalid update' }, 422);
      if (this.failRefUpdates > 0) {
        this.failRefUpdates -= 1;
        return this.response({ message: 'Reference update conflict' }, 422);
      }
      if (commit.parent !== this.head) return this.response({ message: 'Reference changed' }, 422);
      this.head = payload.sha;
      return this.response({ object: { sha: this.head } });
    }

    throw new Error(`Unexpected GitHub request: ${method} ${endpoint}`);
  }
}

const auth = `Basic ${Buffer.from('tester:secret').toString('base64')}`;

function makeContext(t) {
  const repository = new FakeGitHub();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = repository.fetch.bind(repository);
  t.after(() => { globalThis.fetch = previousFetch; });
  const env = {
    APP_USERNAME: 'tester',
    APP_PASSWORD: 'secret',
    GITHUB_TOKEN: 'test-token',
    GITHUB_OWNER: 'owner',
    GITHUB_REPO: 'repo',
    GITHUB_BRANCH: 'main',
    ASSETS: {
      fetch: async () => new Response('<main>study</main>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    },
  };
  return { env, repository };
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

function emptyManual() {
  return { completedTaskIds: [], note: '', debt: '', mistakes: '' };
}

function validCanvas(id = 'canvas-1') {
  return {
    version: 1,
    id,
    title: '画布',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    syncRevision: 0,
    images: [],
    texts: [],
    anchors: [],
    annotations: [],
    relations: [],
    strokes: [],
    viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 },
  };
}

test('health is public while static assets and APIs require configured Basic auth', async (t) => {
  const { env } = makeContext(t);
  const health = await worker.fetch(new Request('https://study.example/api/health'), env, {});
  assert.equal(health.status, 200);
  const healthBody = await body(health);
  assert.equal(healthBody.storage, 'github');
  assert.equal(healthBody.githubConfigured, true);
  assert.equal(healthBody.repository, 'owner/repo');

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

test('GitHub bootstrap imports public review data once and never overwrites later edits', async (t) => {
  const { env, repository } = makeContext(t);
  repository.seed('data/index.json', JSON.stringify({
    version: 1,
    notes: [{
      id: 'note-1',
      kind: 'mistake',
      title: '题目',
      subject: '高等数学',
      knowledgePath: ['高等数学', '极限'],
      tags: ['错题'],
      remark: '一道题',
      wrongReason: '审题失误',
      questionType: '计算题',
      capturedDate: '2026-07-22',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      organizationStatus: 'confirmed',
      imagePath: 'data/assets/note-1.png',
      items: [],
    }],
  }));
  repository.seed('data/assets/note-1.png', new Uint8Array([1, 2, 3]));

  const initial = await call(env, '/api/learning-data');
  assert.equal(initial.status, 200);
  assert.equal((await body(initial)).revision, 0);

  const bootstrap = await call(env, '/api/admin/bootstrap', { method: 'POST' });
  assert.equal(bootstrap.status, 200);
  const imported = await body(bootstrap);
  assert.equal(imported.notes, 1);
  assert.equal(imported.cards, 1);
  assert.equal(imported.learningImported, true);

  const loaded = await body(await call(env, '/api/learning-data'));
  assert.equal(loaded.days['2026-07-22'].autoNotes[0].filePath, 'github://data/assets/note-1.png');
  assert.equal(loaded.revision, 1);

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

test('invalid GitHub bootstrap JSON fails before importing learning data', async (t) => {
  const { env, repository } = makeContext(t);
  repository.seed('data/index.json', '{invalid');
  const response = await call(env, '/api/admin/bootstrap', { method: 'POST' });
  assert.equal(response.status, 502);
  assert.equal((await body(response)).code, 'GITHUB_JSON_INVALID');
  const learning = await body(await call(env, '/api/learning-data'));
  assert.equal(learning.revision, 0);
  assert.deepEqual(learning.days, {});
});

test('save-note commits a GitHub image and replays the same noteUid without another learning revision', async (t) => {
  const { env, repository } = makeContext(t);
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
  assert.equal(savedBody.filePath, 'github://data/assets/captured-1.png');
  assert.deepEqual([...repository.file('data/assets/captured-1.png')], [1, 2, 3]);
  assert.equal((await body(await call(env, '/api/learning-data'))).revision, 1);

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

test('desktop layout round-trips through GitHub and the event route returns a polling snapshot', async (t) => {
  const { env, repository } = makeContext(t);
  const layout = [{ id: 'clock', type: 'clock', x: 1, y: 2 }];
  const saved = await call(env, '/api/layout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await body(saved)).layout, layout);
  assert.deepEqual((await body(await call(env, '/api/layout'))).layout, layout);
  assert.ok(repository.json('data/cloud/app-state/ZGVza3RvcC1sYXlvdXQ.json'));
  const events = await call(env, '/api/layout/events');
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  assert.match(await events.text(), /event: layout/);
});

test('note-file accepts GitHub asset URIs and rejects traversal', async (t) => {
  const { env, repository } = makeContext(t);
  repository.seed('data/assets/hash.jpg', new Uint8Array([1, 2, 3]));
  const uri = await call(env, '/api/note-file?path=github%3A%2F%2Fdata%2Fassets%2Fhash.jpg');
  assert.equal(uri.status, 200);
  assert.equal(uri.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual([...new Uint8Array(await uri.arrayBuffer())], [1, 2, 3]);

  const bare = await call(env, '/api/note-file?path=data%2Fassets%2Fhash.jpg');
  assert.equal(bare.status, 200);

  const traversal = await call(env, '/api/note-file?path=github%3A%2F%2Fdata%2Fassets%2F..%2Findex.json');
  assert.equal(traversal.status, 403);
  assert.equal((await body(traversal)).code, 'NOTE_PATH_FORBIDDEN');
});

test('learning mutations reject stale revisions and store schedule records in the canonical snapshot', async (t) => {
  const { env, repository } = makeContext(t);
  const conflict = await call(env, '/api/learning-data/day', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: 'x' }, expectedRevision: 9 }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await body(conflict)).code, 'REVISION_CONFLICT');

  const saved = await call(env, '/api/learning-data/day', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: '复习' }, expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await body(saved)).revision, 1);
  assert.equal(repository.json('data/cloud/learning-data.json').days['2026-07-22'].manual.note, '复习');
  const records = await body(await call(env, '/api/schedule-records'));
  assert.equal(records.records['2026-07-22'].note, '复习');
});

test('a failed GitHub reference update cannot partially publish a learning mutation', async (t) => {
  const { env, repository } = makeContext(t);
  repository.failRefUpdates = 4;
  const failed = await call(env, '/api/learning-data/day', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-23', manual: { note: '不得半提交' }, expectedRevision: 0 }),
  });
  assert.equal(failed.status, 409);
  assert.equal((await body(failed)).code, 'REVISION_CONFLICT');
  assert.equal(repository.file('data/cloud/learning-data.json'), null);

  const saved = await call(env, '/api/learning-data/day', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-23', manual: { note: '完整提交' }, expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(repository.json('data/cloud/learning-data.json').days['2026-07-23'].manual.note, '完整提交');
});

test('manual cards inherit source and classification fields from their parent note', async (t) => {
  const { env } = makeContext(t);
  const snapshot = {
    version: 1, revision: 0, updatedAt: null, cards: [], deletedNotes: {},
    days: { '2026-07-22': { manual: emptyManual(), autoNotes: [{
      noteUid: 'parent-note', capturedDate: '2026-07-22', title: '母题', subject: '数学', remark: '',
      createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z', firstSyncedAt: '',
      knowledgePath: ['数学', '高数'], tags: ['重点'], pageRefs: [{ raw: 'P12', page: 12 }],
      filePath: 'github://data/assets/parent.png', reviewStatus: 'corrected', organizationStatus: 'confirmed',
      classificationSource: 'manual', decisionRevision: 1, cardIds: [], studyNotes: [], items: [],
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
  assert.equal(card.sourceFilePath, 'github://data/assets/parent.png');
});

test('card review updates the durable GitHub snapshot and preserves historical error counts', async (t) => {
  const { env, repository } = makeContext(t);
  const snapshot = {
    version: 1, revision: 0, updatedAt: null, deletedNotes: {}, days: {},
    cards: [{
      id: 'card-1', noteUid: 'note-1', sourceKey: 'test', kind: 'mistake', front: '题', back: '答',
      subject: '数学', knowledgePath: ['数学'], tags: [], pageRefs: [], sourceTitle: '题', sourceFilePath: '',
      status: 'active', dueDate: '2026-07-22', reviewStep: 2, reviewCount: 4, lastReviewedAt: '',
      lastReviewResult: 'forgotten', correctCount: 1, incorrectCount: 3, correctStreak: 0, masteredAt: '',
      reviewHistory: [], createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', userEdited: false,
    }],
  };
  assert.equal((await call(env, '/api/learning-data/seed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, expectedRevision: 0 }),
  })).status, 200);
  const reviewed = await call(env, '/api/learning-data/cards/card-1', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: { reviewResult: 'remembered', reviewThought: '已掌握一些' }, expectedRevision: 1 }),
  });
  assert.equal(reviewed.status, 200);
  const card = (await body(reviewed)).cards[0];
  assert.equal(card.correctCount, 2);
  assert.equal(card.incorrectCount, 3);
  assert.equal(card.reviewCount, 5);
  assert.equal(card.reviewHistory.length, 1);
  assert.equal(repository.json('data/cloud/learning-data.json').cards[0].correctCount, 2);
});

test('write APIs reject cross-site requests and non-JSON mutation bodies', async (t) => {
  const { env } = makeContext(t);
  const crossSite = await call(env, '/api/learning-data/day', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: 'x' } }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await body(crossSite)).code, 'CSRF_REJECTED');

  const wrongType = await call(env, '/api/learning-data/day', {
    method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongType.status, 415);

  const valid = await call(env, '/api/learning-data/day', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-07-22', manual: { note: 'ok' }, expectedRevision: 0 }),
  });
  assert.equal(valid.status, 200);
});

test('note review actions are durable, idempotent, and conflict-aware in GitHub', async (t) => {
  const { env, repository } = makeContext(t);
  const snapshot = {
    version: 1, revision: 0, updatedAt: null, cards: [], deletedNotes: {},
    days: { '2026-07-22': { manual: emptyManual(), autoNotes: [{
      noteUid: 'review-note', capturedDate: '2026-07-22', title: '待审核', subject: '默认文件夹', remark: '',
      createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z', firstSyncedAt: '',
      filePath: '', pageRefs: [], tags: [], knowledgePath: ['默认文件夹'], noteType: 'mistake', questionType: '',
      wrongReason: '', wrongReasonSource: '', wrongReasonConfidence: null, organizationStatus: 'pending',
      classificationSource: 'local', reviewStatus: 'pending', decisionRevision: 0, lastReviewOperationId: '',
      lastReviewAction: '', proposalId: 'proposal-1', reviewedAt: '', manualCreated: false, userEditedFields: [],
      goodQuestion: null, items: [], studyNotes: [], confidence: null, cardIds: [],
    }] } },
  };
  assert.equal((await call(env, '/api/learning-data/seed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, expectedRevision: 0 }),
  })).status, 200);
  const action = {
    noteUid: 'review-note', action: 'correct', operationId: 'review-operation-1', expectedDecisionRevision: 0,
    proposalId: 'proposal-1', patch: { subject: '高等数学', knowledgePath: ['高等数学', '极限'], wrongReason: '审题' },
  };
  const corrected = await call(env, '/api/learning-data/note-review-actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: [action] }),
  });
  assert.equal(corrected.status, 200);
  assert.equal((await body(corrected)).results[0].durable, true);

  const replay = await call(env, '/api/learning-data/note-review-actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: [action] }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await body(replay)).results[0].replayed, true);
  assert.ok([...repository.treeFor().keys()].some((path) => path.startsWith('data/cloud/receipts/')));

  const stale = await call(env, '/api/learning-data/note-review-actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions: [{ noteUid: 'review-note', action: 'ignore', operationId: 'review-operation-2', expectedDecisionRevision: 0 }] }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await body(stale)).results[0].code, 'NOTE_REVIEW_CONFLICT');
});

test('canvas save/load uses an atomic GitHub commit and rejects stale revisions', async (t) => {
  const { env, repository } = makeContext(t);
  const document = validCanvas('canvas-1');
  const saved = await call(env, '/api/canvas-projects/canvas-1', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, expectedRevision: 0 }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await body(saved)).document.syncRevision, 1);
  assert.equal(repository.json('data/cloud/canvases/canvas-1.json').syncRevision, 1);
  assert.equal(repository.json('data/cloud/canvas-index.json').projects[0].id, 'canvas-1');

  const loaded = await body(await call(env, '/api/canvas-projects/canvas-1'));
  assert.equal(loaded.document.syncRevision, 1);
  const listed = await body(await call(env, '/api/canvas-projects'));
  assert.equal(listed.projects.length, 1);

  const stale = await call(env, '/api/canvas-projects/canvas-1', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, expectedRevision: 0 }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await body(stale)).code, 'CANVAS_REVISION_CONFLICT');

  const active = await call(env, '/api/canvas-projects/active', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'canvas-1', clientId: 'client-1' }),
  });
  assert.equal(active.status, 200);
});
