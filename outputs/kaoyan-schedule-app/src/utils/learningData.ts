import type { DayRecord, RecordsByDate } from '../types';
import { NOTE_SERVER_URL } from './notes';
import { fetchWithTimeout } from './localService';

export type LearningCardStatus = 'draft' | 'active' | 'archived';
export type LearningCardKind = 'memory' | 'mistake';
export type LearningNoteOrganizationStatus = 'pending' | 'confirmed' | 'ignored';

export interface LearningPageRef {
  raw: string;
  page?: number;
  question?: string;
}

export interface LearningAutoNote {
  noteUid: string;
  capturedDate: string;
  title: string;
  subject: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
  firstSyncedAt: string;
  filePath: string;
  pageRefs: LearningPageRef[];
  tags: string[];
  knowledgePath: string[];
  noteType: string;
  questionType: string;
  wrongReason: string;
  organizationStatus: LearningNoteOrganizationStatus;
  items: Array<{
    title: string;
    knowledgePoint: string;
    questionType: string;
    summary: string;
    tags: string[];
    wrongReason: string;
    intent: {
      isQuestion: boolean;
      isMistake: boolean;
      shouldMemorize: boolean;
    };
  }>;
  confidence: number | null;
  cardIds: string[];
}

export interface LearningCard {
  id: string;
  noteUid: string;
  sourceKey: string;
  kind: LearningCardKind;
  front: string;
  back: string;
  subject: string;
  knowledgePath: string[];
  tags: string[];
  pageRefs: LearningPageRef[];
  sourceTitle: string;
  sourceFilePath: string;
  status: LearningCardStatus;
  dueDate: string;
  reviewStep: number;
  reviewCount: number;
  lastReviewedAt: string;
  lastReviewResult: '' | 'remembered' | 'forgotten';
  createdAt: string;
  updatedAt: string;
  userEdited: boolean;
}

export interface LearningDay {
  manual: DayRecord;
  autoNotes: LearningAutoNote[];
}

export interface LearningDataSnapshot {
  version: number;
  revision: number;
  updatedAt: string | null;
  days: Record<string, LearningDay>;
  cards: LearningCard[];
}

const LEARNING_DATA_CACHE_KEY = 'kaoyan-learning-data-v1';
const LEARNING_PENDING_RECORDS_KEY = 'kaoyan-learning-pending-records-v1';
const LEARNING_PENDING_REPLACE_KEY = 'kaoyan-learning-pending-replace-v1';
const LEARNING_DATA_EVENT = 'kaoyan-learning-data-changed';
const LEARNING_DATA_EVENTS_URL = `${NOTE_SERVER_URL}/learning-data/events`;

const emptyRecord = (): DayRecord => ({
  completedTaskIds: [],
  note: '',
  debt: '',
  mistakes: '',
});

export const emptyLearningData = (): LearningDataSnapshot => ({
  version: 1,
  revision: 0,
  updatedAt: null,
  days: {},
  cards: [],
});

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  : [];

const normalizeManual = (value: unknown): DayRecord => {
  const source = isObject(value) ? value : {};
  return {
    completedTaskIds: strings(source.completedTaskIds),
    note: typeof source.note === 'string' ? source.note : '',
    debt: typeof source.debt === 'string' ? source.debt : '',
    mistakes: typeof source.mistakes === 'string' ? source.mistakes : '',
  };
};

const normalizePageRefs = (value: unknown): LearningPageRef[] => Array.isArray(value)
  ? value.filter(isObject).map((item) => ({
      raw: typeof item.raw === 'string' ? item.raw : '',
      ...(Number.isFinite(Number(item.page)) ? { page: Math.round(Number(item.page)) } : {}),
      ...(typeof item.question === 'string' && item.question ? { question: item.question } : {}),
    }))
  : [];

const normalizeAutoNote = (value: unknown): LearningAutoNote | null => {
  if (!isObject(value) || typeof value.noteUid !== 'string' || !value.noteUid) {
    return null;
  }
  const confidence = Number(value.confidence);
  const items = Array.isArray(value.items) ? value.items.filter(isObject).slice(0, 24).map((item) => ({
    title: typeof item.title === 'string' ? item.title : '',
    knowledgePoint: typeof item.knowledgePoint === 'string' ? item.knowledgePoint : '',
    questionType: typeof item.questionType === 'string' ? item.questionType : '',
    summary: typeof item.summary === 'string' ? item.summary : '',
    tags: strings(item.tags),
    wrongReason: typeof item.wrongReason === 'string' ? item.wrongReason : '',
    intent: {
      isQuestion: isObject(item.intent) && item.intent.isQuestion === true,
      isMistake: isObject(item.intent) && item.intent.isMistake === true,
      shouldMemorize: isObject(item.intent) && item.intent.shouldMemorize === true,
    },
  })) : [];
  return {
    noteUid: value.noteUid,
    capturedDate: typeof value.capturedDate === 'string' ? value.capturedDate : '',
    title: typeof value.title === 'string' ? value.title : '',
    subject: typeof value.subject === 'string' ? value.subject : '默认文件夹',
    remark: typeof value.remark === 'string' ? value.remark : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    firstSyncedAt: typeof value.firstSyncedAt === 'string' ? value.firstSyncedAt : '',
    filePath: typeof value.filePath === 'string' ? value.filePath : '',
    pageRefs: normalizePageRefs(value.pageRefs),
    tags: strings(value.tags),
    knowledgePath: strings(value.knowledgePath),
    noteType: typeof value.noteType === 'string' ? value.noteType : '',
    questionType: typeof value.questionType === 'string' ? value.questionType : '',
    wrongReason: typeof value.wrongReason === 'string' ? value.wrongReason : '',
    organizationStatus: value.organizationStatus === 'confirmed' || value.organizationStatus === 'ignored'
      ? value.organizationStatus
      : 'pending',
    items,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
    cardIds: strings(value.cardIds),
  };
};

const normalizeCard = (value: unknown): LearningCard | null => {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.noteUid !== 'string') {
    return null;
  }
  const status: LearningCardStatus = ['draft', 'active', 'archived'].includes(String(value.status))
    ? value.status as LearningCardStatus
    : 'draft';
  const reviewStep = Number(value.reviewStep);
  const reviewCount = Number(value.reviewCount);
  return {
    id: value.id,
    noteUid: value.noteUid,
    sourceKey: typeof value.sourceKey === 'string' ? value.sourceKey : '',
    kind: value.kind === 'mistake' ? 'mistake' : 'memory',
    front: typeof value.front === 'string' ? value.front : '',
    back: typeof value.back === 'string' ? value.back : '',
    subject: typeof value.subject === 'string' ? value.subject : '',
    knowledgePath: strings(value.knowledgePath),
    tags: strings(value.tags),
    pageRefs: normalizePageRefs(value.pageRefs),
    sourceTitle: typeof value.sourceTitle === 'string' ? value.sourceTitle : '',
    sourceFilePath: typeof value.sourceFilePath === 'string' ? value.sourceFilePath : '',
    status,
    dueDate: typeof value.dueDate === 'string' ? value.dueDate : '',
    reviewStep: Number.isInteger(reviewStep) ? Math.min(3, Math.max(0, reviewStep)) : 0,
    reviewCount: Number.isInteger(reviewCount) && reviewCount >= 0 ? reviewCount : 0,
    lastReviewedAt: typeof value.lastReviewedAt === 'string' ? value.lastReviewedAt : '',
    lastReviewResult: value.lastReviewResult === 'remembered' || value.lastReviewResult === 'forgotten'
      ? value.lastReviewResult
      : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    userEdited: Boolean(value.userEdited),
  };
};

export const normalizeLearningData = (value: unknown): LearningDataSnapshot => {
  if (!isObject(value)) {
    return emptyLearningData();
  }
  const days: Record<string, LearningDay> = {};
  if (isObject(value.days)) {
    Object.entries(value.days).forEach(([date, rawDay]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isObject(rawDay)) {
        return;
      }
      const autoNotes = Array.isArray(rawDay.autoNotes)
        ? rawDay.autoNotes.map(normalizeAutoNote).filter((note): note is LearningAutoNote => Boolean(note))
        : [];
      days[date] = {
        manual: normalizeManual(rawDay.manual),
        autoNotes: [...new Map(autoNotes.map((note) => [note.noteUid, note])).values()],
      };
    });
  }
  const cards = Array.isArray(value.cards)
    ? value.cards.map(normalizeCard).filter((card): card is LearningCard => Boolean(card))
    : [];
  return {
    version: Number.isFinite(Number(value.version)) ? Number(value.version) : 1,
    revision: Number.isInteger(Number(value.revision)) ? Number(value.revision) : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    days,
    cards: [...new Map(cards.map((card) => [card.id, card])).values()],
  };
};

const extractSnapshot = (payload: unknown): LearningDataSnapshot => {
  if (isObject(payload)) {
    if (isObject(payload.learningData)) {
      return normalizeLearningData(payload.learningData);
    }
    if (isObject(payload.data)) {
      return normalizeLearningData(payload.data);
    }
  }
  return normalizeLearningData(payload);
};

const requestSnapshot = async (url: string, init?: RequestInit): Promise<LearningDataSnapshot> => {
  const response = await fetchWithTimeout(url, { cache: 'no-store', ...init }, 4000);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(isObject(payload) && typeof payload.error === 'string' ? payload.error : `学习数据服务返回 ${response.status}`);
    Object.assign(error, { status: response.status, payload });
    throw error;
  }
  const snapshot = extractSnapshot(payload);
  saveLearningDataCache(snapshot);
  return snapshot;
};

export const fetchLearningData = (signal?: AbortSignal): Promise<LearningDataSnapshot> => requestSnapshot(
  `${NOTE_SERVER_URL}/learning-data`,
  { signal },
);

export const patchLearningDay = (
  date: string,
  manual: Partial<DayRecord>,
  expectedRevision?: number,
  options: { keepalive?: boolean } = {},
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/day`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ date, manual, expectedRevision }),
  keepalive: options.keepalive,
});

export const putLearningManualRecords = (
  records: RecordsByDate,
  mode: 'merge' | 'replace' = 'merge',
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/manual-records`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ records, mode, expectedRevision }),
});

export const patchLearningCard = (
  cardId: string,
  patch: Partial<Pick<LearningCard, 'front' | 'back' | 'status' | 'dueDate' | 'userEdited'>> & {
    reviewResult?: 'remembered' | 'forgotten';
  },
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/cards/${encodeURIComponent(cardId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ patch, expectedRevision }),
});

export const patchLearningNote = (
  noteUid: string,
  organizationStatus: Exclude<LearningNoteOrganizationStatus, 'pending'>,
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/notes/${encodeURIComponent(noteUid)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ patch: { organizationStatus }, expectedRevision }),
});

export const getManualRecords = (snapshot: LearningDataSnapshot): RecordsByDate => Object.fromEntries(
  Object.entries(snapshot.days).map(([date, day]) => [date, normalizeManual(day.manual)]),
);

const hasRecordContent = (record: DayRecord): boolean => record.completedTaskIds.length > 0
  || Boolean(record.note || record.debt || record.mistakes);

export const hasLearningContent = (snapshot: LearningDataSnapshot): boolean => snapshot.cards.length > 0
  || Object.values(snapshot.days).some((day) => day.autoNotes.length > 0 || hasRecordContent(day.manual));

export const readLearningDataCache = (): LearningDataSnapshot => {
  try {
    return normalizeLearningData(JSON.parse(window.localStorage.getItem(LEARNING_DATA_CACHE_KEY) ?? 'null'));
  } catch {
    return emptyLearningData();
  }
};

export const saveLearningDataCache = (snapshot: LearningDataSnapshot) => {
  const normalized = normalizeLearningData(snapshot);
  window.localStorage.setItem(LEARNING_DATA_CACHE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(LEARNING_DATA_EVENT, { detail: normalized }));
};

export const subscribeLearningDataCache = (callback: (snapshot: LearningDataSnapshot) => void) => {
  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    callback(normalizeLearningData(detail));
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== LEARNING_DATA_CACHE_KEY || !event.newValue) {
      return;
    }
    try {
      callback(normalizeLearningData(JSON.parse(event.newValue)));
    } catch {
      // Ignore a malformed cache update and keep the last usable snapshot.
    }
  };
  window.addEventListener(LEARNING_DATA_EVENT, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(LEARNING_DATA_EVENT, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
};

export const subscribeLearningDataFromServer = () => {
  if (!('EventSource' in window)) {
    return () => undefined;
  }
  const source = new EventSource(LEARNING_DATA_EVENTS_URL);
  const handleSnapshot = (event: MessageEvent<string>) => {
    try {
      saveLearningDataCache(normalizeLearningData(JSON.parse(event.data)));
    } catch {
      // Keep the last usable cache. EventSource reconnects automatically.
    }
  };
  source.addEventListener('learning-data', handleSnapshot as EventListener);
  return () => {
    source.removeEventListener('learning-data', handleSnapshot as EventListener);
    source.close();
  };
};

export const readPendingLearningRecords = (): RecordsByDate => {
  try {
    const value = JSON.parse(window.localStorage.getItem(LEARNING_PENDING_RECORDS_KEY) ?? '{}');
    if (!isObject(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .map(([date, record]) => [date, normalizeManual(record)]),
    );
  } catch {
    return {};
  }
};

export const queuePendingLearningRecord = (date: string, record: DayRecord) => {
  const replacement = readPendingLearningReplacement();
  if (replacement) {
    replacement[date] = normalizeManual(record);
    window.localStorage.setItem(LEARNING_PENDING_REPLACE_KEY, JSON.stringify(replacement));
    return;
  }
  const pending = readPendingLearningRecords();
  pending[date] = normalizeManual(record);
  window.localStorage.setItem(LEARNING_PENDING_RECORDS_KEY, JSON.stringify(pending));
};

export const readPendingLearningReplacement = (): RecordsByDate | null => {
  const raw = window.localStorage.getItem(LEARNING_PENDING_REPLACE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (!isObject(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .map(([date, record]) => [date, normalizeManual(record)]),
    );
  } catch {
    return {};
  }
};

export const queuePendingLearningReplacement = (records: RecordsByDate) => {
  const normalized = Object.fromEntries(
    Object.entries(records)
      .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .map(([date, record]) => [date, normalizeManual(record)]),
  );
  window.localStorage.setItem(LEARNING_PENDING_REPLACE_KEY, JSON.stringify(normalized));
  window.localStorage.removeItem(LEARNING_PENDING_RECORDS_KEY);
};

export const clearPendingLearningReplacement = () => {
  window.localStorage.removeItem(LEARNING_PENDING_REPLACE_KEY);
};

export const clearPendingLearningRecord = (date: string, expectedRecord?: DayRecord) => {
  const pending = readPendingLearningRecords();
  if (expectedRecord && pending[date] && JSON.stringify(pending[date]) !== JSON.stringify(normalizeManual(expectedRecord))) {
    return;
  }
  delete pending[date];
  if (Object.keys(pending).length === 0) {
    window.localStorage.removeItem(LEARNING_PENDING_RECORDS_KEY);
  } else {
    window.localStorage.setItem(LEARNING_PENDING_RECORDS_KEY, JSON.stringify(pending));
  }
};

export const recordsMissingFromSnapshot = (
  records: RecordsByDate,
  snapshot: LearningDataSnapshot,
): RecordsByDate => Object.fromEntries(
  Object.entries(records).filter(([date, record]) => (
    hasRecordContent(record)
    && (!snapshot.days[date] || !hasRecordContent(snapshot.days[date].manual))
  )),
);

export const defaultLearningRecord = emptyRecord;
