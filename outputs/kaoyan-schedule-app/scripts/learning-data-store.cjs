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
const DEFAULT_SUBJECT_NAMES = new Set(['默认文件夹', '未分类', '默认', '收件箱']);

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
    deletedNotes: {},
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

function normalizeStudyNotes(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).slice(-200).map((item, index) => ({
    id: (asOptionalString(item.id) || `thought-${index}`).slice(0, 160),
    text: asString(item.text).slice(0, 4000),
    createdAt: asString(item.createdAt),
    updatedAt: asString(item.updatedAt),
  })).filter((item) => item.text.trim());
}

function normalizeReviewHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).slice(-200).map((item, index) => ({
    id: (asOptionalString(item.id) || `review-${index}`).slice(0, 160),
    reviewedAt: asString(item.reviewedAt),
    result: item.result === 'forgotten' ? 'forgotten' : 'remembered',
    thought: asString(item.thought).slice(0, 4000),
  }));
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
      isGood: item.intent?.isGood === true,
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
  const filePath = asString(value.filePath);
  const rawSubject = asString(value.subject, '默认文件夹');
  const fileSubject = filePath ? path.basename(path.dirname(filePath)).trim() : '';
  const inferredFromFile = value.classificationSource !== 'manual'
    && DEFAULT_SUBJECT_NAMES.has(rawSubject)
    && fileSubject
    && !DEFAULT_SUBJECT_NAMES.has(fileSubject)
    && !['.metadata', '笔记'].includes(fileSubject);
  const subject = inferredFromFile ? fileSubject : rawSubject;
  const rawKnowledgePath = uniqueStrings(value.knowledgePath);
  const knowledgePath = inferredFromFile
    ? [subject, ...rawKnowledgePath.filter((item) => !DEFAULT_SUBJECT_NAMES.has(item) && item !== subject)].slice(0, 3)
    : rawKnowledgePath;
  const organizationStatus = NOTE_ORGANIZATION_STATUSES.has(value.organizationStatus)
    ? value.organizationStatus
    : 'pending';
  return {
    noteUid,
    capturedDate: DATE_PATTERN.test(asString(value.capturedDate)) ? value.capturedDate : '',
    title: asString(value.title),
    subject,
    remark: asString(value.remark),
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
    firstSyncedAt: asString(value.firstSyncedAt),
    filePath,
    pageRefs: normalizePageRefs(value.pageRefs),
    tags: uniqueStrings(value.tags),
    knowledgePath,
    noteType: asString(value.noteType),
    questionType: asString(value.questionType),
    wrongReason: asString(value.wrongReason),
    wrongReasonSource: asString(value.wrongReasonSource),
    wrongReasonConfidence: Number.isFinite(Number(value.wrongReasonConfidence))
      ? Math.min(1, Math.max(0, Number(value.wrongReasonConfidence)))
      : null,
    organizationStatus: inferredFromFile && organizationStatus === 'pending' ? 'confirmed' : organizationStatus,
    classificationSource: ['ai', 'local', 'manual'].includes(value.classificationSource)
      ? inferredFromFile && value.classificationSource !== 'manual' ? 'local' : value.classificationSource
      : inferredFromFile ? 'local' : 'ai',
    manualCreated: value.manualCreated === true,
    userEditedFields: uniqueStrings(value.userEditedFields),
    goodQuestion: typeof value.goodQuestion === 'boolean' ? value.goodQuestion : null,
    items: normalizeLearningItems(value.items),
    studyNotes: normalizeStudyNotes(value.studyNotes),
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
  const reviewHistory = normalizeReviewHistory(value.reviewHistory);
  const correctCount = Number(value.correctCount);
  const incorrectCount = Number(value.incorrectCount);
  const correctStreak = Number(value.correctStreak);
  const front = asString(value.front);
  const back = asString(value.back);
  const subject = asString(value.subject);
  const storedStatus = CARD_STATUSES.has(value.status) ? value.status : 'active';
  const status = storedStatus === 'draft'
    && front.trim()
    && back.trim()
    && !DEFAULT_SUBJECT_NAMES.has(subject.trim())
    ? 'active'
    : storedStatus;
  return {
    id,
    noteUid,
    sourceKey: asString(value.sourceKey),
    kind: CARD_KINDS.has(value.kind) ? value.kind : 'memory',
    front,
    back,
    subject,
    knowledgePath: uniqueStrings(value.knowledgePath),
    tags: uniqueStrings(value.tags),
    pageRefs: normalizePageRefs(value.pageRefs),
    sourceTitle: asString(value.sourceTitle),
    sourceFilePath: asString(value.sourceFilePath),
    status,
    dueDate: DATE_PATTERN.test(asString(value.dueDate)) ? value.dueDate : '',
    reviewStep: Number.isInteger(reviewStep) ? Math.min(5, Math.max(0, reviewStep)) : 0,
    reviewCount: Number.isInteger(reviewCount) && reviewCount >= 0 ? reviewCount : 0,
    lastReviewedAt: asString(value.lastReviewedAt),
    lastReviewResult: ['remembered', 'forgotten'].includes(value.lastReviewResult) ? value.lastReviewResult : '',
    correctCount: Number.isInteger(correctCount) && correctCount >= 0
      ? correctCount
      : reviewHistory.filter((entry) => entry.result === 'remembered').length,
    incorrectCount: Number.isInteger(incorrectCount) && incorrectCount >= 0
      ? incorrectCount
      : reviewHistory.filter((entry) => entry.result === 'forgotten').length,
    correctStreak: Number.isInteger(correctStreak) && correctStreak >= 0 ? correctStreak : 0,
    masteredAt: asString(value.masteredAt),
    reviewHistory,
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

function normalizeDeletedNote(value, noteUid) {
  if (!isPlainObject(value)) return null;
  const note = normalizeAutoNote({ ...(isPlainObject(value.note) ? value.note : {}), noteUid });
  if (!note) return null;
  const cards = Array.isArray(value.cards)
    ? value.cards
      .map((card) => normalizeCard({ ...(isPlainObject(card) ? card : {}), noteUid }))
      .filter(Boolean)
    : [];
  return {
    deletedAt: asOptionalString(value.deletedAt) || note.updatedAt || note.createdAt,
    note,
    cards: [...new Map(cards.map((card) => [card.id, card])).values()],
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
  const deletedNotes = {};
  if (isPlainObject(value.deletedNotes)) {
    for (const [noteUid, deletedNote] of Object.entries(value.deletedNotes)) {
      const normalized = normalizeDeletedNote(deletedNote, noteUid);
      if (normalized) deletedNotes[noteUid] = normalized;
    }
  }

  const revision = Number(value.revision);
  return {
    version: LEARNING_DATA_VERSION,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    days,
    cards: dedupedCards,
    deletedNotes,
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
    if (snapshot.deletedNotes?.[noteUid]) {
      return snapshot;
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

    let existingNote = normalizeAutoNote(syncOptions.existingNote);
    for (const [date, dayValue] of Object.entries(snapshot.days)) {
      const day = normalizeDay(dayValue);
      const found = day.autoNotes.find((note) => note.noteUid === noteUid);
      if (found) {
        existingNote = found;
      }
      day.autoNotes = day.autoNotes.filter((note) => note.noteUid !== noteUid);
      snapshot.days[date] = day;
    }

    const resolvedSubject = existingNote?.classificationSource === 'manual'
      ? existingNote.subject
      : enrichment.subject ?? metadata.subject ?? existingNote?.subject ?? '';
    const cardsAreKnowledgeEligible = !DEFAULT_SUBJECT_NAMES.has(String(resolvedSubject).trim());
    const seenCardContent = new Set();
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
        subject: existingNote?.classificationSource === 'manual'
          ? existingNote.subject
          : card?.subject ?? enrichment.subject ?? metadata.subject,
        knowledgePath: existingNote?.classificationSource === 'manual'
          ? existingNote.knowledgePath
          : card?.knowledgePath ?? enrichment.knowledgePath,
        tags: card?.tags ?? enrichment.tags,
        pageRefs: card?.pageRefs ?? enrichment.pageRefs,
        sourceTitle: card?.sourceTitle ?? metadata.title,
        sourceFilePath: card?.sourceFilePath ?? metadata.filePath,
        status: card?.status === 'archived' ? 'archived' : cardsAreKnowledgeEligible ? 'active' : 'draft',
        dueDate: cardsAreKnowledgeEligible ? card?.dueDate ?? capturedDate : '',
        createdAt: card?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }).filter((card) => {
      if (!card || !card.front.trim() || !card.back.trim()) return false;
      const contentKey = `${card.kind}|${card.front.trim().toLocaleLowerCase('zh-CN')}`;
      if (seenCardContent.has(contentKey)) return false;
      seenCardContent.add(contentKey);
      return true;
    }).slice(0, 2);

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
          correctCount: previous?.correctCount ?? card.correctCount,
          incorrectCount: previous?.incorrectCount ?? card.incorrectCount,
          correctStreak: previous?.correctStreak ?? card.correctStreak,
          masteredAt: previous?.masteredAt || card.masteredAt,
          reviewHistory: previous?.reviewHistory ?? card.reviewHistory,
        });
      }
    }
    snapshot.cards = [...cardsById.values()];

    const cardIds = snapshot.cards.filter((card) => card.noteUid === noteUid).map((card) => card.id);
    const confidence = Number(enrichment.confidence);
    const userEditedFields = new Set(existingNote?.userEditedFields || []);
    const keepUserValue = (field, incoming, fallback) => (
      userEditedFields.has(field) ? existingNote?.[field] : incoming ?? fallback
    );
    const autoNote = normalizeAutoNote({
      ...existingNote,
      noteUid,
      capturedDate,
      title: keepUserValue('title', enrichment.title ?? metadata.title, existingNote?.title),
      subject: existingNote?.classificationSource === 'manual'
        ? existingNote.subject
        : enrichment.subject ?? metadata.subject ?? existingNote?.subject,
      remark: keepUserValue('remark', metadata.remark, existingNote?.remark),
      createdAt,
      updatedAt: timestamp,
      firstSyncedAt: existingNote?.firstSyncedAt || timestamp,
      filePath: metadata.filePath ?? existingNote?.filePath,
      pageRefs: enrichment.pageRefs ?? existingNote?.pageRefs,
      tags: keepUserValue('tags', enrichment.tags, existingNote?.tags),
      knowledgePath: existingNote?.classificationSource === 'manual'
        ? existingNote.knowledgePath
        : enrichment.knowledgePath ?? existingNote?.knowledgePath,
      noteType: keepUserValue('noteType', enrichment.noteType, existingNote?.noteType),
      questionType: existingNote?.classificationSource === 'manual'
        ? existingNote.questionType
        : enrichment.questionType ?? existingNote?.questionType,
      wrongReason: userEditedFields.has('wrongReason')
        ? existingNote?.wrongReason
        : enrichment.wrongReason ?? existingNote?.wrongReason,
      wrongReasonSource: userEditedFields.has('wrongReason')
        ? existingNote?.wrongReasonSource || (existingNote?.wrongReason ? 'manual' : 'manual_deleted')
        : enrichment.wrongReasonSource ?? existingNote?.wrongReasonSource,
      wrongReasonConfidence: userEditedFields.has('wrongReason')
        ? (existingNote?.wrongReason ? 1 : null)
        : enrichment.wrongReasonConfidence ?? existingNote?.wrongReasonConfidence,
      userEditedFields: [...userEditedFields],
      organizationStatus: resolveOrganizationStatus(
        enrichment.organizationStatus,
        existingNote?.organizationStatus,
      ),
      classificationSource: existingNote?.classificationSource === 'manual'
        ? 'manual'
        : enrichment.classificationSource ?? existingNote?.classificationSource ?? 'ai',
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
          existingNote: previous,
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
      for (const previous of previousNotes.values()) {
        if (!previous.manualCreated || snapshot.deletedNotes?.[previous.noteUid] || noteUids.has(previous.noteUid)) continue;
        const capturedDate = DATE_PATTERN.test(previous.capturedDate)
          ? previous.capturedDate
          : formatDateInTimeZone(previous.createdAt || timestamp, timeZone);
        const day = normalizeDay(snapshot.days[capturedDate]);
        day.autoNotes.push(previous);
        snapshot.days[capturedDate] = day;
        noteUids.add(previous.noteUid);
      }
      const liveNoteUids = new Set(Object.values(snapshot.days)
        .flatMap((day) => normalizeDay(day).autoNotes)
        .map((note) => note.noteUid));
      snapshot.cards = snapshot.cards.filter((card) => liveNoteUids.has(card.noteUid));
      return snapshot;
    }, mutationOptions);
  }

  function restoreSnapshot(value, mutationOptions = {}) {
    if (!isPlainObject(value)) throw new Error('Invalid learning data snapshot');
    const restored = normalizeSnapshot(value);
    return commit(() => restored, mutationOptions);
  }

  function findLiveNote(snapshot, noteUid) {
    for (const [date, dayValue] of Object.entries(snapshot.days)) {
      const day = normalizeDay(dayValue);
      const note = day.autoNotes.find((item) => item.noteUid === noteUid);
      if (note) return { date, day, note };
    }
    return null;
  }

  function learningError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function createNote(input, mutationOptions = {}) {
    if (!isPlainObject(input)) throw learningError('Invalid learning note input', 'INVALID_LEARNING_NOTE');
    return commit((snapshot) => {
      const noteUid = (asOptionalString(input.noteUid) || `note-${crypto.randomUUID()}`).slice(0, 160);
      if (snapshot.deletedNotes?.[noteUid]) {
        throw learningError(`Learning note is deleted: ${noteUid}`, 'NOTE_DELETED');
      }
      if (findLiveNote(snapshot, noteUid)) {
        throw learningError(`Learning note already exists: ${noteUid}`, 'NOTE_ALREADY_EXISTS');
      }
      const timestamp = now().toISOString();
      const capturedDate = DATE_PATTERN.test(asString(input.capturedDate))
        ? input.capturedDate
        : formatDateInTimeZone(timestamp, timeZone);
      const subject = asOptionalString(input.subject);
      if (!subject) throw learningError('Learning note subject is required', 'INVALID_LEARNING_NOTE');
      const knowledgePath = uniqueStrings(input.knowledgePath);
      const normalizedPath = [subject, ...knowledgePath.filter((item) => item !== subject)].slice(0, 3);
      const noteType = asString(input.noteType, 'note').trim().slice(0, 40) || 'note';
      const tags = uniqueStrings(input.tags);
      if (noteType === 'mistake' && !tags.includes('错题')) tags.push('错题');
      if (noteType === 'memory' && !tags.includes('背诵')) tags.push('背诵');
      let note = normalizeAutoNote({
        noteUid,
        capturedDate,
        title: asString(input.title).slice(0, 240),
        subject,
        remark: asString(input.remark).slice(0, 8000),
        createdAt: timestamp,
        updatedAt: timestamp,
        firstSyncedAt: timestamp,
        filePath: '',
        pageRefs: normalizePageRefs(input.pageRefs),
        tags,
        knowledgePath: normalizedPath,
        noteType,
        questionType: asString(input.questionType).slice(0, 60),
        wrongReason: asString(input.wrongReason).slice(0, 1000),
        organizationStatus: 'confirmed',
        classificationSource: 'manual',
        manualCreated: true,
        userEditedFields: [
          'title',
          'remark',
          'tags',
          'noteType',
          ...(asString(input.wrongReason).trim() ? ['wrongReason'] : []),
          ...(typeof input.goodQuestion === 'boolean' ? ['goodQuestion'] : []),
        ],
        wrongReasonSource: asString(input.wrongReason).trim() ? 'manual' : '',
        wrongReasonConfidence: asString(input.wrongReason).trim() ? 1 : null,
        goodQuestion: typeof input.goodQuestion === 'boolean' ? input.goodQuestion : null,
        items: normalizeLearningItems(input.items),
        confidence: null,
        cardIds: [],
      });
      if (input.createCard === true && (noteType === 'mistake' || noteType === 'memory')) {
        const sourceKey = 'manual:create';
        const card = normalizeCard({
          id: makeCardId(noteUid, sourceKey),
          noteUid,
          sourceKey,
          kind: noteType === 'mistake' ? 'mistake' : 'memory',
          front: note.title,
          back: note.remark,
          subject: note.subject,
          knowledgePath: note.knowledgePath,
          tags: note.tags,
          pageRefs: note.pageRefs,
          sourceTitle: note.title,
          sourceFilePath: '',
          status: 'active',
          dueDate: formatDateInTimeZone(timestamp, timeZone),
          createdAt: timestamp,
          updatedAt: timestamp,
          userEdited: true,
        });
        snapshot.cards.push(card);
        note = normalizeAutoNote({ ...note, cardIds: [card.id] });
      }
      const day = normalizeDay(snapshot.days[capturedDate]);
      day.autoNotes.push(note);
      snapshot.days[capturedDate] = day;
      return snapshot;
    }, mutationOptions);
  }

  function createCard(input, mutationOptions = {}) {
    if (!isPlainObject(input)) throw learningError('Invalid learning card input', 'INVALID_LEARNING_CARD');
    const noteUid = asOptionalString(input.noteUid);
    if (!noteUid) throw learningError('Learning card noteUid is required', 'INVALID_LEARNING_CARD');
    return commit((snapshot) => {
      const entry = findLiveNote(snapshot, noteUid);
      if (!entry) throw learningError(`Learning note not found: ${noteUid}`, 'NOTE_NOT_FOUND');
      const timestamp = now().toISOString();
      const sourceKey = (asOptionalString(input.sourceKey) || `manual:${crypto.randomUUID()}`).slice(0, 160);
      const cardId = (asOptionalString(input.id) || makeCardId(noteUid, sourceKey)).slice(0, 160);
      if (snapshot.cards.some((card) => card.id === cardId)) {
        throw learningError(`Learning card already exists: ${cardId}`, 'CARD_ALREADY_EXISTS');
      }
      const card = normalizeCard({
        id: cardId,
        noteUid,
        sourceKey,
        kind: CARD_KINDS.has(input.kind) ? input.kind : 'memory',
        front: asString(input.front).slice(0, 2000),
        back: asString(input.back).slice(0, 8000),
        subject: asOptionalString(input.subject) || entry.note.subject,
        knowledgePath: Array.isArray(input.knowledgePath) ? input.knowledgePath : entry.note.knowledgePath,
        tags: Array.isArray(input.tags) ? input.tags : entry.note.tags,
        pageRefs: Array.isArray(input.pageRefs) ? input.pageRefs : entry.note.pageRefs,
        sourceTitle: asOptionalString(input.sourceTitle) || entry.note.title,
        sourceFilePath: entry.note.filePath,
        status: input.status === 'archived' ? 'archived' : 'active',
        dueDate: DATE_PATTERN.test(asString(input.dueDate))
          ? input.dueDate
          : formatDateInTimeZone(timestamp, timeZone),
        createdAt: timestamp,
        updatedAt: timestamp,
        userEdited: true,
      });
      snapshot.cards.push(card);
      entry.day.autoNotes = entry.day.autoNotes.map((note) => note.noteUid === noteUid
        ? normalizeAutoNote({ ...note, cardIds: [...note.cardIds, card.id], updatedAt: timestamp })
        : note);
      snapshot.days[entry.date] = entry.day;
      return snapshot;
    }, mutationOptions);
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
      const nextCorrectCount = current.correctCount + (reviewResult === 'remembered' ? 1 : 0);
      const nextIncorrectCount = current.incorrectCount + (reviewResult === 'forgotten' ? 1 : 0);
      const nextCorrectStreak = reviewResult === 'remembered' ? current.correctStreak + 1 : 0;
      const mastered = reviewResult === 'remembered' && nextCorrectStreak >= 3;
      const baseInterval = reviewResult === 'remembered' ? [1, 3, 7, 14, 30, 60][current.reviewStep] : 1;
      const knownAttempts = nextCorrectCount + nextIncorrectCount;
      const errorRate = knownAttempts > 0 ? nextIncorrectCount / knownAttempts : 0;
      const difficultyPenalty = 1 + Math.min(3, nextIncorrectCount) * 0.45 + errorRate * 0.8;
      const intervalDays = reviewResult === 'remembered'
        ? Math.max(1, Math.round(baseInterval / difficultyPenalty))
        : 1;
      const reviewThought = asString(patch.reviewThought).trim().slice(0, 4000);
      const reviewPatch = reviewResult === null ? {} : {
        status: mastered ? 'archived' : 'active',
        dueDate: mastered ? '' : formatDateInTimeZone(new Date(now().getTime() + intervalDays * 86400000), timeZone),
        reviewStep: reviewResult === 'forgotten' ? 0 : Math.min(5, current.reviewStep + 1),
        reviewCount: current.reviewCount + 1,
        lastReviewedAt: timestamp,
        lastReviewResult: reviewResult,
        correctCount: nextCorrectCount,
        incorrectCount: nextIncorrectCount,
        correctStreak: nextCorrectStreak,
        masteredAt: mastered ? timestamp : reviewResult === 'forgotten' ? '' : current.masteredAt,
        reviewHistory: [...current.reviewHistory, {
          id: `review-${crypto.randomUUID()}`,
          reviewedAt: timestamp,
          result: reviewResult,
          thought: reviewThought,
        }].slice(-200),
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
      throw learningError('Invalid note update', 'INVALID_LEARNING_NOTE');
    }
    const hasOrganizationStatus = Object.hasOwn(patch, 'organizationStatus');
    if (hasOrganizationStatus && !NOTE_ORGANIZATION_STATUSES.has(patch.organizationStatus)) {
      throw learningError('Invalid note organization status', 'INVALID_LEARNING_NOTE');
    }
    const classificationKeys = ['subject', 'knowledgePath', 'questionType', 'wrongReason'];
    const contentKeys = ['title', 'remark', 'tags', 'noteType', 'goodQuestion'];
    const editableKeys = [...classificationKeys, ...contentKeys];
    const editsClassification = classificationKeys.some((key) => Object.hasOwn(patch, key));
    const thoughtAction = isPlainObject(patch.thoughtAction) ? patch.thoughtAction : null;
    const hasThoughtAction = Boolean(thoughtAction);
    if (!hasOrganizationStatus && !hasThoughtAction && !editableKeys.some((key) => Object.hasOwn(patch, key))) {
      throw learningError('Empty note update', 'INVALID_LEARNING_NOTE');
    }
    if (hasThoughtAction && !['add', 'update', 'delete'].includes(thoughtAction.action)) {
      throw learningError('Invalid study note action', 'INVALID_LEARNING_NOTE');
    }
    if (hasThoughtAction && thoughtAction.action !== 'add' && !asOptionalString(thoughtAction.id)) {
      throw learningError('Study note id is required', 'INVALID_LEARNING_NOTE');
    }
    if (hasThoughtAction && thoughtAction.action !== 'delete' && !asOptionalString(thoughtAction.text)) {
      throw learningError('Study note text is required', 'INVALID_LEARNING_NOTE');
    }
    const subject = Object.hasOwn(patch, 'subject') ? asOptionalString(patch.subject) : null;
    if (Object.hasOwn(patch, 'subject') && !subject) {
      throw learningError('Invalid note subject', 'INVALID_LEARNING_NOTE');
    }
    if (Object.hasOwn(patch, 'knowledgePath') && !Array.isArray(patch.knowledgePath)) {
      throw learningError('Invalid note knowledge path', 'INVALID_LEARNING_NOTE');
    }
    if (Object.hasOwn(patch, 'tags') && !Array.isArray(patch.tags)) {
      throw learningError('Invalid note tags', 'INVALID_LEARNING_NOTE');
    }
    if (Object.hasOwn(patch, 'goodQuestion') && typeof patch.goodQuestion !== 'boolean') {
      throw learningError('Invalid good question flag', 'INVALID_LEARNING_NOTE');
    }
    return commit((snapshot) => {
      let found = false;
      const timestamp = now().toISOString();
      let nextSubject = null;
      let nextKnowledgePath = null;
      for (const day of Object.values(snapshot.days)) {
        day.autoNotes = day.autoNotes.map((note) => {
          if (note.noteUid !== noteUid) return note;
          found = true;
          nextSubject = subject || note.subject;
          nextKnowledgePath = Object.hasOwn(patch, 'knowledgePath')
            ? uniqueStrings(patch.knowledgePath).slice(0, 3)
            : note.knowledgePath;
          if (nextKnowledgePath[0] !== nextSubject) {
            nextKnowledgePath = [nextSubject, ...nextKnowledgePath.filter((item) => item !== note.subject && item !== nextSubject)].slice(0, 3);
          }
          const userEditedFields = new Set(note.userEditedFields);
          const normalizedPatchValue = (key) => {
            if (key === 'knowledgePath' || key === 'tags') return JSON.stringify(uniqueStrings(patch[key]));
            if (key === 'goodQuestion') return String(patch[key] === true);
            return asString(patch[key]).trim();
          };
          const normalizedNoteValue = (key) => {
            if (key === 'knowledgePath' || key === 'tags') return JSON.stringify(note[key] || []);
            if (key === 'goodQuestion') return String(note[key] === true);
            return asString(note[key]).trim();
          };
          const changedEditableKeys = editableKeys.filter((key) => (
            Object.hasOwn(patch, key) && normalizedPatchValue(key) !== normalizedNoteValue(key)
          ));
          changedEditableKeys.forEach((key) => userEditedFields.add(key));
          let studyNotes = normalizeStudyNotes(note.studyNotes);
          if (thoughtAction?.action === 'add') {
            studyNotes = [...studyNotes, {
              id: `thought-${crypto.randomUUID()}`,
              text: asString(thoughtAction.text).trim().slice(0, 4000),
              createdAt: timestamp,
              updatedAt: timestamp,
            }].slice(-200);
          } else if (thoughtAction?.action === 'update') {
            const thoughtId = asString(thoughtAction.id);
            if (!studyNotes.some((item) => item.id === thoughtId)) {
              throw learningError(`Study note not found: ${thoughtId}`, 'STUDY_NOTE_NOT_FOUND');
            }
            studyNotes = studyNotes.map((item) => item.id === thoughtId
              ? { ...item, text: asString(thoughtAction.text).trim().slice(0, 4000), updatedAt: timestamp }
              : item);
          } else if (thoughtAction?.action === 'delete') {
            studyNotes = studyNotes.filter((item) => item.id !== asString(thoughtAction.id));
          }
          return normalizeAutoNote({
            ...note,
            ...(Object.hasOwn(patch, 'title') ? { title: asString(patch.title).slice(0, 240) } : {}),
            ...(Object.hasOwn(patch, 'remark') ? { remark: asString(patch.remark).slice(0, 8000) } : {}),
            ...(Object.hasOwn(patch, 'tags') ? { tags: uniqueStrings(patch.tags) } : {}),
            ...(Object.hasOwn(patch, 'noteType') ? { noteType: asString(patch.noteType).trim().slice(0, 40) || 'note' } : {}),
            ...(Object.hasOwn(patch, 'goodQuestion') ? { goodQuestion: patch.goodQuestion === true } : {}),
            ...(subject ? { subject } : {}),
            ...((subject || Object.hasOwn(patch, 'knowledgePath')) ? { knowledgePath: nextKnowledgePath } : {}),
            ...(Object.hasOwn(patch, 'questionType') ? { questionType: asString(patch.questionType).slice(0, 60) } : {}),
            ...(Object.hasOwn(patch, 'wrongReason') ? {
              wrongReason: asString(patch.wrongReason).slice(0, 500),
              ...(changedEditableKeys.includes('wrongReason') ? {
                wrongReasonSource: asString(patch.wrongReason).trim() ? 'manual' : 'manual_deleted',
                wrongReasonConfidence: asString(patch.wrongReason).trim() ? 1 : null,
              } : {}),
            } : {}),
            organizationStatus: hasOrganizationStatus
              ? patch.organizationStatus
              : editableKeys.some((key) => Object.hasOwn(patch, key)) ? 'confirmed' : note.organizationStatus,
            classificationSource: changedEditableKeys.some((key) => classificationKeys.includes(key)) ? 'manual' : note.classificationSource,
            userEditedFields: [...userEditedFields],
            studyNotes,
            updatedAt: timestamp,
          });
        });
      }
      if (!found) {
        const error = new Error(`Learning note not found: ${noteUid}`);
        error.code = 'NOTE_NOT_FOUND';
        throw error;
      }
      if (editableKeys.some((key) => Object.hasOwn(patch, key))) {
        snapshot.cards = snapshot.cards.map((card) => card.noteUid === noteUid
          ? normalizeCard({
              ...card,
              ...(editsClassification ? {
                subject: nextSubject || card.subject,
                knowledgePath: nextKnowledgePath || card.knowledgePath,
              } : {}),
              ...(Object.hasOwn(patch, 'title') ? { sourceTitle: asString(patch.title).slice(0, 240) } : {}),
              ...(Object.hasOwn(patch, 'tags') ? { tags: uniqueStrings(patch.tags) } : {}),
              updatedAt: timestamp,
            })
          : card);
      }
      return snapshot;
    }, mutationOptions);
  }

  function deleteNote(noteUid, mutationOptions = {}) {
    if (!asOptionalString(noteUid)) throw learningError('Invalid note id', 'INVALID_LEARNING_NOTE');
    return commit((snapshot) => {
      const entry = findLiveNote(snapshot, noteUid);
      if (!entry) throw learningError(`Learning note not found: ${noteUid}`, 'NOTE_NOT_FOUND');
      const deletedAt = now().toISOString();
      const cards = snapshot.cards.filter((card) => card.noteUid === noteUid);
      snapshot.deletedNotes[noteUid] = normalizeDeletedNote({
        deletedAt,
        note: { ...entry.note, updatedAt: deletedAt },
        cards,
      }, noteUid);
      entry.day.autoNotes = entry.day.autoNotes.filter((note) => note.noteUid !== noteUid);
      snapshot.days[entry.date] = entry.day;
      snapshot.cards = snapshot.cards.filter((card) => card.noteUid !== noteUid);
      return snapshot;
    }, mutationOptions);
  }

  function restoreNote(noteUid, mutationOptions = {}) {
    if (!asOptionalString(noteUid)) throw learningError('Invalid note id', 'INVALID_LEARNING_NOTE');
    return commit((snapshot) => {
      const deleted = normalizeDeletedNote(snapshot.deletedNotes?.[noteUid], noteUid);
      if (!deleted) throw learningError(`Deleted learning note not found: ${noteUid}`, 'NOTE_NOT_FOUND');
      if (findLiveNote(snapshot, noteUid)) {
        throw learningError(`Learning note already exists: ${noteUid}`, 'NOTE_ALREADY_EXISTS');
      }
      const timestamp = now().toISOString();
      const capturedDate = DATE_PATTERN.test(deleted.note.capturedDate)
        ? deleted.note.capturedDate
        : formatDateInTimeZone(deleted.note.createdAt || timestamp, timeZone);
      const restoredCards = deleted.cards.map((card) => normalizeCard({ ...card, updatedAt: timestamp }));
      const note = normalizeAutoNote({
        ...deleted.note,
        capturedDate,
        updatedAt: timestamp,
        cardIds: restoredCards.map((card) => card.id),
      });
      const day = normalizeDay(snapshot.days[capturedDate]);
      day.autoNotes = day.autoNotes.filter((item) => item.noteUid !== noteUid);
      day.autoNotes.push(note);
      snapshot.days[capturedDate] = day;
      const restoredIds = new Set(restoredCards.map((card) => card.id));
      snapshot.cards = snapshot.cards.filter((card) => !restoredIds.has(card.id));
      snapshot.cards.push(...restoredCards);
      delete snapshot.deletedNotes[noteUid];
      return snapshot;
    }, mutationOptions);
  }

  function deleteCard(cardId, mutationOptions = {}) {
    if (!asOptionalString(cardId)) {
      throw new Error('Invalid card id');
    }
    return commit((snapshot) => {
      if (!snapshot.cards.some((card) => card.id === cardId)) {
        throw learningError(`Learning card not found: ${cardId}`, 'CARD_NOT_FOUND');
      }
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
    createNote,
    updateNote,
    deleteNote,
    restoreNote,
    createCard,
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
