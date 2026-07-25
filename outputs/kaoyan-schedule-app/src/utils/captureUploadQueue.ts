import { saveLearningDataCache } from './learningData';
import { saveNoteImagesBatch, type SaveNotePayload } from './notes';

export type CaptureUploadStatus = 'queued' | 'uploading' | 'completed' | 'failed' | 'cancelled';

export interface CaptureUploadJob {
  id: string;
  status: CaptureUploadStatus;
  payloads: SaveNotePayload[];
  noteUids: string[];
  attempts: number;
  nextAttemptAt: number;
  message: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface CaptureUploadSummary {
  queued: number;
  uploading: number;
  failed: number;
  completed: number;
  message: string;
}

const DB_NAME = 'kaoyan-capture-outbox-v2';
const STORE_NAME = 'capture-uploads';
const DB_VERSION = 1;
const EVENT_NAME = 'kaoyan-capture-outbox-changed';
const MAX_JOBS = 36;
const MAX_TOTAL_BYTES = 110 * 1024 * 1024;
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const UPLOAD_LEASE_MS = 2 * 60 * 1000;
const RETRY_DELAYS_MS = [1_200, 3_000, 10_000, 30_000, 90_000, 5 * 60_000];

let databasePromise: Promise<IDBDatabase> | null = null;
let processorPromise: Promise<void> | null = null;
let retryTimer: number | null = null;

const nowIso = () => new Date().toISOString();
const dataUrlBytes = (value: string): number => Math.ceil(Math.max(0, value.length - value.indexOf(',') - 1) * 0.75);
const jobBytes = (job: CaptureUploadJob): number => job.payloads.reduce((sum, item) => sum + dataUrlBytes(item.imageDataUrl), 0);

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('当前浏览器不支持本地可靠上传队列。'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('本地上传队列打开失败。'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('本地上传队列读写失败。'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('本地上传队列事务已中止。'));
  transaction.onerror = () => reject(transaction.error ?? new Error('本地上传队列事务失败。'));
});

const readJobs = async (): Promise<CaptureUploadJob[]> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return requestResult(transaction.objectStore(STORE_NAME).getAll()) as Promise<CaptureUploadJob[]>;
};

const putJob = async (job: CaptureUploadJob): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).put(job));
  await committed;
};

const deleteJob = async (id: string): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  await committed;
};

const emit = async (): Promise<void> => {
  const summary = await getCaptureUploadSummary();
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: summary }));
};

const prune = async (): Promise<CaptureUploadJob[]> => {
  const jobs = await readJobs();
  const cutoff = Date.now() - COMPLETED_RETENTION_MS;
  const expired = jobs.filter((job) => (
    (job.status === 'completed' || job.status === 'cancelled')
    && new Date(job.completedAt || job.updatedAt).getTime() < cutoff
  ));
  await Promise.all(expired.map((job) => deleteJob(job.id)));
  return jobs.filter((job) => !expired.some((item) => item.id === job.id));
};

const retryDelay = (attempts: number): number => {
  const base = RETRY_DELAYS_MS[Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, attempts - 1))];
  return base + Math.round(Math.random() * Math.min(2_000, base * 0.2));
};

const retryable = (message: string): boolean => /load failed|failed to fetch|network|网络|请求超时|timeout|revision conflict|github.*changed|暂未确认/i.test(message);

const patchJob = async (job: CaptureUploadJob, patch: Partial<CaptureUploadJob>): Promise<CaptureUploadJob> => {
  const updated = { ...job, ...patch, updatedAt: nowIso() };
  await putJob(updated);
  await emit();
  return updated;
};

const isRunnable = (job: CaptureUploadJob, now = Date.now()): boolean => {
  if (job.status === 'queued' || job.status === 'failed') return job.nextAttemptAt <= now;
  if (job.status !== 'uploading') return false;
  const updatedAt = new Date(job.updatedAt || job.createdAt).getTime();
  const leaseExpiresAt = Number.isFinite(updatedAt) ? updatedAt + UPLOAD_LEASE_MS : job.nextAttemptAt;
  return Math.min(job.nextAttemptAt || leaseExpiresAt, leaseExpiresAt) <= now;
};

const runnableAt = (job: CaptureUploadJob): number => {
  if (job.status !== 'uploading') return job.nextAttemptAt;
  const updatedAt = new Date(job.updatedAt || job.createdAt).getTime();
  const leaseExpiresAt = Number.isFinite(updatedAt) ? updatedAt + UPLOAD_LEASE_MS : Date.now();
  return Math.min(job.nextAttemptAt || leaseExpiresAt, leaseExpiresAt);
};

const nextRunnable = (jobs: CaptureUploadJob[]): CaptureUploadJob | null => {
  const now = Date.now();
  return jobs
    .filter((job) => isRunnable(job, now))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null;
};

const scheduleNext = async (): Promise<void> => {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  const jobs = await readJobs();
  const waiting = jobs
    .filter((job) => ['queued', 'failed', 'uploading'].includes(job.status))
    .sort((left, right) => runnableAt(left) - runnableAt(right))[0];
  if (!waiting) return;
  const delay = Math.max(250, runnableAt(waiting) - Date.now());
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void resumeCaptureUploads();
  }, delay);
};

const processOutbox = async (): Promise<void> => {
  while (navigator.onLine !== false) {
    const jobs = await prune();
    const job = nextRunnable(jobs);
    if (!job) break;
    const recovering = job.status === 'uploading';
    const uploading = await patchJob(job, {
      status: 'uploading',
      attempts: job.attempts + 1,
      nextAttemptAt: Date.now() + UPLOAD_LEASE_MS,
      message: recovering
        ? '上次上传被系统中断，正在从本机队列自动续传'
        : job.payloads.length > 1 ? `正在后台上传 ${job.payloads.length} 道题` : '正在后台上传图片',
      error: '',
    });
    try {
      const result = await saveNoteImagesBatch(uploading.payloads);
      if (result.learningData) saveLearningDataCache(result.learningData);
      await patchJob(uploading, {
        status: 'completed',
        nextAttemptAt: 0,
        message: uploading.payloads.length > 1 ? `${uploading.payloads.length} 道题已同步，局域网规则正在后台命名分类` : '图片已同步，局域网规则正在后台命名分类',
        error: '',
        completedAt: nowIso(),
        payloads: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = retryable(message);
      await patchJob(uploading, {
        status: 'failed',
        nextAttemptAt: canRetry ? Date.now() + retryDelay(uploading.attempts) : Number.MAX_SAFE_INTEGER,
        message: canRetry ? '网络中断，已保留在本机，稍后自动续传' : '后台保存失败，已保留在本机，可手动重试',
        error: message,
      });
      if (!canRetry) break;
    }
  }
  await scheduleNext();
};

export const enqueueCaptureUpload = async (payloads: SaveNotePayload[]): Promise<CaptureUploadJob> => {
  if (!Array.isArray(payloads) || payloads.length < 1) throw new Error('没有可加入后台保存的图片。');
  const jobs = await prune();
  const activeJobs = jobs.filter((job) => !['completed', 'cancelled'].includes(job.status));
  const noteUids = payloads.map((item) => item.noteUid || '').filter(Boolean);
  const duplicate = activeJobs.find((job) => job.noteUids.some((uid) => noteUids.includes(uid)));
  if (duplicate) {
    void resumeCaptureUploads();
    return duplicate;
  }
  const createdAt = nowIso();
  const job: CaptureUploadJob = {
    id: `capture-${crypto.randomUUID()}`,
    status: 'queued',
    payloads,
    noteUids,
    attempts: 0,
    nextAttemptAt: Date.now(),
    message: payloads.length > 1 ? `${payloads.length} 道题已存入本机后台队列` : '图片已存入本机后台队列',
    error: '',
    createdAt,
    updatedAt: createdAt,
    completedAt: '',
  };
  const totalBytes = activeJobs.reduce((sum, item) => sum + jobBytes(item), 0) + jobBytes(job);
  if (activeJobs.length >= MAX_JOBS || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('本机待上传图片过多，请联网完成现有任务后再继续。');
  }
  await putJob(job);
  try { await navigator.storage?.persist?.(); } catch {}
  await emit();
  void resumeCaptureUploads();
  return job;
};

export const resumeCaptureUploads = async (): Promise<void> => {
  if (processorPromise) return processorPromise;
  processorPromise = processOutbox().finally(() => { processorPromise = null; });
  return processorPromise;
};

export const retryCaptureUploads = async (): Promise<void> => {
  const jobs = await readJobs();
  await Promise.all(jobs.filter((job) => job.status === 'failed').map((job) => putJob({
    ...job,
    status: 'queued',
    nextAttemptAt: Date.now(),
    message: '等待重新上传',
    error: '',
    updatedAt: nowIso(),
  })));
  await emit();
  return resumeCaptureUploads();
};

export const getCaptureUploadSummary = async (): Promise<CaptureUploadSummary> => {
  let jobs: CaptureUploadJob[] = [];
  try { jobs = await readJobs(); } catch {}
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const uploading = jobs.filter((job) => job.status === 'uploading').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const completed = jobs.filter((job) => job.status === 'completed').length;
  const message = uploading > 0 ? `正在后台保存 ${uploading} 条`
    : queued > 0 ? `${queued} 条等待后台保存`
      : failed > 0 ? `${failed} 条已保留在本机，等待重试`
        : completed > 0 ? '最近拍照已同步' : '';
  return { queued, uploading, failed, completed, message };
};

export const subscribeCaptureUploads = (listener: (summary: CaptureUploadSummary) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<CaptureUploadSummary>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
};

export const installCaptureUploadResumer = (): (() => void) => {
  const resume = () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) void resumeCaptureUploads(); };
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', resume);
  void emit();
  void resumeCaptureUploads();
  return () => {
    window.removeEventListener('online', resume);
    document.removeEventListener('visibilitychange', resume);
  };
};

export const captureUploadQueueInternals = Object.freeze({
  isRunnable,
  runnableAt,
  uploadLeaseMs: UPLOAD_LEASE_MS,
});
