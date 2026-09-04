const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('quick material attachments survive remounts and do not leak into the image capture paste handler', () => {
  const composer = read('src/components/QuickMaterialComposer.tsx');
  const draft = read('src/utils/quickMaterialDraft.ts');

  assert.match(composer, /loadQuickMaterialDraft\(\)/);
  assert.match(composer, /saveQuickMaterialDraft\(\{/);
  assert.match(composer, /filesRef\.current/);
  assert.match(composer, /event\.stopPropagation\(\)/);
  assert.match(composer, /await clearQuickMaterialDraft\(\)/);
  assert.match(draft, /indexedDB\.open/);
  assert.match(draft, /memoryDraft/);
  assert.match(draft, /store\.put\(draft, ACTIVE_DRAFT_KEY\)/);
});
