import { HttpError, sha256 } from './http.js';
import { readAppState, resultChanges, SQL, writeAppState } from './storage.js';

const CANVAS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_CANVAS_BYTES = 24 * 1024 * 1024;

function assertCanvasId(value) {
  if (typeof value !== 'string' || !CANVAS_ID.test(value) || value === '.' || value === '..') {
    throw new HttpError(400, 'Canvas id must be 1-80 path-safe ASCII characters.', 'CANVAS_DOCUMENT_INVALID');
  }
  return value;
}

function parseSummary(row) {
  try {
    return JSON.parse(row.summary_json);
  } catch {
    return {};
  }
}

function rowSummary(row) {
  return {
    ...parseSummary(row),
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    syncRevision: Number(row.revision) || 0,
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

export async function listCanvasProjects(env) {
  const result = await env.DB.prepare(SQL.listCanvas).all();
  return (result?.results ?? []).map(rowSummary);
}

export async function loadCanvasProject(env, projectId) {
  projectId = assertCanvasId(projectId);
  const row = await env.DB.prepare(SQL.selectCanvas).bind(projectId).first();
  if (!row) throw new HttpError(404, 'Canvas project not found.', 'CANVAS_NOT_FOUND');
  const object = await env.BUCKET.get(String(row.r2_key));
  if (!object?.body) throw new HttpError(404, 'Canvas document object is missing.', 'CANVAS_OBJECT_NOT_FOUND');
  if (Number(object.size) > MAX_CANVAS_BYTES) throw new HttpError(413, 'Canvas document is too large.', 'CANVAS_TOO_LARGE');
  let document;
  try {
    document = JSON.parse(await object.text());
  } catch {
    throw new HttpError(500, 'Stored canvas document is invalid.', 'CANVAS_DOCUMENT_READ_FAILED');
  }
  validateDocument(document, projectId);
  return document;
}

export async function saveCanvasProject(env, projectId, payload) {
  projectId = assertCanvasId(projectId);
  const source = payload?.document && typeof payload.document === 'object' ? payload.document : payload;
  validateDocument(source, projectId);
  const expectedRevision = payload?.document && typeof payload.document === 'object'
    ? payload.expectedRevision
    : undefined;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new HttpError(400, 'expectedRevision must be a non-negative integer.', 'CANVAS_DOCUMENT_INVALID');
  }
  const existing = await env.DB.prepare(SQL.selectCanvas).bind(projectId).first();
  const actualRevision = Number(existing?.revision ?? 0);
  if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
    throw new HttpError(409, `Canvas project revision changed from ${expectedRevision} to ${actualRevision}.`, 'CANVAS_REVISION_CONFLICT', {
      expectedRevision,
      actualRevision,
    });
  }
  const updatedAt = new Date().toISOString();
  const createdAt = typeof existing?.created_at === 'string'
    ? existing.created_at
    : typeof source.createdAt === 'string' ? source.createdAt : updatedAt;
  const document = {
    ...source,
    id: projectId,
    createdAt,
    updatedAt,
    syncRevision: actualRevision + 1,
    relations: Array.isArray(source.relations) ? source.relations : [],
    strokes: Array.isArray(source.strokes) ? source.strokes : [],
  };
  const serialized = JSON.stringify(document);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CANVAS_BYTES) {
    throw new HttpError(413, 'Canvas document is too large.', 'CANVAS_TOO_LARGE');
  }
  const contentHash = await sha256(serialized);
  const revisionLabel = String(document.syncRevision);
  const r2Key = `canvases/${projectId}/revisions/${revisionLabel}-${contentHash}.json`;
  let storedObject = await env.BUCKET.put(r2Key, serialized, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
    customMetadata: { canvasId: projectId, revision: String(document.syncRevision), contentHash },
  });
  if (!storedObject) {
    storedObject = await env.BUCKET.head(r2Key);
    if (storedObject?.customMetadata?.contentHash !== contentHash) {
      throw new HttpError(409, 'Canvas version key is already occupied by different content.', 'CANVAS_REVISION_CONFLICT', {
        expectedRevision,
        actualRevision,
      });
    }
  }
  const summary = summarize(document);
  let result;
  if (existing) {
    result = await env.DB.prepare(SQL.updateCanvas).bind(
      summary.title,
      document.syncRevision,
      r2Key,
      storedObject.etag,
      updatedAt,
      JSON.stringify(summary),
      projectId,
      actualRevision,
    ).run();
  } else {
    try {
      result = await env.DB.prepare(SQL.insertCanvas).bind(
        projectId,
        summary.title,
        document.syncRevision,
        r2Key,
        storedObject.etag,
        createdAt,
        updatedAt,
        JSON.stringify(summary),
      ).run();
    } catch {
      result = null;
    }
  }
  if (!result || resultChanges(result) !== 1) {
    throw new HttpError(409, 'Canvas metadata changed while saving.', 'CANVAS_REVISION_CONFLICT', {
      expectedRevision,
      actualRevision: Number((await env.DB.prepare(SQL.selectCanvas).bind(projectId).first())?.revision ?? actualRevision),
    });
  }
  const previousKey = typeof existing?.r2_key === 'string' ? existing.r2_key : '';
  const liveRevisionPrefix = `canvases/${projectId}/revisions/`;
  const previousVersionName = previousKey.startsWith(liveRevisionPrefix)
    ? previousKey.slice(liveRevisionPrefix.length)
    : '';
  if (
    previousKey
    && previousKey !== r2Key
    && /^\d+-[a-f0-9]{64}\.json$/.test(previousVersionName)
  ) {
    try {
      await env.BUCKET.delete(previousKey);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'canvas_previous_version_cleanup_failed',
        projectId,
        r2Key: previousKey,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return { document, summary };
}

export async function deleteCanvasProject(env, projectId, payload) {
  projectId = assertCanvasId(projectId);
  const row = await env.DB.prepare(SQL.selectCanvas).bind(projectId).first();
  if (!row) throw new HttpError(404, 'Canvas project not found.', 'CANVAS_NOT_FOUND');
  const actualRevision = Number(row.revision) || 0;
  if (payload.expectedRevision !== undefined && Number(payload.expectedRevision) !== actualRevision) {
    throw new HttpError(409, 'Canvas project changed before deletion.', 'CANVAS_REVISION_CONFLICT', {
      expectedRevision: payload.expectedRevision,
      actualRevision,
    });
  }
  const result = await env.DB.prepare(SQL.deleteCanvas).bind(projectId, actualRevision).run();
  if (resultChanges(result) !== 1) {
    throw new HttpError(409, 'Canvas project changed before deletion.', 'CANVAS_REVISION_CONFLICT', { actualRevision });
  }
  // Canvas objects are immutable versions. Retaining the pointed object avoids
  // deleting bootstrap data and keeps a recovery path for accidental deletes.
  const deletedAt = new Date().toISOString();
  return { projectId, deletedAt, recoverable: false };
}

export async function setActiveCanvas(env, payload) {
  const projectId = assertCanvasId(payload.projectId);
  if (!await env.DB.prepare(SQL.selectCanvas).bind(projectId).first()) {
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
  const seenIds = new Set();
  return source.map((item) => {
    let id;
    try {
      id = assertCanvasId(item?.id);
    } catch {
      throw new HttpError(400, 'Bootstrap canvas index contains an invalid id.', 'INVALID_BOOTSTRAP');
    }
    if (seenIds.has(id)) throw new HttpError(400, `Bootstrap canvas id is duplicated: ${id}`, 'INVALID_BOOTSTRAP');
    seenIds.add(id);
    const revision = Number.isInteger(Number(item.revision ?? item.syncRevision))
      ? Math.max(0, Number(item.revision ?? item.syncRevision))
      : 0;
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString();
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
    const summary = item.summary && typeof item.summary === 'object' ? item.summary : item;
    const candidateKey = typeof item.r2Key === 'string' ? item.r2Key : '';
    const bootstrapPrefix = `bootstrap/canvases/${id}/`;
    const objectName = candidateKey.startsWith(bootstrapPrefix)
      ? candidateKey.slice(bootstrapPrefix.length)
      : '';
    if (!/^[a-f0-9]{64}\.json$/.test(objectName)) {
      throw new HttpError(400, `Bootstrap canvas key is invalid: ${id}`, 'INVALID_BOOTSTRAP');
    }
    return {
      id,
      title: typeof item.title === 'string' ? item.title.slice(0, 240) : '',
      revision,
      r2Key: candidateKey,
      r2Etag: typeof item.r2Etag === 'string' ? item.r2Etag : null,
      createdAt,
      updatedAt,
      summary: {
        ...summary,
        id,
        title: typeof item.title === 'string' ? item.title.slice(0, 240) : '',
        createdAt,
        updatedAt,
        syncRevision: revision,
      },
    };
  });
}

export async function upsertBootstrapCanvases(env, projects) {
  let changed = 0;
  for (const project of projects) {
    const result = await env.DB.prepare(SQL.upsertCanvasBootstrap).bind(
      project.id,
      project.title,
      project.revision,
      project.r2Key,
      project.r2Etag,
      project.createdAt,
      project.updatedAt,
      JSON.stringify(project.summary),
    ).run();
    changed += resultChanges(result);
  }
  return changed;
}
