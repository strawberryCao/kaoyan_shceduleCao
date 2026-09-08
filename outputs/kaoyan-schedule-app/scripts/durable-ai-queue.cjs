const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');

const AI_QUEUE_SCHEMA_VERSION = 1;
const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const RETRYABLE_STATUSES = new Set(['failed', 'needs_review']);

class DurableAiQueueError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'DurableAiQueueError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanId(value, field, maxLength = 160) {
  const result = String(value || '').trim();
  if (!result || result.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw new DurableAiQueueError('INVALID_AI_JOB', `${field} is invalid.`, 400);
  }
  return result;
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.job_id,
    type: row.task_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    noteUid: row.subject_type === 'learning-note' ? row.subject_id : '',
    status: row.status,
    progress: Number(row.progress) || 0,
    message: row.message || '',
    error: row.error_message || '',
    errorCode: row.error_code || '',
    result: parseJson(row.result_json, null),
    attemptCount: Number(row.attempt_count) || 0,
    billableAttemptCount: Number(row.billable_attempt_count) || 0,
    requiresExplicitRetry: row.status === 'failed' || row.status === 'needs_review',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || '',
    completedAt: row.completed_at || '',
  };
}

function createDurableAiQueue(options = {}) {
  const requestedDatabasePath = String(options.databasePath || '').trim();
  if (!requestedDatabasePath) throw new Error('AI queue database path is required.');
  const databasePath = path.resolve(requestedDatabasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_queue_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_jobs (
      job_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      task_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      billable_attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ai_jobs_status_idx ON ai_jobs(status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS ai_jobs_subject_idx ON ai_jobs(subject_type, subject_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ai_attempts (
      attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES ai_jobs(job_id),
      ordinal INTEGER NOT NULL,
      task_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      phase TEXT NOT NULL,
      started_at TEXT NOT NULL,
      UNIQUE(job_id, ordinal)
    );
  `);
  const schemaRow = database.prepare("SELECT value FROM ai_queue_meta WHERE key = 'schema_version'").get();
  const storedSchema = Number(schemaRow?.value || 0);
  if (storedSchema > AI_QUEUE_SCHEMA_VERSION) {
    database.close();
    throw new DurableAiQueueError('AI_QUEUE_SCHEMA_TOO_NEW', `AI queue schema ${storedSchema} is newer than supported ${AI_QUEUE_SCHEMA_VERSION}.`, 500);
  }
  database.prepare("INSERT INTO ai_queue_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(AI_QUEUE_SCHEMA_VERSION));

  const statements = {
    byId: database.prepare('SELECT * FROM ai_jobs WHERE job_id = ?'),
    byKey: database.prepare('SELECT * FROM ai_jobs WHERE idempotency_key = ?'),
    insert: database.prepare(`INSERT INTO ai_jobs(
      job_id,idempotency_key,payload_hash,task_type,subject_type,subject_id,payload_json,status,priority,progress,message,
      error_code,error_message,result_json,attempt_count,billable_attempt_count,created_at,updated_at,started_at,completed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    update: database.prepare(`UPDATE ai_jobs SET
      status=?, progress=?, message=?, error_code=?, error_message=?, result_json=?, attempt_count=?,
      billable_attempt_count=?, updated_at=?, started_at=?, completed_at=? WHERE job_id=?`),
    next: database.prepare("SELECT * FROM ai_jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1"),
    list: database.prepare('SELECT * FROM ai_jobs ORDER BY created_at DESC LIMIT ?'),
    listBySubject: database.prepare('SELECT * FROM ai_jobs WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC LIMIT ?'),
    interrupted: database.prepare("SELECT * FROM ai_jobs WHERE status = 'processing' ORDER BY created_at ASC"),
    attempt: database.prepare('INSERT INTO ai_attempts(job_id,ordinal,task_name,provider,model,phase,started_at) VALUES(?,?,?,?,?,?,?)'),
    attempts: database.prepare('SELECT ordinal,task_name,provider,model,phase,started_at FROM ai_attempts WHERE job_id = ? ORDER BY ordinal ASC'),
    counts: database.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review
      FROM ai_jobs`),
  };
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const execute = typeof options.execute === 'function' ? options.execute : async () => {
    throw new DurableAiQueueError('AI_JOB_HANDLER_MISSING', 'No durable AI job handler is configured.', 500);
  };
  const syncStore = options.syncStore || null;
  const context = new AsyncLocalStorage();
  const listeners = new Set();
  let running = false;
  let started = false;
  let closed = false;
  let scheduled = false;

  function persist(row, patch) {
    const timestamp = now().toISOString();
    const next = {
      ...row,
      status: patch.status ?? row.status,
      progress: patch.progress ?? row.progress,
      message: patch.message ?? row.message,
      error_code: patch.errorCode ?? row.error_code,
      error_message: patch.errorMessage ?? row.error_message,
      result_json: Object.hasOwn(patch, 'result') ? canonicalJson(patch.result) : row.result_json,
      attempt_count: patch.attemptCount ?? row.attempt_count,
      billable_attempt_count: patch.billableAttemptCount ?? row.billable_attempt_count,
      updated_at: timestamp,
      started_at: Object.hasOwn(patch, 'startedAt') ? patch.startedAt : row.started_at,
      completed_at: Object.hasOwn(patch, 'completedAt') ? patch.completedAt : row.completed_at,
    };
    statements.update.run(
      next.status, next.progress, next.message, next.error_code, next.error_message, next.result_json,
      next.attempt_count, next.billable_attempt_count, next.updated_at, next.started_at, next.completed_at, row.job_id,
    );
    return statements.byId.get(row.job_id);
  }

  function publish(row) {
    const job = publicJob(row);
    if (syncStore) {
      try {
        syncStore.queueLocalMutation({
          deviceId: 'mac-ai',
          entityType: 'ai-task',
          entityId: job.id,
          mutation: {
            kind: 'patch',
            source: job.status === 'completed' ? 'ai' : 'system',
            fields: {
              jobId: job.id,
              taskType: job.type,
              subjectType: job.subjectType,
              subjectId: job.subjectId,
              status: job.status,
              progress: job.progress,
              message: job.message,
              errorCode: job.errorCode,
              result: job.result,
              billableAttemptCount: job.billableAttemptCount,
              requiresExplicitRetry: job.requiresExplicitRetry,
              createdAt: job.createdAt,
              updatedAt: job.updatedAt,
              completedAt: job.completedAt,
            },
          },
        });
      } catch {
        // AI completion is durable in its own database. Sync can catch up later.
      }
    }
    for (const listener of listeners) {
      try { listener(job); } catch {}
    }
    return job;
  }

  function recoverInterrupted() {
    const recovered = [];
    for (const row of statements.interrupted.all()) {
      const billable = Number(row.billable_attempt_count) > 0;
      const next = persist(row, billable ? {
        status: 'needs_review',
        progress: Math.max(5, Number(row.progress) || 0),
        message: 'Mac 在付费请求开始后中断；为避免重复计费，必须由你确认后重试',
        errorCode: 'AI_RESULT_UNCERTAIN_AFTER_RESTART',
        errorMessage: '任务结果不确定，系统没有自动再次调用模型。',
        completedAt: now().toISOString(),
      } : {
        status: 'queued',
        progress: 0,
        message: 'Mac 重启后已安全恢复，尚未发起付费请求',
        errorCode: '',
        errorMessage: '',
        startedAt: null,
        completedAt: null,
      });
      recovered.push(publish(next));
    }
    return recovered;
  }

  function enqueue(input = {}) {
    if (closed) throw new DurableAiQueueError('AI_QUEUE_CLOSED', 'AI queue is closed.', 503);
    const idempotencyKey = cleanId(input.idempotencyKey, 'idempotencyKey', 240);
    const taskType = cleanId(input.taskType, 'taskType', 80);
    const subjectType = cleanId(input.subjectType || 'system', 'subjectType', 80);
    const subjectId = cleanId(input.subjectId || taskType, 'subjectId', 180);
    const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
    const payloadJson = canonicalJson(payload);
    if (Buffer.byteLength(payloadJson) > 512 * 1024) {
      throw new DurableAiQueueError('AI_JOB_PAYLOAD_TOO_LARGE', 'AI job payload is too large.', 413);
    }
    const payloadHash = sha256(`${taskType}\0${subjectType}\0${subjectId}\0${payloadJson}`);
    const existing = statements.byKey.get(idempotencyKey);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new DurableAiQueueError('AI_JOB_KEY_REUSED', 'AI job idempotency key was reused with different content.');
      }
      return { job: publicJob(existing), replayed: true };
    }
    const timestamp = now().toISOString();
    const jobId = `ai-${sha256(idempotencyKey).slice(0, 32)}`;
    statements.insert.run(
      jobId, idempotencyKey, payloadHash, taskType, subjectType, subjectId, payloadJson, 'queued',
      Math.max(-100, Math.min(100, Number(input.priority) || 0)), 0, String(input.message || '已加入 Mac AI 队列').slice(0, 300),
      '', '', null, 0, 0, timestamp, timestamp, null, null,
    );
    const job = publish(statements.byId.get(jobId));
    schedulePump();
    return { job, replayed: false };
  }

  function markAttemptStarted(details = {}) {
    const active = context.getStore();
    if (!active?.jobId) return null;
    const row = statements.byId.get(active.jobId);
    if (!row || row.status !== 'processing') return null;
    const ordinal = Number(row.billable_attempt_count) + 1;
    const timestamp = now().toISOString();
    statements.attempt.run(
      row.job_id, ordinal, String(details.task || row.task_type).slice(0, 100),
      String(details.provider || '').slice(0, 100), String(details.model || '').slice(0, 180),
      String(details.phase || 'request').slice(0, 40), timestamp,
    );
    const next = persist(row, {
      billableAttemptCount: ordinal,
      message: ordinal === 1 ? 'Mac 已开始模型请求' : `Mac 正在执行第 ${ordinal} 次模型尝试`,
      progress: Math.max(15, Number(row.progress) || 0),
    });
    publish(next);
    return publicJob(next);
  }

  async function runOne(row) {
    const processing = persist(row, {
      status: 'processing',
      progress: Math.max(5, Number(row.progress) || 0),
      message: 'Mac 正在准备 AI 任务',
      errorCode: '',
      errorMessage: '',
      attemptCount: Number(row.attempt_count) + 1,
      startedAt: now().toISOString(),
      completedAt: null,
    });
    publish(processing);
    try {
      const result = await context.run({ jobId: row.job_id }, () => execute({
        ...publicJob(processing),
        payload: parseJson(processing.payload_json, {}),
      }));
      const latest = statements.byId.get(row.job_id);
      const completed = persist(latest, {
        status: 'completed', progress: 100, message: 'AI 任务已完成', errorCode: '', errorMessage: '',
        result: result ?? null, completedAt: now().toISOString(),
      });
      publish(completed);
    } catch (error) {
      const latest = statements.byId.get(row.job_id);
      const failed = persist(latest, {
        status: 'failed',
        progress: 100,
        message: Number(latest.billable_attempt_count) > 0
          ? 'AI 未完成；系统不会自动重复付费，请检查后手动重试'
          : 'AI 尚未发起付费请求，可以检查配置后重试',
        errorCode: String(error?.code || 'AI_JOB_FAILED').slice(0, 100),
        errorMessage: String(error?.message || error || 'AI job failed').slice(0, 600),
        completedAt: now().toISOString(),
      });
      publish(failed);
    }
  }

  async function pump() {
    if (!started || running || closed) return;
    running = true;
    try {
      while (!closed) {
        const row = statements.next.get();
        if (!row) break;
        await runOne(row);
      }
    } finally {
      running = false;
    }
  }

  function schedulePump() {
    if (!started || running || scheduled || closed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      void pump();
    });
  }

  function start() {
    if (started || closed) return { recovered: [] };
    started = true;
    const recovered = recoverInterrupted();
    schedulePump();
    return { recovered };
  }

  function retry(jobId) {
    const row = statements.byId.get(cleanId(jobId, 'jobId', 100));
    if (!row) throw new DurableAiQueueError('AI_JOB_NOT_FOUND', 'AI task was not found.', 404);
    if (!RETRYABLE_STATUSES.has(row.status)) {
      throw new DurableAiQueueError('AI_JOB_NOT_RETRYABLE', 'Only failed or interrupted AI tasks can be retried.');
    }
    const next = persist(row, {
      status: 'queued', progress: 0, message: '你已确认重试，任务重新进入 Mac AI 队列',
      errorCode: '', errorMessage: '', result: null, startedAt: null, completedAt: null,
    });
    const job = publish(next);
    schedulePump();
    return job;
  }

  function getJob(jobId) {
    return publicJob(statements.byId.get(cleanId(jobId, 'jobId', 100)));
  }

  function listJobs(input = {}) {
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 80));
    const rows = input.subjectType && input.subjectId
      ? statements.listBySubject.all(cleanId(input.subjectType, 'subjectType', 80), cleanId(input.subjectId, 'subjectId', 180), limit)
      : statements.list.all(limit);
    return rows.map(publicJob);
  }

  function getAttempts(jobId) {
    const id = cleanId(jobId, 'jobId', 100);
    return statements.attempts.all(id).map((row) => ({
      ordinal: Number(row.ordinal), task: row.task_name, provider: row.provider, model: row.model,
      phase: row.phase, startedAt: row.started_at,
    }));
  }

  function getStatus() {
    const row = statements.counts.get();
    return {
      role: 'mac-ai-authority',
      total: Number(row.total) || 0,
      queued: Number(row.queued) || 0,
      processing: Number(row.processing) || 0,
      failed: Number(row.failed) || 0,
      needsReview: Number(row.needs_review) || 0,
      running,
    };
  }

  async function waitForIdle(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (running || statements.next.get()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for durable AI queue.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function close() {
    closed = true;
    database.close();
  }

  return {
    start,
    close,
    enqueue,
    retry,
    getJob,
    listJobs,
    getAttempts,
    getStatus,
    markAttemptStarted,
    waitForIdle,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

module.exports = {
  AI_QUEUE_SCHEMA_VERSION,
  ACTIVE_STATUSES,
  DurableAiQueueError,
  createDurableAiQueue,
};
