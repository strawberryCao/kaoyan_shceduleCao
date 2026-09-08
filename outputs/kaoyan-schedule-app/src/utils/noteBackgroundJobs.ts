import {
  createCaptureBatch,
  getCaptureBatchJob,
  IS_CLOUD_RUNTIME,
  NOTE_SERVER_URL,
  retryCaptureBatchJob,
} from './notes';
import { fetchLearningData } from './learningData';
import {
  openTransientBytes,
  sealTransientBytes,
  type EncryptedTransientBytes,
} from './captureUploadQueue';

export type MultiQuestionJobStatus =
  | 'queued'
  | 'uploading'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'needs_review'
  | 'waiting_quota'
  | 'cancelled'
  | 'failed';

export interface MultiQuestionJob {
  id: string;
  serverJobId: string;
  sourceEntryId?: string;
  imageDataUrl: string;
  imageBlob?: Blob;
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
const DB_VERSION = 2;
const EVENT_NAME = 'kaoyan-multi-question-job-changed';
const activeJobs = new Set<string>();
let databasePromise: Promise<IDBDatabase> | null = null;
let migrationPromise: Promise<void> | null = null;

interface StoredMultiQuestionJob extends Omit<MultiQuestionJob, 'imageDataUrl' | 'imageBlob' | 'subject' | 'remark'> {
  schemaVersion: 2;
  encryption: 'AES-GCM';
  sealedMetadata?: EncryptedTransientBytes;
  sealedImage?: EncryptedTransientBytes;
  imageMimeType?: string;
}

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => (await fetch(dataUrl)).blob();
const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('本机裁题原图读取失败。'));
  reader.readAsDataURL(blob);
});

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

const readStoredJobs = async (): Promise<Array<StoredMultiQuestionJob | MultiQuestionJob>> => {
  const database = await openDatabase();
  return requestResult(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll());
};

const readStoredJob = async (id: string): Promise<StoredMultiQuestionJob | MultiQuestionJob | null> => {
  const database = await openDatabase();
  return (await requestResult(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)) as StoredMultiQuestionJob | MultiQuestionJob | undefined) ?? null;
};

const storeJob = async (job: StoredMultiQuestionJob): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).put(job));
  await committed;
};

const toStoredJob = async (job: MultiQuestionJob): Promise<StoredMultiQuestionJob> => {
  const sourceBlob = job.imageBlob || (job.imageDataUrl ? await dataUrlToBlob(job.imageDataUrl) : null);
  const { imageDataUrl: _imageDataUrl, imageBlob: _imageBlob, subject, remark, ...rest } = job;
  const [sealedMetadata, sealedImage] = sourceBlob ? await Promise.all([
    sealTransientBytes('multi-question-metadata', job.id, new TextEncoder().encode(JSON.stringify({ subject, remark }))),
    sealTransientBytes('multi-question-image', job.id, await sourceBlob.arrayBuffer()),
  ]) : [undefined, undefined];
  return {
    ...rest,
    schemaVersion: 2,
    encryption: 'AES-GCM',
    sealedMetadata,
    sealedImage,
    imageMimeType: sourceBlob?.type || '',
  };
};

const fromStoredJob = async (stored: StoredMultiQuestionJob | MultiQuestionJob): Promise<MultiQuestionJob> => {
  if ((stored as StoredMultiQuestionJob).schemaVersion !== 2) return stored as MultiQuestionJob;
  const encrypted = stored as StoredMultiQuestionJob;
  let subject = '默认文件夹';
  let remark = '';
  let imageBlob: Blob | undefined;
  if (encrypted.sealedMetadata) {
    const metadata = JSON.parse(new TextDecoder().decode(await openTransientBytes(
      'multi-question-metadata', encrypted.id, encrypted.sealedMetadata,
    ))) as { subject?: string; remark?: string };
    subject = metadata.subject?.trim() || subject;
    remark = metadata.remark?.trim() || '';
  }
  if (encrypted.sealedImage) {
    imageBlob = new Blob([
      await openTransientBytes('multi-question-image', encrypted.id, encrypted.sealedImage),
    ], { type: encrypted.imageMimeType || 'image/jpeg' });
  }
  const {
    schemaVersion: _schemaVersion,
    encryption: _encryption,
    sealedMetadata: _sealedMetadata,
    sealedImage: _sealedImage,
    imageMimeType: _imageMimeType,
    ...rest
  } = encrypted;
  return { ...rest, imageDataUrl: '', imageBlob, subject, remark };
};

const ensureMigrated = async (): Promise<void> => {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    for (const stored of await readStoredJobs()) {
      if ((stored as StoredMultiQuestionJob).schemaVersion === 2) continue;
      await storeJob(await toStoredJob(stored as MultiQuestionJob));
    }
  })().catch((error): never => {
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
};

const readJobs = async (): Promise<MultiQuestionJob[]> => {
  await ensureMigrated();
  return Promise.all((await readStoredJobs()).map(fromStoredJob));
};

const readJob = async (id: string): Promise<MultiQuestionJob | null> => {
  await ensureMigrated();
  const stored = await readStoredJob(id);
  return stored ? fromStoredJob(stored) : null;
};

const putJob = async (job: MultiQuestionJob): Promise<MultiQuestionJob> => {
  await storeJob(await toStoredJob(job));
  emit(job);
  void import('./activityTasks').then(({ mirrorCropActivity }) => mirrorCropActivity(job)).catch(() => undefined);
  return job;
};

const removeJob = async (id: string): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  await committed;
  void import('./activityTasks').then(({ removeActivityTask }) => removeActivityTask(`crop:${id}`)).catch(() => undefined);
};

const patchJob = async (id: string, patch: Partial<MultiQuestionJob>): Promise<MultiQuestionJob> => {
  const current = await readJob(id);
  if (!current) throw new Error('后台多题任务不存在。');
  return putJob({ ...current, ...patch, updatedAt: new Date().toISOString() });
};

const localStatus = (status: string): MultiQuestionJobStatus => {
  if (status === 'cancelled') return 'cancelled';
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
      sourceEntryId: response.job.entryId || response.job.parentEntryId || job.sourceEntryId,
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
    const imageDataUrl = uploading.imageBlob ? await blobToDataUrl(uploading.imageBlob) : uploading.imageDataUrl;
    const response = await createCaptureBatch(imageDataUrl, {
      batchId: uploading.id,
      subject: uploading.subject,
      remark: uploading.remark,
    });
    const submitted = await patchJob(job.id, {
      serverJobId: response.jobId,
      sourceEntryId: response.entryId || response.job.entryId || response.job.parentEntryId || '',
      imageDataUrl: '',
      imageBlob: undefined,
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
  }
};

const resumeOne = async (id: string): Promise<void> => {
  if (activeJobs.has(id) || navigator.onLine === false) return;
  const job = await readJob(id);
  if (!job) return;
  activeJobs.add(id);
  try {
    if (job.serverJobId) await pollServerJob(job);
    else if ((job.imageBlob || job.imageDataUrl) && ['queued', 'failed', 'uploading'].includes(job.status)) await submitOriginal(job);
  } finally {
    activeJobs.delete(id);
  }
};

export const enqueueMultiQuestionJob = async (
  imageDataUrl: string,
  options: { subject?: string; remark?: string } = {},
): Promise<MultiQuestionJob> => {
  const now = new Date().toISOString();
  const imageBlob = await dataUrlToBlob(imageDataUrl);
  const job: MultiQuestionJob = {
    id: `batch-${crypto.randomUUID()}`,
    serverJobId: '',
    sourceEntryId: '',
    imageDataUrl: '',
    imageBlob,
    subject: options.subject?.trim() || '默认文件夹',
    remark: options.remark?.trim() || '',
    status: 'queued',
    progress: 0,
    message: '整页原图已加密暂存在本机，送达 Mac 后自动清除',
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
    if (!job.serverJobId && (job.imageBlob || job.imageDataUrl) && ['queued', 'uploading', 'failed'].includes(job.status)) {
      // The stable batch id makes a lost upload response safe to replay. This
      // only confirms the original on Mac; failed/uncertain paid AI work is
      // never restarted from a browser lifecycle event.
      await resumeOne(job.id);
      continue;
    }
    if (job.serverJobId && ['submitted', 'processing'].includes(job.status)) {
      // Status polling is read-only and lets a reopened Safari surface work
      // that the Mac has already completed.
      await resumeOne(job.id);
    }
  }
};

export const installMultiQuestionJobResumer = (): (() => void) => {
  const resume = () => { void resumeMultiQuestionJobs(); };
  const visible = () => { if (document.visibilityState === 'visible') resume(); };
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', visible);
  resume();
  return () => {
    window.removeEventListener('online', resume);
    window.removeEventListener('pageshow', resume);
    document.removeEventListener('visibilitychange', visible);
  };
};

export const retryMultiQuestionJob = async (id: string): Promise<MultiQuestionJob> => {
  const current = await readJob(id);
  if (current && !current.serverJobId && (current.imageBlob || current.imageDataUrl)) {
    const queued = await patchJob(id, {
      status: 'queued',
      progress: 0,
      message: '已重新加入本机加密上传队列',
      error: '',
      completedAt: '',
    });
    window.setTimeout(() => { void resumeOne(id); }, 0);
    return queued;
  }
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

export const loadMultiQuestionJobForReview = async (id: string): Promise<{
  job: MultiQuestionJob;
  imageDataUrl: string;
}> => {
  let job = await readJob(id);
  if (!job) throw new Error('这条多题审核任务不存在。');
  if (job.imageBlob) return { job, imageDataUrl: await blobToDataUrl(job.imageBlob) };
  if (job.imageDataUrl) return { job, imageDataUrl: job.imageDataUrl };

  if (!job.sourceEntryId && job.serverJobId) {
    const response = await getCaptureBatchJob(job.serverJobId);
    const sourceEntryId = response.job.entryId || response.job.parentEntryId || '';
    if (sourceEntryId) job = await patchJob(job.id, { sourceEntryId });
  }
  const sourceEntryId = job.sourceEntryId;
  if (!sourceEntryId) throw new Error('原图索引缺失；任务记录仍保留，请从学习中心打开“AI多题原图”。');
  const snapshot = await fetchLearningData();
  const sourceNote = Object.values(snapshot.days || {})
    .flatMap((day) => Array.isArray(day.autoNotes) ? day.autoNotes : [])
    .find((note) => note.noteUid === sourceEntryId);
  const sourceAttachment = sourceNote?.attachments?.find((attachment) => attachment.kind === 'image')
    || sourceNote?.attachments?.[0];
  const filePath = sourceAttachment?.filePath || sourceNote?.filePath || '';
  if (!filePath) throw new Error('找不到这条任务保存的整页原图。');
  const response = await fetch(`${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(filePath)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`整页原图读取失败（${response.status}）。`);
  return { job, imageDataUrl: await blobToDataUrl(await response.blob()) };
};

export const completeMultiQuestionReview = async (id: string, savedNoteUids: string[]): Promise<MultiQuestionJob> => (
  patchJob(id, {
    status: 'completed',
    progress: 100,
    message: `逐题审核完成，已保存 ${savedNoteUids.length} 道题`,
    error: '',
    detectedCount: savedNoteUids.length,
    savedNoteUids,
    imageDataUrl: '',
    imageBlob: undefined,
    completedAt: new Date().toISOString(),
  })
);

export const cancelMultiQuestionJob = async (id: string): Promise<void> => {
  const current = await readJob(id);
  if (!current || current.status === 'completed') return;
  await patchJob(id, {
    status: 'cancelled',
    message: '已停止自动处理；原图和当前结果仍保留，可进入审核或稍后重试',
    error: '',
    completedAt: '',
  });
  await import('./activityTasks').then(({ patchActivityTask }) => patchActivityTask(`crop:${id}`, { status: 'cancelled', canCancel: false, canRetry: true }));
};

export const subscribeMultiQuestionJobs = (listener: (job: MultiQuestionJob) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<MultiQuestionJob>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
};

export const multiQuestionJobInternals = Object.freeze({
  databaseName: DB_NAME,
  storeName: STORE_NAME,
});
