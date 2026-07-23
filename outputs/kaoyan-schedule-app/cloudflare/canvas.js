import { HttpError } from './http.js';
import { commitFiles, getBranchHead, readJsonFile } from './github-store.js';
import { readAppState, writeAppState } from './storage.js';

const CANVAS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_CANVAS_BYTES = 24 * 1024 * 1024;
const INDEX_PATH = 'data/cloud/canvas-index.json';
const CANVAS_ROOT = 'data/cloud/canvases';

function assertCanvasId(value) {
  if (typeof value !== 'string' || !CANVAS_ID.test(value) || value === '.' || value === '..') {
    throw new HttpError(400, 'Canvas id must be 1-80 path-safe ASCII characters.', 'CANVAS_DOCUMENT_INVALID');
  }
  return value;
}

function canvasPath(projectId) {
  return `${CANVAS_ROOT}/${assertCanvasId(projectId)}.json`;
}

function emptyIndex() {
  return { version: 1, revision: 0, updatedAt: null, projects: [] };
}

function normalizeIndex(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projects = Array.isArray(source.projects) ? source.projects : [];
  return {
    version: 1,
    revision: Number.isInteger(Number(source.revision)) ? Math.max(0, Number(source.revision)) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    projects: projects.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
      ...item,
      id: assertCanvasId(item.id),
      title: typeof item.title === 'string' ? item.title.slice(0, 240) : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
      syncRevision: Number.isInteger(Number(item.syncRevision ?? item.revision))
        ? Math.max(0, Number(item.syncRevision ?? item.revision))
        : 0,
    })),
  };
}

function summarize(document) {
  return {
    id: document.id,
    title: typeof document.title === 'string' ? document.title.slice(0, 240) : '',
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    imageCount: Array.isArray(document.images) ? document.images.length : 0,
    textCount: Array.isArray(document.texts) ? document.texts.length : 0,
    annotationCount: Array.isArray(document.annotations) ? document.annotations.length : 0,
    anchorCount: Array.isArray(document.anchors) ? document.anchors.length : 0,
    relationCount: Array.isArray(document.relations) ? document.relations.length : 0,
    strokeCount: Array.isArray(document.strokes) ? document.strokes.length : 0,
    syncRevision: Number(document.syncRevision) || 0,
  };
}

function validateDocument(document, projectId) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new HttpError(400, 'document must be an object.', 'CANVAS_DOCUMENT_INVALID');
  }
  if (document.id !== projectId) {
    throw new HttpError(400, 'Document id must match the requested canvas id.', 'CANVAS_DOCUMENT_INVALID');
  }
  if (document.version !== 1) {
    throw new HttpError(400, 'Canvas document version must be 1.', 'CANVAS_DOCUMENT_INVALID');
  }
  for (const field of ['images', 'texts', 'anchors', 'annotations']) {
    if (!Array.isArray(document[field])) {
      throw new HttpError(400, `${field} must be an array.`, 'CANVAS_DOCUMENT_INVALID');
    }
  }
  if (!document.viewport || !Number.isFinite(document.viewport.zoom)) {
    throw new HttpError(400, 'Canvas viewport is invalid.', 'CANVAS_DOCUMENT_INVALID');
  }
}

async function readIndex(env, options = {}) {
  const file = await readJsonFile(env, INDEX_PATH, {
    ref: options.ref,
    allowMissing: true,
    maxBytes: 4 * 1024 * 1024,
  });
  return normalizeIndex(file?.value ?? emptyIndex());
}

export async function listCanvasProjects(env) {
  return (await readIndex(env)).projects;
}

export async function loadCanvasProject(env, projectId) {
  projectId = assertCanvasId(projectId);
  const file = await readJsonFile(env, canvasPath(projectId), {
    allowMissing: true,
    maxBytes: MAX_CANVAS_BYTES,
  });
  if (!file) throw new HttpError(404, 'Canvas project not found.', 'CANVAS_NOT_FOUND');
  validateDocument(file.value, projectId);
  return file.value;
}

export async function saveCanvasProject(env, projectId, payload) {
  projectId = assertCanvasId(projectId);
  const source = payload?.document && typeof payload.document === 'object' ? payload.document : payload;
  validateDocument(source, projectId);
  const expectedRevision = payload?.document && typeof payload.document === 'object' ? payload.expectedRevision : undefined;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new HttpError(400, 'expectedRevision must be a non-negative integer.', 'CANVAS_DOCUMENT_INVALID');
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const index = await readIndex(env, { ref: head });
    const existingIndex = index.projects.findIndex((item) => item.id === projectId);
    const existing = existingIndex >= 0 ? index.projects[existingIndex] : null;
    const actualRevision = Number(existing?.syncRevision ?? 0);
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      throw new HttpError(409, `Canvas project revision changed from ${expectedRevision} to ${actualRevision}.`, 'CANVAS_REVISION_CONFLICT', {
        expectedRevision,
        actualRevision,
      });
    }
    const updatedAt = new Date().toISOString();
    const createdAt = existing?.createdAt || (typeof source.createdAt === 'string' ? source.createdAt : updatedAt);
    const document = {
      ...source,
      id: projectId,
      createdAt,
      updatedAt,
      syncRevision: actualRevision + 1,
      relations: Array.isArray(source.relations) ? source.relations : [],
      strokes: Array.isArray(source.strokes) ? source.strokes : [],
    };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (new TextEncoder().encode(serialized).byteLength > MAX_CANVAS_BYTES) {
      throw new HttpError(413, 'Canvas document is too large.', 'CANVAS_TOO_LARGE');
    }
    const summary = summarize(document);
    const projects = [...index.projects];
    if (existingIndex >= 0) projects[existingIndex] = summary;
    else projects.push(summary);
    projects.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const nextIndex = {
      version: 1,
      revision: index.revision + 1,
      updatedAt,
      projects,
    };
    try {
      await commitFiles(env, {
        expectedHeadSha: head,
        message: `cloud: save canvas ${projectId} revision ${document.syncRevision}`,
        files: [
          { path: canvasPath(projectId), content: serialized },
          { path: INDEX_PATH, content: `${JSON.stringify(nextIndex, null, 2)}\n` },
        ],
      });
      return { document, summary };
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'Canvas metadata changed while saving.', 'CANVAS_REVISION_CONFLICT');
}

export async function deleteCanvasProject(env, projectId, payload = {}) {
  projectId = assertCanvasId(projectId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const index = await readIndex(env, { ref: head });
    const existing = index.projects.find((item) => item.id === projectId);
    if (!existing) throw new HttpError(404, 'Canvas project not found.', 'CANVAS_NOT_FOUND');
    const actualRevision = Number(existing.syncRevision) || 0;
    if (payload.expectedRevision !== undefined && Number(payload.expectedRevision) !== actualRevision) {
      throw new HttpError(409, 'Canvas project changed before deletion.', 'CANVAS_REVISION_CONFLICT', {
        expectedRevision: payload.expectedRevision,
        actualRevision,
      });
    }
    const deletedAt = new Date().toISOString();
    const nextIndex = {
      ...index,
      revision: index.revision + 1,
      updatedAt: deletedAt,
      projects: index.projects.filter((item) => item.id !== projectId),
    };
    try {
      await commitFiles(env, {
        expectedHeadSha: head,
        message: `cloud: remove canvas ${projectId}`,
        files: [{ path: INDEX_PATH, content: `${JSON.stringify(nextIndex, null, 2)}\n` }],
      });
      return { projectId, deletedAt, recoverable: true };
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'Canvas project changed before deletion.', 'CANVAS_REVISION_CONFLICT');
}

export async function setActiveCanvas(env, payload) {
  const projectId = assertCanvasId(payload.projectId);
  if (!(await readIndex(env)).projects.some((item) => item.id === projectId)) {
    throw new HttpError(404, 'Canvas project not found.', 'CANVAS_NOT_FOUND');
  }
  const current = await readAppState(env, 'active-canvas');
  const selectedAt = new Date().toISOString();
  const active = {
    type: 'active',
    projectId,
    sourceClientId: typeof payload.clientId === 'string' ? payload.clientId.slice(0, 128) : undefined,
    selectionRevision: Number(current?.revision || 0) + 1,
    selectedAt,
  };
  await writeAppState(env, 'active-canvas', active, active.selectionRevision, selectedAt);
  return active;
}

export function normalizeCanvasIndex(value) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.projects) ? value.projects : null;
  if (!source) throw new HttpError(400, 'Bootstrap canvas index must be an array.', 'INVALID_BOOTSTRAP');
  const seen = new Set();
  return source.map((item) => {
    const id = assertCanvasId(item?.id);
    if (seen.has(id)) throw new HttpError(400, `Bootstrap canvas id is duplicated: ${id}`, 'INVALID_BOOTSTRAP');
    seen.add(id);
    const revision = Number.isInteger(Number(item.revision ?? item.syncRevision))
      ? Math.max(0, Number(item.revision ?? item.syncRevision))
      : 0;
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString();
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
    return {
      ...(item.summary && typeof item.summary === 'object' ? item.summary : item),
      id,
      title: typeof item.title === 'string' ? item.title.slice(0, 240) : '',
      createdAt,
      updatedAt,
      syncRevision: revision,
    };
  });
}

export async function upsertBootstrapCanvases(env, projects) {
  const normalized = normalizeCanvasIndex(projects);
  if (normalized.length === 0) return 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const index = await readIndex(env, { ref: head });
    const byId = new Map(index.projects.map((item) => [item.id, item]));
    let changed = 0;
    for (const project of normalized) {
      const previous = byId.get(project.id);
      if (!previous || Number(project.syncRevision) > Number(previous.syncRevision)) {
        byId.set(project.id, project);
        changed += 1;
      }
    }
    if (changed === 0) return 0;
    const updatedAt = new Date().toISOString();
    const nextIndex = {
      version: 1,
      revision: index.revision + 1,
      updatedAt,
      projects: [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    };
    try {
      await commitFiles(env, {
        expectedHeadSha: head,
        message: 'cloud: import canvas index',
        files: [{ path: INDEX_PATH, content: `${JSON.stringify(nextIndex, null, 2)}\n` }],
      });
      return changed;
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  return 0;
}
