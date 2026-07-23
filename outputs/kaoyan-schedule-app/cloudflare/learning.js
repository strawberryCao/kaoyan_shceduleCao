import {
  compareAndSwapLearningState,
  mirrorScheduleRecords,
  readLearningState,
  readReceipt,
  writeReceipt,
} from './storage.js';
import { HttpError, sha256 } from './http.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MANUAL = Object.freeze({ completedTaskIds: [], note: '', debt: '', mistakes: '' });
const REVIEW_ACTIONS = new Set(['accept', 'correct', 'ignore']);
const HUMAN_REVIEW_STATUSES = new Set(['accepted', 'corrected', 'ignored']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, limit = Infinity) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function manualRecord(value, fallback = DEFAULT_MANUAL) {
  const source = isObject(value) ? value : {};
  return {
    completedTaskIds: Array.isArray(source.completedTaskIds)
      ? uniqueStrings(source.completedTaskIds)
      : [...fallback.completedTaskIds],
    note: typeof source.note === 'string' ? source.note : fallback.note,
    debt: typeof source.debt === 'string' ? source.debt : fallback.debt,
    mistakes: typeof source.mistakes === 'string' ? source.mistakes : fallback.mistakes,
  };
}

function dayRecord(value) {
  const source = isObject(value) ? value : {};
  return {
    manual: manualRecord(source.manual),
    autoNotes: Array.isArray(source.autoNotes) ? source.autoNotes : [],
  };
}

function shanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function assertExpectedRevision(expectedRevision, actualRevision) {
  if (expectedRevision === undefined || expectedRevision === null) return;
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected !== actualRevision) {
    throw new HttpError(409, `Learning data revision conflict: expected ${expectedRevision}, actual ${actualRevision}`, 'REVISION_CONFLICT', {
      expectedRevision,
      actualRevision,
    });
  }
}

export function findNote(snapshot, noteUid) {
  for (const [date, rawDay] of Object.entries(snapshot.days ?? {})) {
    const day = dayRecord(rawDay);
    const index = day.autoNotes.findIndex((note) => note?.noteUid === noteUid);
    if (index >= 0) return { date, day, index, note: day.autoNotes[index] };
  }
  return null;
}

async function mutateLearning(env, options, mutator) {
  const expectedRevision = options?.expectedRevision;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await readLearningState(env);
    assertExpectedRevision(expectedRevision, current.revision);
    const snapshot = structuredClone(current.snapshot);
    const outcome = await mutator(snapshot, current.revision);
    if (outcome?.noCommit === true) {
      return { snapshot: current.snapshot, outcome };
    }
    const updatedAt = new Date().toISOString();
    const stored = await compareAndSwapLearningState(env, current, snapshot, updatedAt);
    if (stored) {
      try {
        await mirrorScheduleRecords(env, stored, outcome?.touchedDates);
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'schedule_mirror_failed',
          revision: stored.revision,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return { snapshot: stored, outcome: outcome ?? {} };
    }
    const latest = await readLearningState(env);
    if (expectedRevision !== undefined && expectedRevision !== null) {
      assertExpectedRevision(expectedRevision, latest.revision);
    }
  }
  throw new HttpError(409, 'Learning data changed while saving; retry with the latest revision.', 'REVISION_CONFLICT');
}

export async function getLearningSnapshot(env) {
  return (await readLearningState(env)).snapshot;
}

export async function replaceLearningSnapshot(env, incoming, expectedRevision = 0) {
  if (!isObject(incoming)) throw new HttpError(400, 'snapshot is required', 'INVALID_LEARNING_DATA');
  const normalized = {
    version: Number.isFinite(Number(incoming.version)) ? Number(incoming.version) : 1,
    revision: 0,
    updatedAt: null,
    days: isObject(incoming.days) ? incoming.days : {},
    cards: Array.isArray(incoming.cards) ? incoming.cards : [],
    deletedNotes: isObject(incoming.deletedNotes) ? incoming.deletedNotes : {},
  };
  const result = await mutateLearning(env, { expectedRevision }, (snapshot) => {
    Object.assign(snapshot, structuredClone(normalized));
    return { touchedDates: Object.keys(normalized.days) };
  });
  return result.snapshot;
}

export async function patchDay(env, payload) {
  if (!DATE_PATTERN.test(text(payload.date))) {
    throw new HttpError(400, 'A valid YYYY-MM-DD date is required.', 'INVALID_LEARNING_DAY');
  }
  if (!isObject(payload.manual)) {
    throw new HttpError(400, 'manual must be an object.', 'INVALID_LEARNING_DAY');
  }
  return (await mutateLearning(env, payload, (snapshot) => {
    const day = dayRecord(snapshot.days[payload.date]);
    day.manual = manualRecord(payload.manual, day.manual);
    snapshot.days[payload.date] = day;
    return { touchedDates: [payload.date] };
  })).snapshot;
}

export async function putManualRecords(env, payload) {
  if (!isObject(payload.records)) {
    throw new HttpError(400, 'records must be an object.', 'INVALID_MANUAL_RECORDS');
  }
  return (await mutateLearning(env, payload, (snapshot) => {
    if (payload.mode === 'replace') {
      for (const [date, rawDay] of Object.entries(snapshot.days)) {
        snapshot.days[date] = { ...dayRecord(rawDay), manual: structuredClone(DEFAULT_MANUAL) };
      }
    }
    const touchedDates = [];
    for (const [date, record] of Object.entries(payload.records)) {
      if (!DATE_PATTERN.test(date) || !isObject(record)) continue;
      const day = dayRecord(snapshot.days[date]);
      day.manual = manualRecord(record, payload.mode === 'replace' ? DEFAULT_MANUAL : day.manual);
      snapshot.days[date] = day;
      touchedDates.push(date);
    }
    return { touchedDates: payload.mode === 'replace' ? Object.keys(snapshot.days) : touchedDates };
  })).snapshot;
}

function noteDefaults(input, noteUid, timestamp) {
  const subject = text(input.subject, 120).trim();
  if (!subject) throw new HttpError(400, 'Learning note subject is required.', 'INVALID_LEARNING_NOTE');
  const capturedDate = DATE_PATTERN.test(text(input.capturedDate)) ? input.capturedDate : shanghaiDate(new Date(timestamp));
  const knowledgePath = [subject, ...uniqueStrings(input.knowledgePath).filter((item) => item !== subject)].slice(0, 3);
  const noteType = text(input.noteType || 'note', 40).trim() || 'note';
  return {
    noteUid,
    capturedDate,
    title: text(input.title, 240),
    subject,
    remark: text(input.remark, 8000),
    createdAt: timestamp,
    updatedAt: timestamp,
    firstSyncedAt: timestamp,
    filePath: '',
    pageRefs: Array.isArray(input.pageRefs) ? input.pageRefs.slice(0, 100) : [],
    tags: uniqueStrings(input.tags),
    knowledgePath,
    noteType,
    questionType: text(input.questionType, 60),
    wrongReason: text(input.wrongReason, 1000),
    wrongReasonSource: text(input.wrongReason).trim() ? 'manual' : '',
    wrongReasonConfidence: null,
    organizationStatus: 'confirmed',
    classificationSource: 'manual',
    reviewStatus: 'corrected',
    decisionRevision: 1,
    lastReviewOperationId: `create-${noteUid}`,
    lastReviewAction: 'correct',
    proposalId: '',
    reviewedAt: timestamp,
    manualCreated: true,
    userEditedFields: ['title', 'remark', 'tags', 'noteType'],
    goodQuestion: typeof input.goodQuestion === 'boolean' ? input.goodQuestion : null,
    items: Array.isArray(input.items) ? input.items.slice(0, 24) : [],
    studyNotes: [],
    confidence: null,
    cardIds: [],
  };
}

function cardDefaults(input, cardId, timestamp) {
  if (!text(input.noteUid).trim() || !text(input.front).trim() || !text(input.back).trim()) {
    throw new HttpError(400, 'noteUid, front and back are required.', 'INVALID_LEARNING_CARD');
  }
  return {
    id: cardId,
    noteUid: text(input.noteUid, 160),
    sourceKey: text(input.sourceKey || 'manual:create', 160),
    kind: input.kind === 'mistake' ? 'mistake' : 'memory',
    front: text(input.front, 8000),
    back: text(input.back, 12000),
    subject: text(input.subject, 120),
    knowledgePath: uniqueStrings(input.knowledgePath).slice(0, 3),
    tags: uniqueStrings(input.tags),
    pageRefs: Array.isArray(input.pageRefs) ? input.pageRefs.slice(0, 100) : [],
    sourceTitle: text(input.sourceTitle, 240),
    sourceFilePath: text(input.sourceFilePath, 1000),
    status: ['draft', 'active', 'archived'].includes(input.status) ? input.status : 'active',
    dueDate: DATE_PATTERN.test(text(input.dueDate)) ? input.dueDate : shanghaiDate(new Date(timestamp)),
    reviewStep: 0,
    reviewCount: 0,
    lastReviewedAt: '',
    lastReviewResult: '',
    correctCount: 0,
    incorrectCount: 0,
    correctStreak: 0,
    masteredAt: '',
    reviewHistory: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    userEdited: true,
  };
}

export async function createNote(env, payload) {
  const input = isObject(payload.input) ? payload.input : payload.note;
  if (!isObject(input)) throw new HttpError(400, 'input is required.', 'INVALID_LEARNING_NOTE');
  const noteUid = (text(input.noteUid, 160).trim() || `note-${crypto.randomUUID()}`);
  const timestamp = new Date().toISOString();
  return (await mutateLearning(env, payload, (snapshot) => {
    if (snapshot.deletedNotes[noteUid]) throw new HttpError(409, 'Learning note is deleted.', 'NOTE_DELETED');
    if (findNote(snapshot, noteUid)) throw new HttpError(409, 'Learning note already exists.', 'NOTE_ALREADY_EXISTS');
    const note = noteDefaults(input, noteUid, timestamp);
    const day = dayRecord(snapshot.days[note.capturedDate]);
    day.autoNotes.push(note);
    snapshot.days[note.capturedDate] = day;
    if (input.createCard === true && ['mistake', 'memory'].includes(note.noteType)) {
      const cardId = `card-${noteUid}-manual`;
      const card = cardDefaults({
        noteUid,
        kind: note.noteType,
        front: note.title,
        back: note.remark,
        subject: note.subject,
        knowledgePath: note.knowledgePath,
        tags: note.tags,
        pageRefs: note.pageRefs,
        sourceTitle: note.title,
      }, cardId, timestamp);
      snapshot.cards.push(card);
      note.cardIds.push(cardId);
    }
    return { touchedDates: [note.capturedDate] };
  })).snapshot;
}

export async function createCard(env, payload) {
  const input = isObject(payload.input) ? payload.input : payload.card;
  if (!isObject(input)) throw new HttpError(400, 'input is required.', 'INVALID_LEARNING_CARD');
  const cardId = text(input.id, 160).trim() || `card-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  return (await mutateLearning(env, payload, (snapshot) => {
    const parent = findNote(snapshot, input.noteUid);
    if (!parent) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
    if (snapshot.cards.some((card) => card.id === cardId)) {
      throw new HttpError(409, 'Learning card already exists.', 'CARD_ALREADY_EXISTS');
    }
    const inheritedInput = {
      ...input,
      ...(!Object.hasOwn(input, 'subject') ? { subject: parent.note.subject } : {}),
      ...(!Object.hasOwn(input, 'knowledgePath') ? { knowledgePath: parent.note.knowledgePath } : {}),
      ...(!Object.hasOwn(input, 'tags') ? { tags: parent.note.tags } : {}),
      ...(!Object.hasOwn(input, 'pageRefs') ? { pageRefs: parent.note.pageRefs } : {}),
      ...(!Object.hasOwn(input, 'sourceTitle') ? { sourceTitle: parent.note.title } : {}),
      ...(!Object.hasOwn(input, 'sourceFilePath') ? { sourceFilePath: parent.note.filePath } : {}),
    };
    const card = cardDefaults(inheritedInput, cardId, timestamp);
    snapshot.cards.push(card);
    parent.note.cardIds = [...new Set([...(parent.note.cardIds ?? []), cardId])];
    parent.day.autoNotes[parent.index] = parent.note;
    snapshot.days[parent.date] = parent.day;
    return { touchedDates: [parent.date] };
  })).snapshot;
}

function updateThoughts(note, action, timestamp) {
  if (!isObject(action)) return note.studyNotes ?? [];
  const thoughts = Array.isArray(note.studyNotes) ? note.studyNotes : [];
  if (action.action === 'add' && text(action.text).trim()) {
    return [...thoughts, {
      id: `thought-${crypto.randomUUID()}`,
      text: text(action.text, 4000).trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
    }].slice(-200);
  }
  if (action.action === 'update') {
    if (!thoughts.some((item) => item.id === action.id)) {
      throw new HttpError(404, 'Study note not found.', 'STUDY_NOTE_NOT_FOUND');
    }
    return thoughts.map((item) => item.id === action.id
      ? { ...item, text: text(action.text, 4000).trim(), updatedAt: timestamp }
      : item);
  }
  if (action.action === 'delete') return thoughts.filter((item) => item.id !== action.id);
  throw new HttpError(400, 'Invalid study note action.', 'INVALID_LEARNING_NOTE');
}

export async function patchNote(env, noteUid, payload) {
  const patch = isObject(payload.patch) ? payload.patch : {};
  const allowed = ['title', 'remark', 'tags', 'noteType', 'subject', 'knowledgePath', 'questionType', 'wrongReason', 'organizationStatus', 'goodQuestion', 'thoughtAction'];
  if (!allowed.some((key) => Object.hasOwn(patch, key))) {
    throw new HttpError(400, 'Empty note update.', 'INVALID_LEARNING_NOTE');
  }
  const timestamp = new Date().toISOString();
  return (await mutateLearning(env, payload, (snapshot) => {
    const entry = findNote(snapshot, noteUid);
    if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
    const note = entry.note;
    const classificationKeys = ['subject', 'knowledgePath', 'questionType', 'wrongReason'];
    const editsClassification = classificationKeys.some((key) => Object.hasOwn(patch, key));
    const recordsDecision = editsClassification || ['confirmed', 'ignored'].includes(patch.organizationStatus);
    const nextSubject = Object.hasOwn(patch, 'subject') ? text(patch.subject, 120).trim() : note.subject;
    if (!nextSubject) throw new HttpError(400, 'A note subject is required.', 'INVALID_LEARNING_NOTE');
    let nextPath = Object.hasOwn(patch, 'knowledgePath') ? uniqueStrings(patch.knowledgePath).slice(0, 3) : uniqueStrings(note.knowledgePath);
    nextPath = [nextSubject, ...nextPath.filter((item) => item !== nextSubject && item !== note.subject)].slice(0, 3);
    const reviewStatus = editsClassification
      ? 'corrected'
      : patch.organizationStatus === 'ignored' ? 'ignored'
        : patch.organizationStatus === 'confirmed' ? 'accepted'
          : patch.organizationStatus === 'pending' ? 'pending' : note.reviewStatus;
    const contentEdited = ['title', 'remark', 'tags', 'noteType', 'goodQuestion'].filter((key) => Object.hasOwn(patch, key));
    const updated = {
      ...note,
      ...(Object.hasOwn(patch, 'title') ? { title: text(patch.title, 240) } : {}),
      ...(Object.hasOwn(patch, 'remark') ? { remark: text(patch.remark, 8000) } : {}),
      ...(Object.hasOwn(patch, 'tags') ? { tags: uniqueStrings(patch.tags) } : {}),
      ...(Object.hasOwn(patch, 'noteType') ? { noteType: text(patch.noteType, 40) || 'note' } : {}),
      ...(Object.hasOwn(patch, 'goodQuestion') ? { goodQuestion: patch.goodQuestion === true } : {}),
      subject: nextSubject,
      knowledgePath: nextPath,
      ...(Object.hasOwn(patch, 'questionType') ? { questionType: text(patch.questionType, 60) } : {}),
      ...(Object.hasOwn(patch, 'wrongReason') ? {
        wrongReason: text(patch.wrongReason, 500),
        wrongReasonSource: 'manual',
        wrongReasonConfidence: null,
      } : {}),
      organizationStatus: reviewStatus === 'ignored' ? 'ignored' : reviewStatus === 'pending' ? 'pending' : 'confirmed',
      classificationSource: editsClassification ? 'manual' : note.classificationSource,
      reviewStatus,
      decisionRevision: recordsDecision ? Number(note.decisionRevision || 0) + 1 : Number(note.decisionRevision || 0),
      reviewedAt: recordsDecision ? timestamp : note.reviewedAt,
      userEditedFields: [...new Set([...(note.userEditedFields ?? []), ...contentEdited])],
      studyNotes: Object.hasOwn(patch, 'thoughtAction') ? updateThoughts(note, patch.thoughtAction, timestamp) : note.studyNotes,
      updatedAt: timestamp,
    };
    entry.day.autoNotes[entry.index] = updated;
    snapshot.days[entry.date] = entry.day;
    snapshot.cards = snapshot.cards.map((card) => card.noteUid !== noteUid ? card : {
      ...card,
      ...(editsClassification ? { subject: nextSubject, knowledgePath: nextPath } : {}),
      ...(Object.hasOwn(patch, 'title') ? { sourceTitle: updated.title } : {}),
      ...(Object.hasOwn(patch, 'tags') ? { tags: updated.tags } : {}),
      ...(reviewStatus === 'ignored' ? { status: 'archived', dueDate: '' } : {}),
      updatedAt: timestamp,
    });
    return { touchedDates: [entry.date] };
  })).snapshot;
}

function addDays(date, days) {
  return shanghaiDate(new Date(date.getTime() + days * 86400000));
}

export async function patchCard(env, cardId, payload) {
  const patch = isObject(payload.patch) ? payload.patch : {};
  const timestamp = new Date().toISOString();
  return (await mutateLearning(env, payload, (snapshot) => {
    const index = snapshot.cards.findIndex((card) => card.id === cardId);
    if (index < 0) throw new HttpError(404, 'Learning card not found.', 'CARD_NOT_FOUND');
    const current = snapshot.cards[index];
    const reviewResult = ['remembered', 'forgotten'].includes(patch.reviewResult) ? patch.reviewResult : null;
    let reviewPatch = {};
    if (reviewResult) {
      const correctCount = Number(current.correctCount || 0) + (reviewResult === 'remembered' ? 1 : 0);
      const incorrectCount = Number(current.incorrectCount || 0) + (reviewResult === 'forgotten' ? 1 : 0);
      const correctStreak = reviewResult === 'remembered' ? Number(current.correctStreak || 0) + 1 : 0;
      const mastered = correctStreak >= 3;
      const step = Number(current.reviewStep || 0);
      const baseInterval = reviewResult === 'remembered'
        ? [1, 3, 7, 14, 30, 60][Math.min(5, step)]
        : 1;
      const knownAttempts = correctCount + incorrectCount;
      const errorRate = knownAttempts > 0 ? incorrectCount / knownAttempts : 0;
      const difficultyPenalty = 1 + Math.min(3, incorrectCount) * 0.45 + errorRate * 0.8;
      const intervalDays = reviewResult === 'remembered'
        ? Math.max(1, Math.round(baseInterval / difficultyPenalty))
        : 1;
      reviewPatch = {
        status: mastered ? 'archived' : 'active',
        dueDate: mastered ? '' : addDays(new Date(timestamp), intervalDays),
        reviewStep: reviewResult === 'forgotten' ? 0 : Math.min(5, step + 1),
        reviewCount: Number(current.reviewCount || 0) + 1,
        lastReviewedAt: timestamp,
        lastReviewResult: reviewResult,
        correctCount,
        incorrectCount,
        correctStreak,
        masteredAt: mastered ? timestamp : reviewResult === 'forgotten' ? '' : current.masteredAt,
        reviewHistory: [...(Array.isArray(current.reviewHistory) ? current.reviewHistory : []), {
          id: `review-${crypto.randomUUID()}`,
          reviewedAt: timestamp,
          result: reviewResult,
          thought: text(patch.reviewThought, 4000).trim(),
        }].slice(-200),
      };
    }
    snapshot.cards[index] = {
      ...current,
      ...(Object.hasOwn(patch, 'front') ? { front: text(patch.front, 8000) } : {}),
      ...(Object.hasOwn(patch, 'back') ? { back: text(patch.back, 12000) } : {}),
      ...(['draft', 'active', 'archived'].includes(patch.status) ? { status: patch.status } : {}),
      ...(DATE_PATTERN.test(text(patch.dueDate)) || patch.dueDate === '' ? { dueDate: patch.dueDate } : {}),
      ...reviewPatch,
      userEdited: patch.userEdited === undefined
        ? current.userEdited || Object.hasOwn(patch, 'front') || Object.hasOwn(patch, 'back')
        : patch.userEdited === true,
      updatedAt: timestamp,
    };
    return {};
  })).snapshot;
}

export async function deleteNote(env, noteUid, payload) {
  return (await mutateLearning(env, payload, (snapshot) => {
    const entry = findNote(snapshot, noteUid);
    if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
    const deletedAt = new Date().toISOString();
    const cards = snapshot.cards.filter((card) => card.noteUid === noteUid);
    snapshot.deletedNotes[noteUid] = { deletedAt, note: { ...entry.note, updatedAt: deletedAt }, cards };
    entry.day.autoNotes.splice(entry.index, 1);
    snapshot.days[entry.date] = entry.day;
    snapshot.cards = snapshot.cards.filter((card) => card.noteUid !== noteUid);
    return { touchedDates: [entry.date] };
  })).snapshot;
}

export async function restoreNote(env, noteUid, payload) {
  return (await mutateLearning(env, payload, (snapshot) => {
    const deleted = snapshot.deletedNotes[noteUid];
    if (!isObject(deleted?.note)) throw new HttpError(404, 'Deleted learning note not found.', 'NOTE_NOT_FOUND');
    if (findNote(snapshot, noteUid)) throw new HttpError(409, 'Learning note already exists.', 'NOTE_ALREADY_EXISTS');
    const note = { ...deleted.note, updatedAt: new Date().toISOString() };
    const date = DATE_PATTERN.test(note.capturedDate) ? note.capturedDate : shanghaiDate(new Date(note.createdAt || Date.now()));
    const day = dayRecord(snapshot.days[date]);
    day.autoNotes.push(note);
    snapshot.days[date] = day;
    snapshot.cards.push(...(Array.isArray(deleted.cards) ? deleted.cards : []));
    delete snapshot.deletedNotes[noteUid];
    return { touchedDates: [date] };
  })).snapshot;
}

export async function deleteCard(env, cardId, payload) {
  return (await mutateLearning(env, payload, (snapshot) => {
    if (!snapshot.cards.some((card) => card.id === cardId)) {
      throw new HttpError(404, 'Learning card not found.', 'CARD_NOT_FOUND');
    }
    snapshot.cards = snapshot.cards.filter((card) => card.id !== cardId);
    const touchedDates = [];
    for (const [date, rawDay] of Object.entries(snapshot.days)) {
      const day = dayRecord(rawDay);
      day.autoNotes = day.autoNotes.map((note) => ({
        ...note,
        cardIds: (note.cardIds ?? []).filter((id) => id !== cardId),
      }));
      snapshot.days[date] = day;
      touchedDates.push(date);
    }
    return { touchedDates };
  })).snapshot;
}

function canonicalReviewAction(action) {
  return JSON.stringify({
    noteUid: text(action.noteUid, 160),
    action: text(action.action, 20),
    operationId: text(action.operationId, 160),
    expectedDecisionRevision: action.expectedDecisionRevision ?? null,
    proposalId: text(action.proposalId, 160),
    patch: isObject(action.patch) ? {
      ...(Object.hasOwn(action.patch, 'subject') ? { subject: action.patch.subject } : {}),
      ...(Object.hasOwn(action.patch, 'knowledgePath') ? { knowledgePath: action.patch.knowledgePath } : {}),
      ...(Object.hasOwn(action.patch, 'questionType') ? { questionType: action.patch.questionType } : {}),
      ...(Object.hasOwn(action.patch, 'wrongReason') ? { wrongReason: action.patch.wrongReason } : {}),
    } : {},
  });
}

async function recordReviewReceipt(env, action, requestHash, result) {
  try {
    await writeReceipt(env, {
      scope: 'note-review',
      operationId: action.operationId,
      entityId: action.noteUid,
      requestHash,
      result,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    const existing = await readReceipt(env, 'note-review', action.operationId);
    if (!existing || existing.entityId !== action.noteUid || existing.requestHash !== requestHash) throw error;
  }
}

export async function applyReviewAction(env, action) {
  if (!isObject(action) || !text(action.noteUid).trim() || !text(action.operationId).trim() || !REVIEW_ACTIONS.has(action.action)) {
    throw new HttpError(400, 'noteUid, operationId and a valid action are required.', 'INVALID_NOTE_REVIEW_ACTION');
  }
  action = {
    ...action,
    noteUid: text(action.noteUid, 160).trim(),
    operationId: text(action.operationId, 160).trim(),
  };
  const requestHash = await sha256(canonicalReviewAction(action));
  const receipt = await readReceipt(env, 'note-review', action.operationId);
  if (receipt) {
    if (receipt.entityId !== action.noteUid || receipt.requestHash !== requestHash) {
      throw new HttpError(409, 'Review operation id was already used for another decision.', 'REVIEW_OPERATION_REUSED');
    }
    return { ...receipt.result, replayed: true, durable: true };
  }

  const result = await mutateLearning(env, {}, (snapshot) => {
    const entry = findNote(snapshot, action.noteUid);
    if (!entry) throw new HttpError(404, 'Learning note not found.', 'NOTE_NOT_FOUND');
    const note = entry.note;
    if (note.lastReviewOperationId === action.operationId) {
      if (note.lastReviewAction !== action.action || (note.lastReviewRequestHash && note.lastReviewRequestHash !== requestHash)) {
        throw new HttpError(409, 'Review operation id was already used for another decision.', 'REVIEW_OPERATION_REUSED');
      }
      return { touchedDates: [], replayedFromSnapshot: true, noCommit: true, note };
    }
    if (action.expectedDecisionRevision !== undefined && Number(action.expectedDecisionRevision) !== Number(note.decisionRevision || 0)) {
      throw new HttpError(409, 'The note decision changed before this action was saved.', 'NOTE_REVIEW_CONFLICT', {
        actualDecisionRevision: Number(note.decisionRevision || 0),
      });
    }
    if (action.proposalId && note.proposalId && action.proposalId !== note.proposalId) {
      throw new HttpError(409, 'The AI proposal changed before it was reviewed.', 'NOTE_REVIEW_PROPOSAL_CONFLICT', {
        actualProposalId: note.proposalId,
      });
    }
    const patch = isObject(action.patch) ? action.patch : {};
    const subject = Object.hasOwn(patch, 'subject') ? text(patch.subject, 120).trim() : note.subject;
    if (!subject) throw new HttpError(400, 'A reviewed note must have a subject.', 'INVALID_NOTE_REVIEW_ACTION');
    let knowledgePath = Object.hasOwn(patch, 'knowledgePath') ? uniqueStrings(patch.knowledgePath).slice(0, 3) : uniqueStrings(note.knowledgePath);
    knowledgePath = [subject, ...knowledgePath.filter((item) => item !== subject && item !== note.subject)].slice(0, 3);
    const reviewStatus = action.action === 'accept' ? 'accepted' : action.action === 'correct' ? 'corrected' : 'ignored';
    const timestamp = new Date().toISOString();
    const updated = {
      ...note,
      subject,
      knowledgePath,
      ...(Object.hasOwn(patch, 'questionType') ? { questionType: text(patch.questionType, 60) } : {}),
      ...(Object.hasOwn(patch, 'wrongReason') ? { wrongReason: text(patch.wrongReason, 500) } : {}),
      reviewStatus,
      organizationStatus: reviewStatus === 'ignored' ? 'ignored' : 'confirmed',
      classificationSource: action.action === 'correct' ? 'manual' : note.classificationSource,
      decisionRevision: Number(note.decisionRevision || 0) + 1,
      lastReviewOperationId: action.operationId,
      lastReviewAction: action.action,
      lastReviewRequestHash: requestHash,
      proposalId: action.proposalId || note.proposalId || '',
      reviewedAt: timestamp,
      updatedAt: timestamp,
      userEditedFields: action.action === 'correct'
        ? [...new Set([...(note.userEditedFields ?? []), ...Object.keys(patch)])]
        : note.userEditedFields,
    };
    entry.day.autoNotes[entry.index] = updated;
    snapshot.days[entry.date] = entry.day;
    snapshot.cards = snapshot.cards.map((card) => card.noteUid !== action.noteUid ? card : {
      ...card,
      subject,
      knowledgePath,
      ...(action.action === 'ignore' ? { status: 'archived', dueDate: '' } : {}),
      updatedAt: timestamp,
    });
    return { touchedDates: [entry.date], note: updated };
  });

  const storedNote = findNote(result.snapshot, action.noteUid)?.note;
  const actionResult = {
    noteUid: action.noteUid,
    operationId: action.operationId,
    ok: true,
    replayed: result.outcome.replayedFromSnapshot === true,
    durable: true,
    reviewStatus: storedNote?.reviewStatus,
    decisionRevision: storedNote?.decisionRevision,
  };
  await recordReviewReceipt(env, action, requestHash, actionResult);
  return actionResult;
}

export async function applyReviewActions(env, actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 100) {
    throw new HttpError(400, 'actions must contain between 1 and 100 review actions.', 'INVALID_NOTE_REVIEW_ACTION');
  }
  const results = [];
  for (const action of actions) {
    try {
      results.push(await applyReviewAction(env, action));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      results.push({
        noteUid: text(action?.noteUid, 160),
        operationId: text(action?.operationId, 160),
        ok: false,
        durable: false,
        code: error.code,
        error: error.message,
        ...error.details,
      });
    }
  }
  const failed = results.filter((result) => !result.ok);
  const snapshot = await getLearningSnapshot(env);
  const status = failed.length === 0 ? 200
    : failed.some((result) => ['NOTE_REVIEW_CONFLICT', 'NOTE_REVIEW_PROPOSAL_CONFLICT', 'REVIEW_OPERATION_REUSED'].includes(result.code)) ? 409
      : failed.every((result) => result.code === 'NOTE_NOT_FOUND') ? 404
        : failed.every((result) => result.code === 'INVALID_NOTE_REVIEW_ACTION') ? 400 : 500;
  return { status, body: { ok: failed.length === 0, snapshot, results } };
}

export function normalizeBootstrapSnapshot(value) {
  const source = isObject(value?.learningData) ? value.learningData : isObject(value?.data) ? value.data : value;
  if (!isObject(source)) throw new HttpError(400, 'Bootstrap learning data is invalid.', 'INVALID_BOOTSTRAP');
  const snapshot = {
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: 0,
    updatedAt: null,
    days: isObject(source.days) ? structuredClone(source.days) : {},
    cards: Array.isArray(source.cards) ? structuredClone(source.cards) : [],
    deletedNotes: isObject(source.deletedNotes) ? structuredClone(source.deletedNotes) : {},
  };
  const noteAssetKey = (note, fallback = '') => {
    const current = text(note?.filePath || fallback, 2000).replaceAll('\\', '/');
    const safeRelative = (value) => /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..');
    if (current.startsWith('github://data/assets/')) {
      const relative = current.slice('github://data/assets/'.length);
      return safeRelative(relative) ? current : '';
    }
    if (current.startsWith('data/assets/')) {
      const relative = current.slice('data/assets/'.length);
      return safeRelative(relative) ? `github://${current}` : '';
    }
    if (current.startsWith('r2://note-assets/')) {
      const relative = current.slice('r2://note-assets/'.length);
      return safeRelative(relative) ? `github://data/assets/${relative}` : '';
    }
    return '';
  };
  for (const day of Object.values(snapshot.days)) {
    if (!Array.isArray(day?.autoNotes)) continue;
    day.autoNotes = day.autoNotes.map((note) => ({ ...note, filePath: noteAssetKey(note) }));
  }
  snapshot.cards = snapshot.cards.map((card) => ({
    ...card,
    sourceFilePath: noteAssetKey({ noteUid: card.noteUid, filePath: card.sourceFilePath }),
  }));
  for (const deleted of Object.values(snapshot.deletedNotes)) {
    if (!isObject(deleted?.note)) continue;
    deleted.note.filePath = noteAssetKey(deleted.note);
    if (Array.isArray(deleted.cards)) {
      deleted.cards = deleted.cards.map((card) => ({
        ...card,
        sourceFilePath: noteAssetKey({ noteUid: card.noteUid, filePath: card.sourceFilePath }),
      }));
    }
  }
  return snapshot;
}

export function createSavedImageNote(payload, file, timestamp) {
  const subject = text(payload.subject, 120).trim() || '默认文件夹';
  const remark = text(payload.remark, 8000);
  const title = remark.trim().split(/\r?\n/)[0]?.slice(0, 120) || (payload.kind === 'canvas' ? '画布笔记' : '图片笔记');
  return {
    ...noteDefaults({ title, subject, remark, noteType: 'note' }, payload.noteUid, timestamp),
    filePath: `github://${file.repoPath}`,
    organizationStatus: 'pending',
    classificationSource: 'local',
    reviewStatus: 'pending',
    decisionRevision: 0,
    lastReviewOperationId: '',
    lastReviewAction: '',
    reviewedAt: '',
    manualCreated: false,
    userEditedFields: remark ? ['remark'] : [],
  };
}

export async function insertSavedImageNote(env, note) {
  return (await mutateLearning(env, {}, (snapshot) => {
    const existing = findNote(snapshot, note.noteUid);
    if (existing) return { touchedDates: [], note: existing.note, replayed: true, noCommit: true };
    if (snapshot.deletedNotes[note.noteUid]) throw new HttpError(409, 'Learning note is deleted.', 'NOTE_DELETED');
    const day = dayRecord(snapshot.days[note.capturedDate]);
    day.autoNotes.push(note);
    snapshot.days[note.capturedDate] = day;
    return { touchedDates: [note.capturedDate], note, replayed: false };
  }));
}
