import { normalizeCanvasIndex, upsertBootstrapCanvases } from './canvas.js';
import { HttpError, sha256 } from './http.js';
import {
  getLearningSnapshot,
  normalizeBootstrapSnapshot,
  replaceLearningSnapshot,
} from './learning.js';
import { readAppState, readLearningState, writeAppState } from './storage.js';

const MAX_BOOTSTRAP_BYTES = 12 * 1024 * 1024;

async function readBootstrapObject(env, key) {
  const metadata = await env.BUCKET.head(key);
  if (!metadata) throw new HttpError(404, `Bootstrap object is missing: ${key}`, 'BOOTSTRAP_OBJECT_MISSING');
  if (Number(metadata.size) > MAX_BOOTSTRAP_BYTES) {
    throw new HttpError(413, `Bootstrap object is too large: ${key}`, 'BOOTSTRAP_TOO_LARGE');
  }
  const object = await env.BUCKET.get(key);
  if (!object?.body) throw new HttpError(404, `Bootstrap object is missing: ${key}`, 'BOOTSTRAP_OBJECT_MISSING');
  const raw = await object.text();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, `Bootstrap object is invalid JSON: ${key}`, 'INVALID_BOOTSTRAP');
  }
  return { raw, value, hash: await sha256(raw) };
}

function hasLearningContent(snapshot) {
  return Object.values(snapshot.days ?? {}).some((day) => (
    Array.isArray(day?.autoNotes) && day.autoNotes.length > 0
  ) || Object.values(day?.manual ?? {}).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value)))
    || (snapshot.cards?.length ?? 0) > 0
    || Object.keys(snapshot.deletedNotes ?? {}).length > 0;
}

export async function bootstrapFromR2(env, options = {}) {
  const [learningObject, canvasObject] = await Promise.all([
    readBootstrapObject(env, 'bootstrap/learning-data.json'),
    readBootstrapObject(env, 'bootstrap/canvas-index.json'),
  ]);
  const [learningMarker, canvasMarker] = await Promise.all([
    readAppState(env, 'bootstrap-learning'),
    readAppState(env, 'bootstrap-canvas-index'),
  ]);
  const canvasProjects = normalizeCanvasIndex(canvasObject.value);
  const now = new Date().toISOString();
  let learningImported = false;
  let learningSnapshot = await getLearningSnapshot(env);
  if (learningMarker?.value?.hash !== learningObject.hash) {
    const current = await readLearningState(env);
    const force = options.force === true;
    const incoming = normalizeBootstrapSnapshot(learningObject.value);
    const comparableCurrent = {
      ...current.snapshot,
      revision: 0,
      updatedAt: null,
    };
    const alreadyImported = JSON.stringify(comparableCurrent) === JSON.stringify(incoming);
    if (alreadyImported) {
      await writeAppState(env, 'bootstrap-learning', { hash: learningObject.hash }, current.revision, now);
      learningSnapshot = current.snapshot;
    } else if (hasLearningContent(current.snapshot) && !force) {
      throw new HttpError(
        409,
        'Cloud learning data already contains changes. Use force with the current expectedRevision to replace it.',
        'BOOTSTRAP_WOULD_OVERWRITE',
        { actualRevision: current.revision },
      );
    } else {
      const expectedRevision = force ? options.expectedRevision : current.revision;
      if (force && (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision)) {
        throw new HttpError(409, 'Bootstrap expectedRevision is stale.', 'REVISION_CONFLICT', {
          expectedRevision,
          actualRevision: current.revision,
        });
      }
      learningSnapshot = await replaceLearningSnapshot(env, incoming, expectedRevision);
      await writeAppState(env, 'bootstrap-learning', { hash: learningObject.hash }, learningSnapshot.revision, now);
      learningImported = true;
    }
  }

  let canvasImported = 0;
  if (canvasMarker?.value?.hash !== canvasObject.hash) {
    canvasImported = await upsertBootstrapCanvases(env, canvasProjects);
    await writeAppState(env, 'bootstrap-canvas-index', { hash: canvasObject.hash }, canvasProjects.length, now);
  }

  const noteCount = Object.values(learningSnapshot.days ?? {})
    .reduce((count, day) => count + (Array.isArray(day?.autoNotes) ? day.autoNotes.length : 0), 0);
  return {
    ok: true,
    replayed: !learningImported && canvasImported === 0,
    learningImported,
    learningRevision: learningSnapshot.revision,
    notes: noteCount,
    cards: learningSnapshot.cards?.length ?? 0,
    canvases: canvasProjects.length,
    canvasRecordsChanged: canvasImported,
  };
}
