import { HttpError } from './http.js';
import { findNote, getLearningSnapshot } from './learning.js';
import { runConfiguredNoteAnalysis } from './note-analysis-job.js';
import { runConfiguredRename } from './rename-job.js';
import { getEntry } from './entries.js';
import { runConfiguredMaterialNaming } from './material-naming.js';
import { readAppState, readReceipt, writeAppState, writeReceipt } from './storage.js';

const STATE_KEY = 'ai-background-jobs';
const MAX_JOBS = 160;
const PROCESSING_STALE_MS = 7 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const JOB_TYPES = new Set(['note-rename', 'note-pipeline']);
const EXECUTION_RECEIPT_SCOPE = 'ai-background-execution';
const enqueueLocks = new Map();

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStaleProcessing(job, now = Date.now()) {
  if (job?.status !== 'processing') return false;
  const updatedAt = new Date(job.updatedAt || job.createdAt || 0).getTime();
  return !Number.isFinite(updatedAt) || now - updatedAt >= PROCESSING_STALE_MS;
}

export function isRenameEligibleNote(note) {
  const sourceType = String(note?.sourceType || '');
  const filePath = String(note?.filePath || '').replaceAll('\\', '/');
  const hasImageAttachment = Array.isArray(note?.attachments) && note.attachments.some((attachment) => (
    String(attachment?.mimeType || '').startsWith('image/')
    || /\.(?:jpe?g|png|webp|gif|avif)$/i.test(String(attachment?.name || attachment?.filePath || attachment?.cloudPath || ''))
  ) && Boolean(
    attachment?.assetId
    || String(attachment?.cloudPath || attachment?.filePath || '').startsWith('github://'),
  ));
  return Boolean(note) && (
    sourceType === 'ai-multi-question'
    || sourceType === 'single-capture'
    || /^multi_[A-Za-z0-9_-]+/i.test(String(note.noteUid || ''))
    || (Array.isArray(note.tags) && note.tags.includes('AI多题拆分'))
    || /^github:\/\/data\/assets\/.+\.(?:jpe?g|png|webp|gif|avif)$/i.test(filePath)
    || hasImageAttachment
  );
}

function isMaterialNote(note) {
  const attachments = Array.isArray(note?.attachments) ? note.attachments : [];
  const facets = Array.isArray(note?.facets) ? note.facets : [];
  return Boolean(note)
    && (note.noteType === 'quick' || facets.includes('quick'))
    && attachments.length > 0;
}

function normalizeJob(value) {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) return null;
  return {
    id: value.id,
    type: JOB_TYPES.has(value.type) ? value.type : String(value.type || ''),
    noteUid: String(value.noteUid || ''),
    status: ['queued', 'processing', 'completed', 'failed', 'skipped'].includes(value.status) ? value.status : 'failed',
    progress: Math.max(0, Math.min(100, Number(value.progress) || 0)),
    message: String(value.message || ''),
    error: String(value.error || ''),
    errorCode: String(value.errorCode || ''),
    attempts: Math.max(0, Math.min(100, Number(value.attempts) || 0)),
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

function normalizeOperationId(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]{12,100}$/.test(normalized) ? normalized : crypto.randomUUID();
}

async function enqueueJobLocked(env, noteUid, type, options = {}) {
  const operationId = normalizeOperationId(options.operationId);
  const snapshot = await getLearningSnapshot(env);
  const entry = findNote(snapshot, noteUid);
  if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  if (!isRenameEligibleNote(entry.note) && !isMaterialNote(entry.note)) {
    throw new HttpError(403, '这条记录没有可供局域网 Agent 处理的云端原图。', 'AI_RENAME_NOT_ALLOWED');
  }

  const relatedJobs = await listBackgroundJobs(env, { noteUid, type });
  const operationReplay = relatedJobs.find((job) => job.request?.operationId === operationId);
  if (operationReplay) return { job: operationReplay, replayed: true };
  const stale = relatedJobs.find((job) => isStaleProcessing(job));
  if (stale) {
    await updateJob(env, stale.id, {
      status: 'failed',
      progress: 100,
      message: '上次 AI 任务执行被中断，未自动重复调用模型；本次由你的点击重新开始。',
      error: 'AI 任务执行中断，已停止自动重试。',
      errorCode: 'AI_JOB_INTERRUPTED',
      completedAt: new Date().toISOString(),
    });
  }
  const existing = relatedJobs
    .find((job) => ACTIVE_STATUSES.has(job.status) && !isStaleProcessing(job));
  if (existing) return { job: existing, replayed: true };

  const now = new Date().toISOString();
  const pipeline = type === 'note-pipeline';
  const job = {
    id: `job-${operationId}`,
    type,
    noteUid,
    status: 'queued',
    progress: 0,
    message: pipeline ? '已加入局域网规则命名与分类队列' : '已加入后台命名队列',
    error: '',
    errorCode: '',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    request: {
      baselineTitle: String(entry.note.title || ''),
      baselineUpdatedAt: String(entry.note.updatedAt || ''),
      baselineRemark: String(entry.note.remark || ''),
      operationId,
    },
    result: null,
  };
  await mutateJobs(env, (jobs) => { jobs.push(job); });
  return { job, replayed: false };
}

async function enqueueJob(env, noteUid, type, options = {}) {
  const key = `${type}:${noteUid}`;
  const previous = enqueueLocks.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => enqueueJobLocked(env, noteUid, type, options));
  enqueueLocks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (enqueueLocks.get(key) === pending) enqueueLocks.delete(key);
  }
}

export async function enqueueRenameJob(env, noteUid, options = {}) {
  return enqueueJob(env, noteUid, 'note-rename', options);
}

export async function enqueueNotePipelineJob(env, noteUid) {
  return enqueueJob(env, noteUid, 'note-pipeline');
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

async function claimJobExecution(env, job) {
  const existing = await readReceipt(env, EXECUTION_RECEIPT_SCOPE, job.id);
  if (existing) return false;
  try {
    await writeReceipt(env, {
      scope: EXECUTION_RECEIPT_SCOPE,
      operationId: job.id,
      entityId: job.noteUid,
      requestHash: `${job.type}:${job.noteUid}`,
      result: { claimed: true, attempt: Number(job.attempts || 0) + 1 },
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    // createOnly is the cross-isolate lock. If another Worker won the race,
    // this execution must stop before touching a paid provider.
    if (await readReceipt(env, EXECUTION_RECEIPT_SCOPE, job.id)) return false;
    throw error;
  }
}

async function runRenameStage(env, job) {
  const snapshot = await getLearningSnapshot(env);
  const entry = findNote(snapshot, job.noteUid);
  if (isMaterialNote(entry?.note)) {
    const materialEntry = await getEntry(env, job.noteUid);
    if (Array.isArray(materialEntry.entry?.assets) && materialEntry.entry.assets.length > 0) {
      return runConfiguredMaterialNaming(env, job.noteUid, {
        explicit: true,
        userTitle: false,
      });
    }
  }
  if (entry?.note?.kind === 'canvas' || entry?.note?.sourceType === 'canvas-publish') {
    const enrichment = await runConfiguredNoteAnalysis(env, job.noteUid);
    return {
      applied: true,
      title: enrichment.analysis?.title || entry.note.title || '画布笔记',
      subject: enrichment.analysis?.subject || entry.note.subject || '',
      snapshot: enrichment.snapshot,
      provider: enrichment.provider || '',
      model: enrichment.model || '',
      taskId: enrichment.taskId || 'canvas_note_understanding',
    };
  }
  return runConfiguredRename(env, job.noteUid, {
    baselineTitle: job.request.baselineTitle,
    baselineUpdatedAt: job.request.baselineUpdatedAt,
  });
}

export async function processBackgroundJob(env, jobId) {
  const job = await getBackgroundJob(env, jobId);
  if (!job || !ACTIVE_STATUSES.has(job.status)) return job;
  if (job.status === 'processing' && !isStaleProcessing(job)) return job;
  if (job.status === 'processing') {
    return updateJob(env, jobId, {
      status: 'failed',
      progress: 100,
      message: 'AI 任务执行被中断，已停止自动重试；可由你手动重试。',
      error: 'AI 任务执行中断，未再次调用模型。',
      errorCode: 'AI_JOB_INTERRUPTED',
      completedAt: new Date().toISOString(),
    });
  }

  const claimed = await claimJobExecution(env, job);
  if (!claimed) return getBackgroundJob(env, jobId);

  await updateJob(env, jobId, {
    status: 'processing',
    attempts: Number(job.attempts || 0) + 1,
    progress: 15,
    message: job.status === 'processing'
      ? '上次 AI 任务被中断，正在从安全检查点自动恢复'
      : 'AI 正在按局域网命名规则处理原图',
    error: '',
    errorCode: '',
  });

  try {
    if (job.type === 'note-rename') {
      const rename = await runRenameStage(env, job);
      const completedAt = new Date().toISOString();
      return updateJob(env, jobId, {
        status: rename.applied === false ? 'skipped' : 'completed',
        progress: 100,
        message: rename.applied === false ? rename.reason || '笔记已被修改，AI 结果未覆盖' : 'AI 命名完成',
        completedAt,
        result: {
          applied: rename.applied !== false,
          title: rename.title || '',
          subject: rename.subject || '',
          provider: rename.provider || '',
          model: rename.model || '',
          taskId: rename.taskId || '',
          revision: Number(rename.snapshot?.revision) || 0,
        },
      });
    }

    await updateJob(env, jobId, {
      progress: 55,
      message: '正在用一次视觉识别同时完成标题、科目、知识点、图片批注与错因提取',
    });
    const enrichment = await runConfiguredNoteAnalysis(env, job.noteUid);
    const completedAt = new Date().toISOString();
    return updateJob(env, jobId, {
      status: 'completed',
      progress: 100,
      message: '局域网规则命名与完整分类已完成',
      completedAt,
      result: {
        applied: true,
        title: enrichment.analysis?.title || '',
        subject: enrichment.analysis?.subject || '',
        knowledgePoint: enrichment.analysis?.knowledgePoint || '',
        noteType: enrichment.analysis?.noteType || '',
        revision: Number(enrichment.snapshot?.revision) || 0,
        provider: enrichment.provider || '',
        model: enrichment.model || '',
        taskId: enrichment.taskId || '',
      },
    });
  } catch (error) {
    return updateJob(env, jobId, {
      status: 'failed',
      progress: 100,
      message: job.type === 'note-pipeline' ? '后台命名或分类失败，原图与学习记录已安全保存，可重新执行' : 'AI 命名失败，可重新执行',
      error: error instanceof Error ? error.message : String(error),
      errorCode: String(error?.code || 'AI_JOB_FAILED'),
      completedAt: new Date().toISOString(),
    });
  }
}

export async function kickPendingJobs(env, limit = 2) {
  const now = Date.now();
  const allJobs = await listBackgroundJobs(env);
  const staleJobs = allJobs.filter((job) => isStaleProcessing(job, now));
  for (const job of staleJobs) {
    await updateJob(env, job.id, {
      status: 'failed',
      progress: 100,
      message: 'AI 任务执行被中断，已停止自动重试；可由你手动重试。',
      error: 'AI 任务执行中断，未再次调用模型。',
      errorCode: 'AI_JOB_INTERRUPTED',
      completedAt: new Date().toISOString(),
    });
  }
  const jobs = allJobs
    .filter((job) => job.status === 'queued')
    .slice(0, Math.max(1, Math.min(5, limit)));
  for (const job of jobs) await processBackgroundJob(env, job.id);
  return jobs.length;
}

export const backgroundJobInternals = Object.freeze({
  isMaterialNote,
  isStaleProcessing,
  claimJobExecution,
  processingStaleMs: PROCESSING_STALE_MS,
});
