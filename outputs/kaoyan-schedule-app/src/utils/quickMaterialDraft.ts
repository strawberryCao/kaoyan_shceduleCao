import type { LearningRecordFacet } from './notes';
import { IS_CLOUD_RUNTIME } from './runtime';
import { openTransientBytes, sealTransientBytes, type EncryptedTransientBytes } from './captureUploadQueue';

const DATABASE_NAME = 'kaoyan-quick-material-draft';
const DATABASE_VERSION = 2;
const STORE_NAME = 'drafts';
const ACTIVE_DRAFT_KEY = 'active';

export interface QuickMaterialDraft {
  version: 1;
  title: string;
  remark: string;
  subject: string;
  facets: LearningRecordFacet[];
  files: File[];
  updatedAt: string;
}

interface EncryptedQuickMaterialDraft {
  version: 2;
  encryption: 'AES-GCM';
  metadata: EncryptedTransientBytes;
  files: EncryptedTransientBytes[];
  updatedAt: string;
}

let memoryDraft: QuickMaterialDraft | null = null;

const cloneDraft = (draft: QuickMaterialDraft): QuickMaterialDraft => ({
  ...draft,
  facets: [...draft.facets],
  files: [...draft.files],
});

const openDraftDatabase = (): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('速记草稿数据库无法打开。'));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
};

const runDraftRequest = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> => {
  const database = await openDraftDatabase();
  if (!database) return null;
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onerror = () => reject(request.error ?? new Error('速记草稿读写失败。'));
      request.onsuccess = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('速记草稿事务已中止。'));
    });
  } finally {
    database.close();
  }
};

const isDraft = (value: unknown): value is QuickMaterialDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<QuickMaterialDraft>;
  return draft.version === 1
    && typeof draft.title === 'string'
    && typeof draft.remark === 'string'
    && typeof draft.subject === 'string'
    && Array.isArray(draft.facets)
    && Array.isArray(draft.files);
};

const isEncryptedDraft = (value: unknown): value is EncryptedQuickMaterialDraft => {
  const draft = value as Partial<EncryptedQuickMaterialDraft> | null;
  return Boolean(draft && draft.version === 2 && draft.encryption === 'AES-GCM'
    && draft.metadata && Array.isArray(draft.files));
};

const encryptDraft = async (draft: QuickMaterialDraft): Promise<EncryptedQuickMaterialDraft> => {
  const metadata = await sealTransientBytes(
    'quick-material-metadata',
    ACTIVE_DRAFT_KEY,
    new TextEncoder().encode(JSON.stringify({
      title: draft.title,
      remark: draft.remark,
      subject: draft.subject,
      facets: draft.facets,
      updatedAt: draft.updatedAt,
      fileDescriptors: draft.files.map((file) => ({ name: file.name, type: file.type, lastModified: file.lastModified })),
    })),
  );
  const files = await Promise.all(draft.files.map(async (file, index) => sealTransientBytes(
    'quick-material-file', `${ACTIVE_DRAFT_KEY}:${index}`, await file.arrayBuffer(),
  )));
  return { version: 2, encryption: 'AES-GCM', metadata, files, updatedAt: draft.updatedAt };
};

const decryptDraft = async (draft: EncryptedQuickMaterialDraft): Promise<QuickMaterialDraft> => {
  const metadata = JSON.parse(new TextDecoder().decode(await openTransientBytes(
    'quick-material-metadata', ACTIVE_DRAFT_KEY, draft.metadata,
  ))) as Omit<QuickMaterialDraft, 'version' | 'files'> & {
    fileDescriptors?: Array<{ name?: string; type?: string; lastModified?: number }>;
  };
  const files = await Promise.all(draft.files.map(async (file, index) => new File([
    await openTransientBytes('quick-material-file', `${ACTIVE_DRAFT_KEY}:${index}`, file),
  ], metadata.fileDescriptors?.[index]?.name || `资料-${index + 1}`, {
    type: metadata.fileDescriptors?.[index]?.type || 'application/octet-stream',
    lastModified: metadata.fileDescriptors?.[index]?.lastModified || Date.now(),
  })));
  const { fileDescriptors: _fileDescriptors, ...plainMetadata } = metadata;
  return { version: 1, ...plainMetadata, files };
};

export const loadQuickMaterialDraft = async (): Promise<QuickMaterialDraft | null> => {
  try {
    const stored = await runDraftRequest<QuickMaterialDraft | EncryptedQuickMaterialDraft>('readonly', (store) => store.get(ACTIVE_DRAFT_KEY));
    const restored = isEncryptedDraft(stored) ? await decryptDraft(stored) : isDraft(stored) ? stored : null;
    if (restored) {
      memoryDraft = cloneDraft(restored);
      if (IS_CLOUD_RUNTIME && isDraft(stored)) {
        const encrypted = await encryptDraft(restored);
        await runDraftRequest('readwrite', (store) => store.put(encrypted, ACTIVE_DRAFT_KEY));
      }
      return cloneDraft(restored);
    }
  } catch {
    // Safari private mode and embedded browsers may reject IndexedDB.
  }
  return memoryDraft ? cloneDraft(memoryDraft) : null;
};

export const saveQuickMaterialDraft = async (draft: QuickMaterialDraft): Promise<void> => {
  memoryDraft = cloneDraft(draft);
  try {
    const stored = IS_CLOUD_RUNTIME ? await encryptDraft(draft) : draft;
    await runDraftRequest('readwrite', (store) => store.put(stored, ACTIVE_DRAFT_KEY));
  } catch {
    // Keep the in-memory copy so a component remount in this page remains lossless.
  }
};

export const clearQuickMaterialDraft = async (): Promise<void> => {
  memoryDraft = null;
  try {
    await runDraftRequest('readwrite', (store) => store.delete(ACTIVE_DRAFT_KEY));
  } catch {
    // A successfully saved note must not be reported as failed because draft cleanup failed.
  }
};
