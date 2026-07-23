import { HttpError, sha256 } from './http.js';
import { createSavedImageNote, insertSavedImageNote } from './learning.js';
import { readReceipt, SQL, writeReceipt } from './storage.js';

const NOTE_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
]);

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
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return { mime, extension, bytes };
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

export async function saveNote(env, payload) {
  const noteUid = normalizeNoteUid(payload.noteUid);
  const image = decodeImageDataUrl(payload.imageDataUrl);
  const imageHash = await sha256(image.bytes);
  const requestHash = await sha256(JSON.stringify({
    noteUid,
    kind: payload.kind === 'canvas' ? 'canvas' : 'single',
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    remark: typeof payload.remark === 'string' ? payload.remark : '',
    canvasProjectId: typeof payload.canvasProjectId === 'string' ? payload.canvasProjectId : '',
    imageHash,
  }));
  const existingReceipt = await readReceipt(env, 'save-note', noteUid);
  if (existingReceipt) {
    if (existingReceipt.requestHash !== requestHash) {
      throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
    }
    return { ...existingReceipt.result, idempotentReplay: true };
  }

  const r2Key = `note-assets/${noteUid}.${image.extension}`;
  const existingFile = await env.DB.prepare(SQL.selectNoteFile).bind(noteUid).first();
  if (existingFile && String(existingFile.r2_key) !== r2Key) {
    throw new HttpError(409, 'noteUid was already saved with another file type.', 'SAVE_OPERATION_REUSED');
  }
  const existingObject = await env.BUCKET.head(r2Key);
  if (existingObject && existingObject.customMetadata?.requestHash !== requestHash) {
    throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
  }
  let stored = existingObject;
  if (!stored) {
    stored = await env.BUCKET.put(r2Key, image.bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: image.mime, cacheControl: 'private, no-store' },
      customMetadata: { noteUid, requestHash },
    });
    if (!stored) {
      stored = await env.BUCKET.head(r2Key);
      if (stored?.customMetadata?.requestHash !== requestHash) {
        throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
      }
    }
  }
  if (!stored) throw new HttpError(500, 'The note image could not be stored.', 'NOTE_IMAGE_SAVE_FAILED');
  const timestamp = new Date().toISOString();
  const fileName = `${noteUid}.${image.extension}`;
  await env.DB.prepare(SQL.upsertNoteFile).bind(
    noteUid,
    r2Key,
    fileName,
    image.mime,
    image.bytes.byteLength,
    timestamp,
  ).run();
  const note = createSavedImageNote({ ...payload, noteUid }, { r2Key }, timestamp);
  const learningResult = await insertSavedImageNote(env, note);
  const response = {
    ok: true,
    noteUid,
    filePath: `r2://${r2Key}`,
    fileName,
    metadata: {
      noteUid,
      learning: { tags: note.tags, noteType: note.noteType },
    },
    learningSyncError: null,
    aiStatus: 'unavailable',
    aiAvailable: false,
    provisional: false,
    idempotentReplay: learningResult.outcome.replayed === true,
  };
  await saveReceipt(env, noteUid, requestHash, response);
  return response;
}

function assertNoteAssetKey(value) {
  const normalized = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
  const key = normalized.startsWith('r2://') ? normalized.slice(5) : normalized;
  if (!key.startsWith('note-assets/') || key.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(key)) {
    throw new HttpError(403, 'Only stored note assets can be read.', 'NOTE_PATH_FORBIDDEN');
  }
  return key;
}

export async function getNoteFile(env, path) {
  const key = assertNoteAssetKey(path);
  const object = await env.BUCKET.get(key);
  if (!object?.body) throw new HttpError(404, 'Note image not found.', 'NOTE_FILE_NOT_FOUND');
  const headers = new Headers({
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
  });
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}
