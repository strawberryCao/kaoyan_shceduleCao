import { saveLearningDataCache } from './learningData';
import { saveNoteImagesBatch, type SaveNotePayload } from './notes';

export type CaptureUploadStatus = 'queued' | 'uploading' | 'completed' | 'failed' | 'cancelled';

export interface CaptureUploadJob {
  id: string;
  status: CaptureUploadStatus;
  payloads: SaveNotePayload[];
  imageBlobs?: Blob[];
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

const nowIso = () => new Date().toISOString();
const dataUrlBytes = (value: string): number => Math.ceil(Math.max(0, value.length - value.indexOf(',') - 1) * 0.75);
const jobBytes = (job: CaptureUploadJob): number => job.imageBlobs?.length
  ? job.imageBlobs.reduce((sum, blob) => sum + blob.size, 0)
  : job.payloads.reduce((sum, item) => sum + dataUrlBytes(item.imageDataUrl), 0);
const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => (await fetch(dataUrl)).blob();
const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('本机原图读取失败。'));
  reader.readAsDataURL(blob);
});

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
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
  }).catch((error): never => {
    databasePromise = null;
    throw error;
  });
  databasePromise = pending;
  return pending;
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
  void import('./activityTasks').then(({ mirrorCaptureActivity }) => mirrorCaptureActivity(job)).catch(() => undefined);
};

const deleteJob = async (id: string): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  await committed;
  void import('./activityTasks').then(({ removeActivityTask }) => removeActivityTask(`capture:${id}`)).catch(() => undefined);
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
      const payloads = uploading.imageBlobs?.length
        ? await Promise.all(uploading.payloads.map(async (payload, index) => ({ ...payload, imageDataUrl: await blobToDataUrl(uploading.imageBlobs![index]) })))
        : uploading.payloads;
      const result = await saveNoteImagesBatch(payloads);
      if (result.learningData) saveLearningDataCache(result.learningData);
      await patchJob(uploading, {
        status: 'completed',
        nextAttemptAt: 0,
        message: uploading.payloads.length > 1 ? `${uploading.payloads.length} 道题已同步，局域网规则正在后台命名分类` : '图片已同步，局域网规则正在后台命名分类',
        error: '',
        completedAt: nowIso(),
        payloads: [],
        imageBlobs: [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = retryable(message);
      await patchJob(uploading, {
        status: 'failed',
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        message: canRetry ? '网络中断，原图已保留在本机；可在活动中心明确点击“继续”' : '后台保存失败，原图仍保留在本机，可手动重试',
        error: message,
      });
      break;
    }
  }
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
  const imageBlobs = await Promise.all(payloads.map((payload) => dataUrlToBlob(payload.imageDataUrl)));
  const job: CaptureUploadJob = {
    id: `capture-${crypto.randomUUID()}`,
    status: 'queued',
    payloads: payloads.map((payload) => ({ ...payload, imageDataUrl: '' })),
    imageBlobs,
    noteUids,
    attempts: 0,
    nextAttemptAt: Date.now(),
    message: payloads.length > 1 ? `${payloads.length} 道题已安全保存在本机，活动中心可查看并继续上传` : '图片已安全保存在本机，活动中心可查看并继续上传',
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

export const retryCaptureUpload = async (id: string): Promise<void> => {
  const job = (await readJobs()).find((candidate) => candidate.id === id);
  if (!job || ['completed', 'cancelled'].includes(job.status)) throw new Error('这条拍题任务当前不能继续。');
  await putJob({ ...job, status: 'queued', nextAttemptAt: Date.now(), message: '等待继续上传', error: '', updatedAt: nowIso() });
  await emit();
  return resumeCaptureUploads();
};

export const cancelCaptureUpload = async (id: string): Promise<void> => {
  const job = (await readJobs()).find((candidate) => candidate.id === id);
  if (!job || ['completed', 'cancelled'].includes(job.status)) return;
  await putJob({ ...job, status: 'cancelled', nextAttemptAt: Number.MAX_SAFE_INTEGER, message: '已取消；本机原图仍保留到任务自动清理', error: '', completedAt: nowIso(), updatedAt: nowIso() });
  await emit();
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
  // Opening the app or restoring connectivity must not replay paid work.
  // Historical jobs remain visible and can be retried explicitly.
  void emit();
  return () => undefined;
};

export const captureUploadQueueInternals = Object.freeze({
  isRunnable,
  runnableAt,
  uploadLeaseMs: UPLOAD_LEASE_MS,
});
