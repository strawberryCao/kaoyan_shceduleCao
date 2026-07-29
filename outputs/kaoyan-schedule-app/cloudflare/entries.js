import { HttpError, sha256 } from './http.js';
import {
  commitFiles,
  getBranchHead,
  readFileMetadata,
  readJsonFile,
} from './github-store.js';
import { createLegacyNoteProjection } from './learning.js';
import { decodeMaterialFile } from './media.js';

const V2_ROOT = 'data/v2';
const INDEX_PATH = `${V2_ROOT}/index.json`;
const ENTRY_ROOT = `${V2_ROOT}/entries`;
const ASSET_RECORD_ROOT = `${V2_ROOT}/assets`;
const ASSET_BINARY_ROOT = 'data/assets';
const LEGACY_PATH = 'data/cloud/learning-data.json';
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SUBJECTS = new Set([
  '默认文件夹',
  '高等数学',
  '线性代数',
  '概率论',
  '数据结构',
  '计算机组成',
  '操作系统',
  '计算机网络',
  '英语',
  '政治',
]);
const FACETS = new Set(['mistake', 'good', 'memory', 'knowledge', 'method']);
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

function text(value, limit = Infinity) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function jsonFile(path, value) {
  return { path, content: `${JSON.stringify(value, null, 2)}\n` };
}

function entryPath(entryId) {
  return `${ENTRY_ROOT}/${entryId}.json`;
}

function assetRecordPath(assetId) {
  return `${ASSET_RECORD_ROOT}/${assetId}.json`;
}

function receiptPath(entryId) {
  return `${V2_ROOT}/receipts/create-entry/${entryId}.json`;
}

function normalizeEntryId(value) {
  const entryId = text(value, 160) || `entry-${crypto.randomUUID()}`;
  if (!ENTRY_ID_PATTERN.test(entryId)) {
    throw new HttpError(400, 'entryId must be path-safe ASCII.', 'INVALID_ENTRY_ID');
  }
  return entryId;
}

function normalizeSubject(value) {
  const subject = text(value, 120);
  return SUBJECTS.has(subject) ? subject : '默认文件夹';
}

function normalizeFacets(value) {
  return [...new Set(Array.isArray(value) ? value : [])]
    .filter((facet) => FACETS.has(facet));
}

function normalizeIndex(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schemaVersion: 2,
    revision: Math.max(0, Number(source.revision) || 0),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    entries: Array.isArray(source.entries) ? source.entries.filter((item) => item && typeof item === 'object') : [],
  };
}

function normalizeLegacy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {};
  source.version = Number(source.version) || 1;
  source.revision = Math.max(0, Number(source.revision) || 0);
  source.updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : null;
  source.days = source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {};
  source.cards = Array.isArray(source.cards) ? source.cards : [];
  source.deletedNotes = source.deletedNotes && typeof source.deletedNotes === 'object' && !Array.isArray(source.deletedNotes)
    ? source.deletedNotes
    : {};
  return source;
}

function shanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function legacyNoteType(entry) {
  if (entry.facets.includes('mistake')) return 'mistake';
  if (entry.facets.includes('memory')) return 'memory';
  if (entry.facets.includes('knowledge')) return 'knowledge';
  if (entry.facets.includes('method')) return 'method';
  return entry.kind === 'quick' ? 'quick' : 'note';
}

function upsertLegacyNote(snapshot, entry, timestamp) {
  for (const day of Object.values(snapshot.days)) {
    if (!Array.isArray(day?.autoNotes)) continue;
    const index = day.autoNotes.findIndex((note) => note?.noteUid === entry.entryId);
    if (index < 0) continue;
    const existing = day.autoNotes[index];
    day.autoNotes[index] = {
      ...existing,
      title: entry.title,
      subject: entry.subject,
      remark: entry.body,
      tags: entry.tags,
      facets: [...entry.facets, ...(entry.kind === 'quick' ? ['quick'] : [])],
      noteType: legacyNoteType(entry),
      goodQuestion: entry.facets.includes('good'),
      attachments: entry.assets.map((asset) => ({
        id: asset.assetId,
        kind: asset.kind,
        name: asset.originalFileName,
        mimeType: asset.mime,
        size: asset.size,
        filePath: `github://${asset.path}`,
        previewPath: '',
        posterPath: '',
        createdAt: asset.createdAt,
      })),
      filePath: entry.assets[0] ? `github://${entry.assets[0].path}` : '',
      updatedAt: timestamp,
    };
    snapshot.revision += 1;
    snapshot.updatedAt = timestamp;
    return snapshot;
  }
  const note = createLegacyNoteProjection({
    title: entry.title,
    subject: entry.subject,
    remark: entry.body,
    tags: entry.tags,
    facets: [...entry.facets, ...(entry.kind === 'quick' ? ['quick'] : [])],
    noteType: legacyNoteType(entry),
    goodQuestion: entry.facets.includes('good'),
    attachments: entry.assets.map((asset) => ({
      id: asset.assetId,
      kind: asset.kind,
      name: asset.originalFileName,
      mimeType: asset.mime,
      size: asset.size,
      filePath: `github://${asset.path}`,
      previewPath: '',
      posterPath: '',
      createdAt: asset.createdAt,
    })),
  }, entry.entryId, timestamp);
  note.capturedDate = entry.capturedDate;
  const day = snapshot.days[entry.capturedDate] && typeof snapshot.days[entry.capturedDate] === 'object'
    ? snapshot.days[entry.capturedDate]
    : { manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' }, autoNotes: [] };
  if (!Array.isArray(day.autoNotes)) day.autoNotes = [];
  day.autoNotes.push(note);
  snapshot.days[entry.capturedDate] = day;
  snapshot.revision += 1;
  snapshot.updatedAt = timestamp;
  return snapshot;
}

async function decodeAssets(files, timestamp) {
  if (files.length > MAX_FILES) throw new HttpError(400, 'Too many files.', 'TOO_MANY_NOTE_FILES');
  const decoded = files.map((file, index) => decodeMaterialFile(file, index));
  const totalBytes = decoded.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new HttpError(413, 'Files are too large in total.', 'PAYLOAD_TOO_LARGE');
  return Promise.all(decoded.map(async (file) => {
    const assetId = await sha256(file.bytes);
    const path = `${ASSET_BINARY_ROOT}/${assetId}.${file.extension}`;
    return {
      bytes: file.bytes,
      record: {
        schemaVersion: 2,
        assetId,
        sha256: assetId,
        mime: file.mime,
        originalFileName: file.fileName,
        size: file.bytes.byteLength,
        path,
        kind: file.kind,
        createdAt: timestamp,
      },
    };
  }));
}

function entrySummary(entry) {
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    title: entry.title,
    subject: entry.subject,
    facets: entry.facets,
    version: entry.version,
    state: entry.state,
    assetIds: entry.assets.map((asset) => asset.assetId),
    capturedDate: entry.capturedDate,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function renamedEntryAssets(assets, assetNames) {
  if (!assetNames || typeof assetNames !== 'object' || Array.isArray(assetNames)) return assets;
  return assets.map((asset) => {
    const requested = text(assetNames[asset.assetId], 120);
    if (!requested) return asset;
    const extension = asset.originalFileName.match(/\.[A-Za-z0-9]{1,10}$/)?.[0]
      || asset.path.match(/\.[A-Za-z0-9]{1,10}$/)?.[0]
      || '';
    const stem = requested
      .normalize('NFKC')
      .replace(/\.[A-Za-z0-9]{1,10}$/i, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 100);
    return stem ? { ...asset, originalFileName: `${stem}${extension.toLowerCase()}` } : asset;
  });
}

function createEntryValue(payload, entryId, assets, timestamp) {
  const body = typeof payload.body === 'string'
    ? payload.body.trim().slice(0, 8000)
    : typeof payload.remark === 'string' ? payload.remark.trim().slice(0, 8000) : '';
  const title = text(payload.title, 240)
    || body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120)
    || assets[0]?.originalFileName
    || '快速记录';
  const kind = payload.kind === 'note' ? 'note' : 'quick';
  return {
    schemaVersion: 2,
    entryId,
    kind,
    title,
    body,
    subject: normalizeSubject(payload.subject),
    facets: normalizeFacets(payload.facets),
    tags: [...new Set(Array.isArray(payload.tags) ? payload.tags.map((tag) => text(tag, 80)).filter(Boolean) : [])],
    assets,
    renditions: [],
    thoughts: [],
    version: 1,
    state: 'active',
    archivedAt: null,
    tombstone: null,
    capturedDate: /^\d{4}-\d{2}-\d{2}$/.test(payload.capturedDate) ? payload.capturedDate : shanghaiDate(new Date(timestamp)),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function createEntry(env, payload, options = {}) {
  const entryId = normalizeEntryId(payload.entryId ?? payload.noteUid);
  const timestamp = new Date().toISOString();
  const decodedAssets = await decodeAssets(Array.isArray(payload.files) ? payload.files : [], timestamp);
  const entry = createEntryValue(payload, entryId, decodedAssets.map((asset) => asset.record), timestamp);
  if (!entry.body && entry.assets.length === 0) {
    throw new HttpError(400, 'Text or at least one file is required.', 'EMPTY_ENTRY');
  }
  const requestHash = await sha256(JSON.stringify({
    entryId,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    subject: entry.subject,
    facets: entry.facets,
    tags: entry.tags,
    assets: entry.assets.map((asset) => ({ assetId: asset.assetId, name: asset.originalFileName, mime: asset.mime })),
  }));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const [existingEntry, existingReceipt, indexFile, legacyFile] = await Promise.all([
      readJsonFile(env, entryPath(entryId), { ref: head, allowMissing: true, maxBytes: 2 * 1024 * 1024 }),
      readJsonFile(env, receiptPath(entryId), { ref: head, allowMissing: true, maxBytes: 256 * 1024 }),
      readJsonFile(env, INDEX_PATH, { ref: head, allowMissing: true, maxBytes: 8 * 1024 * 1024 }),
      readJsonFile(env, LEGACY_PATH, { ref: head, allowMissing: true, maxBytes: 24 * 1024 * 1024 }),
    ]);
    if (existingReceipt) {
      if (existingReceipt.value?.requestHash !== requestHash) {
        throw new HttpError(409, 'entryId was already used for different content.', 'ENTRY_ID_REUSED');
      }
      return { ok: true, entry: existingEntry?.value, idempotentReplay: true };
    }
    if (existingEntry) throw new HttpError(409, 'Entry already exists.', 'ENTRY_ALREADY_EXISTS');

    const files = [];
    for (const asset of decodedAssets) {
      const [binaryExists, recordExists] = await Promise.all([
        readFileMetadata(env, asset.record.path, { ref: head, allowMissing: true }),
        readFileMetadata(env, assetRecordPath(asset.record.assetId), { ref: head, allowMissing: true }),
      ]);
      if (!binaryExists) files.push({ path: asset.record.path, content: asset.bytes });
      if (!recordExists) files.push(jsonFile(assetRecordPath(asset.record.assetId), asset.record));
    }
    const index = normalizeIndex(indexFile?.value);
    index.revision += 1;
    index.updatedAt = timestamp;
    index.entries = [
      entrySummary(entry),
      ...index.entries.filter((item) => item.entryId !== entryId),
    ];
    const learningData = upsertLegacyNote(normalizeLegacy(legacyFile?.value), entry, timestamp);
    const additionalFiles = typeof options.additionalFiles === 'function'
      ? await options.additionalFiles({ entry, timestamp, requestHash, head })
      : [];
    if (!Array.isArray(additionalFiles)) {
      throw new HttpError(500, 'Additional entry files are invalid.', 'ENTRY_COMMIT_INVALID');
    }
    files.push(
      jsonFile(entryPath(entryId), entry),
      jsonFile(INDEX_PATH, index),
      jsonFile(LEGACY_PATH, learningData),
      jsonFile(receiptPath(entryId), {
        schemaVersion: 2,
        operation: 'create-entry',
        entryId,
        requestHash,
        createdAt: timestamp,
      }),
      ...additionalFiles,
    );
    try {
      const commit = await commitFiles(env, {
        expectedHeadSha: head,
        message: `data: create entry ${entryId}`,
        files,
      });
      return {
        ok: true,
        entry,
        learningData,
        commitSha: commit.commitSha,
        idempotentReplay: false,
        additionalResult: typeof options.result === 'function' ? options.result({ entry, timestamp, requestHash }) : undefined,
      };
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'Entry changed while saving; retry.', 'ENTRY_REVISION_CONFLICT');
}

export async function listEntries(env) {
  const file = await readJsonFile(env, INDEX_PATH, { allowMissing: true, maxBytes: 8 * 1024 * 1024 });
  const index = normalizeIndex(file?.value);
  return {
    ok: true,
    schemaVersion: 2,
    revision: index.revision,
    updatedAt: index.updatedAt,
    entries: index.entries.filter((entry) => entry.state !== 'tombstoned'),
  };
}

export async function getEntry(env, entryId) {
  entryId = normalizeEntryId(entryId);
  const file = await readJsonFile(env, entryPath(entryId), { allowMissing: true, maxBytes: 2 * 1024 * 1024 });
  if (!file) throw new HttpError(404, 'Entry not found.', 'ENTRY_NOT_FOUND');
  return { ok: true, entry: file.value };
}

export async function getAssetRecord(env, assetId) {
  const normalized = text(assetId, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new HttpError(400, 'assetId must be a SHA-256 hash.', 'INVALID_ASSET_ID');
  }
  const file = await readJsonFile(env, assetRecordPath(normalized), { allowMissing: true, maxBytes: 256 * 1024 });
  if (!file) throw new HttpError(404, 'Asset not found.', 'ASSET_NOT_FOUND');
  return file.value;
}

export async function patchEntry(env, entryId, payload) {
  entryId = normalizeEntryId(entryId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const [entryFile, indexFile, legacyFile] = await Promise.all([
      readJsonFile(env, entryPath(entryId), { ref: head, allowMissing: true, maxBytes: 2 * 1024 * 1024 }),
      readJsonFile(env, INDEX_PATH, { ref: head, allowMissing: true, maxBytes: 8 * 1024 * 1024 }),
      readJsonFile(env, LEGACY_PATH, { ref: head, allowMissing: true, maxBytes: 24 * 1024 * 1024 }),
    ]);
    if (!entryFile) throw new HttpError(404, 'Entry not found.', 'ENTRY_NOT_FOUND');
    const current = entryFile.value;
    if (payload.expectedVersion !== undefined && Number(payload.expectedVersion) !== Number(current.version)) {
      throw new HttpError(409, 'Entry version conflict.', 'ENTRY_VERSION_CONFLICT', { actualVersion: current.version });
    }
    const timestamp = new Date().toISOString();
    const selectedAssets = Array.isArray(payload.assetIds)
      ? current.assets.filter((asset) => payload.assetIds.includes(asset.assetId))
      : current.assets;
    const entry = {
      ...current,
      title: payload.title === undefined ? current.title : text(payload.title, 240) || current.title,
      body: payload.body === undefined ? current.body : String(payload.body).trim().slice(0, 8000),
      subject: payload.subject === undefined ? current.subject : normalizeSubject(payload.subject),
      facets: payload.facets === undefined ? current.facets : normalizeFacets(payload.facets),
      tags: payload.tags === undefined ? current.tags : [...new Set((Array.isArray(payload.tags) ? payload.tags : []).map((tag) => text(tag, 80)).filter(Boolean))],
      assets: renamedEntryAssets(selectedAssets, payload.assetNames),
      version: Number(current.version) + 1,
      updatedAt: timestamp,
    };
    const index = normalizeIndex(indexFile?.value);
    index.revision += 1;
    index.updatedAt = timestamp;
    index.entries = index.entries.map((item) => item.entryId === entryId ? entrySummary(entry) : item);
    const learningData = upsertLegacyNote(normalizeLegacy(legacyFile?.value), entry, timestamp);
    try {
      const commit = await commitFiles(env, {
        expectedHeadSha: head,
        message: `data: update entry ${entryId}`,
        files: [
          jsonFile(entryPath(entryId), entry),
          jsonFile(INDEX_PATH, index),
          jsonFile(LEGACY_PATH, learningData),
        ],
      });
      return { ok: true, entry, learningData, commitSha: commit.commitSha };
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'Entry changed while saving; retry.', 'ENTRY_REVISION_CONFLICT');
}

export async function appendEntryAssets(env, entryId, payload) {
  entryId = normalizeEntryId(entryId);
  const timestamp = new Date().toISOString();
  const decodedAssets = await decodeAssets(Array.isArray(payload.files) ? payload.files : [], timestamp);
  if (decodedAssets.length < 1) throw new HttpError(400, 'At least one file is required.', 'EMPTY_ASSET_APPEND');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const [entryFile, indexFile, legacyFile] = await Promise.all([
      readJsonFile(env, entryPath(entryId), { ref: head, allowMissing: true, maxBytes: 2 * 1024 * 1024 }),
      readJsonFile(env, INDEX_PATH, { ref: head, allowMissing: true, maxBytes: 8 * 1024 * 1024 }),
      readJsonFile(env, LEGACY_PATH, { ref: head, allowMissing: true, maxBytes: 24 * 1024 * 1024 }),
    ]);
    if (!entryFile) throw new HttpError(404, 'Entry not found.', 'ENTRY_NOT_FOUND');
    const current = entryFile.value;
    const knownIds = new Set(current.assets.map((asset) => asset.assetId));
    const additions = decodedAssets.filter((asset, index, source) => (
      !knownIds.has(asset.record.assetId)
      && source.findIndex((candidate) => candidate.record.assetId === asset.record.assetId) === index
    ));
    if (current.assets.length + additions.length > MAX_FILES) {
      throw new HttpError(400, `Each entry supports at most ${MAX_FILES} files.`, 'TOO_MANY_NOTE_FILES');
    }
    if (additions.length === 0) {
      return { ok: true, entry: current, learningData: normalizeLegacy(legacyFile?.value), idempotentReplay: true };
    }

    const files = [];
    for (const asset of additions) {
      const [binaryExists, recordExists] = await Promise.all([
        readFileMetadata(env, asset.record.path, { ref: head, allowMissing: true }),
        readFileMetadata(env, assetRecordPath(asset.record.assetId), { ref: head, allowMissing: true }),
      ]);
      if (!binaryExists) files.push({ path: asset.record.path, content: asset.bytes });
      if (!recordExists) files.push(jsonFile(assetRecordPath(asset.record.assetId), asset.record));
    }
    const entry = {
      ...current,
      assets: [...current.assets, ...additions.map((asset) => asset.record)],
      version: Number(current.version) + 1,
      updatedAt: timestamp,
    };
    const index = normalizeIndex(indexFile?.value);
    index.revision += 1;
    index.updatedAt = timestamp;
    index.entries = index.entries.map((item) => item.entryId === entryId ? entrySummary(entry) : item);
    const learningData = upsertLegacyNote(normalizeLegacy(legacyFile?.value), entry, timestamp);
    files.push(
      jsonFile(entryPath(entryId), entry),
      jsonFile(INDEX_PATH, index),
      jsonFile(LEGACY_PATH, learningData),
    );
    try {
      const commit = await commitFiles(env, {
        expectedHeadSha: head,
        message: `data: append assets to entry ${entryId}`,
        files,
      });
      return {
        ok: true,
        entry,
        learningData,
        commitSha: commit.commitSha,
        idempotentReplay: false,
      };
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'Entry changed while appending assets; retry.', 'ENTRY_REVISION_CONFLICT');
}

export async function commitCaptureResults(env, input) {
  const jobId = text(input.jobId, 160);
  const parentEntryId = normalizeEntryId(input.parentEntryId);
  if (!ENTRY_ID_PATTERN.test(jobId)) throw new HttpError(400, 'Invalid capture job id.', 'INVALID_JOB_ID');
  const crops = Array.isArray(input.crops) ? input.crops.slice(0, 24) : [];
  if (crops.length < 1) throw new HttpError(422, 'No capture results were produced.', 'NO_CAPTURE_RESULTS');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await getBranchHead(env);
    const [parentFile, indexFile, legacyFile, jobFile] = await Promise.all([
      readJsonFile(env, entryPath(parentEntryId), { ref: head, allowMissing: true, maxBytes: 2 * 1024 * 1024 }),
      readJsonFile(env, INDEX_PATH, { ref: head, allowMissing: true, maxBytes: 8 * 1024 * 1024 }),
      readJsonFile(env, LEGACY_PATH, { ref: head, allowMissing: true, maxBytes: 24 * 1024 * 1024 }),
      readJsonFile(env, input.jobPath, { ref: head, allowMissing: true, maxBytes: 512 * 1024 }),
    ]);
    if (!parentFile || !jobFile) throw new HttpError(404, 'Capture job source was not found.', 'CAPTURE_SOURCE_NOT_FOUND');
    if (jobFile.value?.status === 'completed') return { ok: true, job: jobFile.value, idempotentReplay: true };
    const timestamp = new Date().toISOString();
    const index = normalizeIndex(indexFile?.value);
    const learningData = normalizeLegacy(legacyFile?.value);
    const files = [];
    const derivedEntries = [];
    const renditions = [];

    for (let indexValue = 0; indexValue < crops.length; indexValue += 1) {
      const crop = crops[indexValue];
      const bytes = crop.bytes instanceof Uint8Array ? crop.bytes : new Uint8Array(crop.bytes);
      const assetId = await sha256(bytes);
      const extension = text(crop.extension, 12).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
      const path = `${ASSET_BINARY_ROOT}/${assetId}.${extension}`;
      const asset = {
        schemaVersion: 2,
        assetId,
        sha256: assetId,
        mime: text(crop.mime, 160) || 'image/jpeg',
        originalFileName: `自动裁剪-${indexValue + 1}.${extension}`,
        size: bytes.byteLength,
        path,
        kind: 'image',
        createdAt: timestamp,
      };
      const childEntryId = `${parentEntryId}-q${String(indexValue + 1).padStart(2, '0')}`.slice(0, 160);
      const entry = {
        ...createEntryValue({
          kind: 'note',
          title: `第 ${indexValue + 1} 题（待确认）`,
          body: parentFile.value.body,
          subject: parentFile.value.subject,
          facets: parentFile.value.facets,
          tags: [...(parentFile.value.tags || []), 'AI多题拆分', '待确认'],
          capturedDate: parentFile.value.capturedDate,
        }, childEntryId, [asset], timestamp),
        source: {
          type: 'capture-workflow',
          batchId: input.batchId,
          jobId,
          parentEntryId,
          sourceAssetId: input.sourceAssetId,
          splitIndex: indexValue + 1,
        },
        review: {
          status: 'pending',
          reversible: true,
          region: input.regions?.[indexValue] || null,
        },
      };
      const [binaryExists, recordExists] = await Promise.all([
        readFileMetadata(env, path, { ref: head, allowMissing: true }),
        readFileMetadata(env, assetRecordPath(assetId), { ref: head, allowMissing: true }),
      ]);
      if (!binaryExists) files.push({ path, content: bytes });
      if (!recordExists) files.push(jsonFile(assetRecordPath(assetId), asset));
      files.push(jsonFile(entryPath(childEntryId), entry));
      derivedEntries.push(entry);
      renditions.push({
        renditionId: `crop-${assetId}`,
        kind: 'automatic-crop',
        assetId,
        entryId: childEntryId,
        region: input.regions?.[indexValue] || null,
        createdAt: timestamp,
      });
      upsertLegacyNote(learningData, entry, timestamp);
    }

    const parentEntry = {
      ...parentFile.value,
      renditions: [
        ...(Array.isArray(parentFile.value.renditions) ? parentFile.value.renditions.filter((item) => item?.kind !== 'automatic-crop') : []),
        ...renditions,
      ],
      version: Number(parentFile.value.version) + 1,
      updatedAt: timestamp,
    };
    index.revision += 1;
    index.updatedAt = timestamp;
    const derivedIds = new Set(derivedEntries.map((entry) => entry.entryId));
    index.entries = [
      ...derivedEntries.map(entrySummary),
      ...index.entries.map((item) => item.entryId === parentEntryId ? entrySummary(parentEntry) : item)
        .filter((item) => !derivedIds.has(item.entryId)),
    ];
    upsertLegacyNote(learningData, parentEntry, timestamp);
    const job = {
      ...jobFile.value,
      status: 'completed',
      progress: 100,
      message: `已生成 ${derivedEntries.length} 道待确认题目`,
      error: '',
      detectedCount: derivedEntries.length,
      resultEntryIds: derivedEntries.map((entry) => entry.entryId),
      updatedAt: timestamp,
      completedAt: timestamp,
    };
    files.push(
      jsonFile(entryPath(parentEntryId), parentEntry),
      jsonFile(INDEX_PATH, index),
      jsonFile(LEGACY_PATH, learningData),
      jsonFile(input.jobPath, job),
    );
    try {
      const commit = await commitFiles(env, {
        expectedHeadSha: head,
        message: `data: complete capture job ${jobId}`,
        files,
      });
      return { ok: true, job, entries: derivedEntries, commitSha: commit.commitSha, idempotentReplay: false };
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'GITHUB_REVISION_CONFLICT' || attempt === 3) throw error;
    }
  }
  throw new HttpError(409, 'Capture results changed while saving; retry.', 'CAPTURE_REVISION_CONFLICT');
}

export const ENTRY_STORAGE_PATHS = Object.freeze({
  index: INDEX_PATH,
  entries: ENTRY_ROOT,
  assets: ASSET_RECORD_ROOT,
});
