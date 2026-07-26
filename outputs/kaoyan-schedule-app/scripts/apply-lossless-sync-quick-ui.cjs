'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const write = (relative, content) => fs.writeFileSync(path.join(root, relative), content, 'utf8');

function replaceOnce(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`${label}: anchor missing`);
  return source.replace(oldValue, newValue);
}

function replaceRegex(source, pattern, replacement, label) {
  if (typeof replacement === 'string' && source.includes(replacement)) return source;
  if (!pattern.test(source)) throw new Error(`${label}: pattern missing`);
  return source.replace(pattern, replacement);
}

// Learning center: make quick notes reachable even when they remain in the default bucket.
{
  let source = read('src/components/LearningCenter.tsx');
  source = replaceOnce(source, '  X,\n  ZoomIn,', '  X,\n  Zap,\n  ZoomIn,', 'quick icon import');
  source = replaceOnce(
    source,
    "type CenterView = 'review' | 'mistakes' | 'good' | 'memory' | 'library' | 'uncategorized' | 'inbox' | 'weekly';",
    "type CenterView = 'review' | 'mistakes' | 'good' | 'memory' | 'quick' | 'library' | 'uncategorized' | 'inbox' | 'weekly';",
    'quick center view type',
  );
  source = replaceOnce(
    source,
    "  if (requested === 'mistakes' || requested === 'good' || requested === 'memory' || requested === 'uncategorized' || requested === 'inbox' || requested === 'weekly') return requested;",
    "  if (requested === 'mistakes' || requested === 'good' || requested === 'memory' || requested === 'quick' || requested === 'uncategorized' || requested === 'inbox' || requested === 'weekly') return requested;",
    'quick initial view',
  );
  source = replaceOnce(
    source,
`const isGoodNote = (note: LearningAutoNote): boolean => {
  if (note.goodQuestion !== null) return note.goodQuestion;
  const hasUserOwnedGoodTag = (note.manualCreated || note.userEditedFields.includes('tags'))
    && noteHasTag(note, GOOD_QUESTION_WORDS);
  return note.noteType === 'good' || hasUserOwnedGoodTag || remarkSignalsGood(note.remark);
};
`,
`const isGoodNote = (note: LearningAutoNote): boolean => {
  if (note.goodQuestion !== null) return note.goodQuestion;
  const hasUserOwnedGoodTag = (note.manualCreated || note.userEditedFields.includes('tags'))
    && noteHasTag(note, GOOD_QUESTION_WORDS);
  return note.noteType === 'good' || hasUserOwnedGoodTag || remarkSignalsGood(note.remark);
};

const isQuickNote = (note: LearningAutoNote): boolean => (
  note.noteType === 'quick'
  || note.facets.includes('quick')
  || note.tags.some((tag) => tag.includes('速记'))
  || note.sourceType === 'material-note'
  || note.sourceType === 'quick-material'
);
`,
    'quick note predicate',
  );
  source = replaceOnce(
    source,
`  const memoryNotes = useMemo(() => indexedNotes.filter(({ note }) => isMemoryNote(note)), [indexedNotes]);
  const uncategorizedNotes = useMemo(() => indexedNotes.filter(({ note }) => (
    !isMistakeNote(note) && !isGoodNote(note) && !isMemoryNote(note)
  )), [indexedNotes]);
`,
`  const memoryNotes = useMemo(() => indexedNotes.filter(({ note }) => isMemoryNote(note)), [indexedNotes]);
  const quickNotes = useMemo(() => allNotes.filter(({ note }) => isQuickNote(note)), [allNotes]);
  const uncategorizedNotes = useMemo(() => indexedNotes.filter(({ note }) => (
    !isQuickNote(note) && !isMistakeNote(note) && !isGoodNote(note) && !isMemoryNote(note)
  )), [indexedNotes]);
`,
    'quick note collection',
  );
  source = replaceOnce(
    source,
`  const visibleMemory = useMemo(() => rankNotesForQuery(memoryNotes, query), [memoryNotes, query]);
  const visibleGood = useMemo(() => rankNotesForQuery(goodNotes, query), [goodNotes, query]);
  const visibleLibrary = useMemo(() => rankNotesForQuery(indexedNotes, query), [indexedNotes, query]);
`,
`  const visibleMemory = useMemo(() => rankNotesForQuery(memoryNotes, query), [memoryNotes, query]);
  const visibleGood = useMemo(() => rankNotesForQuery(goodNotes, query), [goodNotes, query]);
  const visibleQuick = useMemo(() => rankNotesForQuery(quickNotes, query), [query, quickNotes]);
  const visibleLibrary = useMemo(() => rankNotesForQuery(indexedNotes, query), [indexedNotes, query]);
`,
    'quick visible collection',
  );
  source = replaceOnce(
    source,
`  const noteListForView = view === 'mistakes'
    ? visibleMistakes
    : view === 'good'
      ? visibleGood
    : view === 'memory'
      ? visibleMemory
      : view === 'uncategorized'
        ? visibleUncategorized
      : visibleLibrary;
`,
`  const noteListForView = view === 'mistakes'
    ? visibleMistakes
    : view === 'good'
      ? visibleGood
    : view === 'memory'
      ? visibleMemory
      : view === 'quick'
        ? visibleQuick
        : view === 'uncategorized'
          ? visibleUncategorized
        : visibleLibrary;
`,
    'quick list routing',
  );
  source = replaceOnce(
    source,
`  const renderUncategorized = () => (
`,
`  const renderQuick = () => (
    <div className={\`lc-workspace \${mobileListOpen ? 'is-list-open' : 'is-detail-open'}\`}>
      <aside className="lc-master-pane">
        {renderSearch(visibleQuick.length, '搜索速记内容、附件名或备注')}
        <div className="lc-master-list">
          {visibleQuick.map((entry) => renderNoteButton(entry, 'library'))}
          {visibleQuick.length === 0 && <div className="lc-list-empty"><Zap size={23} /><strong>还没有速记</strong></div>}
        </div>
      </aside>
      <section className="lc-detail-pane">{renderNoteDetail(selectedNote, 'library')}</section>
    </div>
  );

  const renderUncategorized = () => (
`,
    'quick renderer',
  );
  source = replaceOnce(
    source,
`    { id: 'memory', label: '背诵', icon: Brain, count: memoryNotes.length },
    { id: 'uncategorized', label: '普通笔记', icon: ClipboardCheck, count: uncategorizedNotes.length },
`,
`    { id: 'memory', label: '背诵', icon: Brain, count: memoryNotes.length },
    { id: 'quick', label: '速记', icon: Zap, count: quickNotes.length },
    { id: 'uncategorized', label: '普通笔记', icon: ClipboardCheck, count: uncategorizedNotes.length },
`,
    'quick navigation tab',
  );
  source = replaceOnce(
    source,
`        {view === 'memory' && renderMemory()}
        {view === 'uncategorized' && renderUncategorized()}
`,
`        {view === 'memory' && renderMemory()}
        {view === 'quick' && renderQuick()}
        {view === 'uncategorized' && renderUncategorized()}
`,
    'quick body route',
  );
  write('src/components/LearningCenter.tsx', source);
}

// Three-way merge: preserve independent edits, attachments, facets and unknown future fields.
{
  let source = read('scripts/merge-learning-data.cjs');
  source = replaceOnce(
    source,
`  return {
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: Number.isInteger(Number(source.revision)) ? Math.max(0, Number(source.revision)) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    days: isObject(source.days) ? clone(source.days) : {},
    cards: Array.isArray(source.cards) ? clone(source.cards) : [],
    deletedNotes: isObject(source.deletedNotes) ? clone(source.deletedNotes) : {},
  };
`,
`  return {
    ...clone(source),
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: Number.isInteger(Number(source.revision)) ? Math.max(0, Number(source.revision)) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    days: isObject(source.days) ? clone(source.days) : {},
    cards: Array.isArray(source.cards) ? clone(source.cards) : [],
    deletedNotes: isObject(source.deletedNotes) ? clone(source.deletedNotes) : {},
  };
`,
    'preserve snapshot fields',
  );
  source = replaceOnce(
    source,
`function indexBy(items, key) {
`,
`function mergeStringSet(localValue, remoteValue, previousValue, localUpdatedAt, remoteUpdatedAt) {
  if (!Array.isArray(localValue)) return uniqueStrings(remoteValue);
  if (!Array.isArray(remoteValue)) return uniqueStrings(localValue);
  const local = new Set(uniqueStrings(localValue));
  const remote = new Set(uniqueStrings(remoteValue));
  const previous = new Set(uniqueStrings(previousValue));
  const values = new Set([...local, ...remote, ...previous]);
  const merged = [];
  for (const value of values) {
    const localHas = local.has(value);
    const remoteHas = remote.has(value);
    const previousHas = previous.has(value);
    let keep;
    if (localHas === remoteHas) keep = localHas;
    else if (localHas === previousHas) keep = remoteHas;
    else if (remoteHas === previousHas) keep = localHas;
    else keep = time(remoteUpdatedAt) > time(localUpdatedAt) ? remoteHas : localHas;
    if (keep) merged.push(value);
  }
  return merged;
}

function recordTimestamp(value, fallback) {
  return value?.updatedAt || value?.reviewedAt || value?.createdAt || fallback;
}

function mergeObjectFields(localValue, remoteValue, previousValue, localUpdatedAt, remoteUpdatedAt, strategies = {}) {
  const local = isObject(localValue) ? localValue : {};
  const remote = isObject(remoteValue) ? remoteValue : {};
  const previous = isObject(previousValue) ? previousValue : {};
  const result = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(previous)]);
  for (const key of keys) {
    const strategy = strategies[key];
    let value;
    if (strategy?.type === 'set') {
      value = mergeStringSet(local[key], remote[key], previous[key], localUpdatedAt, remoteUpdatedAt);
    } else if (strategy?.type === 'records') {
      value = mergeKeyedRecords(
        local[key],
        remote[key],
        previous[key],
        strategy.key || 'id',
        localUpdatedAt,
        remoteUpdatedAt,
        strategy.strategies || {},
      );
    } else {
      value = chooseSide(local[key], remote[key], previous[key], localUpdatedAt, remoteUpdatedAt).value;
    }
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function mergeKeyedRecords(localItems, remoteItems, previousItems, key, localUpdatedAt, remoteUpdatedAt, strategies = {}) {
  if (!Array.isArray(localItems)) return clone(Array.isArray(remoteItems) ? remoteItems : []);
  if (!Array.isArray(remoteItems)) return clone(localItems);
  const local = indexBy(localItems, key);
  const remote = indexBy(remoteItems, key);
  const previous = indexBy(previousItems, key);
  const ids = new Set([...local.keys(), ...remote.keys(), ...previous.keys()]);
  const result = [];
  for (const id of ids) {
    const localValue = local.get(id);
    const remoteValue = remote.get(id);
    const previousValue = previous.get(id);
    if (localValue && remoteValue) {
      result.push(mergeObjectFields(
        localValue,
        remoteValue,
        previousValue,
        recordTimestamp(localValue, localUpdatedAt),
        recordTimestamp(remoteValue, remoteUpdatedAt),
        strategies,
      ));
      continue;
    }
    if (localValue && !remoteValue) {
      if (!previousValue) {
        result.push(clone(localValue));
      } else if (!equal(localValue, previousValue) && time(recordTimestamp(localValue, localUpdatedAt)) >= time(remoteUpdatedAt)) {
        result.push(clone(localValue));
      }
      continue;
    }
    if (remoteValue && !localValue) {
      if (!previousValue) {
        result.push(clone(remoteValue));
      } else if (!equal(remoteValue, previousValue) && time(recordTimestamp(remoteValue, remoteUpdatedAt)) > time(localUpdatedAt)) {
        result.push(clone(remoteValue));
      }
    }
  }
  return result.sort((left, right) => {
    const leftTime = time(left.createdAt || left.reviewedAt || left.updatedAt);
    const rightTime = time(right.createdAt || right.reviewedAt || right.updatedAt);
    return leftTime - rightTime || String(left[key]).localeCompare(String(right[key]));
  });
}

function latestTimestamp(left, right, fallback = '') {
  return time(right) > time(left) ? right || fallback : left || fallback;
}

function indexBy(items, key) {
`,
    'field merge helpers',
  );
  source = replaceRegex(
    source,
    /function mergeNote\(localNote, remoteNote, previousNote, localSnapshotUpdatedAt, remoteSnapshotUpdatedAt\) \{[\s\S]*?\n\}\n\nfunction mergeCard/,
`function mergeNote(localNote, remoteNote, previousNote, localSnapshotUpdatedAt, remoteSnapshotUpdatedAt) {
  const local = sanitizeNote(localNote);
  const remote = sanitizeNote(remoteNote);
  const previous = sanitizeNote(previousNote);
  const localUpdatedAt = local?.updatedAt || localSnapshotUpdatedAt;
  const remoteUpdatedAt = remote?.updatedAt || remoteSnapshotUpdatedAt;
  const merged = mergeObjectFields(local, remote, previous, localUpdatedAt, remoteUpdatedAt, {
    tags: { type: 'set' },
    facets: { type: 'set' },
    cardIds: { type: 'set' },
    userEditedFields: { type: 'set' },
    attachments: { type: 'records', key: 'id' },
    studyNotes: { type: 'records', key: 'id' },
  });
  merged.updatedAt = latestTimestamp(localUpdatedAt, remoteUpdatedAt, merged.updatedAt);
  return sanitizeNote(merged) || {};
}

function mergeCard`,
    'field-level note merge',
  );
  source = replaceRegex(
    source,
    /function mergeCard\(localCard, remoteCard, previousCard, localSnapshotUpdatedAt, remoteSnapshotUpdatedAt\) \{[\s\S]*?\n\}\n\nfunction manualRecord/,
`function mergeCard(localCard, remoteCard, previousCard, localSnapshotUpdatedAt, remoteSnapshotUpdatedAt) {
  const localUpdatedAt = localCard?.updatedAt || localSnapshotUpdatedAt;
  const remoteUpdatedAt = remoteCard?.updatedAt || remoteSnapshotUpdatedAt;
  const merged = mergeObjectFields(localCard, remoteCard, previousCard, localUpdatedAt, remoteUpdatedAt, {
    tags: { type: 'set' },
    reviewHistory: { type: 'records', key: 'id' },
  });
  merged.updatedAt = latestTimestamp(localUpdatedAt, remoteUpdatedAt, merged.updatedAt);
  merged.reviewCount = Math.max(Number(merged.reviewCount) || 0, Array.isArray(merged.reviewHistory) ? merged.reviewHistory.length : 0);
  return merged;
}

function manualRecord`,
    'field-level card merge',
  );
  source = replaceOnce(
    source,
`  return {
    completedTaskIds: uniqueStrings(source.completedTaskIds),
    note: typeof source.note === 'string' ? source.note : '',
    debt: typeof source.debt === 'string' ? source.debt : '',
    mistakes: typeof source.mistakes === 'string' ? source.mistakes : '',
  };
`,
`  return {
    ...clone(source),
    completedTaskIds: uniqueStrings(source.completedTaskIds),
    note: typeof source.note === 'string' ? source.note : '',
    debt: typeof source.debt === 'string' ? source.debt : '',
    mistakes: typeof source.mistakes === 'string' ? source.mistakes : '',
  };
`,
    'preserve manual record fields',
  );
  source = replaceOnce(
    source,
`  for (const key of ['completedTaskIds', 'note', 'debt', 'mistakes']) {
    result[key] = chooseSide(local[key], remote[key], previous[key], localUpdatedAt, remoteUpdatedAt).value;
  }
`,
`  for (const key of ['completedTaskIds', 'note', 'debt', 'mistakes']) {
    result[key] = key === 'completedTaskIds'
      ? mergeStringSet(local[key], remote[key], previous[key], localUpdatedAt, remoteUpdatedAt)
      : chooseSide(local[key], remote[key], previous[key], localUpdatedAt, remoteUpdatedAt).value;
  }
`,
    'merge completed task ids',
  );
  source = replaceOnce(
    source,
`  const merged = emptySnapshot();
  merged.version = Math.max(local.version, remote.version, previous.version, 1);
`,
`  const topLevel = mergeObjectFields(local, remote, previous, local.updatedAt, remote.updatedAt);
  const merged = { ...topLevel, ...emptySnapshot() };
  merged.version = Math.max(local.version, remote.version, previous.version, 1);
  merged.updatedAt = latestTimestamp(local.updatedAt, remote.updatedAt, topLevel.updatedAt);
`,
    'preserve top-level fields',
  );
  write('scripts/merge-learning-data.cjs', source);
}

// Local normalization must not erase fields introduced by newer clients.
{
  let source = read('scripts/learning-data-store.cjs');
  source = replaceOnce(source, '    return {\n      id: (asOptionalString(item.id)', '    return {\n      ...clone(item),\n      id: (asOptionalString(item.id)', 'preserve attachment fields');
  source = replaceOnce(source, '  return {\n    noteUid,\n    capturedDate:', '  return {\n    ...clone(value),\n    noteUid,\n    capturedDate:', 'preserve note fields');
  source = replaceOnce(source, '  return {\n    id,\n    noteUid,', '  return {\n    ...clone(value),\n    id,\n    noteUid,', 'preserve card fields');
  source = replaceOnce(
    source,
`  return {
    manual: normalizeManualRecord(source.manual),
    autoNotes: dedupedNotes,
  };
`,
`  return {
    ...clone(source),
    manual: normalizeManualRecord(source.manual),
    autoNotes: dedupedNotes,
  };
`,
    'preserve day fields',
  );
  source = replaceOnce(
    source,
`  return {
    deletedAt: asOptionalString(value.deletedAt) || note.updatedAt || note.createdAt,
    note,
    cards: [...new Map(cards.map((card) => [card.id, card])).values()],
  };
`,
`  return {
    ...clone(value),
    deletedAt: asOptionalString(value.deletedAt) || note.updatedAt || note.createdAt,
    note,
    cards: [...new Map(cards.map((card) => [card.id, card])).values()],
  };
`,
    'preserve tombstone fields',
  );
  source = replaceOnce(
    source,
`  return {
    version: LEARNING_DATA_VERSION,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    days,
    cards: dedupedCards,
    deletedNotes,
  };
`,
`  return {
    ...clone(value),
    version: LEARNING_DATA_VERSION,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    days,
    cards: dedupedCards,
    deletedNotes,
  };
`,
    'preserve normalized snapshot fields',
  );
  write('scripts/learning-data-store.cjs', source);
}

// Browser normalization is also forward-compatible.
{
  let source = read('src/utils/learningData.ts');
  source = replaceOnce(
    source,
`  return {
    noteUid: value.noteUid,
`,
`  return {
    ...value,
    noteUid: value.noteUid,
`,
    'preserve frontend note fields',
  );
  write('src/utils/learningData.ts', source);
}

// Behavioral regressions for independent fields, deletions and future metadata.
{
  let source = read('scripts/__tests__/merge-learning-data.test.cjs');
  const marker = "test('field-level merge preserves independent note changes and future fields'";
  if (!source.includes(marker)) {
    source += `

test('field-level merge preserves independent note changes and future fields', () => {
  const previous = base();
  const local = structuredClone(previous);
  const remote = structuredClone(previous);
  const localNote = local.days['2026-07-24'].autoNotes[0];
  const remoteNote = remote.days['2026-07-24'].autoNotes[0];
  local.updatedAt = '2026-07-24T01:00:00.000Z';
  localNote.updatedAt = local.updatedAt;
  localNote.title = '本地修改后的标题';
  localNote.localFuture = { retained: true };

  remote.updatedAt = '2026-07-24T02:00:00.000Z';
  remoteNote.updatedAt = remote.updatedAt;
  remoteNote.attachments = [{
    id: 'asset-1',
    kind: 'pdf',
    name: '讲义.pdf',
    filePath: 'github://data/assets/n1/讲义.pdf',
    checksum: 'sha256:future',
  }];
  remoteNote.facets = ['quick', 'knowledge'];
  remoteNote.sourceType = 'material-note';
  remoteNote.sourceBatchId = 'batch-remote';
  remoteNote.remoteFuture = { retained: true };

  const merged = mergeSnapshots(local, remote, previous);
  const note = merged.days['2026-07-24'].autoNotes[0];
  assert.equal(note.title, '本地修改后的标题');
  assert.deepEqual(note.facets, ['quick', 'knowledge']);
  assert.equal(note.attachments[0].checksum, 'sha256:future');
  assert.equal(note.sourceBatchId, 'batch-remote');
  assert.deepEqual(note.localFuture, { retained: true });
  assert.deepEqual(note.remoteFuture, { retained: true });
});

test('three-way set and attachment merge respects explicit local removals', () => {
  const previous = base();
  const previousNote = previous.days['2026-07-24'].autoNotes[0];
  previousNote.facets = ['quick', 'knowledge'];
  previousNote.tags = ['速记', '知识'];
  previousNote.attachments = [
    { id: 'a', name: '保留.pdf', filePath: 'github://data/assets/n1/a.pdf', createdAt: '2026-07-24T00:00:00.000Z' },
    { id: 'b', name: '删除.pdf', filePath: 'github://data/assets/n1/b.pdf', createdAt: '2026-07-24T00:00:00.000Z' },
  ];

  const local = structuredClone(previous);
  local.updatedAt = '2026-07-24T02:00:00.000Z';
  const localNote = local.days['2026-07-24'].autoNotes[0];
  localNote.updatedAt = local.updatedAt;
  localNote.facets = ['quick'];
  localNote.tags = ['速记'];
  localNote.attachments = [localNote.attachments[0]];

  const remote = structuredClone(previous);
  remote.updatedAt = '2026-07-24T03:00:00.000Z';

  const note = mergeSnapshots(local, remote, previous).days['2026-07-24'].autoNotes[0];
  assert.deepEqual(note.facets, ['quick']);
  assert.deepEqual(note.tags, ['速记']);
  assert.deepEqual(note.attachments.map((item) => item.id), ['a']);
});

test('card text edits and remote review progress merge independently', () => {
  const previous = base();
  const local = structuredClone(previous);
  const remote = structuredClone(previous);
  local.updatedAt = '2026-07-24T01:00:00.000Z';
  local.cards[0].updatedAt = local.updatedAt;
  local.cards[0].front = '本地改过的问题';

  remote.updatedAt = '2026-07-24T02:00:00.000Z';
  remote.cards[0].updatedAt = remote.updatedAt;
  remote.cards[0].reviewHistory = [{
    id: 'review-remote',
    reviewedAt: remote.updatedAt,
    result: 'remembered',
    thought: '远端完成复习',
  }];
  remote.cards[0].reviewCount = 1;

  const card = mergeSnapshots(local, remote, previous).cards[0];
  assert.equal(card.front, '本地改过的问题');
  assert.equal(card.reviewHistory[0].thought, '远端完成复习');
  assert.equal(card.reviewCount, 1);
});
`;
  }
  write('scripts/__tests__/merge-learning-data.test.cjs', source);
}

{
  const file = 'scripts/__tests__/learning-data-lossless-normalization.test.cjs';
  if (!fs.existsSync(path.join(root, file))) {
    write(file, `'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeSnapshot } = require('../learning-data-store.cjs');

test('normalization preserves future snapshot, note, attachment and card fields', () => {
  const snapshot = normalizeSnapshot({
    version: 1,
    revision: 3,
    updatedAt: '2026-07-24T00:00:00.000Z',
    futureSnapshot: { enabled: true },
    days: {
      '2026-07-24': {
        futureDay: 'kept',
        manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' },
        autoNotes: [{
          noteUid: 'future-note',
          capturedDate: '2026-07-24',
          title: '未来字段',
          subject: '默认文件夹',
          futureNote: { value: 7 },
          attachments: [{
            id: 'asset-1',
            name: '资料.pdf',
            filePath: 'github://data/assets/future-note/资料.pdf',
            futureAttachment: 'kept',
          }],
        }],
      },
    },
    cards: [{
      id: 'future-card',
      noteUid: 'future-note',
      futureCard: 'kept',
    }],
    deletedNotes: {},
  });

  assert.deepEqual(snapshot.futureSnapshot, { enabled: true });
  assert.equal(snapshot.days['2026-07-24'].futureDay, 'kept');
  assert.deepEqual(snapshot.days['2026-07-24'].autoNotes[0].futureNote, { value: 7 });
  assert.equal(snapshot.days['2026-07-24'].autoNotes[0].attachments[0].futureAttachment, 'kept');
  assert.equal(snapshot.cards[0].futureCard, 'kept');
});
`);
  }
}

console.log('Applied quick-note visibility and lossless learning-data merge patch.');
