const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

test('schedule always covers today plus a future planning horizon', () => {
  const source = fs.readFileSync(path.join(root, 'src/utils/schedule.ts'), 'utf8');
  assert.match(source, /const FUTURE_SCHEDULE_DAYS = 120/);
  assert.match(source, /elapsed \+ FUTURE_SCHEDULE_DAYS \+ 1/);
  assert.match(source, /days\.filter\(\(day\) => day\.date <= today\)\.forEach/);
});

test('schedule UI does not claim to be a fixed thirty-day window', () => {
  const app = fs.readFileSync(path.join(root, 'src/components/ScheduleApp.tsx'), 'utf8');
  const sidebar = fs.readFileSync(path.join(root, 'src/components/Sidebar.tsx'), 'utf8');
  assert.doesNotMatch(app, />30 天统计</);
  assert.doesNotMatch(sidebar, /aria-label="30 天日期列表"/);
});
