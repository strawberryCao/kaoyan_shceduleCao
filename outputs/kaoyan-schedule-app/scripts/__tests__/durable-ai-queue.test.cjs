'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createDurableAiQueue } = require('../durable-ai-queue.cjs');

function temporaryQueue(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-ai-queue-'));
  const databasePath = path.join(root, 'tasks.sqlite');
  const queue = createDurableAiQueue({ databasePath, ...options });
  t.after(() => {
    try { queue.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { queue, databasePath, root };
}

test('durable AI jobs are idempotent and publish privacy-safe task state to sync', async (t) => {
  const synchronized = [];
  let queue;
  ({ queue } = temporaryQueue(t, {
    syncStore: { queueLocalMutation(input) { synchronized.push(input); } },
    execute: async (job) => {
      queue.markAttemptStarted({ task: job.type, provider: 'test-provider', model: 'test-model', phase: 'request' });
      return { title: '极限计算', provider: 'test-provider' };
    },
  }));
  const input = {
    idempotencyKey: 'note-naming:note-001:hash-001',
    taskType: 'note-naming',
    subjectType: 'learning-note',
    subjectId: 'note-001',
    payload: { noteUid: 'note-001' },
  };
  const first = queue.enqueue(input);
  const replay = queue.enqueue(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, first.job.id);
  assert.throws(() => queue.enqueue({ ...input, payload: { noteUid: 'different' } }), (error) => error.code === 'AI_JOB_KEY_REUSED');
  queue.start();
  await queue.waitForIdle();
  const completed = queue.getJob(first.job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.billableAttemptCount, 1);
  assert.deepEqual(completed.result, { provider: 'test-provider', title: '极限计算' });
  assert.equal(queue.getAttempts(first.job.id).length, 1);
  const latestSync = synchronized.at(-1);
  assert.equal(latestSync.entityType, 'ai-task');
  assert.equal(latestSync.entityId, first.job.id);
  assert.equal(latestSync.mutation.fields.status, 'completed');
  assert.equal(JSON.stringify(latestSync).includes('note-naming:note-001:hash-001'), false);
});

test('an interrupted paid request requires explicit retry and never auto-runs after restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-ai-recover-paid-'));
  const databasePath = path.join(root, 'tasks.sqlite');
  let queue = createDurableAiQueue({ databasePath, execute: async () => assert.fail('must not auto-run uncertain task') });
  const created = queue.enqueue({
    idempotencyKey: 'paid-interruption-001', taskType: 'note-naming', subjectType: 'learning-note', subjectId: 'note-paid', payload: {},
  }).job;
  queue.close();
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE ai_jobs SET status='processing', billable_attempt_count=1, started_at=? WHERE job_id=?").run(new Date().toISOString(), created.id);
  database.close();

  let executions = 0;
  queue = createDurableAiQueue({ databasePath, execute: async () => { executions += 1; return { ok: true }; } });
  t.after(() => {
    try { queue.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const recovered = queue.start().recovered[0];
  await queue.waitForIdle();
  assert.equal(recovered.status, 'needs_review');
  assert.equal(recovered.errorCode, 'AI_RESULT_UNCERTAIN_AFTER_RESTART');
  assert.equal(executions, 0);

  queue.retry(created.id);
  await queue.waitForIdle();
  assert.equal(executions, 1);
  assert.equal(queue.getJob(created.id).status, 'completed');
});

test('pre-request interruptions resume automatically while provider failures require a user retry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-ai-recover-safe-'));
  const databasePath = path.join(root, 'tasks.sqlite');
  let queue = createDurableAiQueue({ databasePath });
  const created = queue.enqueue({
    idempotencyKey: 'safe-interruption-001', taskType: 'note-naming', subjectType: 'learning-note', subjectId: 'note-safe', payload: {},
  }).job;
  queue.close();
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE ai_jobs SET status='processing', billable_attempt_count=0, started_at=? WHERE job_id=?").run(new Date().toISOString(), created.id);
  database.close();

  let executions = 0;
  queue = createDurableAiQueue({
    databasePath,
    execute: async () => {
      executions += 1;
      const error = new Error('provider unavailable');
      error.code = 'AI_ALL_PROVIDERS_FAILED';
      throw error;
    },
  });
  t.after(() => {
    try { queue.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  queue.start();
  await queue.waitForIdle();
  assert.equal(executions, 1);
  assert.equal(queue.getJob(created.id).status, 'failed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(executions, 1, 'failed jobs must not retry themselves');
});

test('older runtimes reject a future AI queue schema without rewriting it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-ai-future-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'tasks.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE ai_queue_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO ai_queue_meta VALUES('schema_version','99');");
  database.close();
  assert.throws(() => createDurableAiQueue({ databasePath }), (error) => error.code === 'AI_QUEUE_SCHEMA_TOO_NEW');
  const check = new DatabaseSync(databasePath);
  assert.equal(check.prepare("SELECT value FROM ai_queue_meta WHERE key='schema_version'").get().value, '99');
  check.close();
});
