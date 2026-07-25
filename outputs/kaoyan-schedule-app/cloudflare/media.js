import { HttpError, sha256 } from './http.js';
import { createNote, createSavedImageNote, getLearningSnapshot, insertSavedImageNote } from './learning.js';
import {
  assertRepoPath,
  publicFileResponse,
  readFile,
  writeBinaryFile,
} from './github-store.js';
import { readReceipt, writeReceipt } from './storage.js';
import { mirrorNewCloudImage, mirroredCloudImagePaths } from './source-mirror.js';
import { enqueueRenameJob, processBackgroundJob } from './background-jobs.js';

const NOTE_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024;
const MAX_MATERIAL_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_MATERIAL_FILES = 8;
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
  ['application/pdf', 'pdf'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['text/html', 'html'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
]);
const EXTENSION_MIME = new Map([...MIME_EXTENSIONS].map(([mime, extension]) => [extension, mime]));
EXTENSION_MIME.set('jpeg', 'image/jpeg');
EXTENSION_MIME.set('htm', 'text/html');
const SAFE_MATERIAL_EXTENSIONS = new Set(EXTENSION_MIME.keys());

function decodeImageDataUrl(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'imageDataUrl is required.', 'INVALID_NOTE_IMAGE');
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) throw new HttpError(400, 'imageDataUrl must contain a base64 image.', 'INVALID_NOTE_IMAGE');
  const mime = match[1].toLowerCase();
  const extension = MIME_EXTENSIONS.get(mime);
  if (!extension || !mime.startsWith('image/')) throw new HttpError(415, 'This image format is not supported.', 'NOTE_FILE_UNSUPPORTED');
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

function safeFileName(value, index, mime) {
  const raw = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  const suppliedExtension = cleaned.includes('.') ? cleaned.split('.').at(-1).toLowerCase() : '';
  const extension = SAFE_MATERIAL_EXTENSIONS.has(suppliedExtension)
    ? suppliedExtension
    : MIME_EXTENSIONS.get(mime) || '';
  if (!extension) throw new HttpError(415, 'This file format is not supported.', 'NOTE_FILE_UNSUPPORTED');
  const stem = (cleaned.replace(/\.[^.]+$/, '').trim() || `资料-${index + 1}`).slice(0, 100);
  return `${stem}.${extension}`;
}

export function decodeMaterialFile(input, index = 0) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Material file is invalid.', 'INVALID_NOTE_FILE');
  const value = typeof input.dataUrl === 'string' ? input.dataUrl : '';
  const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) throw new HttpError(400, 'Material file must contain base64 data.', 'INVALID_NOTE_FILE');
  const declaredMime = match[1].toLowerCase();
  let binary;
  try {
    binary = atob(match[2].replace(/[\r\n]/g, ''));
  } catch {
    throw new HttpError(400, 'Material file contains invalid base64.', 'INVALID_NOTE_FILE');
  }
  if (binary.length > MAX_MATERIAL_BYTES) throw new HttpError(413, 'A material file is too large.', 'PAYLOAD_TOO_LARGE');
  const fileName = safeFileName(input.name, index, declaredMime);
  const extension = fileName.split('.').at(-1).toLowerCase();
  const canonicalMime = EXTENSION_MIME.get(extension) || declaredMime;
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const kind = canonicalMime.startsWith('image/') ? 'image'
    : canonicalMime === 'application/pdf' ? 'pdf'
      : ['doc', 'docx'].includes(extension) ? 'word'
        : ['html', 'htm'].includes(extension) ? 'html' : 'file';
  return { bytes, fileName, extension, mime: canonicalMime, kind };
}

async function saveReceipt(env, scope, noteUid, requestHash, result) {
  try {
    await writeReceipt(env, {
      scope,
      operationId: noteUid,
      entityId: noteUid,
      requestHash,
      result,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const existing = await readReceipt(env, scope, noteUid);
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
  const note = createSavedImageNote({ ...payload, sourceType: payload.sourceType || 'single-capture', noteUid }, { repoPath }, timestamp);
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
    aiStatus: 'pending',
    aiAvailable: true,
    provisional: false,
    idempotentReplay: learningResult.outcome.replayed === true,
  };

  const backgroundWork = Promise.allSettled([
    mirrorNewCloudImage(env, image, note, payload, timestamp),
    saveReceipt(env, 'save-note', noteUid, requestHash, { ...response, learningData: undefined }),
  ]).then(async (result) => {
    reportBackgroundFailure('cloud_note_post_save_failed', noteUid, result);
    try {
      const queued = await enqueueRenameJob(env, noteUid);
      await processBackgroundJob(env, queued.job.id);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'cloud_note_naming_failed', noteUid, error: error instanceof Error ? error.message : String(error) }));
    }
  });
  if (ctx?.waitUntil) ctx.waitUntil(backgroundWork);
  else await backgroundWork;

  return response;
}

function snapshotNote(snapshot, noteUid) {
  for (const day of Object.values(snapshot?.days || {})) {
    const note = Array.isArray(day?.autoNotes) ? day.autoNotes.find((item) => item?.noteUid === noteUid) : null;
    if (note) return note;
  }
  return null;
}

export async function saveMaterialNote(env, payload) {
  const noteUid = normalizeNoteUid(payload.noteUid);
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (files.length > MAX_MATERIAL_FILES) throw new HttpError(400, 'Too many material files.', 'TOO_MANY_NOTE_FILES');
  const decoded = files.map((file, index) => decodeMaterialFile(file, index));
  const totalBytes = decoded.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_MATERIAL_TOTAL_BYTES) throw new HttpError(413, 'Material files are too large in total.', 'PAYLOAD_TOO_LARGE');
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 240) : '';
  const remark = typeof payload.remark === 'string' ? payload.remark.trim().slice(0, 8000) : '';
  if (!title && !remark && decoded.length === 0) {
    throw new HttpError(400, 'Text or at least one file is required.', 'EMPTY_MATERIAL_NOTE');
  }
  const fileHashes = [];
  for (const file of decoded) fileHashes.push(await sha256(file.bytes));
  const requestHash = await sha256(JSON.stringify({
    noteUid,
    title,
    remark,
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    facets: Array.isArray(payload.facets) ? payload.facets : [],
    files: decoded.map((file, index) => ({ name: file.fileName, mime: file.mime, hash: fileHashes[index] })),
  }));
  const existingReceipt = await readReceipt(env, 'save-material-note', noteUid);
  if (existingReceipt) {
    if (existingReceipt.requestHash !== requestHash) {
      throw new HttpError(409, 'noteUid was already used for another material note.', 'SAVE_OPERATION_REUSED');
    }
    return { ...existingReceipt.result, learningData: await getLearningSnapshot(env), idempotentReplay: true };
  }

  const timestamp = new Date().toISOString();
  const attachments = [];
  for (let index = 0; index < decoded.length; index += 1) {
    const file = decoded[index];
    const repoPath = `${ASSET_ROOT}${noteUid}/${String(index + 1).padStart(2, '0')}-${file.fileName}`;
    const existing = await readFile(env, repoPath, { allowMissing: true, maxBytes: MAX_MATERIAL_BYTES });
    if (existing) {
      const existingHash = await sha256(existing.bytes);
      if (existingHash !== fileHashes[index]) throw new HttpError(409, 'Stored material file has different content.', 'SAVE_OPERATION_REUSED');
    } else {
      await writeBinaryFile(env, repoPath, file.bytes, {
        createOnly: true,
        message: `data: save learning material ${noteUid} ${index + 1}`,
      });
    }
    attachments.push({
      id: `material-${index + 1}`,
      kind: file.kind,
      name: file.fileName,
      mimeType: file.mime,
      size: file.bytes.byteLength,
      filePath: `github://${repoPath}`,
      previewPath: '',
      posterPath: '',
      createdAt: timestamp,
    });
  }

  let snapshot = await getLearningSnapshot(env);
  let note = snapshotNote(snapshot, noteUid);
  if (!note) {
    snapshot = await createNote(env, {
      input: {
        noteUid,
        capturedDate: typeof payload.capturedDate === 'string' ? payload.capturedDate : undefined,
        title: title || remark.split(/\r?\n/)[0]?.slice(0, 120) || attachments[0]?.name || '快速记录',
        subject: typeof payload.subject === 'string' && payload.subject.trim() ? payload.subject.trim() : '默认文件夹',
        remark,
        tags: Array.isArray(payload.tags) ? payload.tags : [],
        facets: Array.isArray(payload.facets) ? payload.facets : ['quick'],
        noteType: Array.isArray(payload.facets) && payload.facets.includes('mistake') ? 'mistake'
          : Array.isArray(payload.facets) && payload.facets.includes('memory') ? 'memory'
            : Array.isArray(payload.facets) && payload.facets.includes('knowledge') ? 'knowledge' : 'quick',
        goodQuestion: Array.isArray(payload.facets) && payload.facets.includes('good'),
        attachments,
        createCard: false,
      },
    });
    note = snapshotNote(snapshot, noteUid);
  }

  const response = {
    ok: true,
    noteUid,
    attachments: note?.attachments || attachments,
    learningData: snapshot,
    idempotentReplay: false,
  };
  await saveReceipt(env, 'save-material-note', noteUid, requestHash, { ...response, learningData: undefined });
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
  if (!EXTENSION_MIME.has(extension)) throw new HttpError(403, 'This stored note file type is not allowed.', 'NOTE_PATH_FORBIDDEN');
  if (prefix === SOURCE_NOTES_ROOT && repoPath.split('/').includes('.metadata')) {
    throw new HttpError(403, 'Metadata files are not public note files.', 'NOTE_PATH_FORBIDDEN');
  }
  return { repoPath, prefix, extension };
}

export async function getNoteFile(env, path) {
  const asset = noteAssetPath(path);
  const image = (EXTENSION_MIME.get(asset.extension) || '').startsWith('image/');
  return publicFileResponse(env, asset.repoPath, {
    prefix: asset.prefix,
    contentType: EXTENSION_MIME.get(asset.extension) || 'application/octet-stream',
    contentDisposition: image ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(asset.repoPath.split('/').at(-1) || 'material')}`,
    cacheControl: 'private, max-age=31536000, immutable',
  });
}
