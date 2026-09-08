export type ActivityTaskStatus =
  | 'local_saved'
  | 'queued'
  | 'uploading'
  | 'processing'
  | 'needs_review'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'cancelled';

export type ActivityTaskKind =
  | 'capture_upload'
  | 'question_crop'
  | 'material_append'
  | 'ai_rename'
  | 'classification'
  | 'canvas_organization';

export interface ActivityTask {
  id: string;
  sourceId: string;
  kind: ActivityTaskKind;
  status: ActivityTaskStatus;
  title: string;
  message: string;
  error: string;
  errorCode: string;
  progress: number;
  attempts: number;
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
  durationMs: number | null;
  resultNoteUids: string[];
  targetUrl: string;
  canRetry: boolean;
  canCancel: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface ActivityTaskSummary {
  failed: number;
  needsReview: number;
  active: number;
}

const DB_NAME = 'kaoyan-activity-tasks-v1';
const STORE_NAME = 'tasks';
const DB_VERSION = 1;
const EVENT_NAME = 'kaoyan-activity-tasks-changed';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let databasePromise: Promise<IDBDatabase> | null = null;
const remoteMemoryTasks = new Map<string, ActivityTask>();

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('当前浏览器不支持活动任务存储。'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('活动任务存储打开失败。'));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
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
  request.onerror = () => reject(request.error ?? new Error('活动任务读写失败。'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('活动任务事务已中止。'));
  transaction.onerror = () => reject(transaction.error ?? new Error('活动任务事务失败。'));
});

const emit = () => window.dispatchEvent(new Event(EVENT_NAME));

export const activityTaskNoteUid = (task: ActivityTask): string => {
  let queryNoteUid = '';
  try {
    queryNoteUid = new URL(task.targetUrl, window.location.origin).searchParams.get('noteUid') || '';
  } catch {
    // Historical task URLs can be malformed. A bad task must remain visible
    // without breaking the entire Activity Center.
  }
  const resultNoteUid = task.resultNoteUids.find((value) => typeof value === 'string' && value.trim()) || '';
  const sourceNoteUid = !task.sourceId.startsWith('job-') && !task.sourceId.startsWith('capture-')
    ? task.sourceId
    : '';
  return resultNoteUid || queryNoteUid || (task.kind === 'ai_rename' ? sourceNoteUid : '');
};

export const listActivityTasks = async (): Promise<ActivityTask[]> => {
  const tasks = IS_CLOUD_RUNTIME
    ? [...remoteMemoryTasks.values()]
    : await (async () => {
      const database = await openDatabase();
      return requestResult(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()) as Promise<ActivityTask[]>;
    })();
  const ordered = tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const seenAiRenameNotes = new Set<string>();
  return ordered.filter((task) => {
    if (task.kind !== 'ai_rename') return true;
    const noteUid = activityTaskNoteUid(task);
    if (!noteUid) return true;
    if (seenAiRenameNotes.has(noteUid)) return false;
    seenAiRenameNotes.add(noteUid);
    return true;
  });
};

export const getActivityTask = async (id: string): Promise<ActivityTask | null> => {
  if (IS_CLOUD_RUNTIME) return remoteMemoryTasks.get(id) ?? null;
  const database = await openDatabase();
  return (await requestResult(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)) as ActivityTask | undefined) ?? null;
};

export const upsertActivityTask = async (task: ActivityTask): Promise<ActivityTask> => {
  if (IS_CLOUD_RUNTIME) {
    remoteMemoryTasks.set(task.id, task);
    emit();
    return task;
  }
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).put(task));
  await committed;
  emit();
  return task;
};

export const patchActivityTask = async (id: string, patch: Partial<ActivityTask>): Promise<ActivityTask | null> => {
  const current = await getActivityTask(id);
  if (!current) return null;
  return upsertActivityTask({ ...current, ...patch, updatedAt: new Date().toISOString() });
};

export const removeActivityTask = async (id: string): Promise<void> => {
  if (IS_CLOUD_RUNTIME) {
    remoteMemoryTasks.delete(id);
    emit();
    return;
  }
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const committed = transactionDone(transaction);
  await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  await committed;
  emit();
};

export const activitySummary = (tasks: ActivityTask[]): ActivityTaskSummary => ({
  failed: tasks.filter((task) => task.status === 'failed_retryable' || task.status === 'failed_terminal').length,
  needsReview: tasks.filter((task) => task.status === 'needs_review').length,
  active: tasks.filter((task) => ['local_saved', 'queued', 'uploading', 'processing'].includes(task.status)).length,
});

export const getActivityTaskSummary = async (): Promise<ActivityTaskSummary> => activitySummary(await listActivityTasks());

export const subscribeActivityTasks = (listener: () => void): (() => void) => {
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
};

export const createActivityTask = (
  input: Pick<ActivityTask, 'id' | 'sourceId' | 'kind' | 'status' | 'title'> & Partial<ActivityTask>,
): ActivityTask => {
  const now = new Date().toISOString();
  return {
    message: '', error: '', errorCode: '', progress: 0, attempts: 0,
    provider: '', model: '', fallbackProvider: '', fallbackModel: '', durationMs: null,
    resultNoteUids: [], targetUrl: '', canRetry: false, canCancel: true,
    createdAt: now, updatedAt: now, completedAt: '',
    ...input,
  };
};

const readLegacyStore = <T>(databaseName: string, storeName: string): Promise<T[]> => new Promise((resolve) => {
  const request = window.indexedDB.open(databaseName);
  let existed = true;
  request.onupgradeneeded = () => {
    existed = false;
    request.transaction?.abort();
  };
  request.onerror = () => resolve([]);
  request.onsuccess = () => {
    const database = request.result;
    if (!existed || !database.objectStoreNames.contains(storeName)) {
      database.close();
      resolve([]);
      return;
    }
    const read = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    read.onerror = () => { database.close(); resolve([]); };
    read.onsuccess = () => { database.close(); resolve((read.result || []) as T[]); };
  };
});

type LegacyCapture = {
  id: string; status: string; payloads?: unknown[]; noteUids?: string[]; attempts?: number;
  message?: string; error?: string; createdAt?: string; updatedAt?: string; completedAt?: string;
};
type LegacyCrop = {
  id: string; serverJobId?: string; status: string; progress?: number; attempts?: number;
  message?: string; error?: string; savedNoteUids?: string[]; createdAt?: string; updatedAt?: string; completedAt?: string;
};

const captureStatus = (job: LegacyCapture): ActivityTaskStatus => {
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'uploading') return 'uploading';
  if (job.status === 'failed') return 'failed_retryable';
  return 'local_saved';
};

const cropStatus = (job: LegacyCrop): ActivityTaskStatus => {
  if (job.status === 'completed') return 'completed';
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'needs_review' || job.status === 'waiting_quota') return 'needs_review';
  if (job.status === 'failed') return 'failed_retryable';
  if (job.status === 'uploading') return 'uploading';
  if (job.status === 'queued') return 'local_saved';
  return 'processing';
};

export const mirrorCaptureActivity = async (job: LegacyCapture): Promise<void> => {
  const now = new Date().toISOString();
  await upsertActivityTask(createActivityTask({
    id: `capture:${job.id}`, sourceId: job.id, kind: 'capture_upload', status: captureStatus(job),
    title: (job.payloads?.length || job.noteUids?.length || 1) > 1 ? '多题图片保存' : '拍题图片保存',
    message: job.message || '', error: job.error || '', attempts: Number(job.attempts) || 0,
    progress: job.status === 'completed' ? 100 : job.status === 'uploading' ? 35 : 5,
    resultNoteUids: job.noteUids || [], targetUrl: '?noteApp=1',
    canRetry: ['queued', 'uploading', 'failed'].includes(job.status), canCancel: !['completed', 'cancelled'].includes(job.status),
    createdAt: job.createdAt || now, updatedAt: job.updatedAt || now, completedAt: job.completedAt || '',
  }));
};

export const mirrorCropActivity = async (job: LegacyCrop): Promise<void> => {
  const now = new Date().toISOString();
  await upsertActivityTask(createActivityTask({
    id: `crop:${job.id}`, sourceId: job.id, kind: 'question_crop', status: cropStatus(job),
    title: 'AI 自动裁题', message: job.message || '', error: job.error || '',
    progress: Math.max(0, Math.min(100, Number(job.progress) || 0)), attempts: Number(job.attempts) || 0,
    resultNoteUids: job.savedNoteUids || [],
    targetUrl: job.status === 'completed' && job.savedNoteUids?.[0]
      ? `?panel=learning&view=uncategorized&noteUid=${encodeURIComponent(job.savedNoteUids[0])}`
      : `?noteApp=1&reviewJob=${encodeURIComponent(job.id)}`,
    canRetry: ['failed', 'waiting_quota', 'cancelled'].includes(job.status),
    canCancel: !['completed', 'cancelled'].includes(job.status), createdAt: job.createdAt || now,
    updatedAt: job.updatedAt || now, completedAt: job.completedAt || '',
  }));
};

export const initializeActivityTasks = async (): Promise<void> => {
  const [captures, crops] = await Promise.all([
    readLegacyStore<LegacyCapture>('kaoyan-capture-outbox-v2', 'capture-uploads'),
    readLegacyStore<LegacyCrop>('kaoyan-note-background-v2', 'multi-question-jobs'),
  ]);
  await Promise.all([...captures.map(mirrorCaptureActivity), ...crops.map(mirrorCropActivity)]);
  const tasks = await listActivityTasks();
  const cutoff = Date.now() - RETENTION_MS;
  await Promise.all(tasks
    .filter((task) => ['completed', 'cancelled'].includes(task.status) && new Date(task.completedAt || task.updatedAt).getTime() < cutoff)
    .map((task) => removeActivityTask(task.id)));
};
import { IS_CLOUD_RUNTIME } from './runtime';
