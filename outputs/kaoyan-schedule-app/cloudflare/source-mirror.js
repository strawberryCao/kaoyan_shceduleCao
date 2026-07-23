import { readFile, readJsonFile, writeBinaryFile, writeJsonFile } from './github-store.js';

const ROOT = 'source-notes/普通笔记';
const META_ROOT = `${ROOT}/.metadata`;

function safeUid(value) {
  const uid = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(uid)) throw new Error('Invalid mirrored note uid');
  return uid;
}

function metadataPath(noteUid) {
  return `${META_ROOT}/${safeUid(noteUid)}.cloud-note.json`;
}

function sourceType(note, payload = {}) {
  if (payload.sourceType) return String(payload.sourceType).slice(0, 80);
  if (note.sourceType) return String(note.sourceType).slice(0, 80);
  return 'single-capture';
}

function mirrorMetadata(note, payload, fileName, timestamp) {
  return {
    schemaVersion: 1,
    origin: 'cloudflare',
    noteUid: safeUid(note.noteUid),
    sourceType: sourceType(note, payload),
    sourceBatchId: String(payload.sourceBatchId || note.sourceBatchId || '').slice(0, 160),
    sourceSplitIndex: Number(payload.sourceSplitIndex || note.sourceSplitIndex) || null,
    subject: '普通笔记',
    title: String(note.title || '').slice(0, 240),
    remark: String(note.remark || '').slice(0, 8000),
    tags: Array.isArray(note.tags) ? [...new Set(note.tags.filter((item) => typeof item === 'string'))].slice(0, 40) : [],
    noteType: String(note.noteType || 'note').slice(0, 40),
    fileName,
    createdAt: String(note.createdAt || timestamp),
    updatedAt: String(note.updatedAt || timestamp),
  };
}

export async function mirrorNewCloudImage(env, image, note, payload, timestamp) {
  const noteUid = safeUid(note.noteUid);
  const fileName = `${noteUid}.${image.extension}`;
  const imagePath = `${ROOT}/${fileName}`;
  const existing = await readFile(env, imagePath, { allowMissing: true, maxBytes: 20 * 1024 * 1024 });
  if (!existing) {
    await writeBinaryFile(env, imagePath, image.bytes, {
      createOnly: true,
      message: `data: mirror cloud note ${noteUid}`,
    });
  }
  await writeJsonFile(env, metadataPath(noteUid), mirrorMetadata(note, payload, fileName, timestamp), {
    message: `data: write cloud note metadata ${noteUid}`,
  });
  return { imagePath, metadataPath: metadataPath(noteUid), fileName };
}

export async function updateMirroredCloudNote(env, note) {
  const noteUid = safeUid(note.noteUid);
  const path = metadataPath(noteUid);
  const existing = await readJsonFile(env, path, { allowMissing: true, maxBytes: 256 * 1024 });
  if (!existing?.value || typeof existing.value !== 'object') return false;
  const current = existing.value;
  const next = {
    ...current,
    sourceType: sourceType(note, current),
    sourceBatchId: String(note.sourceBatchId || current.sourceBatchId || '').slice(0, 160),
    sourceSplitIndex: Number(note.sourceSplitIndex || current.sourceSplitIndex) || null,
    title: String(note.title || '').slice(0, 240),
    remark: String(note.remark || '').slice(0, 8000),
    tags: Array.isArray(note.tags) ? [...new Set(note.tags.filter((item) => typeof item === 'string'))].slice(0, 40) : [],
    noteType: String(note.noteType || 'note').slice(0, 40),
    updatedAt: String(note.updatedAt || new Date().toISOString()),
  };
  await writeJsonFile(env, path, next, {
    message: `data: update cloud note metadata ${noteUid}`,
  });
  return true;
}

export const SOURCE_MIRROR_PATHS = Object.freeze({ root: ROOT, metadata: META_ROOT });
