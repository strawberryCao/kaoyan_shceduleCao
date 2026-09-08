'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('activity center exposes explicit Mac AI retries and reversible conflict choices', () => {
  const activity = read('src/components/ActivityCenter.tsx');
  const notes = read('src/utils/notes.ts');
  const policy = read('scripts/lan-gateway-policy.cjs');
  const styles = read('src/activity-center.css');

  assert.match(activity, /Mac AI 处理中心/);
  assert.match(activity, /job\.requiresExplicitRetry/);
  assert.match(activity, /模型请求 \{job\.billableAttemptCount \|\| 0\} 次/);
  assert.match(activity, /数据版本选择/);
  assert.match(activity, /保留这一版/);
  assert.match(activity, /采用这一版/);
  assert.match(activity, /系统不会静默覆盖任一版本/);
  assert.match(activity, /undoSyncConflict/);
  assert.match(notes, /retryAuthorityAiTask/);
  assert.match(notes, /resolveSyncConflict/);
  assert.match(policy, /\/ai\/tasks/);
  assert.match(policy, /\/sync\/conflicts/);
  assert.match(styles, /authority-ai-card>button\{min-height:44px/);
  assert.match(styles, /conflict-choices>button\{[^}]*touch-action:manipulation/);
});

test('remote shell can log out and never exposes desktop-only routes', () => {
  const app = read('src/App.tsx');
  const shell = read('src/components/WebAppShell.tsx');
  const styles = read('src/web-app-shell.css');

  assert.match(app, /IS_CLOUD_RUNTIME && \(isAiConfigMode \|\| isConsoleMode \|\| isWallpaperMode\)/);
  assert.match(app, /isWallpaperMode && !window\.kaoyanDesktop\?\.isElectron/);
  assert.match(shell, /window\.kaoyanDesktop\?\.isElectron &&/);
  assert.match(shell, /fetch\('\/api\/auth\/logout'/);
  assert.match(shell, /尚未送达 Mac 的加密速记会保留/);
  assert.match(styles, /web-app-mobile-logout/);
  assert.match(styles, /min-height: 44px/);
});
