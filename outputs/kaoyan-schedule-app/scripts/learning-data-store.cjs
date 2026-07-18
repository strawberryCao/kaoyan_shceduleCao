const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unlinkFileIfExists } = require('./safe-file-ops.cjs');

const LEARNING_DATA_VERSION = 1;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CARD_STATUSES = new Set(['draft', 'active', 'archived']);
const CARD_KINDS = new Set(['memory', 'mistake']);
const NOTE_ORGANIZATION_STATUSES = new Set(['pending', 'confirmed', 'ignored']);

function resolveOrganizationStatus(incomingStatus, existingStatus) {
  const incoming = NOTE_ORGANIZATION_STATUSES.has(incomingStatus) ? incomingStatus : null;
  const existing = NOTE_ORGANIZATION_STATUSES.has(existingStatus) ? existingStatus : null;
  if (existing === 'confirmed' || existing === 'ignored') {
    return existing;
  }
  return incoming || existing || 'pending';
}

class LearningDataConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super(`Learning data revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = 'LearningDataConflictError';
    this.code = 'REVISION_CONFLICT';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function defaultManualRecord() {
  return {
    completedTaskIds: [],
    note: '',
    debt: '',
    mistakes: '',
  };
}

function defaultSnapshot() {
  return {
    version: LEARNING_DATA_VERSION,
    revision: 0,
    updatedAt: null,
    days: {},
    cards: [],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function normalizeManualRecord(value, fallback = defaultManualRecord()) {
  const source = isPlainObject(value) ? value : {};
  return {
    completedTaskIds: Array.isArray(source.completedTaskIds)
      ? uniqueStrings(source.completedTaskIds)
      : [...fallback.completedTaskIds],
    note: typeof source.note === 'string' ? source.note : fallback.note,
    debt: typeof source.debt === 'string' ? source.debt : fallback.debt,
    mistakes: typeof source.mistakes === 'string' ? source.mistakes : fallback.mistakes,
  };
}

function normalizePageRefs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isPlainObject)
    .map((item) => {
      const page = Number(item.page);
      return {
        raw: asString(item.raw).slice(0, 120),
        ...(Number.isFinite(page) && page > 0 ? { page: Math.round(page) } : {}),
        ...(asOptionalString(item.question) ? { question: asString(item.question).slice(0, 80) } : {}),
      };
    })
    .filter((item) => item.raw || item.page || item.question);
}

function normalizeLearningItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).slice(0, 24).map((item) => ({
    title: asString(item.title).slice(0, 120),
    knowledgePoint: asString(item.knowledgePoint).slice(0, 60),
    questionType: asString(item.questionType).slice(0, 60),
    summary: asString(item.summary).slice(0, 1000),
    tags: uniqueStrings(item.tags),
    wrongReason: asString(item.wrongReason).slice(0, 500),
    intent: {
      isQuestion: item.intent?.isQuestion === true,
      isMistake: item.intent?.isMistake === true,
      shouldMemorize: item.intent?.shouldMemorize === true,
    },
  }));
}

function normalizeAutoNote(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const noteUid = asOptionalString(value.noteUid);
  if (!noteUid) {
    return null;
  }

  const confidence = Number(value.confidence);
  return {
    noteUid,
    capturedDate: DATE_PATTERN.test(asString(value.capturedDate)) ? value.capturedDate : '',
    title: asString(value.title),
    subject: asString(value.subject, '默认文件夹'),
    remark: asString(value.remark),
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
    firstSyncedAt: asString(value.firstSyncedAt),
    filePath: asString(value.filePath),
    pageRefs: normalizePageRefs(value.pageRefs),
    tags: uniqueStrings(value.tags),
    knowledgePath: uniqueStrings(value.knowledgePath),
    noteType: asString(value.noteType),
    questionType: asString(value.questionType),
    wrongReason: asString(value.wrongReason),
    organizationStatus: NOTE_ORGANIZATION_STATUSES.has(value.organizationStatus)
      ? value.organizationStatus
      : 'pending',
    items: normalizeLearningItems(value.items),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null,
    cardIds: uniqueStrings(value.cardIds),
  };
}

function normalizeCard(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const id = asOptionalString(value.id);
  const noteUid = asOptionalString(value.noteUid);
  if (!id || !noteUid) {
    return null;
  }

  const reviewStep = Number(value.reviewStep);
  const reviewCount = Number(value.reviewCount);
  return {
    id,
    noteUid,
    sourceKey: asString(value.sourceKey),
    kind: CARD_KINDS.has(value.kind) ? value.kind : 'memory',
    front: asString(value.front),
    back: asString(value.back),
    subject: asString(value.subject),
    knowledgePath: uniqueStrings(value.knowledgePath),
    tags: uniqueStrings(value.tags),
    pageRefs: normalizePageRefs(value.pageRefs),
    sourceTitle: asString(value.sourceTitle),
    sourceFilePath: asString(value.sourceFilePath),
    status: CARD_STATUSES.has(value.status) ? value.status : 'draft',
    dueDate: DATE_PATTERN.test(asString(value.dueDate)) ? value.dueDate : '',
    reviewStep: Number.isInteger(reviewStep) ? Math.min(3, Math.max(0, reviewStep)) : 0,
    reviewCount: Number.isInteger(reviewCount) && reviewCount >= 0 ? reviewCount : 0,
    lastReviewedAt: asString(value.lastReviewedAt),
    lastReviewResult: ['remembered', 'forgotten'].includes(value.lastReviewResult) ? value.lastReviewResult : '',
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
    userEdited: Boolean(value.userEdited),
  };
}

function normalizeDay(value) {
  const source = isPlainObject(value) ? value : {};
  const autoNotes = Array.isArray(source.autoNotes)
    ? source.autoNotes.map(normalizeAutoNote).filter(Boolean)
    : [];
  const dedupedNotes = [...new Map(autoNotes.map((note) => [note.noteUid, note])).values()];
  return {
    manual: normalizeManualRecord(source.manual),
    autoNotes: dedupedNotes,
  };
}

function normalizeSnapshot(value) {
  if (!isPlainObject(value)) {
    return defaultSnapshot();
  }

  const days = {};
  if (isPlainObject(value.days)) {
    for (const [date, day] of Object.entries(value.days)) {
      if (DATE_PATTERN.test(date)) {
        days[date] = normalizeDay(day);
      }
    }
  }

  const cards = Array.isArray(value.cards)
    ? value.cards.map(normalizeCard).filter(Boolean)
    : [];
  const dedupedCards = [...new Map(cards.map((card) => [card.id, card])).values()];

  const revision = Number(value.revision);
  return {
    version: LEARNING_DATA_VERSION,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    days,
    cards: dedupedCards,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatDateInTimeZone(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date value');
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function makeCardId(noteUid, sourceKey) {
  const digest = crypto.createHash('sha256').update(`${noteUid}|${sourceKey}`).digest('hex').slice(0, 20);
  return `card-${digest}`;
}

function getNoteUid(metadata) {
  return asOptionalString(metadata?.noteUid)
    || asOptionalString(metadata?.learning?.noteUid)
    || asOptionalString(metadata?.uid);
}

function createLearningDataStore(options = {}) {
  const assistantRoot = options.assistantRoot
    || process.env.KAOYAN_ASSISTANT_ROOT
    || path.join(os.homedir(), 'Desktop', '考研桌面助手');
  const filePath = options.filePath || path.join(assistantRoot, 'learning-data.json');
  const backupPath = options.backupPath || `${filePath}.bak`;
  // The Desktop data folder can allow atomic replacements while still denying
  // deletion of a sibling lock file. Use the writable temp directory for the
  // lock, with a deterministic id so every writer of this data file shares it.
  const lockId = crypto.createHash('sha256')
    .update(path.resolve(filePath).toLowerCase())
    .digest('hex')
    .slice(0, 32);
  const lockPath = options.lockPath || path.join(os.tmpdir(), 'kaoyan-schedule-app-locks', `${lockId}.lock`);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;

  function readFile(candidatePath) {
    if (!fs.existsSync(candidatePath)) {
      return null;
    }
    try {
      return normalizeSnapshot(JSON.parse(fs.readFileSync(candidatePath, 'utf8')));
    } catch {
      return null;
    }
  }

  function readCurrent() {
    return readFile(filePath) || readFile(backupPath) || defaultSnapshot();
  }

  function removeStaleWriteLock() {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age <= 60_000) {
        return false;
      }
      unlinkFileIfExists(lockPath);
      return !fs.existsSync(lockPath);
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }

  function makeBusyError(cause) {
    const lockError = new Error('Learning data is busy; please retry');
    lockError.code = 'LEARNING_DATA_BUSY';
    if (cause) lockError.cause = cause;
    return lockError;
  }

  function acquireWriteLock() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = fs.openSync(lockPath, 'wx');
        let writeError = null;
        try {
          fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
        } catch (error) {
          writeError = error;
        } finally {
          fs.closeSync(descriptor);
        }
        if (writeError) {
          unlinkFileIfExists(lockPath);
          throw writeError;
        }
        return () => unlinkFileIfExists(lockPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (attempt === 0 && removeStaleWriteLock()) {
          continue;
        }
        throw makeBusyError(error);
      }
    }
    throw makeBusyError();
  }

  function writeAtomic(snapshot) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    try {
      fs.writeFileSync(tempPath, serialized, 'utf8');
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath);
      }
      fs.renameSync(tempPath, filePath);
    } finally {
      if (fs.existsSync(tempPath)) {
        unlinkFileIfExists(tempPath);
      }
    }
  }

  function assertRevision(snapshot, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null) {
      return;
    }
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected !== snapshot.revision) {
      throw new LearningDataConflictError(expectedRevision, snapshot.revision);
    }
  }

  function commit(mutator, mutationOptions = {}) {
    const releaseLock = acquireWriteLock();
    try {
      const current = readCurrent();
      assertRevision(current, mutationOptions.expectedRevision);
      const next = normalizeSnapshot(mutator(clone(current)) || current);
      next.revision = current.revision + 1;
      next.updatedAt = now().toISOString();
      writeAtomic(next);
      return clone(next);
    } finally {
      releaseLock();
    }
  }

  function getSnapshot() {
    return clone(readCurrent());
  }

  function upsertDayManual(date, patch, mutationOptions = {}) {
    if (!DATE_PATTERN.test(asString(date))) {
      throw new Error('Invalid learning day date');
    }
    if (!isPlainObject(patch)) {
      throw new Error('Invalid manual day patch');
    }

    return commit((snapshot) => {
      const day = normalizeDay(snapshot.days[date]);
      day.manual = normalizeManualRecord(patch, day.manual);
      snapshot.days[date] = day;
      return snapshot;
    }, mutationOptions);
  }

  function mergeManualRecords(records, mutationOptions = {}) {
    if (!isPlainObject(records)) {
      throw new Error('Invalid manual records payload');
    }

    return commit((snapshot) => {
      for (const [date, record] of Object.entries(records)) {
        if (!DATE_PATTERN.test(date) || !isPlainObject(record)) {
          continue;
        }
        const day = normalizeDay(snapshot.days[date]);
        day.manual = normalizeManualRecord(record, day.manual);
        snapshot.days[date] = day;
      }
      return snapshot;
    }, mutationOptions);
  }

  function replaceManualRecords(records, mutationOptions = {}) {
    if (!isPlainObject(records)) {
      throw new Error('Invalid manual records payload');
    }

    return commit((snapshot) => {
      for (const [date, dayValue] of Object.entries(snapshot.days)) {
        snapshot.days[date] = {
          ...normalizeDay(dayValue),
          manual: defaultManualRecord(),
        };
      }
      for (const [date, record] of Object.entries(records)) {
        if (!DATE_PATTERN.test(date) || !isPlainObject(record)) {
          continue;
        }
        const day = normalizeDay(snapshot.days[date]);
        day.manual = normalizeManualRecord(record);
        snapshot.days[date] = day;
      }
      return snapshot;
    }, mutationOptions);
  }

  function applyNoteSync(snapshot, metadata, syncOptions = {}, timestamp = now().toISOString()) {
    if (!isPlainObject(metadata)) {
      throw new Error('Invalid note metadata');
    }
    const noteUid = getNoteUid(metadata);
    if (!noteUid) {
      throw new Error('noteUid is required for idempotent learning-data sync');
    }
    const enrichment = isPlainObject(syncOptions.enrichment)
      ? syncOptions.enrichment
      : isPlainObject(metadata.learning) ? metadata.learning : {};
    const createdAt = asOptionalString(metadata.createdAt) || now().toISOString();
    const capturedDate = DATE_PATTERN.test(asString(enrichment.capturedDate))
      ? enrichment.capturedDate
      : formatDateInTimeZone(createdAt, timeZone);
    const incomingCards = Array.isArray(syncOptions.cards)
      ? syncOptions.cards
      : Array.isArray(enrichment.cards) ? enrichment.cards : [];

    let existingNote = null;
    for (const [date, dayValue] of Object.entries(snapshot.days)) {
      const day = normalizeDay(dayValue);
      const found = day.autoNotes.find((note) => note.noteUid === noteUid);
      if (found) {
        existingNote = found;
      }
      day.autoNotes = day.autoNotes.filter((note) => note.noteUid !== noteUid);
      snapshot.days[date] = day;
    }

    const generatedCards = incomingCards.map((card, index) => {
      const sourceKey = asOptionalString(card?.sourceKey)
        || asOptionalString(card?.cardKey)
        || `${CARD_KINDS.has(card?.kind) ? card.kind : 'memory'}:${index}`;
      const id = asOptionalString(card?.id) || makeCardId(noteUid, sourceKey);
      return normalizeCard({
        ...card,
        id,
        noteUid,
        sourceKey,
        subject: card?.subject ?? enrichment.subject ?? metadata.subject,
        knowledgePath: card?.knowledgePath ?? enrichment.knowledgePath,
        tags: card?.tags ?? enrichment.tags,
        pageRefs: card?.pageRefs ?? enrichment.pageRefs,
        sourceTitle: card?.sourceTitle ?? metadata.title,
        sourceFilePath: card?.sourceFilePath ?? metadata.filePath,
        status: card?.status ?? 'draft',
        createdAt: card?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }).filter(Boolean);

    const generatedCardIds = new Set(generatedCards.map((card) => card.id));
    snapshot.cards = snapshot.cards.filter((card) => (
      card.noteUid !== noteUid
      || generatedCardIds.has(card.id)
      || card.userEdited
      || card.status !== 'draft'
    ));
    const cardsById = new Map(snapshot.cards.map((card) => [card.id, normalizeCard(card)]).filter(([, card]) => card));
    for (const card of generatedCards) {
      const previous = cardsById.get(card.id);
      if (previous?.userEdited) {
        cardsById.set(card.id, {
          ...card,
          ...previous,
          sourceFilePath: card.sourceFilePath,
          sourceTitle: card.sourceTitle,
          subject: card.subject,
          knowledgePath: card.knowledgePath,
          tags: card.tags,
          pageRefs: card.pageRefs,
          updatedAt: previous.updatedAt,
        });
      } else {
        cardsById.set(card.id, {
          ...previous,
          ...card,
          createdAt: previous?.createdAt || card.createdAt,
          status: previous?.status || card.status,
          dueDate: previous?.dueDate || card.dueDate,
          reviewStep: previous?.reviewStep ?? card.reviewStep,
          reviewCount: previous?.reviewCount ?? card.reviewCount,
          lastReviewedAt: previous?.lastReviewedAt || card.lastReviewedAt,
          lastReviewResult: previous?.lastReviewResult || card.lastReviewResult,
        });
      }
    }
    snapshot.cards = [...cardsById.values()];

    const cardIds = snapshot.cards.filter((card) => card.noteUid === noteUid).map((card) => card.id);
    const confidence = Number(enrichment.confidence);
    const autoNote = normalizeAutoNote({
      ...existingNote,
      noteUid,
      capturedDate,
      title: enrichment.title ?? metadata.title ?? existingNote?.title,
      subject: enrichment.subject ?? metadata.subject ?? existingNote?.subject,
      remark: metadata.remark ?? existingNote?.remark,
      createdAt,
      updatedAt: timestamp,
      firstSyncedAt: existingNote?.firstSyncedAt || timestamp,
      filePath: metadata.filePath ?? existingNote?.filePath,
      pageRefs: enrichment.pageRefs ?? existingNote?.pageRefs,
      tags: enrichment.tags ?? existingNote?.tags,
      knowledgePath: enrichment.knowledgePath ?? existingNote?.knowledgePath,
      noteType: enrichment.noteType ?? existingNote?.noteType,
      questionType: enrichment.questionType ?? existingNote?.questionType,
      wrongReason: enrichment.wrongReason ?? existingNote?.wrongReason,
      organizationStatus: resolveOrganizationStatus(
        enrichment.organizationStatus,
        existingNote?.organizationStatus,
      ),
      items: enrichment.items ?? existingNote?.items,
      confidence: Number.isFinite(confidence) ? confidence : existingNote?.confidence,
      cardIds,
    });

    const targetDay = normalizeDay(snapshot.days[capturedDate]);
    targetDay.autoNotes.push(autoNote);
    snapshot.days[capturedDate] = targetDay;
    return snapshot;
  }

  function syncNote(metadata, syncOptions = {}) {
    return commit((snapshot) => applyNoteSync(snapshot, metadata, syncOptions), syncOptions);
  }

  function rebuildNoteIndex(entries, mutationOptions = {}) {
    if (!Array.isArray(entries)) {
      throw new Error('Invalid note index entries');
    }
    const deduped = new Map();
    for (const entry of entries) {
      const metadata = isPlainObject(entry?.metadata) ? entry.metadata : entry;
      if (!isPlainObject(metadata)) throw new Error('Invalid note index entry');
      const noteUid = getNoteUid(metadata);
      if (!noteUid) throw new Error('noteUid is required for note index rebuild');
      deduped.set(noteUid, {
        metadata,
        enrichment: isPlainObject(entry?.enrichment) ? entry.enrichment : metadata.learning,
        cards: Array.isArray(entry?.cards) ? entry.cards : metadata.learning?.cards,
      });
    }

    return commit((snapshot) => {
      const previousNotes = new Map();
      for (const [date, dayValue] of Object.entries(snapshot.days)) {
        const day = normalizeDay(dayValue);
        for (const note of day.autoNotes) previousNotes.set(note.noteUid, note);
        day.autoNotes = [];
        snapshot.days[date] = day;
      }
      const noteUids = new Set(deduped.keys());
      const timestamp = now().toISOString();
      for (const entry of deduped.values()) {
        const previous = previousNotes.get(getNoteUid(entry.metadata));
        applyNoteSync(snapshot, entry.metadata, {
          enrichment: {
            ...(entry.enrichment || {}),
            organizationStatus: resolveOrganizationStatus(
              entry.enrichment?.organizationStatus,
              previous?.organizationStatus,
            ),
          },
          cards: entry.cards,
        }, timestamp);
      }
      snapshot.cards = snapshot.cards.filter((card) => noteUids.has(card.noteUid));
      return snapshot;
    }, mutationOptions);
  }

  function restoreSnapshot(value, mutationOptions = {}) {
    if (!isPlainObject(value)) throw new Error('Invalid learning data snapshot');
    const restored = normalizeSnapshot(value);
    return commit(() => restored, mutationOptions);
  }

  function updateCard(cardId, patch, mutationOptions = {}) {
    if (!asOptionalString(cardId) || !isPlainObject(patch)) {
      throw new Error('Invalid card update');
    }
    return commit((snapshot) => {
      const index = snapshot.cards.findIndex((card) => card.id === cardId);
      if (index < 0) {
        const error = new Error(`Learning card not found: ${cardId}`);
        error.code = 'CARD_NOT_FOUND';
        throw error;
      }
      const current = normalizeCard(snapshot.cards[index]);
      const timestamp = now().toISOString();
      const reviewResult = ['remembered', 'forgotten'].includes(patch.reviewResult)
        ? patch.reviewResult
        : null;
      const intervalDays = reviewResult === 'forgotten'
        ? 1
        : reviewResult === 'remembered' ? [1, 3, 7, 14][current.reviewStep] : null;
      const reviewPatch = intervalDays === null ? {} : {
        dueDate: formatDateInTimeZone(new Date(now().getTime() + intervalDays * 86400000), timeZone),
        reviewStep: reviewResult === 'forgotten' ? 0 : Math.min(3, current.reviewStep + 1),
        reviewCount: current.reviewCount + 1,
        lastReviewedAt: timestamp,
        lastReviewResult: reviewResult,
      };
      const next = normalizeCard({
        ...current,
        ...patch,
        ...reviewPatch,
        id: current.id,
        noteUid: current.noteUid,
        createdAt: current.createdAt,
        updatedAt: timestamp,
        userEdited: patch.userEdited === undefined
          ? current.userEdited || Object.hasOwn(patch, 'front') || Object.hasOwn(patch, 'back')
          : Boolean(patch.userEdited),
      });
      snapshot.cards[index] = next;
      return snapshot;
    }, mutationOptions);
  }

  function updateNote(noteUid, patch, mutationOptions = {}) {
    if (!asOptionalString(noteUid) || !isPlainObject(patch)) {
      throw new Error('Invalid note update');
    }
    const organizationStatus = patch.organizationStatus;
    if (!NOTE_ORGANIZATION_STATUSES.has(organizationStatus)) {
      throw new Error('Invalid note organization status');
    }
    return commit((snapshot) => {
      let found = false;
      const timestamp = now().toISOString();
      for (const day of Object.values(snapshot.days)) {
        day.autoNotes = day.autoNotes.map((note) => {
          if (note.noteUid !== noteUid) return note;
          found = true;
          return normalizeAutoNote({ ...note, organizationStatus, updatedAt: timestamp });
        });
      }
      if (!found) {
        const error = new Error(`Learning note not found: ${noteUid}`);
        error.code = 'NOTE_NOT_FOUND';
        throw error;
      }
      return snapshot;
    }, mutationOptions);
  }

  function deleteCard(cardId, mutationOptions = {}) {
    if (!asOptionalString(cardId)) {
      throw new Error('Invalid card id');
    }
    return commit((snapshot) => {
      snapshot.cards = snapshot.cards.filter((card) => card.id !== cardId);
      for (const day of Object.values(snapshot.days)) {
        day.autoNotes = day.autoNotes.map((note) => ({
          ...note,
          cardIds: note.cardIds.filter((id) => id !== cardId),
        }));
      }
      return snapshot;
    }, mutationOptions);
  }

  // A crashed organizer or an older server can leave this file behind. Clear
  // only genuinely stale locks at startup; a live writer keeps its fresh lock.
  removeStaleWriteLock();

  return {
    filePath,
    backupPath,
    lockPath,
    getSnapshot,
    upsertDayManual,
    mergeManualRecords,
    replaceManualRecords,
    syncNote,
    rebuildNoteIndex,
    restoreSnapshot,
    updateNote,
    updateCard,
    deleteCard,
  };
}

module.exports = {
  LEARNING_DATA_VERSION,
  LearningDataConflictError,
  createLearningDataStore,
  defaultSnapshot,
  formatDateInTimeZone,
  makeCardId,
  normalizeSnapshot,
};
