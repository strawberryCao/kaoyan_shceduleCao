'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = path.join(root, 'outputs', 'kaoyan-schedule-app');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, content) {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`updated ${relative}`);
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing anchor: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

const mediaSource = `import { HttpError, sha256 } from './http.js';
import { createNote, createSavedImageNote, getLearningSnapshot, insertSavedImageNote } from './learning.js';
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
  const stem = (cleaned.replace(/\.[^.]+$/, '').trim() || \`资料-\${index + 1}\`).slice(0, 100);
  return \`\${stem}.\${extension}\`;
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

  const repoPath = \`\${ASSET_ROOT}\${noteUid}.\${image.extension}\`;
  const existingFile = await readFile(env, repoPath, { allowMissing: true, maxBytes: MAX_IMAGE_BYTES });
  if (existingFile) {
    const existingHash = await sha256(existingFile.bytes);
    if (existingHash !== imageHash) {
      throw new HttpError(409, 'noteUid was already used for another image.', 'SAVE_OPERATION_REUSED');
    }
  } else {
    await writeBinaryFile(env, repoPath, image.bytes, {
      createOnly: true,
      message: \`data: save note image \${noteUid}\`,
    });
  }

  const timestamp = new Date().toISOString();
  const fileName = \`\${noteUid}.\${image.extension}\`;
  const note = createSavedImageNote({ ...payload, noteUid }, { repoPath }, timestamp);
  const learningResult = await insertSavedImageNote(env, note);
  const sourceMirror = mirroredCloudImagePaths(noteUid, image.extension);
  const response = {
    ok: true,
    noteUid,
    filePath: \`github://\${repoPath}\`,
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
    saveReceipt(env, 'save-note', noteUid, requestHash, { ...response, learningData: undefined }),
  ]).then((result) => reportBackgroundFailure('cloud_note_post_save_failed', noteUid, result));
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
    const repoPath = \`\${ASSET_ROOT}\${noteUid}/\${String(index + 1).padStart(2, '0')}-\${file.fileName}\`;
    const existing = await readFile(env, repoPath, { allowMissing: true, maxBytes: MAX_MATERIAL_BYTES });
    if (existing) {
      const existingHash = await sha256(existing.bytes);
      if (existingHash !== fileHashes[index]) throw new HttpError(409, 'Stored material file has different content.', 'SAVE_OPERATION_REUSED');
    } else {
      await writeBinaryFile(env, repoPath, file.bytes, {
        createOnly: true,
        message: \`data: save learning material \${noteUid} \${index + 1}\`,
      });
    }
    attachments.push({
      id: \`material-\${index + 1}\`,
      kind: file.kind,
      name: file.fileName,
      mimeType: file.mime,
      size: file.bytes.byteLength,
      filePath: \`github://\${repoPath}\`,
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
      repoPath = assertRepoPath(\`\${ASSET_ROOT}\${normalized.slice('r2://note-assets/'.length)}\`, prefix);
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
    contentDisposition: image ? 'inline' : \`attachment; filename*=UTF-8''\${encodeURIComponent(asset.repoPath.split('/').at(-1) || 'material')}\`,
    cacheControl: 'private, max-age=31536000, immutable',
  });
}
`;
write('outputs/kaoyan-schedule-app/cloudflare/media.js', mediaSource);

let githubStore = read('outputs/kaoyan-schedule-app/cloudflare/github-store.js');
githubStore = replaceOnce(
  githubStore,
  "  if (options.contentType) headers.set('Content-Type', options.contentType);\n  return new Response(response.body, { status: 200, headers });",
  "  if (options.contentType) headers.set('Content-Type', options.contentType);\n  if (options.contentDisposition) headers.set('Content-Disposition', options.contentDisposition);\n  return new Response(response.body, { status: 200, headers });",
  'github-store content disposition',
);
write('outputs/kaoyan-schedule-app/cloudflare/github-store.js', githubStore);

let worker = read('outputs/kaoyan-schedule-app/cloudflare/worker.js');
worker = replaceOnce(worker, "import { getNoteFile, saveNote } from './media.js';", "import { getNoteFile, saveMaterialNote, saveNote } from './media.js';", 'worker media import');
worker = replaceOnce(
  worker,
  "  if (request.method === 'POST' && pathname === '/save-note') {\n    const result = await saveNote(env, await readJson(request, 28 * 1024 * 1024));\n    return json(result, result.idempotentReplay ? 200 : 202);\n  }",
  "  if (request.method === 'POST' && pathname === '/save-note') {\n    const result = await saveNote(env, await readJson(request, 28 * 1024 * 1024), ctx);\n    return json(result, result.idempotentReplay ? 200 : 202);\n  }\n  if (request.method === 'POST' && pathname === '/save-material-note') {\n    const result = await saveMaterialNote(env, await readJson(request, 24 * 1024 * 1024));\n    return json(result, result.idempotentReplay ? 200 : 201);\n  }",
  'worker material route',
);
write('outputs/kaoyan-schedule-app/cloudflare/worker.js', worker);

let notes = read('outputs/kaoyan-schedule-app/src/utils/notes.ts');
notes = replaceOnce(
  notes,
  "export interface SaveNoteResult {",
  `export interface MaterialFilePayload {\n  name: string;\n  mimeType: string;\n  size: number;\n  dataUrl: string;\n}\n\nexport type LearningRecordFacet = 'quick' | 'mistake' | 'good' | 'memory' | 'knowledge';\n\nexport interface SaveMaterialPayload {\n  noteUid?: string;\n  capturedDate?: string;\n  title?: string;\n  remark?: string;\n  subject?: string;\n  tags?: string[];\n  facets?: LearningRecordFacet[];\n  files?: File[];\n}\n\nexport interface SaveMaterialResult {\n  ok: boolean;\n  noteUid: string;\n  attachments?: Array<{ id: string; kind: string; name: string; mimeType: string; size: number | null; filePath: string }>;\n  learningData?: LearningDataSnapshot;\n  idempotentReplay?: boolean;\n  error?: string;\n}\n\nexport interface SaveNoteResult {`,
  'notes material types',
);
notes = replaceOnce(
  notes,
  "export const detectQuestionRegions = async (imageDataUrl: string): Promise<DetectQuestionResult> => {",
  `export const saveLearningMaterial = async (payload: SaveMaterialPayload): Promise<SaveMaterialResult> => {\n  const noteUid = payload.noteUid || createNoteUid();\n  const files: MaterialFilePayload[] = [];\n  for (const file of payload.files ?? []) {\n    files.push({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, dataUrl: await fileToDataUrl(file) });\n  }\n  return fetchJsonWithTimeout<SaveMaterialResult>(\`${'${NOTE_SERVER_URL}'}/save-material-note\`, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ ...payload, files, noteUid }),\n  }, Math.max(NOTE_SAVE_TIMEOUT_MS, 45_000));\n};\n\nexport const detectQuestionRegions = async (imageDataUrl: string): Promise<DetectQuestionResult> => {`,
  'notes save material function',
);
write('outputs/kaoyan-schedule-app/src/utils/notes.ts', notes);

const composer = `import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, FilePlus2, LoaderCircle, Paperclip, Save, Trash2, X } from 'lucide-react';
import { saveLearningMaterial, type LearningRecordFacet } from '../utils/notes';
import { saveLearningDataCache } from '../utils/learningData';
import '../quick-material-composer.css';

const SUBJECTS = ['默认文件夹', '高等数学', '线性代数', '概率论', '英语', '政治', '数据结构', '计算机组成', '操作系统', '计算机网络'];
const FACETS: Array<{ id: LearningRecordFacet; label: string }> = [
  { id: 'quick', label: '速记' },
  { id: 'mistake', label: '错题' },
  { id: 'good', label: '好题' },
  { id: 'memory', label: '背诵' },
  { id: 'knowledge', label: '知识点' },
];
const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

interface QuickMaterialComposerProps {
  onClose: () => void;
  onSaved: (message: string) => void;
}

const formatBytes = (bytes: number): string => bytes >= 1024 * 1024
  ? \`${'${(bytes / 1024 / 1024).toFixed(1)}'} MB\`
  : \`${'${Math.max(1, Math.round(bytes / 1024))}'} KB\`;

export function QuickMaterialComposer({ onClose, onSaved }: QuickMaterialComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [remark, setRemark] = useState('');
  const [subject, setSubject] = useState('默认文件夹');
  const [facets, setFacets] = useState<LearningRecordFacet[]>(['quick']);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const next = [...files];
    for (const file of Array.from(incoming)) {
      if (next.length >= MAX_FILES) break;
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} 超过 8 MB，未加入。`);
        continue;
      }
      if (!next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
    }
    const size = next.reduce((sum, file) => sum + file.size, 0);
    if (size > MAX_TOTAL_BYTES) {
      setError('全部资料合计不能超过 16 MB。');
      return;
    }
    setFiles(next);
    setError('');
  };

  const toggleFacet = (facet: LearningRecordFacet) => {
    setFacets((current) => current.includes(facet)
      ? current.filter((item) => item !== facet)
      : [...current, facet]);
  };

  const submit = async () => {
    if (saving) return;
    if (!title.trim() && !remark.trim() && files.length === 0) {
      setError('至少写一点文字，或加入一个资料文件。');
      return;
    }
    try {
      setSaving(true);
      setError('');
      const result = await saveLearningMaterial({ title: title.trim(), remark: remark.trim(), subject, facets, files });
      if (result.learningData) saveLearningDataCache(result.learningData);
      setSaved(true);
      onSaved(`已保存${files.length ? ` · ${files.length} 个资料` : '文字速记'}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <main className="quick-material-composer is-saved">
        <CheckCircle2 size={42} />
        <h1>记录完成</h1>
        <p>文字和资料已经写入学习中心。</p>
        <button className="primary" type="button" onClick={onClose}>返回笔记小 App</button>
      </main>
    );
  }

  return (
    <main className="quick-material-composer">
      <header>
        <button type="button" onClick={onClose} aria-label="返回"><ArrowLeft size={20} /></button>
        <strong>文字 / 多资料速记</strong>
        <button type="button" onClick={onClose} aria-label="关闭"><X size={20} /></button>
      </header>
      <section className="quick-material-form">
        <label><span>标题 <small>可选</small></span><input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} placeholder="例如：拉格朗日中值定理的构造思路" /></label>
        <label><span>正文 / 备注 <small>可只写文字</small></span><textarea value={remark} maxLength={8000} onChange={(event) => setRemark(event.target.value)} placeholder="直接记下想法、错因、结论或待解决问题……" /></label>
        <label><span>科目</span><select value={subject} onChange={(event) => setSubject(event.target.value)}>{SUBJECTS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <fieldset><legend>记录身份 <small>可多选</small></legend><div className="quick-material-facets">{FACETS.map((facet) => <button className={facets.includes(facet.id) ? 'active' : ''} key={facet.id} type="button" onClick={() => toggleFacet(facet.id)}>{facet.label}</button>)}</div></fieldset>
        <div className="quick-material-files">
          <div><span>资料附件</span><small>{files.length}/{MAX_FILES} · {formatBytes(totalBytes)}/16 MB</small></div>
          <button type="button" onClick={() => inputRef.current?.click()}><FilePlus2 size={17} />加入图片、PDF、Word、HTML 或文本</button>
          <input ref={inputRef} type="file" multiple hidden accept="image/*,.pdf,.doc,.docx,.html,.htm,.txt,.md" onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
          {files.length > 0 && <ul>{files.map((file, index) => <li key={`${file.name}:${file.size}:${file.lastModified}`}><Paperclip size={15} /><span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span><button type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`移除 ${file.name}`}><Trash2 size={15} /></button></li>)}</ul>}
        </div>
        {error && <p className="quick-material-error" role="alert">{error}</p>}
        <footer><button type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary" type="button" onClick={() => void submit()} disabled={saving}>{saving ? <LoaderCircle size={17} /> : <Save size={17} />}{saving ? '正在保存…' : '保存到学习中心'}</button></footer>
      </section>
    </main>
  );
}
`;
write('outputs/kaoyan-schedule-app/src/components/QuickMaterialComposer.tsx', composer);

const composerCss = `.quick-material-composer{min-height:100vh;background:#f5f6f8;color:#18202a;display:flex;flex-direction:column}.quick-material-composer>header{height:54px;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;padding:0 8px;border-bottom:1px solid #e2e5e9;background:#fff;position:sticky;top:0;z-index:2}.quick-material-composer>header strong{text-align:center;font-size:16px}.quick-material-composer button{font:inherit}.quick-material-composer>header button{border:0;background:transparent;width:40px;height:40px;border-radius:12px;display:grid;place-items:center}.quick-material-form{width:min(720px,100%);margin:0 auto;padding:20px;display:grid;gap:17px}.quick-material-form label{display:grid;gap:7px}.quick-material-form label>span,.quick-material-files>div>span,.quick-material-form legend{font-weight:700;font-size:14px}.quick-material-form small{font-weight:400;color:#737b86}.quick-material-form input,.quick-material-form textarea,.quick-material-form select{width:100%;box-sizing:border-box;border:1px solid #d8dce2;border-radius:12px;background:#fff;padding:12px 13px;color:inherit;font:inherit;outline:none}.quick-material-form textarea{min-height:150px;resize:vertical;line-height:1.6}.quick-material-form input:focus,.quick-material-form textarea:focus,.quick-material-form select:focus{border-color:#5b6fdf;box-shadow:0 0 0 3px rgba(91,111,223,.12)}.quick-material-form fieldset{border:0;padding:0;margin:0;display:grid;gap:8px}.quick-material-facets{display:flex;flex-wrap:wrap;gap:8px}.quick-material-facets button{border:1px solid #d7dbe2;border-radius:999px;background:#fff;padding:8px 13px}.quick-material-facets button.active{border-color:#596dde;background:#eef0ff;color:#3449b8;font-weight:700}.quick-material-files{display:grid;gap:10px;border:1px solid #dde1e7;border-radius:16px;background:#fff;padding:14px}.quick-material-files>div{display:flex;justify-content:space-between;gap:12px}.quick-material-files>button{border:1px dashed #aab2c0;background:#fafbfc;border-radius:12px;padding:13px;display:flex;align-items:center;justify-content:center;gap:8px}.quick-material-files ul{list-style:none;padding:0;margin:0;display:grid;gap:7px}.quick-material-files li{display:grid;grid-template-columns:20px 1fr 36px;gap:8px;align-items:center;padding:9px;border-radius:10px;background:#f5f6f8}.quick-material-files li span{min-width:0;display:grid}.quick-material-files li strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}.quick-material-files li button{border:0;background:transparent;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:#8b3b46}.quick-material-error{margin:0;color:#a12636;background:#fff0f2;border-radius:10px;padding:10px 12px}.quick-material-form>footer{display:flex;justify-content:flex-end;gap:10px}.quick-material-form>footer button,.quick-material-composer.is-saved button{border:1px solid #d4d8df;border-radius:11px;background:#fff;padding:11px 16px;display:flex;align-items:center;justify-content:center;gap:8px}.quick-material-form>footer .primary,.quick-material-composer.is-saved .primary{background:#5367d8;border-color:#5367d8;color:#fff;font-weight:700}.quick-material-form>footer button:disabled{opacity:.6}.quick-material-form>footer .primary svg{animation:none}.quick-material-form>footer .primary:disabled svg{animation:quick-material-spin .8s linear infinite}.quick-material-composer.is-saved{align-items:center;justify-content:center;text-align:center;padding:28px}.quick-material-composer.is-saved svg{color:#2e9a62}.quick-material-composer.is-saved h1{margin:14px 0 4px}.quick-material-composer.is-saved p{margin:0 0 20px;color:#6d7580}@keyframes quick-material-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.quick-material-form{padding:16px}.quick-material-form textarea{min-height:180px}.quick-material-form>footer{position:sticky;bottom:0;background:linear-gradient(transparent,#f5f6f8 22%);padding-top:24px}.quick-material-form>footer button{flex:1}}`;
write('outputs/kaoyan-schedule-app/quick-material-composer.css', composerCss);

let noteDrop = read('outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx');
noteDrop = replaceOnce(noteDrop, "  FileImage,\n", "  FileImage,\n  FilePlus2,\n", 'note drop material icon');
noteDrop = replaceOnce(noteDrop, "import { ImageCropEditor } from './ImageCropEditor';", "import { ImageCropEditor } from './ImageCropEditor';\nimport { QuickMaterialComposer } from './QuickMaterialComposer';", 'note drop composer import');
noteDrop = replaceOnce(noteDrop, "  const [batchProgress, setBatchProgress] = useState('');", "  const [batchProgress, setBatchProgress] = useState('');\n  const [materialOpen, setMaterialOpen] = useState(false);", 'note drop material state');
noteDrop = replaceOnce(noteDrop, "  if (isMobileCapture) {", "  if (materialOpen) {\n    return <QuickMaterialComposer onClose={() => setMaterialOpen(false)} onSaved={(message) => { setSaved(true); setStatus(message); }} />;\n  }\n\n  if (isMobileCapture) {", 'note drop composer branch');
noteDrop = replaceOnce(noteDrop, "              <button type=\"button\" onClick={() => void pasteFromClipboard()}>\n                <ClipboardPaste size={21} /><span><strong>粘贴图片</strong><small>使用刚复制的截图</small></span>\n              </button>", "              <button type=\"button\" onClick={() => void pasteFromClipboard()}>\n                <ClipboardPaste size={21} /><span><strong>粘贴图片</strong><small>使用刚复制的截图</small></span>\n              </button>\n              <button type=\"button\" onClick={() => setMaterialOpen(true)}>\n                <FilePlus2 size={21} /><span><strong>文字 / 多资料速记</strong><small>可附 PDF、Word、HTML 或多张图片</small></span>\n              </button>", 'mobile material action');
noteDrop = replaceOnce(noteDrop, "            <button type=\"button\" onClick={() => void pasteFromClipboard()}><ClipboardPaste size={15} /><span>粘贴</span></button>", "            <button type=\"button\" onClick={() => void pasteFromClipboard()}><ClipboardPaste size={15} /><span>粘贴</span></button>\n            <button type=\"button\" onClick={() => setMaterialOpen(true)}><FilePlus2 size={15} /><span>资料</span></button>", 'desktop material action');
write('outputs/kaoyan-schedule-app/src/components/NoteDropApp.tsx', noteDrop);

let learningCenter = read('outputs/kaoyan-schedule-app/src/components/LearningCenter.tsx');
learningCenter = replaceOnce(
  learningCenter,
  "const pageRefText = (note: LearningAutoNote): string => note.pageRefs\n  .map((ref) => ref.raw || [ref.page ? `p${ref.page}` : '', ref.question ?? ''].filter(Boolean).join(' '))\n  .filter(Boolean)\n  .join(' · ');",
  "const pageRefText = (note: LearningAutoNote): string => note.pageRefs\n  .map((ref) => ref.raw || [ref.page ? `p${ref.page}` : '', ref.question ?? ''].filter(Boolean).join(' '))\n  .filter(Boolean)\n  .join(' · ');\n\nconst noteAttachments = (note: LearningAutoNote) => note.attachments.length > 0\n  ? note.attachments\n  : note.filePath ? [{ id: 'legacy-primary', kind: 'image' as const, name: '原图', mimeType: 'image/jpeg', size: null, filePath: note.filePath, previewPath: '', posterPath: '', createdAt: note.createdAt }] : [];\nconst noteImageAttachment = (note: LearningAutoNote) => noteAttachments(note).find((attachment) => attachment.kind === 'image');\nconst noteFileUrl = (filePath: string): string => `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(filePath)}`;",
  'learning center attachment helpers',
);
learningCenter = replaceOnce(
  learningCenter,
  "  const noteViewerItems = (entries: IndexedNote[]): ImageViewerItem[] => entries\n    .filter(({ note }) => Boolean(note.filePath))\n    .map(({ note }) => ({\n      id: `note:${note.noteUid}`,\n      src: `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(note.filePath)}`,\n      alt: `${note.title || '笔记'}原图`,\n    }));",
  "  const noteViewerItems = (entries: IndexedNote[]): ImageViewerItem[] => entries.flatMap(({ note }) => noteAttachments(note)\n    .filter((attachment) => attachment.kind === 'image' && attachment.filePath)\n    .map((attachment) => ({\n      id: `note:${note.noteUid}:${attachment.id}`,\n      src: noteFileUrl(attachment.filePath),\n      alt: `${note.title || '笔记'} · ${attachment.name}`,\n    })));",
  'learning center viewer items',
);
learningCenter = replaceOnce(learningCenter, "    const index = items.findIndex((item) => item.id === `note:${note.noteUid}`);", "    const index = items.findIndex((item) => item.id.startsWith(`note:${note.noteUid}:`));", 'learning center viewer index');
learningCenter = replaceOnce(learningCenter, "      const noteUid = item.id.slice(5);", "      const noteUid = item.id.slice(5).split(':')[0];", 'learning center viewer uid');
learningCenter = replaceOnce(
  learningCenter,
  "    const thumbnailUrl = note.filePath\n      ? `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(note.filePath)}`\n      : '';",
  "    const thumbnailAttachment = noteImageAttachment(note);\n    const thumbnailUrl = thumbnailAttachment?.filePath ? noteFileUrl(thumbnailAttachment.filePath) : '';",
  'learning center thumbnail',
);
learningCenter = replaceOnce(
  learningCenter,
  "    const imageUrl = note.filePath ? `${NOTE_SERVER_URL}/note-file?path=${encodeURIComponent(note.filePath)}` : '';",
  "    const attachments = noteAttachments(note);\n    const imageAttachment = noteImageAttachment(note);\n    const imagePath = imageAttachment?.filePath || '';\n    const imageUrl = imagePath ? noteFileUrl(imagePath) : '';",
  'learning center detail attachment state',
);
learningCenter = replaceOnce(learningCenter, "    const sourcePreview = note.filePath ? (", "    const sourcePreview = imagePath ? (", 'learning center source preview condition');
learningCenter = learningCenter.replaceAll('failedImagePath !== note.filePath', 'failedImagePath !== imagePath');
learningCenter = learningCenter.replaceAll('setFailedImagePath(note.filePath)', 'setFailedImagePath(imagePath)');
learningCenter = learningCenter.replaceAll('failedImagePath === note.filePath', 'failedImagePath === imagePath');
learningCenter = replaceOnce(
  learningCenter,
  "        {sourcePreview}\n\n        <header className=\"lc-detail-heading\">",
  "        {sourcePreview}\n        {attachments.length > 0 && (\n          <section className=\"lc-attachments\" aria-label=\"资料附件\">\n            <div><h3>资料附件</h3><span>{attachments.length}</span></div>\n            <ul>{attachments.map((attachment) => (\n              <li key={attachment.id}>\n                <FileText size={17} aria-hidden=\"true\" />\n                <span><strong>{attachment.name}</strong><small>{attachment.kind === 'image' ? '图片' : attachment.kind === 'pdf' ? 'PDF' : attachment.kind === 'word' ? 'Word' : attachment.kind === 'html' ? 'HTML' : '文件'}{attachment.size ? ` · ${Math.max(1, Math.round(attachment.size / 1024))} KB` : ''}</small></span>\n                <a href={noteFileUrl(attachment.filePath)} download={attachment.name}><FileDown size={15} />打开 / 下载</a>\n              </li>\n            ))}</ul>\n          </section>\n        )}\n\n        <header className=\"lc-detail-heading\">",
  'learning center attachment section',
);
write('outputs/kaoyan-schedule-app/src/components/LearningCenter.tsx', learningCenter);

let learningCss = read('outputs/kaoyan-schedule-app/learning-center.css');
learningCss += `\n.lc-attachments{margin:0 0 18px;border:1px solid var(--lc-line,#e2e5e9);border-radius:14px;background:var(--lc-card,#fff);overflow:hidden}.lc-attachments>div{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--lc-line,#e2e5e9)}.lc-attachments h3{margin:0;font-size:14px}.lc-attachments>div>span{min-width:24px;height:24px;border-radius:999px;background:#eef0f4;display:grid;place-items:center;font-size:12px}.lc-attachments ul{list-style:none;padding:7px;margin:0;display:grid;gap:4px}.lc-attachments li{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px;border-radius:10px}.lc-attachments li:hover{background:#f5f6f8}.lc-attachments li>span{min-width:0;display:grid}.lc-attachments li strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lc-attachments li small{color:#747c87}.lc-attachments a{display:flex;align-items:center;gap:5px;border:1px solid #d7dbe2;border-radius:9px;padding:7px 9px;color:inherit;text-decoration:none;font-size:12px;white-space:nowrap}@media(max-width:720px){.lc-attachments li{grid-template-columns:22px minmax(0,1fr)}.lc-attachments a{grid-column:2;justify-self:start}}\n`;
write('outputs/kaoyan-schedule-app/learning-center.css', learningCss);

const mediaTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMaterialFile } from './media.js';

test('material decoder accepts PDF and preserves a safe filename', () => {
  const decoded = decodeMaterialFile({ name: '推导/证明.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' });
  assert.equal(decoded.kind, 'pdf');
  assert.equal(decoded.mime, 'application/pdf');
  assert.equal(decoded.fileName, '推导_证明.pdf');
  assert.ok(decoded.bytes.byteLength > 0);
});

test('material decoder rejects unsupported executable files', () => {
  assert.throws(() => decodeMaterialFile({ name: 'run.exe', dataUrl: 'data:application/octet-stream;base64,AA==' }), /not supported/i);
});
`;
write('outputs/kaoyan-schedule-app/cloudflare/media-material.test.mjs', mediaTest);

console.log('Multimaterial media and capture continuation applied.');
