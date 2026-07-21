import type { CanvasDocument, CanvasInkStroke } from './canvasDocument';
import { fetchWithTimeout } from './localService';
import { NOTE_SERVER_URL } from './notes';

type CanvasRequestOperation = 'list' | 'load' | 'save' | 'delete' | 'active' | 'organize';

const CANVAS_REQUEST_TIMEOUT_MS: Record<CanvasRequestOperation, number> = {
  list: 5000,
  load: 15000,
  save: 30000,
  delete: 10000,
  active: 5000,
  organize: 15000,
};

export interface CanvasProjectSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  imageCount: number;
  textCount: number;
  annotationCount: number;
  anchorCount: number;
  relationCount: number;
  strokeCount?: number;
  syncRevision: number;
}

export interface CanvasProjectSavedEvent {
  type: 'saved';
  projectId: string;
  revision: number;
  updatedAt: string;
  sourceClientId?: string;
}

export interface CanvasProjectLiveStrokeEvent {
  type: 'live-stroke';
  projectId: string;
  sourceClientId?: string;
  stroke: CanvasInkStroke;
}

export interface CanvasProjectDeletedEvent {
  type: 'deleted';
  projectId: string;
  revision: number;
  updatedAt: string;
  sourceClientId?: string;
}

export interface CanvasProjectActiveEvent {
  type: 'active';
  projectId: string;
  sourceClientId?: string;
  selectionRevision: number;
  selectedAt: string;
}

export type CanvasProjectEvent = CanvasProjectSavedEvent | CanvasProjectLiveStrokeEvent | CanvasProjectDeletedEvent | CanvasProjectActiveEvent;

export interface CanvasAiOrganizationJob {
  id: string;
  projectId: string;
  status: 'queued' | 'analyzing' | 'applying' | 'complete' | 'failed';
  progress: number;
  message: string;
  provider?: string;
  model?: string;
  summary?: string;
  movedCount?: number;
  revision?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface CanvasProjectListResponse {
  ok: boolean;
  projects?: CanvasProjectSummary[];
  error?: string;
}

interface CanvasProjectResponse {
  ok: boolean;
  document?: CanvasDocument;
  summary?: CanvasProjectSummary;
  code?: string;
  actualRevision?: number;
  error?: string;
}

interface CanvasProjectDeleteResponse {
  ok: boolean;
  projectId?: string;
  deletedAt?: string;
  recoverable?: boolean;
  code?: string;
  actualRevision?: number;
  error?: string;
}

interface CanvasProjectActiveResponse {
  ok: boolean;
  active?: CanvasProjectActiveEvent;
  error?: string;
}

interface CanvasAiOrganizationResponse {
  ok: boolean;
  job?: CanvasAiOrganizationJob | null;
  error?: string;
}

export class CanvasSyncConflictError extends Error {
  readonly actualRevision: number;

  constructor(message: string, actualRevision: number) {
    super(message);
    this.name = 'CanvasSyncConflictError';
    this.actualRevision = actualRevision;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let result: T & { error?: string; code?: string; actualRevision?: number };
  try {
    result = await response.json() as T & { error?: string };
  } catch {
    throw new Error('本地画布服务返回了无法识别的数据。');
  }
  if (!response.ok) {
    if (response.status === 409 && result.code === 'CANVAS_REVISION_CONFLICT') {
      throw new CanvasSyncConflictError(
        result.error || '另一台设备刚刚更新了这个画布。',
        Number.isInteger(result.actualRevision) ? Number(result.actualRevision) : 0,
      );
    }
    throw new Error(result.error || `画布服务请求失败（${response.status}）`);
  }
  return result;
}

const unavailableMessage = (operation: CanvasRequestOperation, timedOut: boolean): string => {
  if (operation === 'list') {
    return timedOut ? '本地画布服务响应超时，正在自动重试。' : '本地画布服务暂时断开，正在自动重连。';
  }
  if (operation === 'save') {
    return timedOut
      ? '保存结果暂未确认，本机草稿仍在；请稍后按 Ctrl+S 再保存一次。'
      : '本地画布服务暂时断开，本机草稿仍在；服务恢复后请再次保存。';
  }
  if (operation === 'delete') {
    return timedOut ? '删除画布超时，工程尚未确认删除。' : '本地画布服务暂时断开，工程尚未删除。';
  }
  if (operation === 'active') {
    return timedOut ? '同步当前画布超时，正在等待自动重连。' : '当前画布暂未同步到其他设备。';
  }
  if (operation === 'organize') {
    return timedOut ? 'AI 整理任务响应较慢，后台可能仍在继续；请稍后查看状态。' : '暂时无法连接 AI 画布整理服务。';
  }
  return timedOut ? '打开画布超时，请稍后重新选择。' : '本地画布服务暂时断开，请稍后重新打开这个画布。';
};

async function requestCanvas<T>(operation: CanvasRequestOperation, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { cache: 'no-store', ...init }, CANVAS_REQUEST_TIMEOUT_MS[operation]);
  } catch (error) {
    const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new Error(unavailableMessage(operation, timedOut));
  }
  return readJson<T>(response);
}

export async function listCanvasProjects(): Promise<CanvasProjectSummary[]> {
  const result = await requestCanvas<CanvasProjectListResponse>('list', `${NOTE_SERVER_URL}/canvas-projects`);
  if (!result.ok) {
    throw new Error(result.error || '读取画布列表失败');
  }
  return result.projects ?? [];
}

export async function loadCanvasProject(projectId: string): Promise<CanvasDocument> {
  const result = await requestCanvas<CanvasProjectResponse>('load', `${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(projectId)}`);
  if (!result.ok || !result.document) {
    throw new Error(result.error || '读取画布失败');
  }
  return result.document;
}

const CANVAS_CLIENT_ID_KEY = 'kaoyan.canvas.clientId.v1';

export function getCanvasClientId(): string {
  try {
    const existing = sessionStorage.getItem(CANVAS_CLIENT_ID_KEY);
    if (existing) return existing;
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const clientId = `canvas-${random}`;
    sessionStorage.setItem(CANVAS_CLIENT_ID_KEY, clientId);
    return clientId;
  } catch {
    return `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export async function saveCanvasProject(
  document: CanvasDocument,
  expectedRevision = document.syncRevision,
  clientId = getCanvasClientId(),
): Promise<CanvasProjectResponse> {
  const result = await requestCanvas<CanvasProjectResponse>('save', `${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(document.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, expectedRevision, clientId }),
  });
  if (!result.ok || !result.document) {
    throw new Error(result.error || '保存画布工程失败');
  }
  return result;
}

export async function deleteCanvasProject(
  projectId: string,
  expectedRevision: number,
  clientId = getCanvasClientId(),
): Promise<CanvasProjectDeleteResponse> {
  const result = await requestCanvas<CanvasProjectDeleteResponse>('delete', `${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision, clientId }),
  });
  if (!result.ok) throw new Error(result.error || '删除画布工程失败');
  return result;
}

export async function sendCanvasLiveStroke(
  projectId: string,
  stroke: CanvasInkStroke,
  clientId = getCanvasClientId(),
): Promise<void> {
  const response = await fetchWithTimeout(`${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(projectId)}/live-stroke`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, stroke }),
  }, 2500);
  if (!response.ok) {
    let message = `实时笔迹发送失败（${response.status}）`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Preserve the status-based fallback.
    }
    throw new Error(message);
  }
}

export async function setActiveCanvasProject(
  projectId: string,
  clientId = getCanvasClientId(),
): Promise<CanvasProjectActiveEvent> {
  const result = await requestCanvas<CanvasProjectActiveResponse>('active', `${NOTE_SERVER_URL}/canvas-projects/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, clientId }),
  });
  if (!result.ok || !result.active) throw new Error(result.error || '同步当前画布失败');
  return result.active;
}

export async function startCanvasAiOrganization(
  projectId: string,
  previewDataUrl: string,
  clientId = getCanvasClientId(),
): Promise<CanvasAiOrganizationJob> {
  const result = await requestCanvas<CanvasAiOrganizationResponse>('organize', `${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(projectId)}/ai-organize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewDataUrl, clientId }),
  });
  if (!result.ok || !result.job) throw new Error(result.error || '启动 AI 画布整理失败');
  return result.job;
}

export async function getCanvasAiOrganization(projectId: string): Promise<CanvasAiOrganizationJob | null> {
  const result = await requestCanvas<CanvasAiOrganizationResponse>('organize', `${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(projectId)}/ai-organize`);
  if (!result.ok) throw new Error(result.error || '读取 AI 画布整理进度失败');
  return result.job ?? null;
}

export function subscribeCanvasProjectEvents(
  onEvent: (event: CanvasProjectEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`${NOTE_SERVER_URL}/canvas-projects/events`);
  const handleEvent = (message: Event) => {
    try {
      const event = JSON.parse((message as MessageEvent<string>).data) as CanvasProjectEvent;
      if (!event?.projectId) return;
      if ((event.type === 'saved' || event.type === 'deleted') && !Number.isInteger(event.revision)) return;
      if (event.type === 'active' && !Number.isInteger(event.selectionRevision)) return;
      if (event.type === 'live-stroke' && (!event.stroke || event.stroke.kind !== 'ink')) return;
      if (event.type !== 'saved' && event.type !== 'live-stroke' && event.type !== 'deleted' && event.type !== 'active') return;
      onEvent(event);
    } catch {
      // Ignore a malformed event and let EventSource keep the connection alive.
    }
  };
  source.addEventListener('canvas-project', handleEvent);
  source.onopen = () => onConnectionChange?.(true);
  source.onerror = () => onConnectionChange?.(false);
  return () => {
    source.removeEventListener('canvas-project', handleEvent);
    source.close();
  };
}
