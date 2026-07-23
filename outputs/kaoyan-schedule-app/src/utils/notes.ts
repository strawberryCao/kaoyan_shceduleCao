import type { LearningDataSnapshot } from './learningData';
import type { NormalizedCrop } from './imageCrop';

export type NoteKind = 'single' | 'canvas';

export interface SaveNotePayload {
  imageDataUrl: string;
  kind: NoteKind;
  noteUid?: string;
  remark?: string;
  subject?: string;
  canvasProjectId?: string;
  sourceType?: 'ai-multi-question' | 'single-capture' | string;
  sourceBatchId?: string;
  sourceSplitIndex?: number;
  tags?: string[];
}

export interface SaveNoteResult {
  ok: boolean;
  noteUid?: string;
  filePath?: string;
  fileName?: string;
  metadata?: {
    noteUid?: string;
    learning?: {
      tags?: string[];
      noteType?: string;
    };
  };
  learningData?: LearningDataSnapshot;
  learningSyncError?: string | null;
  aiStatus?: 'pending' | 'complete' | 'failed' | 'unavailable';
  aiAvailable?: boolean;
  provisional?: boolean;
  idempotentReplay?: boolean;
  error?: string;
}

export interface DetectQuestionResult {
  ok: boolean;
  model?: string;
  regions: NormalizedCrop[];
  error?: string;
}

export type AiBackgroundJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'skipped';

export interface AiBackgroundJob {
  id: string;
  type: string;
  noteUid: string;
  status: AiBackgroundJobStatus;
  progress: number;
  message: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  result?: {
    applied?: boolean;
    title?: string;
    revision?: number;
  } | null;
}

export interface AiJobResponse {
  ok: boolean;
  accepted?: boolean;
  replayed?: boolean;
  job: AiBackgroundJob;
}

const isLoopbackHostname = (hostname: string): boolean => (
  hostname === '127.0.0.1'
  || hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
);

export const IS_CLOUD_RUNTIME = typeof window !== 'undefined'
  && window.location.protocol === 'https:'
  && !isLoopbackHostname(window.location.hostname.toLowerCase());

const resolveNoteServerUrl = (): string => {
  if (typeof window === 'undefined') return 'http://127.0.0.1:5174';
  const hostname = window.location.hostname.toLowerCase();
  return isLoopbackHostname(hostname) || window.location.protocol === 'file:'
    ? 'http://127.0.0.1:5174'
    : `${window.location.origin}/api`;
};

export const NOTE_SERVER_URL = resolveNoteServerUrl();
const NOTE_SAVE_TIMEOUT_MS = 15_000;
const AI_REQUEST_TIMEOUT_MS = 45_000;
const AI_ENQUEUE_TIMEOUT_MS = 12_000;

export const createNoteUid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
};

export const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
  reader.readAsDataURL(file);
});

export const getImageDimensions = (src: string): Promise<{ width: number; height: number }> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => reject(new Error('图片尺寸读取失败'));
  image.src = src;
});

const fetchJsonWithTimeout = async <T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const result = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok || !result) throw new Error(result?.error || `服务返回 ${response.status}`);
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时，请检查网络后重试。');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

export const saveNoteImage = async (payload: SaveNotePayload): Promise<SaveNoteResult> => {
  const noteUid = payload.noteUid || createNoteUid();
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(new DOMException(IS_CLOUD_RUNTIME ? '云端保存等待超时' : '本地保存等待超时', 'TimeoutError')),
    NOTE_SAVE_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(`${NOTE_SERVER_URL}/save-note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ subject: '默认文件夹', remark: '', ...payload, noteUid }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${IS_CLOUD_RUNTIME ? '云端' : '本地'}保存暂未确认；可以再次点击保存，系统不会重复创建笔记`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }

  const result = (await response.json()) as SaveNoteResult;
  if (!response.ok || !result.ok) throw new Error(result.error || '保存失败');
  return result;
};

export const detectQuestionRegions = async (imageDataUrl: string): Promise<DetectQuestionResult> => {
  const size = await getImageDimensions(imageDataUrl);
  return fetchJsonWithTimeout<DetectQuestionResult>(`${NOTE_SERVER_URL}/ai/detect-questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl, imageWidth: size.width, imageHeight: size.height }),
  }, AI_REQUEST_TIMEOUT_MS);
};

export const enqueueLearningNoteRename = async (noteUid: string): Promise<AiJobResponse> => (
  fetchJsonWithTimeout<AiJobResponse>(
    `${NOTE_SERVER_URL}/learning-data/notes/${encodeURIComponent(noteUid)}/rename`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    AI_ENQUEUE_TIMEOUT_MS,
  )
);

export const getAiBackgroundJob = async (jobId: string): Promise<AiBackgroundJob> => {
  const response = await fetchJsonWithTimeout<{ ok: boolean; job: AiBackgroundJob }>(
    `${NOTE_SERVER_URL}/ai/jobs/${encodeURIComponent(jobId)}`,
    { method: 'GET', cache: 'no-store' },
    AI_ENQUEUE_TIMEOUT_MS,
  );
  return response.job;
};

const fetchLearningSnapshot = async (): Promise<LearningDataSnapshot> => (
  fetchJsonWithTimeout<LearningDataSnapshot>(
    `${NOTE_SERVER_URL}/learning-data`,
    { method: 'GET', cache: 'no-store' },
    AI_ENQUEUE_TIMEOUT_MS,
  )
);

// Compatibility wrapper for older call sites. It queues the work immediately and
// returns the current snapshot instead of blocking the interface on model output.
export const renameLearningNoteWithAi = async (noteUid: string): Promise<LearningDataSnapshot> => {
  await enqueueLearningNoteRename(noteUid);
  return fetchLearningSnapshot();
};

export const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('图片加载失败'));
  image.src = src;
});
