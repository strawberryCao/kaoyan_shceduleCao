import { cropImageDataUrl, cropManyImages } from './imageCrop';
import { createNoteUid, detectQuestionRegions, type SaveNotePayload } from './notes';
import { enqueueCaptureUpload } from './captureUploadQueue';

export type MultiQuestionJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface MultiQuestionJob {
  id: string;
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

const DB_NAME = 'kaoyan-note-background-v1';
const STORE_NAME = 'multi-question-jobs';
const DB_VERSION = 1;
const EVENT_NAME = 'kaoyan-multi-question-job-changed';
const MAX_AUTO_ATTEMPTS = 2;
const AUTO_RETRY_DELAY_MS = 3_000;
const FULL_PAGE = { x: 0, y: 0, width: 1, height: 1 } as const;
let databasePromise: Promise<IDBDatabase> | null = null;
const activeJobs = new Set<string>();

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

const putJob = async (job: MultiQuestionJob): Promise<MultiQuestionJob> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).put(job));
  await committed;
  emit(job);
  return job;
};

const readJobs = async (): Promise<MultiQuestionJob[]> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return requestResult(transaction.objectStore(STORE_NAME).getAll()) as Promise<MultiQuestionJob[]>;
};

const readJob = async (id: string): Promise<MultiQuestionJob | null> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  return (await requestResult(transaction.objectStore(STORE_NAME).get(id)) as MultiQuestionJob | undefined) ?? null;
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
  return putJob({
    ...current,
    subject: current.subject || '默认文件夹',
    remark: current.remark || '',
    feedbackNoteUid: current.feedbackNoteUid || '',
    ...patch,
    updatedAt: new Date().toISOString(),
  });
};

const safeJobToken = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);

const saveFailureFeedback = async (job: MultiQuestionJob, errorText: string): Promise<string> => {
  const noteUid = `multi_failure_${safeJobToken(job.id)}`.slice(0, 150);
  await enqueueCaptureUpload([{
    imageDataUrl: job.imageDataUrl,
    kind: 'single',
    noteUid,
    subject: job.subject || '默认文件夹',
    remark: [
      'AI 自动裁剪失败，原图已保留到待确认。',
      `失败原因：${errorText || '未知错误'}`,
      '可在学习中心保留原图，或重新触发后台拆分。',
    ].join('\n'),
    sourceType: 'ai-multi-question-failure',
    sourceBatchId: job.id,
    tags: ['AI自动裁剪失败', '待确认'],
  }]);
  return noteUid;
};

const materializeFinalFailureFeedback = async (job: MultiQuestionJob): Promise<void> => {
  if (!job.imageDataUrl || job.feedbackNoteUid) return;
  try {
    const feedbackNoteUid = await saveFailureFeedback(job, job.error || '历史自动裁剪任务失败。');
    await patchJob(job.id, { status: 'failed', message: '自动裁剪失败，原图已加入后台保存队列', feedbackNoteUid });
  } catch (error) {
    const feedbackError = error instanceof Error ? error.message : String(error);
    await patchJob(job.id, {
      status: 'failed',
      message: '自动裁剪失败；原图仍保留在本机任务中，可重新打开后重试',
      error: [job.error, `反馈保存失败：${feedbackError}`].filter(Boolean).join('；'),
    });
  }
};

const processJob = async (id: string): Promise<void> => {
  if (activeJobs.has(id)) return;
  const initial = await readJob(id);
  if (!initial || initial.status === 'completed' || !initial.imageDataUrl) return;
  if (initial.attempts >= MAX_AUTO_ATTEMPTS && initial.status === 'failed') return;

  activeJobs.add(id);
  let retryAfterFailure = false;
  try {
    const attempt = initial.attempts + 1;
    await patchJob(id, { status: 'processing', attempts: attempt, progress: 4, message: '正在后台准备轻量识别图', error: '' });

    // AI 只读取压缩后的轻量图，坐标仍是 0-1，最终裁剪始终使用本机保存的原图。
    const detectionImage = await cropImageDataUrl(initial.imageDataUrl, FULL_PAGE, 1500, 0.72);
    await patchJob(id, { progress: 10, message: 'AI 正在后台识别完整题目单元' });
    const detection = await detectQuestionRegions(detectionImage);
    if (!Array.isArray(detection.regions) || detection.regions.length < 1) {
      throw new Error('AI 没有识别到可裁剪的完整题目区域。');
    }

    await patchJob(id, {
      detectedCount: detection.regions.length,
      progress: 45,
      message: `已识别 ${detection.regions.length} 个完整题目单元，正在从原图裁剪`,
    });
    const images = await cropManyImages(initial.imageDataUrl, detection.regions, 1800, 0.86);
    if (images.length < 1) throw new Error('识别到了题目区域，但没有生成有效裁剪。');

    const batchToken = safeJobToken(id);
    const payloads: SaveNotePayload[] = images.map((imageDataUrl, index) => ({
      imageDataUrl,
      kind: 'single',
      noteUid: `multi_${batchToken}_${index + 1}`.slice(0, 150),
      subject: initial.subject || '默认文件夹',
      remark: initial.remark || '',
      sourceType: 'ai-multi-question',
      sourceBatchId: id,
      sourceSplitIndex: index + 1,
      tags: ['AI多题拆分'],
    }));

    await patchJob(id, { progress: 82, message: `正在把 ${payloads.length} 道题一次性写入本机上传队列` });
    await enqueueCaptureUpload(payloads);
    const savedNoteUids = payloads.map((item) => item.noteUid || '').filter(Boolean);
    const completed = await patchJob(id, {
      imageDataUrl: '',
      status: 'completed',
      progress: 100,
      message: `已自动生成并排队保存 ${savedNoteUids.length} 道题；无需人工确认`,
      error: '',
      completedAt: new Date().toISOString(),
      savedNoteUids,
    });
    window.setTimeout(() => { void removeJob(completed.id); }, 24 * 60 * 60 * 1000);
  } catch (error) {
    const current = await readJob(id);
    const errorText = error instanceof Error ? error.message : String(error);
    const finalFailure = Number(current?.attempts || 0) >= MAX_AUTO_ATTEMPTS;
    let feedbackNoteUid = current?.feedbackNoteUid || '';
    let feedbackError = '';
    if (finalFailure && initial.imageDataUrl && !feedbackNoteUid) {
      try { feedbackNoteUid = await saveFailureFeedback({ ...initial, ...current }, errorText); }
      catch (failure) { feedbackError = failure instanceof Error ? failure.message : String(failure); }
    }
    await patchJob(id, {
      status: 'failed',
      progress: current?.progress || 0,
      message: finalFailure
        ? feedbackNoteUid ? '自动裁剪失败，原图已加入后台保存队列' : '自动裁剪失败；原图仍保留在本机任务中'
        : '后台处理暂时失败，3 秒后自动重试',
      error: [errorText, feedbackError ? `反馈保存失败：${feedbackError}` : ''].filter(Boolean).join('；'),
      feedbackNoteUid,
    });
    retryAfterFailure = !finalFailure;
  } finally {
    activeJobs.delete(id);
    if (retryAfterFailure) window.setTimeout(() => { void processJob(id); }, AUTO_RETRY_DELAY_MS);
  }
};

export const enqueueMultiQuestionJob = async (
  imageDataUrl: string,
  options: { subject?: string; remark?: string } = {},
): Promise<MultiQuestionJob> => {
  const now = new Date().toISOString();
  const id = `batch_${createNoteUid()}`;
  const job: MultiQuestionJob = {
    id,
    imageDataUrl,
    subject: options.subject?.trim() || '默认文件夹',
    remark: options.remark?.trim() || '',
    status: 'queued',
    progress: 0,
    message: '整页原图已安全保存在本机后台队列',
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
  window.setTimeout(() => { void processJob(id); }, 0);
  return job;
};

export const resumeMultiQuestionJobs = async (): Promise<void> => {
  let jobs: MultiQuestionJob[];
  try { jobs = await readJobs(); } catch { return; }
  const now = Date.now();
  for (const job of jobs) {
    if (job.status === 'completed') {
      if (job.completedAt && now - new Date(job.completedAt).getTime() > 24 * 60 * 60 * 1000) await removeJob(job.id);
      continue;
    }
    if (job.status === 'processing') await patchJob(job.id, { status: 'queued', message: '正在恢复后台任务' });
    if (job.status === 'failed' && job.attempts >= MAX_AUTO_ATTEMPTS && job.imageDataUrl && !job.feedbackNoteUid) {
      window.setTimeout(() => { void materializeFinalFailureFeedback(job); }, 0);
      continue;
    }
    if (job.status === 'queued' || (job.status === 'failed' && job.attempts < MAX_AUTO_ATTEMPTS)) {
      window.setTimeout(() => { void processJob(job.id); }, 0);
    }
  }
};

export const subscribeMultiQuestionJobs = (listener: (job: MultiQuestionJob) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<MultiQuestionJob>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
};
