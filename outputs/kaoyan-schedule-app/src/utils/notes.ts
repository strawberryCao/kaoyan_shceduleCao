import type { LearningDataSnapshot } from './learningData';
import type { NormalizedCrop } from './imageCrop';
import { IS_CLOUD_RUNTIME, NOTE_SERVER_URL } from './runtime';
import { explicitAiActionHeaders } from './aiAction';
export { IS_CLOUD_RUNTIME, NOTE_SERVER_URL } from './runtime';

export type NoteKind = 'single' | 'canvas';

export type NoteAiMode = 'auto-light' | 'auto-advanced' | 'model' | 'off';

export interface NoteAiSelection {
  mode: NoteAiMode;
  providerId?: string;
  modelId?: string;
}

export interface NoteVisionModelChoice {
  providerId: string;
  modelId: string;
  qualityTier: number | null;
  costTier: number | null;
}

export interface SaveNotePayload {
  imageDataUrl: string;
  kind: NoteKind;
  noteUid?: string;
  remark?: string;
  subject?: string;
  subjectLocked?: boolean;
  canvasProjectId?: string;
  sourceType?: 'ai-multi-question' | 'single-capture' | string;
  sourceBatchId?: string;
  sourceSplitIndex?: number;
  tags?: string[];
  aiSelection?: NoteAiSelection;
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
  operationId?: string;
  noteUid: string;
  attachments?: Array<{ id: string; kind: string; name: string; mimeType: string; size: number | null; filePath: string }>;
  learningData?: LearningDataSnapshot;
  idempotentReplay?: boolean;
  commitSha?: string | null;
  sync?: LocalReplicaSyncState;
  error?: string;
}

export interface LocalReplicaSyncState {
  localSaved: boolean;
  state: 'local' | 'queued' | 'acknowledged' | 'conflict';
  pending: number;
  conflicts: number;
}

export interface AppendMaterialPayload {
  operationId?: string;
  noteUid: string;
  title?: string;
  remark?: string;
  subject?: string;
  tags?: string[];
  facets?: LearningRecordFacet[];
  files: File[];
}

export interface GeneratedHtmlNoteArtifact {
  title: string;
  width: number;
  height: number;
  html: string;
  css: string;
  js: string;
  provider: string;
  model: string;
  artifactHash: string;
  requestId: string;
  durationMs: number;
  attempts: Array<{
    provider?: string;
    model?: string;
    phase?: string;
    outcome?: string;
    code?: string | null;
  }>;
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
  sync?: LocalReplicaSyncState;
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

export type AiBackgroundJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'needs_review' | 'skipped';

export interface AiBackgroundJob {
  id: string;
  type: string;
  noteUid: string;
  status: AiBackgroundJobStatus;
  progress: number;
  message: string;
  error: string;
  errorCode?: string;
  attempts?: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  result?: {
    applied?: boolean;
    title?: string;
    subject?: string;
    provider?: string;
    model?: string;
    attempts?: GeneratedHtmlNoteArtifact['attempts'];
    taskId?: string;
    revision?: number;
  } | null;
}

export interface AiJobResponse {
  ok: boolean;
  accepted?: boolean;
  replayed?: boolean;
  job: AiBackgroundJob;
}

export interface AuthorityAiTask extends AiBackgroundJob {
  subjectType?: string;
  subjectId?: string;
  attemptCount?: number;
  billableAttemptCount?: number;
  requiresExplicitRetry?: boolean;
  startedAt?: string;
}

export interface AuthorityAiQueueStatus {
  role: string;
  total: number;
  queued: number;
  processing: number;
  failed: number;
  needsReview: number;
  running: boolean;
}

export interface SyncConflictRecord {
  id: string;
  entityType: string;
  entityId: string;
  entityTitle: string;
  field: string;
  current: unknown;
  incoming: unknown;
  status: 'open' | 'resolved' | 'undone';
  createdAt: string;
  resolvedAt: string;
  resolutionValue: unknown;
  resolutionRevision: number | null;
  undoneAt: string;
  canUndo: boolean;
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
  entryId?: string;
  parentEntryId?: string;
  status: 'queued' | 'waiting_configuration' | 'processing' | 'completed' | 'configuration_mismatch' | 'needs_review' | 'waiting_quota' | 'failed_retryable';
  progress: number;
  message: string;
  error: string;
  errorCode?: string;
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

export const imageFileToCaptureDataUrl = async (file: File, maxEdge = 2560): Promise<string> => {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件。');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return fileToDataUrl(file);
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const ratio = longest > maxEdge ? maxEdge / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: file.type === 'image/png' });
    if (!context) throw new Error('图片压缩初始化失败。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return canvas.toDataURL(outputType, outputType === 'image/jpeg' ? 0.9 : undefined);
  } finally {
    bitmap.close();
  }
};

export const fetchNoteVisionModelChoices = async (): Promise<NoteVisionModelChoice[]> => {
  const response = await fetch(`${NOTE_SERVER_URL}/ai/config`, { cache: 'no-store' });
  const payload = await response.json().catch(() => null) as { providers?: unknown; error?: string } | null;
  if (!response.ok || !payload) throw new Error(payload?.error || `AI 配置读取失败（HTTP ${response.status}）`);
  const providerEntries = Array.isArray(payload.providers)
    ? payload.providers.map((provider) => [String((provider as { id?: string }).id || ''), provider] as const)
    : Object.entries((payload.providers && typeof payload.providers === 'object') ? payload.providers : {});
  return providerEntries.flatMap(([providerId, rawProvider]) => {
    const provider = rawProvider as { enabled?: boolean; models?: unknown[] };
    if (!providerId || provider.enabled === false) return [];
    return (Array.isArray(provider.models) ? provider.models : []).flatMap((rawModel) => {
      const model = typeof rawModel === 'string' ? { id: rawModel, capabilities: [] } : rawModel as {
        id?: string; model?: string; capabilities?: string[]; qualityTier?: number; costTier?: number;
      };
      const modelId = String(model.id || model.model || '').trim();
      const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
      const inferredVision = providerId === 'gemini' || /(?:qwen.*vl|kimi-k(?:2\.5|2\.6|3)|vision)/i.test(modelId);
      if (!modelId || (!capabilities.includes('vision') && !inferredVision)) return [];
      return [{
        providerId,
        modelId,
        qualityTier: Number.isFinite(Number(model.qualityTier)) ? Number(model.qualityTier) : null,
        costTier: Number.isFinite(Number(model.costTier)) ? Number(model.costTier) : null,
      }];
    });
  }).sort((left, right) => (
    (right.qualityTier ?? 0) - (left.qualityTier ?? 0)
    || (left.costTier ?? 9) - (right.costTier ?? 9)
    || `${left.providerId}/${left.modelId}`.localeCompare(`${right.providerId}/${right.modelId}`)
  ));
};

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

export const appendLearningMaterials = async (payload: AppendMaterialPayload): Promise<SaveMaterialResult> => {
  if (!payload.noteUid.trim()) throw new Error('没有可追加资料的速记。');
  if (!payload.files.length) throw new Error('请选择要加入的资料。');
  const files: MaterialFilePayload[] = [];
  for (const file of payload.files) {
    files.push({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      dataUrl: await fileToDataUrl(file),
    });
  }
  const operationId = payload.operationId || `material-${createNoteUid()}`;
  return fetchJsonWithTimeout<SaveMaterialResult>(`${NOTE_SERVER_URL}/append-material-note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, operationId, files }),
  }, Math.max(NOTE_SAVE_TIMEOUT_MS, 45_000));
};

export const generateQuickHtmlNote = async (input: {
  prompt: string;
  draftTitle?: string;
  draftRemark?: string;
}): Promise<GeneratedHtmlNoteArtifact> => {
  const prompt = input.prompt.trim();
  if (prompt.length < 3) throw new Error('请先描述希望生成的交互笔记。');
  const clientPolicy = await (async () => {
    try {
      const configuration = await fetchJsonWithTimeout<{
        ok: boolean;
        tasks?: Record<string, { timeoutMs?: number; fallback?: boolean; options?: Record<string, string | number | boolean> }>;
        taskDefinitions?: Array<{ id?: string; defaults?: { timeoutMs?: number } }>;
      }>(`${NOTE_SERVER_URL}/ai/config`, { method: 'GET', cache: 'no-store' }, 5_000);
      const task = configuration.tasks?.interactive_note_generation || {};
      const definition = configuration.taskDefinitions?.find((entry) => entry.id === 'interactive_note_generation');
      const timeoutMs = Math.max(1_000, Math.min(300_000, Number(task.timeoutMs || definition?.defaults?.timeoutMs || 120_000)));
      const contextChars = Math.max(500, Math.min(12_000, Number(task.options?.contextChars || 4_000)));
      const networkRetries = Math.max(0, Math.min(2, Number(task.options?.networkRetries || 0)));
      const jsonRepairRetries = Math.max(0, Math.min(2, Number(task.options?.jsonRepairRetries ?? 1)));
      const candidateCount = task.fallback === false ? 1 : 2;
      return {
        contextChars,
        requestTimeoutMs: Math.min(600_000, Math.max(
          30_000,
          timeoutMs * (1 + networkRetries + jsonRepairRetries) * candidateCount + 15_000,
        )),
      };
    } catch {
      return { contextChars: 4_000, requestTimeoutMs: 510_000 };
    }
  })();
  const draftContext = [
    input.draftTitle?.trim() ? `当前速记标题：${input.draftTitle.trim().slice(0, 160)}` : '',
    input.draftRemark?.trim() ? `当前速记正文：${input.draftRemark.trim().slice(0, clientPolicy.contextChars)}` : '',
  ].filter(Boolean).join('\n');
  let result: {
    ok: boolean;
    requestId?: string;
    durationMs?: number;
    provider?: string;
    model?: string;
    artifactHash?: string;
    attempts?: GeneratedHtmlNoteArtifact['attempts'];
    error?: string;
    widget?: { title?: string; width?: number; height?: number; html?: string; css?: string; js?: string };
  };
  try {
    result = await fetchJsonWithTimeout<typeof result>(`${NOTE_SERVER_URL}/ai/html-note`, {
      method: 'POST',
      headers: explicitAiActionHeaders(),
      body: JSON.stringify({
        prompt: [prompt.slice(0, 650), draftContext].filter(Boolean).join('\n\n'),
      }),
    }, clientPolicy.requestTimeoutMs);
  } catch (error) {
    if (error instanceof Error && /请求超时/.test(error.message)) {
      throw new Error(`AI 交互笔记等待超过 ${Math.round(clientPolicy.requestTimeoutMs / 1000)} 秒；请在 AI 配置中缩短单次超时、关闭重试或改用更快模型。`);
    }
    throw error;
  }
  if (!result.ok || !result.widget?.html) throw new Error(result.error || 'AI 没有生成可用的 HTML。');
  return {
    title: String(result.widget.title || 'AI 交互笔记').slice(0, 80),
    width: Math.max(240, Math.min(720, Number(result.widget.width) || 520)),
    height: Math.max(150, Math.min(620, Number(result.widget.height) || 360)),
    html: String(result.widget.html || ''),
    css: String(result.widget.css || ''),
    js: String(result.widget.js || ''),
    provider: String(result.provider || ''),
    model: String(result.model || ''),
    artifactHash: String(result.artifactHash || ''),
    requestId: String(result.requestId || ''),
    durationMs: Math.max(0, Number(result.durationMs) || 0),
    attempts: Array.isArray(result.attempts) ? result.attempts : [],
  };
};

export const updateCloudEntryAssets = async (
  noteUid: string,
  assetIds: string[],
): Promise<SaveMaterialResult | null> => {
  if (!IS_CLOUD_RUNTIME) return null;
  const result = await fetchJsonWithTimeout<{
    ok: boolean;
    entry: {
      entryId: string;
      assets: Array<{
        assetId: string;
        kind: string;
        originalFileName: string;
        mime: string;
        size: number | null;
        path: string;
        createdAt: string;
      }>;
    };
    learningData?: LearningDataSnapshot;
  }>(`${NOTE_SERVER_URL}/entries/${encodeURIComponent(noteUid)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds }),
  }, Math.max(NOTE_SAVE_TIMEOUT_MS, 30_000));
  return {
    ok: result.ok,
    noteUid: result.entry.entryId,
    learningData: result.learningData,
    attachments: result.entry.assets.map((asset) => ({
      id: asset.assetId,
      kind: asset.kind,
      name: asset.originalFileName,
      mimeType: asset.mime,
      size: asset.size,
      filePath: `github://${asset.path}`,
    })),
  };
};

export const createCaptureBatch = async (
  imageDataUrl: string,
  options: { batchId: string; subject?: string; remark?: string },
): Promise<CaptureBatchResponse> => fetchJsonWithTimeout<CaptureBatchResponse>(`${NOTE_SERVER_URL}/capture-batches`, {
  method: 'POST',
  headers: explicitAiActionHeaders(),
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
    { method: 'POST', headers: explicitAiActionHeaders(), body: '{}' },
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
      headers: explicitAiActionHeaders(),
      body: JSON.stringify({ imageDataUrl, imageWidth: size.width, imageHeight: size.height }),
    }, AI_REQUEST_TIMEOUT_MS);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${NOTE_SERVER_URL}/ai/detect-questions/stream`, {
      method: 'POST',
      headers: { ...explicitAiActionHeaders(), Accept: 'application/x-ndjson' },
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
      headers: explicitAiActionHeaders(),
      body: JSON.stringify({ operationId: `rename-${createNoteUid()}` }),
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

export const fetchAuthorityAiTasks = async (): Promise<{
  jobs: AuthorityAiTask[];
  queue: AuthorityAiQueueStatus | null;
}> => {
  const response = await fetchJsonWithTimeout<{
    ok: boolean;
    jobs: AuthorityAiTask[];
    queue: AuthorityAiQueueStatus | null;
  }>(`${NOTE_SERVER_URL}/ai/tasks`, { method: 'GET', cache: 'no-store' }, AI_ENQUEUE_TIMEOUT_MS);
  return { jobs: response.jobs || [], queue: response.queue || null };
};

export const retryAuthorityAiTask = async (jobId: string): Promise<AuthorityAiTask> => {
  const response = await fetchJsonWithTimeout<{ ok: boolean; job: AuthorityAiTask }>(
    `${NOTE_SERVER_URL}/ai/tasks/${encodeURIComponent(jobId)}/retry`,
    { method: 'POST', headers: explicitAiActionHeaders(), body: '{}' },
    AI_ENQUEUE_TIMEOUT_MS,
  );
  return response.job;
};

export const fetchSyncConflicts = async (includeResolved = true): Promise<SyncConflictRecord[]> => {
  const response = await fetchJsonWithTimeout<{ ok: boolean; conflicts: SyncConflictRecord[] }>(
    `${NOTE_SERVER_URL}/sync/conflicts?includeResolved=${includeResolved ? '1' : '0'}`,
    { method: 'GET', cache: 'no-store' },
    AI_ENQUEUE_TIMEOUT_MS,
  );
  return response.conflicts || [];
};

export const resolveSyncConflict = async (
  conflictId: string,
  choice: 'current' | 'incoming' | 'custom',
  value?: unknown,
): Promise<SyncConflictRecord> => {
  const response = await fetchJsonWithTimeout<{ ok: boolean; conflict: SyncConflictRecord }>(
    `${NOTE_SERVER_URL}/sync/conflicts/${encodeURIComponent(conflictId)}/resolve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: `conflict-${createNoteUid()}`, choice, value }),
    },
    AI_ENQUEUE_TIMEOUT_MS,
  );
  return response.conflict;
};

export const undoSyncConflict = async (conflictId: string): Promise<SyncConflictRecord> => {
  const response = await fetchJsonWithTimeout<{ ok: boolean; conflict: SyncConflictRecord }>(
    `${NOTE_SERVER_URL}/sync/conflicts/${encodeURIComponent(conflictId)}/undo`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: `conflict-undo-${createNoteUid()}` }) },
    AI_ENQUEUE_TIMEOUT_MS,
  );
  return response.conflict;
};

export const searchLearningRecords = async (
  query: string,
  mode: 'normal' | 'ai',
  limit = 120,
): Promise<LearningSearchResponse> => fetchJsonWithTimeout<LearningSearchResponse>(
  `${NOTE_SERVER_URL}/search`,
  {
    method: 'POST',
    headers: mode === 'ai' ? explicitAiActionHeaders() : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode, limit }),
  },
  mode === 'ai' ? 45_000 : AI_ENQUEUE_TIMEOUT_MS,
);

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
