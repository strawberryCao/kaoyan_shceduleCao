import { HttpError } from './http.js';
import { findNote, getLearningSnapshot } from './learning.js';
import { renameNoteWithAi } from './ai.js';
import { readAppState, writeAppState } from './storage.js';

const STATE_KEY = 'ai-background-jobs';
const MAX_JOBS = 120;
const ACTIVE_STATUSES = new Set(['queued', 'processing']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isAiMultiQuestionNote(note) {
  return Boolean(note) && (
    note.sourceType === 'ai-multi-question'
    || /^multi_[A-Za-z0-9_-]+/i.test(String(note.noteUid || ''))
    || (Array.isArray(note.tags) && note.tags.includes('AI多题拆分'))
  );
}

function normalizeJob(value) {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) return null;
  return {
    id: value.id,
    type: value.type === 'note-rename' ? 'note-rename' : String(value.type || ''),
    noteUid: String(value.noteUid || ''),
    status: ['queued', 'processing', 'completed', 'failed', 'skipped'].includes(value.status) ? value.status : 'failed',
    progress: Math.max(0, Math.min(100, Number(value.progress) || 0)),
    message: String(value.message || ''),
    error: String(value.error || ''),
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || ''),
    completedAt: String(value.completedAt || ''),
    request: isObject(value.request) ? value.request : {},
    result: isObject(value.result) ? value.result : null,
  };
}

async function readState(env) {
  const stored = await readAppState(env, STATE_KEY);
  const value = isObject(stored?.value) ? stored.value : {};
  const jobs = Array.isArray(value.jobs) ? value.jobs.map(normalizeJob).filter(Boolean) : [];
  return { revision: Number(stored?.revision) || 0, jobs };
}

async function writeState(env, current, jobs) {
  const updatedAt = new Date().toISOString();
  const compact = jobs
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, MAX_JOBS);
  await writeAppState(env, STATE_KEY, { jobs: compact }, current.revision + 1, updatedAt);
  return { revision: current.revision + 1, jobs: compact };
}

async function mutateJobs(env, mutator) {
  const current = await readState(env);
  const jobs = current.jobs.map((job) => structuredClone(job));
  const result = await mutator(jobs);
  if (result?.noWrite) return { current, result };
  const stored = await writeState(env, current, jobs);
  return { current: stored, result };
}

export async function listBackgroundJobs(env, filters = {}) {
  const state = await readState(env);
  return state.jobs.filter((job) => (
    (!filters.noteUid || job.noteUid === filters.noteUid)
    && (!filters.type || job.type === filters.type)
  ));
}

export async function getBackgroundJob(env, jobId) {
  const jobs = await listBackgroundJobs(env);
  return jobs.find((job) => job.id === jobId) || null;
}

export async function enqueueRenameJob(env, noteUid) {
  const snapshot = await getLearningSnapshot(env);
  const entry = findNote(snapshot, noteUid);
  if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  if (!isAiMultiQuestionNote(entry.note)) {
    throw new HttpError(403, '只有 AI 多题拆分生成的笔记可以使用这个重新命名入口。', 'AI_RENAME_NOT_ALLOWED');
  }

  const existing = (await listBackgroundJobs(env, { noteUid, type: 'note-rename' }))
    .find((job) => ACTIVE_STATUSES.has(job.status));
  if (existing) return { job: existing, replayed: true };

  const now = new Date().toISOString();
  const job = {
    id: `job-${crypto.randomUUID()}`,
    type: 'note-rename',
    noteUid,
    status: 'queued',
    progress: 0,
    message: '已加入后台命名队列',
    error: '',
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    request: {
      baselineTitle: String(entry.note.title || ''),
      baselineUpdatedAt: String(entry.note.updatedAt || ''),
      baselineRemark: String(entry.note.remark || ''),
    },
    result: null,
  };
  await mutateJobs(env, (jobs) => { jobs.push(job); });
  return { job, replayed: false };
}

async function updateJob(env, jobId, patch) {
  let updated = null;
  await mutateJobs(env, (jobs) => {
    const index = jobs.findIndex((job) => job.id === jobId);
    if (index < 0) return { noWrite: true };
    updated = { ...jobs[index], ...patch, updatedAt: new Date().toISOString() };
    jobs[index] = updated;
    return null;
  });
  return updated;
}

export async function processBackgroundJob(env, jobId) {
  const job = await getBackgroundJob(env, jobId);
  if (!job || !ACTIVE_STATUSES.has(job.status)) return job;
  if (job.status === 'processing') return job;

  await updateJob(env, jobId, {
    status: 'processing',
    progress: 20,
    message: 'AI 正在根据原图和最新备注命名',
    error: '',
  });

  try {
    const result = await renameNoteWithAi(env, job.noteUid, {
      baselineTitle: job.request.baselineTitle,
      baselineUpdatedAt: job.request.baselineUpdatedAt,
    });
    const completedAt = new Date().toISOString();
    return updateJob(env, jobId, {
      status: result.applied === false ? 'skipped' : 'completed',
      progress: 100,
      message: result.applied === false ? result.reason || '笔记已被修改，AI 结果未覆盖' : 'AI 命名完成',
      completedAt,
      result: {
        applied: result.applied !== false,
        title: result.title || '',
        revision: Number(result.snapshot?.revision) || 0,
      },
    });
  } catch (error) {
    return updateJob(env, jobId, {
      status: 'failed',
      progress: 100,
      message: 'AI 命名失败，可重新执行',
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
  }
}

export async function kickPendingJobs(env, limit = 2) {
  const jobs = (await listBackgroundJobs(env))
    .filter((job) => job.status === 'queued')
    .slice(0, Math.max(1, Math.min(5, limit)));
  for (const job of jobs) await processBackgroundJob(env, job.id);
  return jobs.length;
}
