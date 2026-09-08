import { saveLearningDataCache } from './learningData';
import { saveNoteImagesBatch, type SaveNotePayload } from './notes';

export type CaptureUploadStatus = 'queued' | 'uploading' | 'completed' | 'failed' | 'cancelled';

export interface CaptureUploadJob {
  id: string;
  status: CaptureUploadStatus;
  noteUids: string[];
  itemCount: number;
  attempts: number;
  nextAttemptAt: number;
  message: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  encrypted: true;
}

export interface CaptureUploadSummary {
  queued: number;
  uploading: number;
  failed: number;
  completed: number;
  message: string;
  encrypted: true;
}

interface EncryptedCaptureItem {
  metadataIv: ArrayBuffer;
  metadataCiphertext: ArrayBuffer;
  imageIv: ArrayBuffer;
  imageCiphertext: ArrayBuffer;
  mimeType: string;
}

export interface EncryptedTransientBytes {
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

interface StoredCaptureUploadJob extends CaptureUploadJob {
  schemaVersion: 2;
  encryption: 'AES-GCM';
  encryptedItems: EncryptedCaptureItem[];
  encryptedByteLength: number;
}

interface LegacyCaptureUploadJob extends Omit<CaptureUploadJob, 'itemCount' | 'encrypted'> {
  payloads?: SaveNotePayload[];
  imageBlobs?: Blob[];
}

const DB_NAME = 'kaoyan-capture-outbox-v2';
const STORE_NAME = 'capture-uploads';
const KEY_STORE_NAME = 'capture-keys';
const KEY_ID = 'aes-gcm-v1';
const DB_VERSION = 2;
const EVENT_NAME = 'kaoyan-capture-outbox-changed';
const MAX_JOBS = 36;
const MAX_TOTAL_BYTES = 110 * 1024 * 1024;
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;
const UPLOAD_LEASE_MS = 2 * 60 * 1000;
const RETRY_DELAYS_MS = [1_200, 3_000, 10_000, 30_000, 90_000, 5 * 60_000];

let databasePromise: Promise<IDBDatabase> | null = null;
let encryptionKeyPromise: Promise<CryptoKey> | null = null;
let processorPromise: Promise<void> | null = null;
let migrationPromise: Promise<void> | null = null;
let wakeTimer: number | null = null;

const nowIso = () => new Date().toISOString();
const textEncoder = new TextEncoder();
const cloneBuffer = (value: ArrayBuffer | ArrayBufferView): ArrayBuffer => {
  if (value instanceof ArrayBuffer) return value.slice(0);
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
};

const dataUrlToBlob = async (dataUrl: string): Promise<Blob> => (await fetch(dataUrl)).blob();
const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('加密原图读取失败。'));
  reader.readAsDataURL(blob);
});

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('本机加密上传队列读写失败。'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('本机加密上传队列事务已中止。'));
  transaction.onerror = () => reject(transaction.error ?? new Error('本机加密上传队列事务失败。'));
});

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (!window.indexedDB || !window.crypto?.subtle) {
      reject(new Error('当前浏览器不支持加密离线队列，请保持连接后再保存。'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('本机加密上传队列打开失败。'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      if (!database.objectStoreNames.contains(KEY_STORE_NAME)) database.createObjectStore(KEY_STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  }).catch((error): never => {
    databasePromise = null;
    throw error;
  });
  databasePromise = pending;
  return pending;
};

const getEncryptionKey = async (): Promise<CryptoKey> => {
  if (encryptionKeyPromise) return encryptionKeyPromise;
  encryptionKeyPromise = (async () => {
    const database = await openDatabase();
    let transaction = database.transaction(KEY_STORE_NAME, 'readonly');
    const existing = await requestResult<{ id: string; key: CryptoKey } | undefined>(transaction.objectStore(KEY_STORE_NAME).get(KEY_ID));
    if (existing?.key) return existing.key;
    const generated = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    transaction = database.transaction(KEY_STORE_NAME, 'readwrite');
    const committed = transactionDone(transaction);
    try {
      await requestResult(transaction.objectStore(KEY_STORE_NAME).add({ id: KEY_ID, key: generated, createdAt: nowIso() }));
      await committed;
      return generated;
    } catch (error) {
      try { transaction.abort(); } catch {}
      // The rejected transaction promise is otherwise left unobserved when a
      // second tab wins the one-time key creation race.
      await committed.catch(() => undefined);
      const retry = database.transaction(KEY_STORE_NAME, 'readonly');
      const winner = await requestResult<{ id: string; key: CryptoKey } | undefined>(retry.objectStore(KEY_STORE_NAME).get(KEY_ID));
      if (winner?.key) return winner.key;
      throw error;
    }
  })().catch((error): never => {
    encryptionKeyPromise = null;
    throw new Error(`无法建立不可导出的本机加密密钥：${error instanceof Error ? error.message : String(error)}`);
  });
  return encryptionKeyPromise;
};

const additionalData = (jobId: string, index: number, part: 'metadata' | 'image') => (
  textEncoder.encode(`kaoyan-mobile-outbox-v2\0${jobId}\0${index}\0${part}`)
);

const encryptBytes = async (key: CryptoKey, bytes: BufferSource, aad: Uint8Array): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> => {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: cloneBuffer(aad) }, key, bytes);
  return { iv: cloneBuffer(iv), ciphertext };
};

const decryptBytes = (key: CryptoKey, ciphertext: ArrayBuffer, iv: ArrayBuffer, aad: Uint8Array): Promise<ArrayBuffer> => (
  window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: cloneBuffer(aad) }, key, ciphertext)
);

const transientAdditionalData = (scope: string, identifier: string) => (
  textEncoder.encode(`kaoyan-mobile-transient-v1\0${scope}\0${identifier}`)
);

export const sealTransientBytes = async (
  scope: string,
  identifier: string,
  bytes: BufferSource,
): Promise<EncryptedTransientBytes> => encryptBytes(
  await getEncryptionKey(),
  bytes,
  transientAdditionalData(scope, identifier),
);

export const openTransientBytes = async (
  scope: string,
  identifier: string,
  sealed: EncryptedTransientBytes,
): Promise<ArrayBuffer> => decryptBytes(
  await getEncryptionKey(),
  sealed.ciphertext,
  sealed.iv,
  transientAdditionalData(scope, identifier),
);

const encryptPayloads = async (jobId: string, payloads: SaveNotePayload[]): Promise<{ items: EncryptedCaptureItem[]; bytes: number }> => {
  const key = await getEncryptionKey();
  const items: EncryptedCaptureItem[] = [];
  let bytes = 0;
  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    const image = await dataUrlToBlob(payload.imageDataUrl);
    const metadata = { ...payload, imageDataUrl: '' };
    const [encryptedMetadata, encryptedImage] = await Promise.all([
      encryptBytes(key, textEncoder.encode(JSON.stringify(metadata)), additionalData(jobId, index, 'metadata')),
      encryptBytes(key, await image.arrayBuffer(), additionalData(jobId, index, 'image')),
    ]);
    items.push({
      metadataIv: encryptedMetadata.iv,
      metadataCiphertext: encryptedMetadata.ciphertext,
      imageIv: encryptedImage.iv,
      imageCiphertext: encryptedImage.ciphertext,
      mimeType: image.type || 'image/jpeg',
    });
    bytes += encryptedMetadata.ciphertext.byteLength + encryptedImage.ciphertext.byteLength;
  }
  return { items, bytes };
};

const decryptPayloads = async (job: StoredCaptureUploadJob): Promise<SaveNotePayload[]> => {
  if (job.schemaVersion !== 2 || job.encryption !== 'AES-GCM') throw new Error('加密队列版本无法识别，未尝试读取明文。');
  const key = await getEncryptionKey();
  return Promise.all(job.encryptedItems.map(async (item, index) => {
    const [metadataBytes, imageBytes] = await Promise.all([
      decryptBytes(key, item.metadataCiphertext, item.metadataIv, additionalData(job.id, index, 'metadata')),
      decryptBytes(key, item.imageCiphertext, item.imageIv, additionalData(job.id, index, 'image')),
    ]);
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as SaveNotePayload;
    return { ...metadata, imageDataUrl: await blobToDataUrl(new Blob([imageBytes], { type: item.mimeType })) };
  }));
};

const publicJob = (job: StoredCaptureUploadJob): CaptureUploadJob => ({
  id: job.id,
  status: job.status,
  noteUids: [...job.noteUids],
  itemCount: job.itemCount,
  attempts: job.attempts,
  nextAttemptAt: job.nextAttemptAt,
  message: job.message,
  error: job.error,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  completedAt: job.completedAt,
  encrypted: true,
});

const readRawJobs = async (): Promise<Array<StoredCaptureUploadJob | LegacyCaptureUploadJob>> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return requestResult(transaction.objectStore(STORE_NAME).getAll());
};

const putStoredJob = async (job: StoredCaptureUploadJob): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).put(job));
  await committed;
  void import('./activityTasks').then(({ mirrorCaptureActivity }) => mirrorCaptureActivity(publicJob(job))).catch(() => undefined);
};

const deleteJob = async (id: string): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  await committed;
  void import('./activityTasks').then(({ removeActivityTask }) => removeActivityTask(`capture:${id}`)).catch(() => undefined);
};

const migrateLegacyJobs = async (): Promise<void> => {
  const jobs = await readRawJobs();
  for (const candidate of jobs) {
    if ((candidate as StoredCaptureUploadJob).schemaVersion === 2) continue;
    const legacy = candidate as LegacyCaptureUploadJob;
    const payloads = Array.isArray(legacy.payloads) ? legacy.payloads : [];
    const restored = await Promise.all(payloads.map(async (payload, index) => ({
      ...payload,
      imageDataUrl: legacy.imageBlobs?.[index]
        ? await blobToDataUrl(legacy.imageBlobs[index])
        : payload.imageDataUrl,
    })));
    const encrypted = restored.length > 0 ? await encryptPayloads(legacy.id, restored) : { items: [], bytes: 0 };
    await putStoredJob({
      id: legacy.id,
      schemaVersion: 2,
      encryption: 'AES-GCM',
      encryptedItems: encrypted.items,
      encryptedByteLength: encrypted.bytes,
      status: legacy.status,
      noteUids: Array.isArray(legacy.noteUids) ? legacy.noteUids : restored.map((item) => item.noteUid || '').filter(Boolean),
      itemCount: restored.length || (Array.isArray(legacy.noteUids) ? legacy.noteUids.length : 0),
      attempts: Number(legacy.attempts) || 0,
      nextAttemptAt: Number(legacy.nextAttemptAt) || Date.now(),
      message: restored.length > 0 ? '旧版待上传内容已原位加密，等待安全续传' : String(legacy.message || ''),
      error: String(legacy.error || ''),
      createdAt: legacy.createdAt || nowIso(),
      updatedAt: nowIso(),
      completedAt: legacy.completedAt || '',
      encrypted: true,
    });
  }
};

const ensureMigrated = (): Promise<void> => {
  if (!migrationPromise) migrationPromise = migrateLegacyJobs().catch((error): never => {
    migrationPromise = null;
    throw error;
  });
  return migrationPromise;
};

const readJobs = async (): Promise<StoredCaptureUploadJob[]> => {
  await ensureMigrated();
  return (await readRawJobs()) as StoredCaptureUploadJob[];
};

const emit = async (): Promise<void> => {
  const summary = await getCaptureUploadSummary();
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: summary }));
};

const prune = async (): Promise<StoredCaptureUploadJob[]> => {
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

const retryable = (message: string): boolean => /load failed|failed to fetch|network|网络|请求超时|timeout|revision conflict|暂未确认|502|503|504/i.test(message);

const patchJob = async (job: StoredCaptureUploadJob, patch: Partial<StoredCaptureUploadJob>): Promise<StoredCaptureUploadJob> => {
  const updated = { ...job, ...patch, updatedAt: nowIso() };
  await putStoredJob(updated);
  await emit();
  return updated;
};

const isRunnable = (job: Pick<StoredCaptureUploadJob, 'status' | 'nextAttemptAt' | 'updatedAt' | 'createdAt'>, now = Date.now()): boolean => {
  if (job.status === 'queued' || job.status === 'failed') return job.nextAttemptAt <= now;
  if (job.status !== 'uploading') return false;
  const updatedAt = new Date(job.updatedAt || job.createdAt).getTime();
  const leaseExpiresAt = Number.isFinite(updatedAt) ? updatedAt + UPLOAD_LEASE_MS : job.nextAttemptAt;
  return Math.min(job.nextAttemptAt || leaseExpiresAt, leaseExpiresAt) <= now;
};

const runnableAt = (job: Pick<StoredCaptureUploadJob, 'status' | 'nextAttemptAt' | 'updatedAt' | 'createdAt'>): number => {
  if (job.status !== 'uploading') return job.nextAttemptAt;
  const updatedAt = new Date(job.updatedAt || job.createdAt).getTime();
  const leaseExpiresAt = Number.isFinite(updatedAt) ? updatedAt + UPLOAD_LEASE_MS : Date.now();
  return Math.min(job.nextAttemptAt || leaseExpiresAt, leaseExpiresAt);
};

const claimJob = async (candidate: StoredCaptureUploadJob): Promise<StoredCaptureUploadJob | null> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const current = await requestResult<StoredCaptureUploadJob | undefined>(store.get(candidate.id));
  if (!current || !isRunnable(current)) {
    try { transaction.abort(); } catch {}
    return null;
  }
  const recovering = current.status === 'uploading';
  const uploading: StoredCaptureUploadJob = {
    ...current,
    status: 'uploading',
    attempts: current.attempts + 1,
    nextAttemptAt: Date.now() + UPLOAD_LEASE_MS,
    message: recovering
      ? 'Safari 上次被系统中断，正在从加密队列自动续传'
      : current.itemCount > 1 ? `正在从加密队列上传 ${current.itemCount} 道题` : '正在从加密队列上传图片',
    error: '',
    updatedAt: nowIso(),
  };
  const committed = transactionDone(transaction);
  await requestResult(store.put(uploading));
  await committed;
  void import('./activityTasks').then(({ mirrorCaptureActivity }) => mirrorCaptureActivity(publicJob(uploading))).catch(() => undefined);
  await emit();
  return uploading;
};

const scheduleWake = (jobs: StoredCaptureUploadJob[]) => {
  if (wakeTimer !== null) window.clearTimeout(wakeTimer);
  wakeTimer = null;
  const future = jobs
    .filter((job) => ['queued', 'uploading', 'failed'].includes(job.status))
    .map(runnableAt)
    .filter((time) => Number.isFinite(time) && time < Number.MAX_SAFE_INTEGER && time > Date.now())
    .sort((a, b) => a - b)[0];
  if (!future) return;
  wakeTimer = window.setTimeout(() => { wakeTimer = null; void resumeCaptureUploads(); }, Math.min(60_000, Math.max(250, future - Date.now())));
};

const processOutbox = async (): Promise<void> => {
  while (navigator.onLine !== false) {
    const jobs = await prune();
    const candidate = jobs.filter((job) => isRunnable(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!candidate) {
      scheduleWake(jobs);
      break;
    }
    const uploading = await claimJob(candidate);
    if (!uploading) continue;
    try {
      const payloads = await decryptPayloads(uploading);
      const result = await saveNoteImagesBatch(payloads);
      if (result.learningData) saveLearningDataCache(result.learningData);
      await patchJob(uploading, {
        status: 'completed',
        nextAttemptAt: 0,
        message: uploading.itemCount > 1
          ? `${uploading.itemCount} 道题已送达 Mac；本机加密临时内容已清除`
          : '图片已送达 Mac；本机加密临时内容已清除',
        error: '',
        completedAt: nowIso(),
        encryptedItems: [],
        encryptedByteLength: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = retryable(message);
      await patchJob(uploading, {
        status: 'failed',
        nextAttemptAt: canRetry ? Date.now() + retryDelay(uploading.attempts) : Number.MAX_SAFE_INTEGER,
        message: canRetry
          ? '连接中断，内容仍加密保留；恢复网络或重新打开 Safari 后会续传'
          : '上传没有完成，加密内容仍保留；请检查登录状态后手动重试',
        error: message,
      });
      if (!canRetry) break;
    }
  }
};

export const enqueueCaptureUpload = async (payloads: SaveNotePayload[]): Promise<CaptureUploadJob> => {
  if (!Array.isArray(payloads) || payloads.length < 1) throw new Error('没有可加入加密队列的图片。');
  const jobs = await prune();
  const activeJobs = jobs.filter((job) => !['completed', 'cancelled'].includes(job.status));
  const noteUids = payloads.map((item) => item.noteUid || '').filter(Boolean);
  const duplicate = activeJobs.find((job) => job.noteUids.some((uid) => noteUids.includes(uid)));
  if (duplicate) {
    void resumeCaptureUploads();
    return publicJob(duplicate);
  }
  const id = `capture-${window.crypto.randomUUID()}`;
  const encrypted = await encryptPayloads(id, payloads);
  const totalBytes = activeJobs.reduce((sum, item) => sum + item.encryptedByteLength, 0) + encrypted.bytes;
  if (activeJobs.length >= MAX_JOBS || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('本机加密待上传内容过多，请联网完成现有任务后再继续。');
  }
  const createdAt = nowIso();
  const job: StoredCaptureUploadJob = {
    id,
    schemaVersion: 2,
    encryption: 'AES-GCM',
    encryptedItems: encrypted.items,
    encryptedByteLength: encrypted.bytes,
    status: 'queued',
    noteUids,
    itemCount: payloads.length,
    attempts: 0,
    nextAttemptAt: Date.now(),
    message: payloads.length > 1
      ? `${payloads.length} 道题已加密暂存在本机，送达 Mac 后自动清除`
      : '图片已加密暂存在本机，送达 Mac 后自动清除',
    error: '',
    createdAt,
    updatedAt: createdAt,
    completedAt: '',
    encrypted: true,
  };
  await putStoredJob(job);
  try { await navigator.storage?.persist?.(); } catch {}
  await emit();
  void resumeCaptureUploads();
  return publicJob(job);
};

export const resumeCaptureUploads = async (): Promise<void> => {
  if (processorPromise) return processorPromise;
  processorPromise = processOutbox().finally(() => { processorPromise = null; });
  return processorPromise;
};

export const retryCaptureUploads = async (): Promise<void> => {
  const jobs = await readJobs();
  await Promise.all(jobs.filter((job) => job.status === 'failed').map((job) => putStoredJob({
    ...job, status: 'queued', nextAttemptAt: Date.now(), message: '等待从加密队列重新上传', error: '', updatedAt: nowIso(),
  })));
  await emit();
  return resumeCaptureUploads();
};

export const retryCaptureUpload = async (id: string): Promise<void> => {
  const job = (await readJobs()).find((candidate) => candidate.id === id);
  if (!job || ['completed', 'cancelled'].includes(job.status)) throw new Error('这条拍题任务当前不能继续。');
  await putStoredJob({ ...job, status: 'queued', nextAttemptAt: Date.now(), message: '等待从加密队列继续上传', error: '', updatedAt: nowIso() });
  await emit();
  return resumeCaptureUploads();
};

export const cancelCaptureUpload = async (id: string): Promise<void> => {
  const job = (await readJobs()).find((candidate) => candidate.id === id);
  if (!job || ['completed', 'cancelled'].includes(job.status)) return;
  await putStoredJob({
    ...job,
    status: 'cancelled',
    nextAttemptAt: Number.MAX_SAFE_INTEGER,
    message: '已取消；加密临时内容将在清理周期内删除',
    error: '',
    completedAt: nowIso(),
    updatedAt: nowIso(),
  });
  await emit();
};

export const getCaptureUploadSummary = async (): Promise<CaptureUploadSummary> => {
  let jobs: StoredCaptureUploadJob[] = [];
  try { jobs = await readJobs(); } catch {}
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const uploading = jobs.filter((job) => job.status === 'uploading').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const completed = jobs.filter((job) => job.status === 'completed').length;
  const message = uploading > 0 ? `正在向 Mac 发送 ${uploading} 条`
    : queued > 0 ? `${queued} 条已加密，等待发送到 Mac`
      : failed > 0 ? `${failed} 条加密保留，等待恢复连接`
        : completed > 0 ? '最近拍照已送达 Mac' : '';
  return { queued, uploading, failed, completed, message, encrypted: true };
};

export const subscribeCaptureUploads = (listener: (summary: CaptureUploadSummary) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<CaptureUploadSummary>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
};

export const installCaptureUploadResumer = (): (() => void) => {
  const resume = () => { void emit(); void resumeCaptureUploads(); };
  const visible = () => { if (document.visibilityState === 'visible') resume(); };
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', visible);
  resume();
  return () => {
    window.removeEventListener('online', resume);
    window.removeEventListener('pageshow', resume);
    document.removeEventListener('visibilitychange', visible);
    if (wakeTimer !== null) window.clearTimeout(wakeTimer);
    wakeTimer = null;
  };
};

export const captureUploadQueueInternals = Object.freeze({
  databaseName: DB_NAME,
  storeName: STORE_NAME,
  keyStoreName: KEY_STORE_NAME,
  isRunnable,
  runnableAt,
  uploadLeaseMs: UPLOAD_LEASE_MS,
});
