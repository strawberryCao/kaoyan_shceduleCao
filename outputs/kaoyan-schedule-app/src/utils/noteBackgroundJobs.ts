import {
  createCaptureBatch,
  getCaptureBatchJob,
  IS_CLOUD_RUNTIME,
  retryCaptureBatchJob,
} from './notes';

export type MultiQuestionJobStatus =
  | 'queued'
  | 'uploading'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'needs_review'
  | 'waiting_quota'
  | 'failed';

export interface MultiQuestionJob {
  id: string;
  serverJobId: string;
  imageDataUrl: string;
  subject: string;
  remark: string;
  status: MultiQuestionJobStatus;
  progress: number;
  message: string;
  error: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  detectedCount: number;
  savedNoteUids: string[];
  feedbackNoteUid: string;
}

const DB_NAME = 'kaoyan-note-background-v2';
const STORE_NAME = 'multi-question-jobs';
const DB_VERSION = 1;
const EVENT_NAME = 'kaoyan-multi-question-job-changed';
const RETRY_DELAYS = [1_500, 5_000, 20_000, 60_000];
const activeJobs = new Set<string>();
let databasePromise: Promise<IDBDatabase> | null = null;

const emit = (job: MultiQuestionJob) => {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: job }));
};

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('当前浏览器不支持可靠后台队列。'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('后台队列数据库打开失败。'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
  });
  return databasePromise;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('后台队列读写失败。'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('后台队列事务已中止。'));
  transaction.onerror = () => reject(transaction.error ?? new Error('后台队列事务失败。'));
});

const readJobs = async (): Promise<MultiQuestionJob[]> => {
  const database = await openDatabase();
  return requestResult(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()) as Promise<MultiQuestionJob[]>;
};

const readJob = async (id: string): Promise<MultiQuestionJob | null> => {
  const database = await openDatabase();
  return (await requestResult(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)) as MultiQuestionJob | undefined) ?? null;
};

const putJob = async (job: MultiQuestionJob): Promise<MultiQuestionJob> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).put(job));
  await committed;
  emit(job);
  return job;
};

const removeJob = async (id: string): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  await committed;
};

const patchJob = async (id: string, patch: Partial<MultiQuestionJob>): Promise<MultiQuestionJob> => {
  const current = await readJob(id);
  if (!current) throw new Error('后台多题任务不存在。');
  return putJob({ ...current, ...patch, updatedAt: new Date().toISOString() });
};

const localStatus = (status: string): MultiQuestionJobStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'processing') return 'processing';
  if (status === 'waiting_quota') return 'waiting_quota';
  if (status === 'needs_review' || status === 'configuration_mismatch' || status === 'waiting_configuration') return 'needs_review';
  if (status === 'failed_retryable') return 'failed';
  return 'submitted';
};

const pollServerJob = async (job: MultiQuestionJob): Promise<void> => {
  if (!job.serverJobId) return;
  try {
    const response = await getCaptureBatchJob(job.serverJobId);
    const status = localStatus(response.job.status);
    const completed = status === 'completed';
    await patchJob(job.id, {
      status,
      progress: Number(response.job.progress) || 0,
      message: response.job.message || '原图已保存，后台任务处理中',
      error: response.job.error || '',
      detectedCount: response.job.resultEntryIds?.length || 0,
      savedNoteUids: response.job.resultEntryIds || [],
      completedAt: completed ? new Date().toISOString() : '',
    });
    if (!completed && !['needs_review', 'waiting_quota', 'failed'].includes(status)) {
      window.setTimeout(() => { void resumeOne(job.id); }, 5_000);
    }
  } catch {
    window.setTimeout(() => { void resumeOne(job.id); }, 15_000);
  }
};

const submitOriginal = async (job: MultiQuestionJob): Promise<void> => {
  const uploading = await patchJob(job.id, {
    status: 'uploading',
    attempts: Number(job.attempts || 0) + 1,
    progress: 3,
    message: '正在一次性保存整页原图和后台任务',
    error: '',
  });
  try {
    const response = await createCaptureBatch(uploading.imageDataUrl, {
      batchId: uploading.id,
      subject: uploading.subject,
      remark: uploading.remark,
    });
    const submitted = await patchJob(job.id, {
      serverJobId: response.jobId,
      imageDataUrl: '',
      status: localStatus(response.job.status),
      progress: Number(response.job.progress) || 5,
      message: response.job.message || '原图已保存，AI 将在后台继续处理',
      error: response.job.error || '',
    });
    void pollServerJob(submitted);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchJob(job.id, {
      status: 'failed',
      message: '上传未确认，原图仍保留在本机队列，稍后自动重试',
      error: message,
    });
    const delay = RETRY_DELAYS[Math.min(RETRY_DELAYS.length - 1, Number(uploading.attempts) - 1)];
    window.setTimeout(() => { void resumeOne(job.id); }, delay);
  }
};

const resumeOne = async (id: string): Promise<void> => {
  if (activeJobs.has(id) || navigator.onLine === false) return;
  const job = await readJob(id);
  if (!job) return;
  activeJobs.add(id);
  try {
    if (job.serverJobId) await pollServerJob(job);
    else if (job.imageDataUrl && ['queued', 'failed', 'uploading'].includes(job.status)) await submitOriginal(job);
  } finally {
    activeJobs.delete(id);
  }
};

export const enqueueMultiQuestionJob = async (
  imageDataUrl: string,
  options: { subject?: string; remark?: string } = {},
): Promise<MultiQuestionJob> => {
  const now = new Date().toISOString();
  const job: MultiQuestionJob = {
    id: `batch-${crypto.randomUUID()}`,
    serverJobId: '',
    imageDataUrl,
    subject: options.subject?.trim() || '默认文件夹',
    remark: options.remark?.trim() || '',
    status: 'queued',
    progress: 0,
    message: '整页原图已保存在本机上传队列',
    error: '',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    detectedCount: 0,
    savedNoteUids: [],
    feedbackNoteUid: '',
  };
  await putJob(job);
  try { await navigator.storage?.persist?.(); } catch {}
  if (IS_CLOUD_RUNTIME) {
    window.setTimeout(() => { void resumeOne(job.id); }, 0);
    return job;
  }

  // 局域网保存必须等到本地服务确认磁盘写入，不能只把原图留在浏览器队列
  // 就向用户显示“已保存”。
  await resumeOne(job.id);
  const persisted = await readJob(job.id);
  if (!persisted?.serverJobId || persisted.status === 'failed') {
    throw new Error(persisted?.error || '本地原图尚未确认写入磁盘，请重试。');
  }
  return persisted;
};

export const resumeMultiQuestionJobs = async (): Promise<void> => {
  let jobs: MultiQuestionJob[];
  try { jobs = await readJobs(); } catch { return; }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const job of jobs) {
    if (job.status === 'completed' && new Date(job.completedAt || job.updatedAt).getTime() < cutoff) {
      await removeJob(job.id);
      continue;
    }
    if (!['completed', 'needs_review', 'waiting_quota'].includes(job.status)) {
      window.setTimeout(() => { void resumeOne(job.id); }, 0);
    }
  }
};

export const retryMultiQuestionJob = async (id: string): Promise<MultiQuestionJob> => {
  const current = await readJob(id);
  if (!current?.serverJobId) throw new Error('这条任务还没有取得服务器任务编号。');
  const retry = await retryCaptureBatchJob(current.serverJobId);
  const next = await patchJob(id, {
    status: localStatus(retry.job.status),
    progress: Number(retry.job.progress) || 5,
    message: retry.job.message || (retry.accepted ? '已重新加入后台处理' : '暂时无法重试'),
    error: retry.job.error || '',
    attempts: Number(current.attempts || 0) + 1,
    completedAt: '',
  });
  if (retry.accepted) window.setTimeout(() => { void resumeOne(id); }, 1_000);
  return next;
};

export const subscribeMultiQuestionJobs = (listener: (job: MultiQuestionJob) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<MultiQuestionJob>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
};
