const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = (relativePath) => fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('search results carry an exact note or card target into the learning center', () => {
  const palette = source('src/components/CommandPalette.tsx');
  const center = source('src/components/LearningCenter.tsx');
  const activity = source('src/components/ActivityCenter.tsx');
  const activityTasks = source('src/utils/activityTasks.ts');
  const navigation = source('src/utils/learningNavigation.ts');

  assert.match(palette, /params\.set\('noteUid', input\.noteUid\)/);
  assert.match(palette, /params\.set\('cardId', input\.cardId\)/);
  assert.match(palette, /view: learningViewForNote\(note\)/);
  assert.match(center, /get\('noteUid'\)/);
  assert.match(center, /get\('cardId'\)/);
  assert.match(center, /requested === 'library'/);
  assert.match(center, /requestedNotePending/);
  assert.match(center, /if \(requestedNoteUidRef\.current\) return/);
  assert.match(activity, /learningNoteTarget\(noteUid, note, learningTargetViewFromUrl\(task\.targetUrl\)\)/);
  assert.match(activity, /learningNoteTarget\(noteUid, undefined, preferredView\)/);
  assert.match(activityTasks, /new URL\(task\.targetUrl, window\.location\.origin\)/);
  assert.match(activityTasks, /task\.resultNoteUids\.find/);
  assert.doesNotMatch(activityTasks, /decodeURIComponent\(queryNoteUid\)/);
  assert.match(navigation, /view: learningViewForNote\(note, preferredView\)/);
  assert.match(navigation, /noteUid/);
  assert.match(center, /hydrationComplete/);
  assert.match(center, /没有找到这条记录/);
});

test('AI semantic search is visible, explicit, and never driven by a reload or input effect', () => {
  const palette = source('src/components/CommandPalette.tsx');
  const center = source('src/components/LearningCenter.tsx');

  assert.match(palette, /const runSemanticSearch = \(\) =>/);
  assert.match(palette, /onClick=\{runSemanticSearch\}/);
  assert.match(palette, /AI 搜索/);
  assert.doesNotMatch(palette, /setTimeout\(\(\) => \{\s*setSemanticState\('loading'\)/);

  assert.match(center, /每次点击只请求一次/);
  assert.match(center, /disabled=\{!query\.trim\(\) \|\| semanticSearch\.loading\}/);
  assert.match(center, /AI搜索/);
  assert.doesNotMatch(center, /\}, \[query, searchMode\]\);/);
});
