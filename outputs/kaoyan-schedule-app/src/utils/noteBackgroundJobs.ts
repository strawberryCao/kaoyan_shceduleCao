import { cropManyImages } from './imageCrop';
import {
  createNoteUid,
  detectQuestionRegions,
  enqueueLearningNoteRename,
  saveNoteImage,
} from './notes';
import { saveLearningDataCache } from './learningData';

export type MultiQuestionJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface MultiQuestionJob {
  id: string;
  imageDataUrl: string;
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
}

const DB_NAME = 'kaoyan-note-background-v1';
const STORE_NAME = 'multi-question-jobs';
const DB_VERSION = 1;
const EVENT_NAME = 'kaoyan-multi-question-job-changed';
const MAX_AUTO_ATTEMPTS = 2;
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
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return databasePromise;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('后台队列写入失败。'));
});

const putJob = async (job: MultiQuestionJob): Promise<MultiQuestionJob> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  await requestResult(transaction.objectStore(STORE_NAME).put(job));
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
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
};

const patchJob = async (id: string, patch: Partial<MultiQuestionJob>): Promise<MultiQuestionJob> => {
  const current = await readJob(id);
  if (!current) throw new Error('后台多题任务不存在。');
  return putJob({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
};

const safeJobToken = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);

const processJob = async (id: string): Promise<void> => {
  if (activeJobs.has(id)) return;
  const initial = await readJob(id);
  if (!initial || initial.status === 'completed' || !initial.imageDataUrl) return;
  if (initial.attempts >= MAX_AUTO_ATTEMPTS && initial.status === 'failed') return;

  activeJobs.add(id);
  try {
    const attempt = initial.attempts + 1;
    await patchJob(id, {
      status: 'processing',
      attempts: attempt,
      progress: 5,
      message: 'AI 正在识别多个题目区域',
      error: '',
    });

    const detection = await detectQuestionRegions(initial.imageDataUrl);
    await patchJob(id, {
      detectedCount: detection.regions.length,
      progress: 25,
      message: `已识别 ${detection.regions.length} 道题，正在自动裁剪`,
    });
    const images = await cropManyImages(initial.imageDataUrl, detection.regions);
    const savedNoteUids: string[] = [];
    const batchToken = safeJobToken(id);

    for (let index = 0; index < images.length; index += 1) {
      const noteUid = `multi_${batchToken}_${index + 1}`.slice(0, 150);
      await patchJob(id, {
        progress: 30 + Math.round((index / Math.max(1, images.length)) * 60),
        message: `正在保存第 ${index + 1}/${images.length} 道题`,
      });
      const result = await saveNoteImage({
        imageDataUrl: images[index],
        kind: 'single',
        noteUid,
        subject: '普通笔记',
        remark: '',
        sourceType: 'ai-multi-question',
        sourceBatchId: id,
        sourceSplitIndex: index + 1,
        tags: ['AI多题拆分'],
      });
      if (result.learningData) saveLearningDataCache(result.learningData);
      savedNoteUids.push(result.noteUid || noteUid);
      try {
        await enqueueLearningNoteRename(result.noteUid || noteUid);
      } catch {
        // The image is already durable. A failed enqueue can be retried from the note detail.
      }
    }

    const completed = await patchJob(id, {
      imageDataUrl: '',
      status: 'completed',
      progress: 100,
      message: `已后台保存 ${savedNoteUids.length} 道题，AI 命名继续执行`,
      error: '',
      completedAt: new Date().toISOString(),
      savedNoteUids,
    });
    window.setTimeout(() => { void removeJob(completed.id); }, 24 * 60 * 60 * 1000);
  } catch (error) {
    const current = await readJob(id);
    await patchJob(id, {
      status: 'failed',
      progress: current?.progress || 0,
      message: current?.attempts && current.attempts >= MAX_AUTO_ATTEMPTS
        ? '后台处理失败，可重新拍摄或再次打开快速记图重试'
        : '后台处理暂时失败，下次打开将自动重试',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeJobs.delete(id);
  }
};

export const enqueueMultiQuestionJob = async (imageDataUrl: string): Promise<MultiQuestionJob> => {
  const now = new Date().toISOString();
  const id = `batch_${createNoteUid()}`;
  const job: MultiQuestionJob = {
    id,
    imageDataUrl,
    status: 'queued',
    progress: 0,
    message: '已保存到本机后台队列',
    error: '',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
    detectedCount: 0,
    savedNoteUids: [],
  };
  await putJob(job);
  window.setTimeout(() => { void processJob(id); }, 0);
  return job;
};

export const resumeMultiQuestionJobs = async (): Promise<void> => {
  let jobs: MultiQuestionJob[];
  try {
    jobs = await readJobs();
  } catch {
    return;
  }
  const now = Date.now();
  for (const job of jobs) {
    if (job.status === 'completed') {
      if (job.completedAt && now - new Date(job.completedAt).getTime() > 24 * 60 * 60 * 1000) await removeJob(job.id);
      continue;
    }
    if (job.status === 'processing') await patchJob(job.id, { status: 'queued', message: '正在恢复后台任务' });
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
