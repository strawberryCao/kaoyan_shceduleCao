import { HttpError, sha256 } from './http.js';
import { createNote, createSavedImageNote, findNote, getLearningSnapshot } from './learning.js';
import {
  assertRepoPath,
  commitFiles,
  getBranchHead,
  publicFileResponse,
  readFile,
  readJsonFile,
  writeBinaryFile,
} from './github-store.js';
import { readReceipt, STORAGE_PATHS, writeReceipt } from './storage.js';
import { mirrorNewCloudImage, mirroredCloudImagePaths } from './source-mirror.js';
import { enqueueNotePipelineJob, processBackgroundJob } from './background-jobs.js';

const NOTE_UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024;
const MAX_MATERIAL_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_IMAGES = 12;
const MAX_BATCH_IMAGE_BYTES = 48 * 1024 * 1024;
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
  ['text/css', 'css'],
  ['text/javascript', 'js'],
  ['application/javascript', 'js'],
  ['application/json', 'json'],
  ['image/svg+xml', 'svg'],
]);
const EXTENSION_MIME = new Map([...MIME_EXTENSIONS].map(([mime, extension]) => [extension, mime]));
EXTENSION_MIME.set('jpeg', 'image/jpeg');
EXTENSION_MIME.set('htm', 'text/html');
const SAFE_MATERIAL_EXTENSIONS = new Set(EXTENSION_MIME.keys());
const AI_SELECTION_MODES = new Set(['auto-light', 'auto-advanced', 'model', 'off']);

function normalizeAiSelection(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { mode: kind === 'canvas' ? 'auto-advanced' : 'auto-light' };
  }
  const mode = AI_SELECTION_MODES.has(value.mode) ? value.mode : kind === 'canvas' ? 'auto-advanced' : 'auto-light';
  const providerId = String(value.providerId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const modelId = String(value.modelId || '').trim().replace(/[\r\n\t]/g, '').slice(0, 120);
  return mode === 'model' && providerId && modelId ? { mode, providerId, modelId } : { mode: mode === 'model' ? 'auto-light' : mode };
}

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

function normalizeLearningSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {};
  return {
    ...source,
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: Number.isInteger(Number(source.revision)) ? Math.max(0, Number(source.revision)) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    days: source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {},
    cards: Array.isArray(source.cards) ? source.cards : [],
    deletedNotes: source.deletedNotes && typeof source.deletedNotes === 'object' && !Array.isArray(source.deletedNotes)
      ? source.deletedNotes : {},
  };
}

function appendSavedImageNote(snapshot, note) {
  const rawDay = snapshot.days[note.capturedDate];
  const day = rawDay && typeof rawDay === 'object' && !Array.isArray(rawDay) ? { ...rawDay } : {};
  day.manual = day.manual && typeof day.manual === 'object' && !Array.isArray(day.manual)
    ? day.manual : { completedTaskIds: [], note: '', debt: '', mistakes: '' };
  day.autoNotes = Array.isArray(day.autoNotes) ? [...day.autoNotes, note] : [note];
  snapshot.days[note.capturedDate] = day;
}

function buildSavedImageResponse(note, image, repoPath, replayed) {
  const sourceMirror = mirroredCloudImagePaths(note.noteUid, image.extension);
  const aiDisabled = note.aiSelection?.mode === 'off';
  return {
    ok: true,
    noteUid: note.noteUid,
    filePath: `github://${repoPath}`,
    fileName: `${note.noteUid}.${image.extension}`,
    sourceMirrorPath: sourceMirror.imagePath,
    metadata: {
      noteUid: note.noteUid,
      sourceType: note.sourceType,
      sourceBatchId: note.sourceBatchId,
      sourceSplitIndex: note.sourceSplitIndex,
      learning: { tags: note.tags, noteType: note.noteType },
    },
    learningSyncError: null,
    aiStatus: aiDisabled ? 'complete' : 'pending',
    aiAvailable: !aiDisabled,
    provisional: false,
    idempotentReplay: replayed,
  };
}

async function prepareSavedImage(payload) {
  const noteUid = normalizeNoteUid(payload.noteUid);
  const image = decodeImageDataUrl(payload.imageDataUrl);
  const imageHash = await sha256(image.bytes);
  const kind = payload.kind === 'canvas' ? 'canvas' : 'single';
  const aiSelection = normalizeAiSelection(payload.aiSelection, kind);
  const requestHash = await sha256(JSON.stringify({
    noteUid,
    kind,
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    remark: typeof payload.remark === 'string' ? payload.remark : '',
    canvasProjectId: typeof payload.canvasProjectId === 'string' ? payload.canvasProjectId : '',
    sourceType: typeof payload.sourceType === 'string' ? payload.sourceType : '',
    sourceBatchId: typeof payload.sourceBatchId === 'string' ? payload.sourceBatchId : '',
    sourceSplitIndex: Number(payload.sourceSplitIndex) || 0,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    aiSelection,
    imageHash,
  }));
  return {
    payload: { ...payload, noteUid, kind, aiSelection },
    noteUid,
    image,
    imageHash,
    requestHash,
    repoPath: `${ASSET_ROOT}${noteUid}.${image.extension}`,
  };
}

async function finishSavedImagesInBackground(env, staged, responses, timestamp) {
  const responseByUid = new Map(responses.map((response) => [response.noteUid, response]));
  const postSave = await Promise.allSettled(staged.flatMap((item) => {
    const response = responseByUid.get(item.noteUid);
    return [
      mirrorNewCloudImage(env, item.image, item.note, item.payload, timestamp),
      saveReceipt(env, 'save-note', item.noteUid, item.requestHash, response),
    ];
  }));
  reportBackgroundFailure('cloud_note_batch_post_save_failed', staged.map((item) => item.noteUid).join(','), postSave);

  const naming = await Promise.allSettled(staged.filter((item) => item.note.aiSelection?.mode !== 'off').map(async (item) => {
    const queued = await enqueueNotePipelineJob(env, item.noteUid);
    await processBackgroundJob(env, queued.job.id);
  }));
  reportBackgroundFailure('cloud_note_batch_ai_pipeline_failed', staged.map((item) => item.noteUid).join(','), naming);
}

export async function saveNoteBatch(env, payload, ctx) {
  const inputs = Array.isArray(payload?.notes) ? payload.notes : [];
  if (inputs.length < 1 || inputs.length > MAX_BATCH_IMAGES) {
    throw new HttpError(400, `notes must contain between 1 and ${MAX_BATCH_IMAGES} images.`, 'INVALID_NOTE_BATCH');
  }
  const prepared = await Promise.all(inputs.map((item) => prepareSavedImage(item && typeof item === 'object' ? item : {})));
  const noteUids = new Set();
  let totalBytes = 0;
  for (const item of prepared) {
    if (noteUids.has(item.noteUid)) throw new HttpError(400, 'A noteUid may appear only once in a batch.', 'DUPLICATE_NOTE_UID');
    noteUids.add(item.noteUid);
    totalBytes += item.image.bytes.byteLength;
  }
  if (totalBytes > MAX_BATCH_IMAGE_BYTES) throw new HttpError(413, 'The image batch is too large.', 'PAYLOAD_TOO_LARGE');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const learningFile = await readJsonFile(env, STORAGE_PATHS.learning, {
      ref: head,
      allowMissing: true,
      maxBytes: 24 * 1024 * 1024,
    });
    const snapshot = normalizeLearningSnapshot(learningFile?.value);
    const timestamp = new Date().toISOString();
    const staged = [];
    const responses = [];

    for (const item of prepared) {
      const existing = findNote(snapshot, item.noteUid)?.note;
      if (existing) {
        if (existing.sourceImageHash && existing.sourceImageHash !== item.imageHash) {
          throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
        }
        const existingPath = typeof existing.filePath === 'string' && existing.filePath.startsWith('github://')
          ? existing.filePath.slice('github://'.length) : item.repoPath;
        responses.push(buildSavedImageResponse(existing, item.image, existingPath, true));
        continue;
      }
      if (snapshot.deletedNotes[item.noteUid]) throw new HttpError(409, 'Learning note is deleted.', 'NOTE_DELETED');
      const note = {
        ...createSavedImageNote(
          { ...item.payload, sourceType: item.payload.sourceType || 'single-capture' },
          { repoPath: item.repoPath },
          timestamp,
        ),
        sourceImageHash: item.imageHash,
      };
      appendSavedImageNote(snapshot, note);
      staged.push({ ...item, note });
      responses.push(buildSavedImageResponse(note, item.image, item.repoPath, false));
    }

    if (staged.length === 0) {
      return { ok: true, notes: responses, learningData: snapshot, idempotentReplay: true };
    }

    const stored = {
      ...snapshot,
      revision: Number(snapshot.revision || 0) + 1,
      updatedAt: timestamp,
    };
    const files = [
      ...staged.map((item) => ({ path: item.repoPath, content: item.image.bytes })),
      { path: STORAGE_PATHS.learning, content: `${JSON.stringify(stored, null, 2)}\n` },
    ];

    try {
      await commitFiles(env, {
        expectedHeadSha: head,
        message: staged.length === 1
          ? `cloud: save note ${staged[0].noteUid}`
          : `cloud: save ${staged.length} captured questions`,
        files,
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === 'GITHUB_REVISION_CONFLICT' && attempt < 3) continue;
      throw error;
    }

    const backgroundWork = finishSavedImagesInBackground(env, staged, responses, timestamp);
    if (ctx?.waitUntil) ctx.waitUntil(backgroundWork);
    else await backgroundWork;
    return { ok: true, notes: responses, learningData: stored, idempotentReplay: false };
  }
  throw new HttpError(409, 'GitHub repository changed while saving; retry.', 'GITHUB_REVISION_CONFLICT');
}

export async function saveNote(env, payload, ctx) {
  const batch = await saveNoteBatch(env, { notes: [payload] }, ctx);
  return {
    ...batch.notes[0],
    learningData: batch.learningData,
    idempotentReplay: batch.idempotentReplay || batch.notes[0]?.idempotentReplay === true,
  };
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

export async function getNoteFile(env, path, options = {}) {
  const asset = noteAssetPath(path);
  const mime = EXTENSION_MIME.get(asset.extension) || 'application/octet-stream';
  const image = mime.startsWith('image/');
  const inline = image || (options.preview === true && asset.extension === 'pdf');
  return publicFileResponse(env, asset.repoPath, {
    prefix: asset.prefix,
    contentType: mime,
    contentDisposition: inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(asset.repoPath.split('/').at(-1) || 'material')}`,
    cacheControl: 'private, max-age=31536000, immutable',
  });
}
