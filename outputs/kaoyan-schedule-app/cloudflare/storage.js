import { HttpError } from './http.js';
import {
  commitFiles,
  getBranchHead,
  readJsonFile,
  writeJsonFile,
} from './github-store.js';

const LEARNING_PATH = 'data/cloud/learning-data.json';
const RECEIPT_ROOT = 'data/cloud/receipts';
const APP_STATE_ROOT = 'data/cloud/app-state';

const EMPTY_SNAPSHOT = Object.freeze({
  version: 1,
  revision: 0,
  updatedAt: null,
  days: {},
  cards: [],
  deletedNotes: {},
});

// Retained as an empty compatibility export for older tests and imports.
export const SQL = Object.freeze({});

export function emptySnapshot() {
  return structuredClone(EMPTY_SNAPSHOT);
}

function normalizeSnapshot(value, revisionOverride) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: Number.isInteger(Number(revisionOverride ?? source.revision))
      ? Math.max(0, Number(revisionOverride ?? source.revision))
      : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    days: source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {},
    cards: Array.isArray(source.cards) ? source.cards : [],
    deletedNotes: source.deletedNotes && typeof source.deletedNotes === 'object' && !Array.isArray(source.deletedNotes)
      ? source.deletedNotes
      : {},
  };
}

function safeToken(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function receiptPath(scope, operationId) {
  return `${RECEIPT_ROOT}/${safeToken(scope)}/${safeToken(operationId)}.json`;
}

function appStatePath(key) {
  return `${APP_STATE_ROOT}/${safeToken(key)}.json`;
}

export async function readLearningState(env) {
  const file = await readJsonFile(env, LEARNING_PATH, { allowMissing: true, maxBytes: 24 * 1024 * 1024 });
  const snapshot = normalizeSnapshot(file?.value ?? EMPTY_SNAPSHOT);
  return { revision: snapshot.revision, snapshot };
}

export async function compareAndSwapLearningState(env, current, snapshot, updatedAt) {
  const currentRevision = typeof current === 'object' && current !== null
    ? Number(current.revision)
    : Number(current);
  const head = await getBranchHead(env);
  const latestFile = await readJsonFile(env, LEARNING_PATH, {
    ref: head,
    allowMissing: true,
    maxBytes: 24 * 1024 * 1024,
  });
  const latest = normalizeSnapshot(latestFile?.value ?? EMPTY_SNAPSHOT);
  if (latest.revision !== currentRevision) return null;
  const stored = normalizeSnapshot({
    ...snapshot,
    revision: currentRevision + 1,
    updatedAt,
  }, currentRevision + 1);
  try {
    await commitFiles(env, {
      expectedHeadSha: head,
      message: `cloud: update learning data to revision ${stored.revision}`,
      files: [{ path: LEARNING_PATH, content: `${JSON.stringify(stored, null, 2)}\n` }],
    });
    return stored;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'GITHUB_REVISION_CONFLICT') return null;
    throw error;
  }
}

// Schedule records already live inside the canonical learning snapshot, so no
// second storage write is required.
export async function mirrorScheduleRecords() {}

export async function readReceipt(env, scope, operationId) {
  const file = await readJsonFile(env, receiptPath(scope, operationId), {
    allowMissing: true,
    maxBytes: 256 * 1024,
  });
  if (!file?.value || typeof file.value !== 'object' || Array.isArray(file.value)) return null;
  const receipt = file.value;
  return {
    scope: String(receipt.scope ?? ''),
    operationId: String(receipt.operationId ?? ''),
    entityId: String(receipt.entityId ?? ''),
    requestHash: String(receipt.requestHash ?? ''),
    result: receipt.result ?? null,
    createdAt: String(receipt.createdAt ?? ''),
  };
}

export async function writeReceipt(env, receipt) {
  await writeJsonFile(env, receiptPath(receipt.scope, receipt.operationId), receipt, {
    createOnly: true,
    message: `cloud: record ${String(receipt.scope).slice(0, 60)} operation`,
  });
}

export async function readAppState(env, key) {
  const file = await readJsonFile(env, appStatePath(key), { allowMissing: true, maxBytes: 2 * 1024 * 1024 });
  if (!file?.value || typeof file.value !== 'object' || Array.isArray(file.value)) return null;
  const value = file.value;
  return {
    key: String(value.key ?? key),
    value: value.value ?? null,
    revision: Number(value.revision) || 0,
    updatedAt: String(value.updatedAt ?? ''),
  };
}

export async function writeAppState(env, key, value, revision, updatedAt) {
  await writeJsonFile(env, appStatePath(key), { key, value, revision, updatedAt }, {
    message: `cloud: update app state ${String(key).slice(0, 80)}`,
  });
}

export function resultChanges(result) {
  return Number(result?.changes ?? result?.meta?.changes ?? 0);
}

export const STORAGE_PATHS = Object.freeze({
  learning: LEARNING_PATH,
  receipts: RECEIPT_ROOT,
  appState: APP_STATE_ROOT,
});
