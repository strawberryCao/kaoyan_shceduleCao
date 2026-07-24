const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return structuredClone(fallback);
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    const wrapped = new Error(`无法读取学习数据 JSON：${filePath}\n${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function time(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function remoteAssetPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  return normalized.startsWith('github://data/assets/')
    || normalized.startsWith('data/assets/')
    || normalized.startsWith('r2://note-assets/');
}

function sanitizeNote(note) {
  if (!isObject(note)) return null;
  const result = clone(note);
  if (remoteAssetPath(result.filePath) && String(result.subject || '').trim().toLowerCase() === 'assets') {
    result.subject = '默认文件夹';
    const knowledgePath = uniqueStrings(result.knowledgePath).filter((item) => item.toLowerCase() !== 'assets');
    result.knowledgePath = ['默认文件夹', ...knowledgePath.filter((item) => item !== '默认文件夹')].slice(0, 3);
    if (result.classificationSource !== 'manual') {
      result.organizationStatus = 'pending';
      result.reviewStatus = 'pending';
      result.classificationSource = 'local';
    }
  }
  return result;
}

function emptySnapshot() {
  return { version: 1, revision: 0, updatedAt: null, days: {}, cards: [], deletedNotes: {} };
}

function normalizeSnapshot(value) {
  const source = isObject(value) ? value : {};
  return {
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: Number.isInteger(Number(source.revision)) ? Math.max(0, Number(source.revision)) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    days: isObject(source.days) ? clone(source.days) : {},
    cards: Array.isArray(source.cards) ? clone(source.cards) : [],
    deletedNotes: isObject(source.deletedNotes) ? clone(source.deletedNotes) : {},
  };
}

function chooseSide(localValue, remoteValue, previousValue, localUpdatedAt, remoteUpdatedAt) {
  if (localValue === undefined) return { side: 'remote', value: clone(remoteValue) };
  if (remoteValue === undefined) return { side: 'local', value: clone(localValue) };
  if (equal(localValue, remoteValue)) return { side: 'local', value: clone(localValue) };
  if (previousValue !== undefined) {
    const localSame = equal(localValue, previousValue);
    const remoteSame = equal(remoteValue, previousValue);
    if (localSame && !remoteSame) return { side: 'remote', value: clone(remoteValue) };
    if (remoteSame && !localSame) return { side: 'local', value: clone(localValue) };
  }
  return time(remoteUpdatedAt) > time(localUpdatedAt)
    ? { side: 'remote', value: clone(remoteValue) }
    : { side: 'local', value: clone(localValue) };
}

function indexBy(items, key) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item)) continue;
    const id = String(item[key] || '').trim();
    if (id) map.set(id, item);
  }
  return map;
}

function mergeChildRecords(localItems, remoteItems, previousItems, baseSide, options = {}) {
  const key = options.key || 'id';
  const local = indexBy(localItems, key);
  const remote = indexBy(remoteItems, key);
  const previous = indexBy(previousItems, key);
  const base = baseSide === 'remote' ? remote : local;
  const other = baseSide === 'remote' ? local : remote;
  const result = new Map([...base.entries()].map(([id, value]) => [id, clone(value)]));

  for (const [id, otherValue] of other.entries()) {
    const baseValue = base.get(id);
    const previousValue = previous.get(id);
    if (!baseValue) {
      if (!previousValue || !equal(otherValue, previousValue)) result.set(id, clone(otherValue));
      continue;
    }
    if (equal(baseValue, otherValue)) continue;
    const chosen = chooseSide(
      baseSide === 'remote' ? otherValue : baseValue,
      baseSide === 'remote' ? baseValue : otherValue,
      previousValue,
      (baseSide === 'remote' ? otherValue : baseValue)?.updatedAt || (baseSide === 'remote' ? otherValue : baseValue)?.reviewedAt,
      (baseSide === 'remote' ? baseValue : otherValue)?.updatedAt || (baseSide === 'remote' ? baseValue : otherValue)?.reviewedAt,
    );
    result.set(id, chosen.value);
  }

  return [...result.values()].sort((left, right) => {
    const leftTime = time(left.createdAt || left.reviewedAt || left.updatedAt);
    const rightTime = time(right.createdAt || right.reviewedAt || right.updatedAt);
    return leftTime - rightTime || String(left[key]).localeCompare(String(right[key]));
  });
}

function mergeNote(localNote, remoteNote, previousNote, localSnapshotUpdatedAt, remoteSnapshotUpdatedAt) {
  const sanitizedLocal = sanitizeNote(localNote);
  const sanitizedRemote = sanitizeNote(remoteNote);
  const sanitizedPrevious = sanitizeNote(previousNote);
  const chosen = chooseSide(
    sanitizedLocal,
    sanitizedRemote,
    sanitizedPrevious,
    sanitizedLocal?.updatedAt || localSnapshotUpdatedAt,
    sanitizedRemote?.updatedAt || remoteSnapshotUpdatedAt,
  );
  const merged = sanitizeNote(chosen.value) || {};
  merged.studyNotes = mergeChildRecords(
    sanitizedLocal?.studyNotes,
    sanitizedRemote?.studyNotes,
    sanitizedPrevious?.studyNotes,
    chosen.side,
  );
  return merged;
}

function mergeCard(localCard, remoteCard, previousCard, localSnapshotUpdatedAt, remoteSnapshotUpdatedAt) {
  const chosen = chooseSide(
    localCard,
    remoteCard,
    previousCard,
    localCard?.updatedAt || localSnapshotUpdatedAt,
    remoteCard?.updatedAt || remoteSnapshotUpdatedAt,
  );
  const merged = clone(chosen.value) || {};
  merged.reviewHistory = mergeChildRecords(
    localCard?.reviewHistory,
    remoteCard?.reviewHistory,
    previousCard?.reviewHistory,
    chosen.side,
  );
  merged.reviewCount = Math.max(Number(merged.reviewCount) || 0, merged.reviewHistory.length);
  return merged;
}

function manualRecord(value) {
  const source = isObject(value) ? value : {};
  return {
    completedTaskIds: uniqueStrings(source.completedTaskIds),
    note: typeof source.note === 'string' ? source.note : '',
    debt: typeof source.debt === 'string' ? source.debt : '',
    mistakes: typeof source.mistakes === 'string' ? source.mistakes : '',
  };
}

function mergeManual(localManual, remoteManual, previousManual, localUpdatedAt, remoteUpdatedAt) {
  const local = manualRecord(localManual);
  const remote = manualRecord(remoteManual);
  const previous = manualRecord(previousManual);
  const result = {};
  for (const key of ['completedTaskIds', 'note', 'debt', 'mistakes']) {
    result[key] = chooseSide(local[key], remote[key], previous[key], localUpdatedAt, remoteUpdatedAt).value;
  }
  return result;
}

function flattenNotes(snapshot) {
  const map = new Map();
  for (const [date, day] of Object.entries(snapshot.days || {})) {
    for (const rawNote of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      const note = sanitizeNote(rawNote);
      const id = String(note?.noteUid || '').trim();
      if (id) map.set(id, { date, note });
    }
  }
  return map;
}

function mergeSnapshots(localInput, remoteInput, previousInput) {
  const local = normalizeSnapshot(localInput);
  const remote = normalizeSnapshot(remoteInput);
  const previous = normalizeSnapshot(previousInput);
  const localNotes = flattenNotes(local);
  const remoteNotes = flattenNotes(remote);
  const previousNotes = flattenNotes(previous);
  const localCards = indexBy(local.cards, 'id');
  const remoteCards = indexBy(remote.cards, 'id');
  const previousCards = indexBy(previous.cards, 'id');
  const merged = emptySnapshot();
  merged.version = Math.max(local.version, remote.version, previous.version, 1);

  const dates = new Set([...Object.keys(local.days), ...Object.keys(remote.days), ...Object.keys(previous.days)]);
  for (const date of dates) {
    merged.days[date] = {
      manual: mergeManual(
        local.days[date]?.manual,
        remote.days[date]?.manual,
        previous.days[date]?.manual,
        local.updatedAt,
        remote.updatedAt,
      ),
      autoNotes: [],
    };
  }

  const noteIds = new Set([...localNotes.keys(), ...remoteNotes.keys(), ...previousNotes.keys()]);
  for (const noteUid of noteIds) {
    const localEntry = localNotes.get(noteUid);
    const remoteEntry = remoteNotes.get(noteUid);
    const previousEntry = previousNotes.get(noteUid);
    if (!localEntry && !remoteEntry) continue;
    const note = mergeNote(localEntry?.note, remoteEntry?.note, previousEntry?.note, local.updatedAt, remote.updatedAt);
    if (!note?.noteUid) continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(note.capturedDate || ''))
      ? note.capturedDate
      : localEntry?.date || remoteEntry?.date || previousEntry?.date;
    if (!merged.days[date]) merged.days[date] = { manual: manualRecord(), autoNotes: [] };
    merged.days[date].autoNotes.push(note);
  }

  const cardIds = new Set([...localCards.keys(), ...remoteCards.keys(), ...previousCards.keys()]);
  for (const cardId of cardIds) {
    const localCard = localCards.get(cardId);
    const remoteCard = remoteCards.get(cardId);
    if (!localCard && !remoteCard) continue;
    merged.cards.push(mergeCard(localCard, remoteCard, previousCards.get(cardId), local.updatedAt, remote.updatedAt));
  }

  const deletedIds = new Set([...Object.keys(local.deletedNotes), ...Object.keys(remote.deletedNotes)]);
  for (const noteUid of deletedIds) {
    const localDeleted = local.deletedNotes[noteUid];
    const remoteDeleted = remote.deletedNotes[noteUid];
    const previousDeleted = previous.deletedNotes[noteUid];
    const chosen = chooseSide(
      localDeleted,
      remoteDeleted,
      previousDeleted,
      localDeleted?.deletedAt || local.updatedAt,
      remoteDeleted?.deletedAt || remote.updatedAt,
    ).value;
    if (!chosen) continue;
    const live = flattenNotes(merged).get(noteUid)?.note;
    if (live && time(live.updatedAt) > time(chosen.deletedAt)) continue;
    merged.deletedNotes[noteUid] = clone(chosen);
    for (const day of Object.values(merged.days)) {
      day.autoNotes = day.autoNotes.filter((note) => note.noteUid !== noteUid);
    }
    merged.cards = merged.cards.filter((card) => card.noteUid !== noteUid);
  }

  for (const day of Object.values(merged.days)) {
    day.autoNotes.sort((left, right) => time(right.updatedAt) - time(left.updatedAt) || String(left.noteUid).localeCompare(String(right.noteUid)));
  }
  merged.cards.sort((left, right) => time(right.updatedAt) - time(left.updatedAt) || String(left.id).localeCompare(String(right.id)));
  return merged;
}

function contentOnly(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return { version: normalized.version, days: normalized.days, cards: normalized.cards, deletedNotes: normalized.deletedNotes };
}

function main() {
  const args = parseArgs(process.argv);
  const configPath = path.resolve(args.config || process.env.KAOYAN_SYNC_CONFIG || 'D:\\kaoyandata\\NoteFolderSync\\config.json');
  const config = readJson(configPath, {});
  const assistantRoot = path.resolve(String(config.assistantRoot || path.join(require('os').homedir(), 'Desktop', '考研桌面助手')));
  const clonePath = path.resolve(String(config.clonePath || 'D:\\kaoyandata\\Caobijidata'));
  const localPath = path.join(assistantRoot, 'learning-data.json');
  const remotePath = path.join(clonePath, 'data', 'cloud', 'learning-data.json');
  const statePath = path.join(path.dirname(configPath), 'learning-data-merge-state.json');
  const statusPath = path.join(path.dirname(configPath), 'learning-data-sync-status.json');
  const local = readJson(localPath, emptySnapshot());
  const remote = readJson(remotePath, emptySnapshot());
  const previousState = readJson(statePath, { snapshot: emptySnapshot() });
  const merged = mergeSnapshots(local, remote, previousState.snapshot);
  const localChanged = !equal(contentOnly(local), contentOnly(merged));
  const remoteChanged = !equal(contentOnly(remote), contentOnly(merged));
  const changed = localChanged || remoteChanged;
  const now = new Date().toISOString();
  if (changed) {
    merged.revision = Math.max(Number(local.revision) || 0, Number(remote.revision) || 0) + 1;
    merged.updatedAt = now;
    writeJsonAtomic(localPath, merged);
    writeJsonAtomic(remotePath, merged);
  } else {
    merged.revision = Math.max(Number(local.revision) || 0, Number(remote.revision) || 0);
    merged.updatedAt = local.updatedAt || remote.updatedAt || null;
  }
  writeJsonAtomic(statePath, { version: 1, synchronizedAt: now, snapshot: merged });
  writeJsonAtomic(statusPath, {
    ok: true,
    synchronizedAt: now,
    localPath,
    remotePath,
    changed,
    localChanged,
    remoteChanged,
    revision: merged.revision,
    noteCount: Object.values(merged.days).reduce((total, day) => total + (Array.isArray(day.autoNotes) ? day.autoNotes.length : 0), 0),
    cardCount: merged.cards.length,
    studyThoughtCount: Object.values(merged.days).reduce((total, day) => total + (Array.isArray(day.autoNotes) ? day.autoNotes.reduce((sum, note) => sum + (Array.isArray(note.studyNotes) ? note.studyNotes.length : 0), 0) : 0), 0),
    reviewHistoryCount: merged.cards.reduce((total, card) => total + (Array.isArray(card.reviewHistory) ? card.reviewHistory.length : 0), 0),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, changed, revision: merged.revision })}\n`);
}

if (require.main === module) main();

module.exports = { mergeSnapshots, normalizeSnapshot, sanitizeNote };
