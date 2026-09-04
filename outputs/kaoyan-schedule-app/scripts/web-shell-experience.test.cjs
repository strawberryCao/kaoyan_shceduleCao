const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('keeps canvas in the core desktop and mobile navigation', () => {
  const shell = read('src/components/WebAppShell.tsx');
  const primaryStart = shell.indexOf('const primaryItems');
  const workspaceStart = shell.indexOf('const workspaceItems');
  const primary = shell.slice(primaryStart, workspaceStart);

  assert.ok(primary.indexOf("label: '今天'") < primary.indexOf("label: '画布'"));
  assert.ok(primary.indexOf("label: '画布'") < primary.indexOf("label: '学习计划'"));
  assert.match(primary, /mode=canvas/);
  assert.match(shell, /key: 'canvas'.+label: '画布'.+mode=canvas/);
});

test('mobile capture is an action and never pretends to be the current page', () => {
  const shell = read('src/components/WebAppShell.tsx');

  assert.match(shell, /key: 'capture'.+active: false/);
  assert.match(shell, /role="status" aria-live="polite"/);
  assert.match(shell, /速记已打开，可以直接拖入或粘贴资料/);
});

test('capture launcher reports whether the desktop note app opened', () => {
  const dock = read('src/components/NoteDock.tsx');
  const start = dock.indexOf('export const openNoteCaptureApp = async');
  const end = dock.indexOf('export const closeNoteCaptureApp', start);
  const launcher = dock.slice(start, end);

  assert.match(launcher, /return true/);
  assert.match(launcher, /return false/);
});

test('review sessions cap the mounted queue and keep four recall grades', () => {
  const source = read('src/components/LearningCenter.tsx');
  assert.match(source, /const REVIEW_SESSION_SIZE = 30/);
  assert.match(source, /const reviewCards = useMemo\(\(\) => dueCards\.slice\(0, reviewSessionSlots\)/);
  assert.match(source, /\{reviewCards\.map\(\(card\) => \(/);
  for (const rating of ['again', 'hard', 'good', 'easy']) {
    assert.match(source, new RegExp(`reviewRating: '${rating}'`));
  }
  assert.match(source, /\u5269\u4f59 \{dueCards\.length\} \u5f20\u4ecd\u4f1a\u4fdd\u7559/);
});

test('internal navigation avoids full page reloads and remounts URL-driven learning views', () => {
  const navigation = read('src/utils/appNavigation.ts');
  const app = read('src/App.tsx');
  assert.match(navigation, /window\.history\.pushState/);
  assert.match(navigation, /APP_LOCATION_EVENT/);
  assert.match(app, /useSyncExternalStore\(subscribeAppLocation/);
  assert.match(app, /<ScheduleApp key=\{appLocation\} \/>/);
});
