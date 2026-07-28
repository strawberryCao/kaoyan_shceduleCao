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

export interface MaterialFilePayload {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

export type LearningRecordFacet = 'quick' | 'mistake' | 'good' | 'memory' | 'knowledge' | 'method';

export interface SaveMaterialPayload {
  noteUid?: string;
  capturedDate?: string;
  title?: string;
  remark?: string;
  subject?: string;
  tags?: string[];
  facets?: LearningRecordFacet[];
  files?: File[];
}

export interface SaveMaterialResult {
  ok: boolean;
  noteUid: string;
  attachments?: Array<{ id: string; kind: string; name: string; mimeType: string; size: number | null; filePath: string }>;
  learningData?: LearningDataSnapshot;
  idempotentReplay?: boolean;
  error?: string;
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

export interface SaveNoteBatchResult {
  ok: boolean;
  notes: SaveNoteResult[];
  learningData?: LearningDataSnapshot;
  idempotentReplay?: boolean;
  error?: string;
}

export interface DetectQuestionResult {
  ok: boolean;
  provider?: string;
  model?: string;
  configurationHash?: string;
  workflowHash?: string;
  regions: NormalizedCrop[];
  rejectedRegions?: Array<NormalizedCrop & { reason?: string; confidence?: number }>;
  quality?: { candidateCount: number; acceptedCount: number; rejectedCount: number };
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

export interface LearningSearchResult {
  noteUid: string;
  title?: string;
  subject?: string;
  capturedDate?: string;
  score: number;
  matchedTerms: string[];
  reason: string;
}

export interface LearningSearchResponse {
  ok: boolean;
  mode: 'normal' | 'ai';
  query: string;
  terms?: string[];
  results: LearningSearchResult[];
  degraded?: boolean;
  sourceRevision?: number;
}

export interface CaptureBatchJob {
  jobId: string;
  status: 'queued' | 'waiting_configuration' | 'processing' | 'completed' | 'configuration_mismatch' | 'needs_review' | 'waiting_quota' | 'failed_retryable';
  progress: number;
  message: string;
  error: string;
  resultEntryIds: string[];
  configurationHash: string;
  workflowHash: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CaptureBatchResponse {
  ok: boolean;
  accepted: boolean;
  jobId: string;
  entryId: string;
  job: CaptureBatchJob;
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
  const explicitRuntimeUrl = String(import.meta.env?.VITE_NOTE_SERVER_URL || '').trim().replace(/\/+$/, '');
  if (explicitRuntimeUrl) return explicitRuntimeUrl;
  const hostname = window.location.hostname.toLowerCase();
  return isLoopbackHostname(hostname) || window.location.protocol === 'file:'
    ? 'http://127.0.0.1:5174'
    : `${window.location.origin}/api`;
};

export const NOTE_SERVER_URL = resolveNoteServerUrl();
const NOTE_SAVE_TIMEOUT_MS = IS_CLOUD_RUNTIME ? 45_000 : 15_000;
const AI_REQUEST_TIMEOUT_MS = 180_000;
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

export const saveNoteImagesBatch = async (payloads: SaveNotePayload[]): Promise<SaveNoteBatchResult> => {
  if (!Array.isArray(payloads) || payloads.length === 0) throw new Error('没有可保存的题目。');
  const notes = payloads.map((payload) => ({ subject: '默认文件夹', remark: '', ...payload, noteUid: payload.noteUid || createNoteUid() }));
  return fetchJsonWithTimeout<SaveNoteBatchResult>(`${NOTE_SERVER_URL}/save-note-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  }, 90_000);
};

export const saveLearningMaterial = async (payload: SaveMaterialPayload): Promise<SaveMaterialResult> => {
  const noteUid = payload.noteUid || createNoteUid();
  const files: MaterialFilePayload[] = [];
  for (const file of payload.files ?? []) {
    files.push({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, dataUrl: await fileToDataUrl(file) });
  }
  return fetchJsonWithTimeout<SaveMaterialResult>(`${NOTE_SERVER_URL}/save-material-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, files, noteUid }),
  }, Math.max(NOTE_SAVE_TIMEOUT_MS, 45_000));
};

export const createCaptureBatch = async (
  imageDataUrl: string,
  options: { batchId: string; subject?: string; remark?: string },
): Promise<CaptureBatchResponse> => fetchJsonWithTimeout<CaptureBatchResponse>(`${NOTE_SERVER_URL}/capture-batches`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    imageDataUrl,
    batchId: options.batchId,
    subject: options.subject || '默认文件夹',
    remark: options.remark || '',
  }),
}, 90_000);

export const getCaptureBatchJob = async (jobId: string): Promise<{ ok: boolean; job: CaptureBatchJob }> => (
  fetchJsonWithTimeout<{ ok: boolean; job: CaptureBatchJob }>(
    `${NOTE_SERVER_URL}/jobs/${encodeURIComponent(jobId)}`,
    { method: 'GET' },
    15_000,
  )
);

export const retryCaptureBatchJob = async (jobId: string): Promise<{ ok: boolean; accepted: boolean; job: CaptureBatchJob }> => (
  fetchJsonWithTimeout<{ ok: boolean; accepted: boolean; job: CaptureBatchJob }>(
    `${NOTE_SERVER_URL}/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    20_000,
  )
);

const detectQuestionRegionsOnce = async (
  imageDataUrl: string,
  onProgress?: (message: string) => void,
): Promise<DetectQuestionResult> => {
  const size = await getImageDimensions(imageDataUrl);
  if (!IS_CLOUD_RUNTIME) {
    return fetchJsonWithTimeout<DetectQuestionResult>(`${NOTE_SERVER_URL}/ai/detect-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl, imageWidth: size.width, imageHeight: size.height }),
    }, AI_REQUEST_TIMEOUT_MS);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${NOTE_SERVER_URL}/ai/detect-questions/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      signal: controller.signal,
      body: JSON.stringify({ imageDataUrl, imageWidth: size.width, imageHeight: size.height }),
    });
    if (!response.ok) {
      const failed = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(failed?.error || `服务返回 ${response.status}`);
    }
    if (!response.body) throw new Error('浏览器没有返回 AI 识别数据流。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          type?: string;
          message?: string;
          error?: string;
          result?: DetectQuestionResult;
        };
        if (message.type === 'progress' && message.message) onProgress?.(message.message);
        if (message.type === 'error') throw new Error(message.error || 'AI 多题识别失败。');
        if (message.type === 'result' && message.result) return message.result;
      }
      if (done) break;
    }
    throw new Error('AI 识别连接结束，但没有返回裁剪结果。');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AI 识别超时，请缩小预裁剪范围后重试。');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

export const detectQuestionRegions = async (
  imageDataUrl: string,
  onProgress?: (message: string) => void,
): Promise<DetectQuestionResult> => {
  try {
    return await detectQuestionRegionsOnce(imageDataUrl, onProgress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!IS_CLOUD_RUNTIME || !/load failed|failed to fetch|network/i.test(message)) throw error;
    onProgress?.('2/4 连接短暂中断，正在自动重新建立 AI 识别连接…');
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    return detectQuestionRegionsOnce(imageDataUrl, onProgress);
  }
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

export const searchLearningRecords = async (
  query: string,
  mode: 'normal' | 'ai',
  limit = 120,
): Promise<LearningSearchResponse> => fetchJsonWithTimeout<LearningSearchResponse>(
  `${NOTE_SERVER_URL}/search`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode, limit }),
  },
  mode === 'ai' ? 45_000 : AI_ENQUEUE_TIMEOUT_MS,
);

export const openSystemMaterialWindow = async (descriptor: Record<string, unknown>): Promise<boolean> => {
  if (IS_CLOUD_RUNTIME) return false;
  if (window.kaoyanDesktop?.openMaterialWindow) {
    return window.kaoyanDesktop.openMaterialWindow(descriptor);
  }
  const result = await fetchJsonWithTimeout<{ ok: boolean }>(
    `${NOTE_SERVER_URL}/material-window`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptor }),
    },
    8_000,
  );
  return result.ok === true;
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
