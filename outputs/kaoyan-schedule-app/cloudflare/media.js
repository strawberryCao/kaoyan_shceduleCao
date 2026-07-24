import { HttpError, sha256 } from './http.js';
import { createSavedImageNote, getLearningSnapshot, insertSavedImageNote } from './learning.js';
import {
  assertRepoPath,
  publicFileResponse,
  readFile,
  writeBinaryFile,
} from './github-store.js';
import { readReceipt, writeReceipt } from './storage.js';
import { mirrorNewCloudImage, mirroredCloudImagePaths } from './source-mirror.js';

const NOTE_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ASSET_ROOT = 'data/assets/';
const SOURCE_NOTES_ROOT = 'source-notes/';
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
]);
const EXTENSION_MIME = new Map([...MIME_EXTENSIONS].map(([mime, extension]) => [extension, mime]));
EXTENSION_MIME.set('jpeg', 'image/jpeg');

function decodeImageDataUrl(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'imageDataUrl is required.', 'INVALID_NOTE_IMAGE');
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) throw new HttpError(400, 'imageDataUrl must contain a base64 image.', 'INVALID_NOTE_IMAGE');
  const mime = match[1].toLowerCase();
  const extension = MIME_EXTENSIONS.get(mime);
  if (!extension) throw new HttpError(415, 'This image format is not supported.', 'NOTE_FILE_UNSUPPORTED');
  let binary;
  try {
    binary = atob(match[2].replace(/[\r\n]/g, ''));
  } catch {
    throw new HttpError(400, 'imageDataUrl contains invalid base64.', 'INVALID_NOTE_IMAGE');
  }
  if (binary.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Note image is too large.', 'PAYLOAD_TOO_LARGE');
  return {
    mime,
    extension,
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  };
}

function normalizeNoteUid(value) {
  const noteUid = typeof value === 'string' ? value.trim() : '';
  if (!NOTE_UID_PATTERN.test(noteUid)) {
    throw new HttpError(400, 'noteUid must be 1-160 path-safe ASCII characters.', 'INVALID_NOTE_UID');
  }
  return noteUid;
}

async function saveReceipt(env, noteUid, requestHash, result) {
  try {
    await writeReceipt(env, {
      scope: 'save-note',
      operationId: noteUid,
      entityId: noteUid,
      requestHash,
      result,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const existing = await readReceipt(env, 'save-note', noteUid);
    if (!existing || existing.requestHash !== requestHash) throw error;
  }
}

function reportBackgroundFailure(event, noteUid, result) {
  for (const item of result) {
    if (item.status !== 'rejected') continue;
    console.error(JSON.stringify({
      level: 'error',
      event,
      noteUid,
      error: item.reason instanceof Error ? item.reason.message : String(item.reason),
    }));
  }
}

export async function saveNote(env, payload, ctx) {
  const noteUid = normalizeNoteUid(payload.noteUid);
  const image = decodeImageDataUrl(payload.imageDataUrl);
  const imageHash = await sha256(image.bytes);
  const requestHash = await sha256(JSON.stringify({
    noteUid,
    kind: payload.kind === 'canvas' ? 'canvas' : 'single',
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    remark: typeof payload.remark === 'string' ? payload.remark : '',
    canvasProjectId: typeof payload.canvasProjectId === 'string' ? payload.canvasProjectId : '',
    sourceType: typeof payload.sourceType === 'string' ? payload.sourceType : '',
    sourceBatchId: typeof payload.sourceBatchId === 'string' ? payload.sourceBatchId : '',
    sourceSplitIndex: Number(payload.sourceSplitIndex) || 0,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    imageHash,
  }));
  const existingReceipt = await readReceipt(env, 'save-note', noteUid);
  if (existingReceipt) {
    if (existingReceipt.requestHash !== requestHash) {
      throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
    }
    return {
      ...existingReceipt.result,
      learningData: await getLearningSnapshot(env),
      idempotentReplay: true,
    };
  }

  const repoPath = `${ASSET_ROOT}${noteUid}.${image.extension}`;
  const existingFile = await readFile(env, repoPath, { allowMissing: true, maxBytes: MAX_IMAGE_BYTES });
  if (existingFile) {
    const existingHash = await sha256(existingFile.bytes);
    if (existingHash !== imageHash) {
      throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
    }
  } else {
    await writeBinaryFile(env, repoPath, image.bytes, {
      createOnly: true,
      message: `data: save note image ${noteUid}`,
    });
  }

  const timestamp = new Date().toISOString();
  const fileName = `${noteUid}.${image.extension}`;
  const note = createSavedImageNote({ ...payload, noteUid }, { repoPath }, timestamp);
  const learningResult = await insertSavedImageNote(env, note);
  const sourceMirror = mirroredCloudImagePaths(noteUid, image.extension);
  const response = {
    ok: true,
    noteUid,
    filePath: `github://${repoPath}`,
    fileName,
    sourceMirrorPath: sourceMirror.imagePath,
    metadata: {
      noteUid,
      sourceType: note.sourceType,
      sourceBatchId: note.sourceBatchId,
      sourceSplitIndex: note.sourceSplitIndex,
      learning: { tags: note.tags, noteType: note.noteType },
    },
    learningData: learningResult.snapshot,
    learningSyncError: null,
    aiStatus: note.sourceType === 'ai-multi-question' ? 'pending' : 'unavailable',
    aiAvailable: note.sourceType === 'ai-multi-question',
    provisional: false,
    idempotentReplay: learningResult.outcome.replayed === true,
  };

  const backgroundWork = Promise.allSettled([
    mirrorNewCloudImage(env, image, note, payload, timestamp),
    saveReceipt(env, noteUid, requestHash, { ...response, learningData: undefined }),
  ]).then((result) => reportBackgroundFailure('cloud_note_post_save_failed', noteUid, result));
  if (ctx?.waitUntil) ctx.waitUntil(backgroundWork);
  else await backgroundWork;

  return response;
}

function noteAssetPath(value) {
  const normalized = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
  let repoPath = '';
  let prefix = '';
  try {
    if (normalized.startsWith('github://data/assets/')) {
      prefix = ASSET_ROOT;
      repoPath = assertRepoPath(normalized.slice('github://'.length), prefix);
    } else if (normalized.startsWith(ASSET_ROOT)) {
      prefix = ASSET_ROOT;
      repoPath = assertRepoPath(normalized, prefix);
    } else if (normalized.startsWith('r2://note-assets/')) {
      prefix = ASSET_ROOT;
      repoPath = assertRepoPath(`${ASSET_ROOT}${normalized.slice('r2://note-assets/'.length)}`, prefix);
    } else if (normalized.startsWith('github://source-notes/')) {
      prefix = SOURCE_NOTES_ROOT;
      repoPath = assertRepoPath(normalized.slice('github://'.length), prefix);
    } else if (normalized.startsWith(SOURCE_NOTES_ROOT)) {
      prefix = SOURCE_NOTES_ROOT;
      repoPath = assertRepoPath(normalized, prefix);
    }
  } catch (error) {
    if (error instanceof HttpError && ['GITHUB_PATH_INVALID', 'GITHUB_PATH_FORBIDDEN'].includes(error.code)) {
      throw new HttpError(403, 'Only stored note assets can be read.', 'NOTE_PATH_FORBIDDEN');
    }
    throw error;
  }
  if (!repoPath || !prefix) throw new HttpError(403, 'Only stored note assets can be read.', 'NOTE_PATH_FORBIDDEN');
  const extension = repoPath.split('.').at(-1)?.toLowerCase() || '';
  if (!EXTENSION_MIME.has(extension)) throw new HttpError(403, 'Only stored note images can be read.', 'NOTE_PATH_FORBIDDEN');
  if (prefix === SOURCE_NOTES_ROOT && repoPath.split('/').includes('.metadata')) {
    throw new HttpError(403, 'Metadata files are not public note images.', 'NOTE_PATH_FORBIDDEN');
  }
  return { repoPath, prefix, extension };
}

export async function getNoteFile(env, path) {
  const asset = noteAssetPath(path);
  return publicFileResponse(env, asset.repoPath, {
    prefix: asset.prefix,
    contentType: EXTENSION_MIME.get(asset.extension) || 'application/octet-stream',
    cacheControl: 'private, max-age=31536000, immutable',
  });
}
