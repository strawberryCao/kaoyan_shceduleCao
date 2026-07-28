import { HttpError } from './http.js';
import { findNote, getLearningSnapshot } from './learning.js';
import { runConfiguredNoteAnalysis } from './note-analysis-job.js';
import { runConfiguredRename } from './rename-job.js';
import { readAppState, writeAppState } from './storage.js';

const STATE_KEY = 'ai-background-jobs';
const MAX_JOBS = 160;
const PROCESSING_STALE_MS = 7 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['queued', 'processing']);
const JOB_TYPES = new Set(['note-rename', 'note-pipeline']);

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

async function enqueueJob(env, noteUid, type) {
  const snapshot = await getLearningSnapshot(env);
  const entry = findNote(snapshot, noteUid);
  if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
  if (!isRenameEligibleNote(entry.note)) {
    throw new HttpError(403, '这条记录没有可供局域网 Agent 处理的云端原图。', 'AI_RENAME_NOT_ALLOWED');
  }

  const existing = (await listBackgroundJobs(env, { noteUid, type }))
    .find((job) => ACTIVE_STATUSES.has(job.status));
  if (existing) return { job: existing, replayed: true };

  const now = new Date().toISOString();
  const pipeline = type === 'note-pipeline';
  const job = {
    id: `job-${crypto.randomUUID()}`,
    type,
    noteUid,
    status: 'queued',
    progress: 0,
    message: pipeline ? '已加入局域网规则命名与分类队列' : '已加入后台命名队列',
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

export async function enqueueRenameJob(env, noteUid) {
  return enqueueJob(env, noteUid, 'note-rename');
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

async function runRenameStage(env, job) {
  return runConfiguredRename(env, job.noteUid, {
    baselineTitle: job.request.baselineTitle,
    baselineUpdatedAt: job.request.baselineUpdatedAt,
  });
}

export async function processBackgroundJob(env, jobId) {
  const job = await getBackgroundJob(env, jobId);
  if (!job || !ACTIVE_STATUSES.has(job.status)) return job;
  if (job.status === 'processing' && !isStaleProcessing(job)) return job;

  await updateJob(env, jobId, {
    status: 'processing',
    progress: 15,
    message: job.status === 'processing'
      ? '上次 AI 任务被中断，正在从安全检查点自动恢复'
      : 'AI 正在按局域网命名规则处理原图',
    error: '',
  });

  try {
    const rename = await runRenameStage(env, job);
    if (job.type === 'note-rename') {
      const completedAt = new Date().toISOString();
      return updateJob(env, jobId, {
        status: rename.applied === false ? 'skipped' : 'completed',
        progress: 100,
        message: rename.applied === false ? rename.reason || '笔记已被修改，AI 结果未覆盖' : 'AI 命名完成',
        completedAt,
        result: {
          applied: rename.applied !== false,
          title: rename.title || '',
          revision: Number(rename.snapshot?.revision) || 0,
        },
      });
    }

    await updateJob(env, jobId, {
      progress: 55,
      message: '命名完成，正在按局域网完整分析器分类、提取错因与生成卡片',
      result: { title: rename.title || '', provider: rename.provider || '', model: rename.model || '' },
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
        title: enrichment.analysis?.title || rename.title || '',
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
      completedAt: new Date().toISOString(),
    });
  }
}

export async function kickPendingJobs(env, limit = 2) {
  const now = Date.now();
  const jobs = (await listBackgroundJobs(env))
    .filter((job) => job.status === 'queued' || isStaleProcessing(job, now))
    .slice(0, Math.max(1, Math.min(5, limit)));
  for (const job of jobs) await processBackgroundJob(env, job.id);
  return jobs.length;
}

export const backgroundJobInternals = Object.freeze({
  isStaleProcessing,
  processingStaleMs: PROCESSING_STALE_MS,
});
