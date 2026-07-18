import type { CanvasDocument } from './canvasDocument';
import { NOTE_SERVER_URL } from './notes';

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
  error?: string;
}

async function readJson<T>(response: Response): Promise<T> {
  const result = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new Error(result.error || `画布服务请求失败（${response.status}）`);
  }
  return result;
}

export async function listCanvasProjects(): Promise<CanvasProjectSummary[]> {
  const response = await fetch(`${NOTE_SERVER_URL}/canvas-projects`, { cache: 'no-store' });
  const result = await readJson<CanvasProjectListResponse>(response);
  if (!result.ok) {
    throw new Error(result.error || '读取画布列表失败');
  }
  return result.projects ?? [];
}

export async function loadCanvasProject(projectId: string): Promise<CanvasDocument> {
  const response = await fetch(`${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(projectId)}`, {
    cache: 'no-store',
  });
  const result = await readJson<CanvasProjectResponse>(response);
  if (!result.ok || !result.document) {
    throw new Error(result.error || '读取画布失败');
  }
  return result.document;
}

export async function saveCanvasProject(document: CanvasDocument): Promise<CanvasProjectResponse> {
  const response = await fetch(`${NOTE_SERVER_URL}/canvas-projects/${encodeURIComponent(document.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document }),
  });
  const result = await readJson<CanvasProjectResponse>(response);
  if (!result.ok || !result.document) {
    throw new Error(result.error || '保存画布工程失败');
  }
  return result;
}
