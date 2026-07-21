import type { DayRecord, RecordsByDate } from '../types';
import { NOTE_SERVER_URL } from './notes';
import { fetchWithTimeout } from './localService';

export type LearningCardStatus = 'draft' | 'active' | 'archived';
export type LearningCardKind = 'memory' | 'mistake';
export type LearningNoteOrganizationStatus = 'pending' | 'confirmed' | 'ignored';
export type LearningNoteClassificationSource = 'ai' | 'local' | 'manual';

export interface LearningStudyThought {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningReviewEntry {
  id: string;
  reviewedAt: string;
  result: 'remembered' | 'forgotten';
  thought: string;
}

export type LearningThoughtAction =
  | { action: 'add'; text: string }
  | { action: 'update'; id: string; text: string }
  | { action: 'delete'; id: string };

export interface LearningNotePatch {
  title?: string;
  remark?: string;
  tags?: string[];
  noteType?: string;
  subject?: string;
  knowledgePath?: string[];
  questionType?: string;
  wrongReason?: string;
  organizationStatus?: LearningNoteOrganizationStatus;
  goodQuestion?: boolean;
  thoughtAction?: LearningThoughtAction;
}

export interface LearningNoteCreateInput {
  noteUid?: string;
  capturedDate?: string;
  title: string;
  remark?: string;
  tags?: string[];
  noteType?: string;
  subject: string;
  knowledgePath?: string[];
  questionType?: string;
  wrongReason?: string;
  pageRefs?: LearningPageRef[];
  items?: LearningAutoNote['items'];
  createCard?: boolean;
  goodQuestion?: boolean;
}

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
  classificationSource: LearningNoteClassificationSource;
  manualCreated: boolean;
  userEditedFields: string[];
  goodQuestion: boolean | null;
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
      isGood: boolean;
      shouldMemorize: boolean;
    };
  }>;
  studyNotes: LearningStudyThought[];
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
  correctCount: number;
  incorrectCount: number;
  correctStreak: number;
  masteredAt: string;
  reviewHistory: LearningReviewEntry[];
  createdAt: string;
  updatedAt: string;
  userEdited: boolean;
}

export interface LearningCardCreateInput {
  noteUid: string;
  kind: LearningCardKind;
  front: string;
  back: string;
  subject?: string;
  knowledgePath?: string[];
  tags?: string[];
  pageRefs?: LearningPageRef[];
  sourceTitle?: string;
  status?: LearningCardStatus;
  dueDate?: string;
}

export interface DeletedLearningNote {
  deletedAt: string;
  note: LearningAutoNote;
  cards: LearningCard[];
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
  deletedNotes: Record<string, DeletedLearningNote>;
}

const LEARNING_DATA_CACHE_KEY = 'kaoyan-learning-data-v1';
const LEARNING_PENDING_RECORDS_KEY = 'kaoyan-learning-pending-records-v1';
const LEARNING_PENDING_REPLACE_KEY = 'kaoyan-learning-pending-replace-v1';
const LEARNING_DATA_EVENT = 'kaoyan-learning-data-changed';
const LEARNING_DATA_EVENTS_URL = `${NOTE_SERVER_URL}/learning-data/events`;
let lastLearningDataCacheKey: string | null = null;
let learningDataEventSource: EventSource | null = null;
let learningDataEventSubscribers = 0;
let learningDataPollSubscribers = 0;
let learningDataPollTimer: number | null = null;
let learningDataPollInFlight: Promise<unknown> | null = null;
let learningDataMemoryCache: LearningDataSnapshot | null = null;
let learningDataMemoryRaw: string | null = null;

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
  deletedNotes: {},
});

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  : [];
const DEFAULT_SUBJECT_NAMES = new Set(['默认文件夹', '未分类', '默认', '收件箱']);

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

const normalizeStudyNotes = (value: unknown): LearningStudyThought[] => Array.isArray(value)
  ? value.filter(isObject).slice(-200).map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `thought-${index}`,
      text: typeof item.text === 'string' ? item.text.slice(0, 4000) : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    })).filter((item) => item.text.trim())
  : [];

const normalizeReviewHistory = (value: unknown): LearningReviewEntry[] => Array.isArray(value)
  ? value.filter(isObject).slice(-200).map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `review-${index}`,
      reviewedAt: typeof item.reviewedAt === 'string' ? item.reviewedAt : '',
      result: item.result === 'forgotten' ? 'forgotten' as const : 'remembered' as const,
      thought: typeof item.thought === 'string' ? item.thought.slice(0, 4000) : '',
    }))
  : [];

const normalizeAutoNote = (value: unknown): LearningAutoNote | null => {
  if (!isObject(value) || typeof value.noteUid !== 'string' || !value.noteUid) {
    return null;
  }
  const confidence = Number(value.confidence);
  const filePath = typeof value.filePath === 'string' ? value.filePath : '';
  const rawSubject = typeof value.subject === 'string' ? value.subject : '默认文件夹';
  const pathParts = filePath.split(/[\\/]/).filter(Boolean);
  const fileSubject = pathParts.length > 1 ? pathParts[pathParts.length - 2].trim() : '';
  const inferredFromFile = value.classificationSource !== 'manual'
    && DEFAULT_SUBJECT_NAMES.has(rawSubject)
    && fileSubject
    && !DEFAULT_SUBJECT_NAMES.has(fileSubject)
    && fileSubject !== '.metadata'
    && fileSubject !== '笔记';
  const subject = inferredFromFile ? fileSubject : rawSubject;
  const rawKnowledgePath = strings(value.knowledgePath);
  const knowledgePath = inferredFromFile
    ? [subject, ...rawKnowledgePath.filter((item) => !DEFAULT_SUBJECT_NAMES.has(item) && item !== subject)].slice(0, 3)
    : rawKnowledgePath;
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
       isGood: isObject(item.intent) && item.intent.isGood === true,
       shouldMemorize: isObject(item.intent) && item.intent.shouldMemorize === true,
    },
  })) : [];
  return {
    noteUid: value.noteUid,
    capturedDate: typeof value.capturedDate === 'string' ? value.capturedDate : '',
    title: typeof value.title === 'string' ? value.title : '',
    subject,
    remark: typeof value.remark === 'string' ? value.remark : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    firstSyncedAt: typeof value.firstSyncedAt === 'string' ? value.firstSyncedAt : '',
    filePath,
    pageRefs: normalizePageRefs(value.pageRefs),
    tags: strings(value.tags),
    knowledgePath,
    noteType: typeof value.noteType === 'string' ? value.noteType : '',
    questionType: typeof value.questionType === 'string' ? value.questionType : '',
    wrongReason: typeof value.wrongReason === 'string' ? value.wrongReason : '',
    organizationStatus: inferredFromFile && value.organizationStatus !== 'ignored'
      ? 'confirmed'
      : value.organizationStatus === 'confirmed' || value.organizationStatus === 'ignored'
      ? value.organizationStatus
      : 'pending',
    classificationSource: inferredFromFile && value.classificationSource !== 'manual'
      ? 'local'
      : value.classificationSource === 'manual' || value.classificationSource === 'local'
      ? value.classificationSource
      : 'ai',
    manualCreated: value.manualCreated === true,
    userEditedFields: strings(value.userEditedFields),
    goodQuestion: typeof value.goodQuestion === 'boolean' ? value.goodQuestion : null,
    items,
    studyNotes: normalizeStudyNotes(value.studyNotes),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
    cardIds: strings(value.cardIds),
  };
};

const normalizeCard = (value: unknown): LearningCard | null => {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.noteUid !== 'string') {
    return null;
  }
  const storedStatus: LearningCardStatus = ['draft', 'active', 'archived'].includes(String(value.status))
    ? value.status as LearningCardStatus
    : 'active';
  const reviewStep = Number(value.reviewStep);
  const reviewCount = Number(value.reviewCount);
  const reviewHistory = normalizeReviewHistory(value.reviewHistory);
  const storedCorrectCount = Number(value.correctCount);
  const storedIncorrectCount = Number(value.incorrectCount);
  const storedCorrectStreak = Number(value.correctStreak);
  const front = typeof value.front === 'string' ? value.front : '';
  const back = typeof value.back === 'string' ? value.back : '';
  const subject = typeof value.subject === 'string' ? value.subject : '';
  const status: LearningCardStatus = storedStatus === 'draft'
    && front.trim()
    && back.trim()
    && !DEFAULT_SUBJECT_NAMES.has(subject.trim())
    ? 'active'
    : storedStatus;
  return {
    id: value.id,
    noteUid: value.noteUid,
    sourceKey: typeof value.sourceKey === 'string' ? value.sourceKey : '',
    kind: value.kind === 'mistake' ? 'mistake' : 'memory',
    front,
    back,
    subject,
    knowledgePath: strings(value.knowledgePath),
    tags: strings(value.tags),
    pageRefs: normalizePageRefs(value.pageRefs),
    sourceTitle: typeof value.sourceTitle === 'string' ? value.sourceTitle : '',
    sourceFilePath: typeof value.sourceFilePath === 'string' ? value.sourceFilePath : '',
    status,
    dueDate: typeof value.dueDate === 'string' ? value.dueDate : '',
    reviewStep: Number.isInteger(reviewStep) ? Math.min(5, Math.max(0, reviewStep)) : 0,
    reviewCount: Number.isInteger(reviewCount) && reviewCount >= 0 ? reviewCount : 0,
    lastReviewedAt: typeof value.lastReviewedAt === 'string' ? value.lastReviewedAt : '',
    lastReviewResult: value.lastReviewResult === 'remembered' || value.lastReviewResult === 'forgotten'
      ? value.lastReviewResult
      : '',
    correctCount: Number.isInteger(storedCorrectCount) && storedCorrectCount >= 0
      ? storedCorrectCount
      : reviewHistory.filter((entry) => entry.result === 'remembered').length,
    incorrectCount: Number.isInteger(storedIncorrectCount) && storedIncorrectCount >= 0
      ? storedIncorrectCount
      : reviewHistory.filter((entry) => entry.result === 'forgotten').length,
    correctStreak: Number.isInteger(storedCorrectStreak) && storedCorrectStreak >= 0 ? storedCorrectStreak : 0,
    masteredAt: typeof value.masteredAt === 'string' ? value.masteredAt : '',
    reviewHistory,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    userEdited: Boolean(value.userEdited),
  };
};

const normalizeDeletedNote = (noteUid: string, value: unknown): DeletedLearningNote | null => {
  if (!isObject(value)) return null;
  const note = normalizeAutoNote({ ...(isObject(value.note) ? value.note : {}), noteUid });
  if (!note) return null;
  const cards = Array.isArray(value.cards)
    ? value.cards
      .map((card) => normalizeCard({ ...(isObject(card) ? card : {}), noteUid }))
      .filter((card): card is LearningCard => Boolean(card))
    : [];
  return {
    deletedAt: typeof value.deletedAt === 'string' ? value.deletedAt : note.updatedAt || note.createdAt,
    note,
    cards: [...new Map(cards.map((card) => [card.id, card])).values()],
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
  const deletedNotes: Record<string, DeletedLearningNote> = {};
  if (isObject(value.deletedNotes)) {
    Object.entries(value.deletedNotes).forEach(([noteUid, deletedNote]) => {
      const normalized = normalizeDeletedNote(noteUid, deletedNote);
      if (normalized) deletedNotes[noteUid] = normalized;
    });
  }
  return {
    version: Number.isFinite(Number(value.version)) ? Number(value.version) : 1,
    revision: Number.isInteger(Number(value.revision)) ? Number(value.revision) : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    days,
    cards: [...new Map(cards.map((card) => [card.id, card])).values()],
    deletedNotes,
  };
};

const learningDataCacheKey = (snapshot: LearningDataSnapshot): string => (
  `${snapshot.version}:${snapshot.revision}:${snapshot.updatedAt ?? ''}`
);

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
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { cache: 'no-store', ...init }, 4000);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new Error(timedOut
      ? '本地笔记服务响应超时，请稍后重试。'
      : '本地笔记服务已断开，请重新启动考研桌面助手后重试。');
  }
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

export const createLearningNote = (
  input: LearningNoteCreateInput,
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/notes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ input, expectedRevision }),
});

export const deleteLearningNote = (
  noteUid: string,
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/notes/${encodeURIComponent(noteUid)}`, {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expectedRevision }),
});

export const restoreLearningNote = (
  noteUid: string,
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/notes/${encodeURIComponent(noteUid)}/restore`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expectedRevision }),
});

export const createLearningCard = (
  input: LearningCardCreateInput,
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/cards`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ input, expectedRevision }),
});

export const patchLearningCard = (
  cardId: string,
  patch: Partial<Pick<LearningCard, 'front' | 'back' | 'status' | 'dueDate' | 'userEdited'>> & {
    reviewResult?: 'remembered' | 'forgotten';
    reviewThought?: string;
  },
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/cards/${encodeURIComponent(cardId)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ patch, expectedRevision }),
});

export const deleteLearningCard = (
  cardId: string,
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/cards/${encodeURIComponent(cardId)}`, {
  method: 'DELETE',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ expectedRevision }),
});

export const patchLearningNote = (
  noteUid: string,
  patch: LearningNotePatch,
  expectedRevision?: number,
): Promise<LearningDataSnapshot> => requestSnapshot(`${NOTE_SERVER_URL}/learning-data/notes/${encodeURIComponent(noteUid)}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ patch, expectedRevision }),
});

export const getManualRecords = (snapshot: LearningDataSnapshot): RecordsByDate => Object.fromEntries(
  Object.entries(snapshot.days).map(([date, day]) => [date, normalizeManual(day.manual)]),
);

const hasRecordContent = (record: DayRecord): boolean => record.completedTaskIds.length > 0
  || Boolean(record.note || record.debt || record.mistakes);

export const hasLearningContent = (snapshot: LearningDataSnapshot): boolean => snapshot.cards.length > 0
  || Object.values(snapshot.days).some((day) => day.autoNotes.length > 0 || hasRecordContent(day.manual));

export const readLearningDataCache = (): LearningDataSnapshot => {
  const raw = window.localStorage.getItem(LEARNING_DATA_CACHE_KEY);
  if (learningDataMemoryCache && raw === learningDataMemoryRaw) {
    lastLearningDataCacheKey = learningDataCacheKey(learningDataMemoryCache);
    return learningDataMemoryCache;
  }
  try {
    const snapshot = normalizeLearningData(JSON.parse(raw ?? 'null'));
    learningDataMemoryCache = snapshot;
    learningDataMemoryRaw = raw;
    lastLearningDataCacheKey = learningDataCacheKey(snapshot);
    return snapshot;
  } catch {
    const snapshot = emptyLearningData();
    learningDataMemoryCache = snapshot;
    learningDataMemoryRaw = raw;
    lastLearningDataCacheKey = learningDataCacheKey(snapshot);
    return snapshot;
  }
};

export const saveLearningDataCache = (snapshot: LearningDataSnapshot) => {
  const normalized = normalizeLearningData(snapshot);
  const cacheKey = learningDataCacheKey(normalized);
  if (cacheKey === lastLearningDataCacheKey) {
    return;
  }
  lastLearningDataCacheKey = cacheKey;
  const raw = JSON.stringify(normalized);
  learningDataMemoryCache = normalized;
  learningDataMemoryRaw = raw;
  window.localStorage.setItem(LEARNING_DATA_CACHE_KEY, raw);
  window.dispatchEvent(new CustomEvent(LEARNING_DATA_EVENT, { detail: normalized }));
};

export const subscribeLearningDataCache = (callback: (snapshot: LearningDataSnapshot) => void) => {
  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    callback(detail === learningDataMemoryCache && learningDataMemoryCache
      ? learningDataMemoryCache
      : normalizeLearningData(detail));
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== LEARNING_DATA_CACHE_KEY || !event.newValue) {
      return;
    }
    try {
      const snapshot = event.newValue === learningDataMemoryRaw && learningDataMemoryCache
        ? learningDataMemoryCache
        : normalizeLearningData(JSON.parse(event.newValue));
      learningDataMemoryCache = snapshot;
      learningDataMemoryRaw = event.newValue;
      lastLearningDataCacheKey = learningDataCacheKey(snapshot);
      callback(snapshot);
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
  learningDataEventSubscribers += 1;
  if (!learningDataEventSource) {
    learningDataEventSource = new EventSource(LEARNING_DATA_EVENTS_URL);
    learningDataEventSource.addEventListener('learning-data', ((event: MessageEvent<string>) => {
      try {
        saveLearningDataCache(normalizeLearningData(JSON.parse(event.data)));
      } catch {
        // Keep the last usable cache. EventSource reconnects automatically.
      }
    }) as EventListener);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    learningDataEventSubscribers = Math.max(0, learningDataEventSubscribers - 1);
    if (learningDataEventSubscribers === 0 && learningDataEventSource) {
      learningDataEventSource.close();
      learningDataEventSource = null;
    }
  };
};

const refreshLearningDataCache = () => {
  if (learningDataPollInFlight) return learningDataPollInFlight;
  learningDataPollInFlight = fetchLearningData()
    .catch(() => undefined)
    .finally(() => {
      learningDataPollInFlight = null;
    });
  return learningDataPollInFlight;
};

export const subscribeLearningDataPolling = () => {
  learningDataPollSubscribers += 1;
  if (learningDataPollSubscribers === 1) {
    void refreshLearningDataCache();
    learningDataPollTimer = window.setInterval(() => {
      void refreshLearningDataCache();
    }, 15_000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    learningDataPollSubscribers = Math.max(0, learningDataPollSubscribers - 1);
    if (learningDataPollSubscribers === 0 && learningDataPollTimer !== null) {
      window.clearInterval(learningDataPollTimer);
      learningDataPollTimer = null;
    }
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
