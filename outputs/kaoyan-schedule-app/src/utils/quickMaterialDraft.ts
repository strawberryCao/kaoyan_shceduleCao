import type { LearningRecordFacet } from './notes';

const DATABASE_NAME = 'kaoyan-quick-material-draft';
const DATABASE_VERSION = 1;
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

export const loadQuickMaterialDraft = async (): Promise<QuickMaterialDraft | null> => {
  try {
    const stored = await runDraftRequest<QuickMaterialDraft>('readonly', (store) => store.get(ACTIVE_DRAFT_KEY));
    if (isDraft(stored)) {
      memoryDraft = cloneDraft(stored);
      return cloneDraft(stored);
    }
  } catch {
    // Safari private mode and embedded browsers may reject IndexedDB.
  }
  return memoryDraft ? cloneDraft(memoryDraft) : null;
};

export const saveQuickMaterialDraft = async (draft: QuickMaterialDraft): Promise<void> => {
  memoryDraft = cloneDraft(draft);
  try {
    await runDraftRequest('readwrite', (store) => store.put(draft, ACTIVE_DRAFT_KEY));
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
