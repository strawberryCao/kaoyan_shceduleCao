'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPersistentAiRequestGuard,
  localDateKey,
  readDailyAttempts,
} = require('../ai-request-budget.cjs');

test('AI usage protection enforces the configured limit and can be disabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-ai-budget-'));
  const logPath = path.join(root, 'attempts.jsonl');
  let settings = { enabled: true, dailyRequestLimit: 2 };
  const guard = createPersistentAiRequestGuard({
    assistantRoot: root,
    logPath,
    getSettings: () => settings,
  });

  try {
    guard({ task: 'note_naming', provider: 'kimi', model: 'test-model' });
    guard({ task: 'semantic_search', provider: 'deepseek', model: 'test-model' });
    assert.throws(
      () => guard({ task: 'note_naming', provider: 'kimi', model: 'test-model' }),
      (error) => error?.code === 'AI_DAILY_REQUEST_LIMIT',
    );
    assert.equal(readDailyAttempts(logPath, localDateKey()), 2);

    settings = { enabled: false, dailyRequestLimit: 1 };
    guard({ task: 'note_naming', provider: 'kimi', model: 'test-model' });
    assert.equal(readDailyAttempts(logPath, localDateKey()), 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI usage protection reloads settings for every request', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-ai-budget-live-'));
  const logPath = path.join(root, 'attempts.jsonl');
  let dailyRequestLimit = 1;
  const guard = createPersistentAiRequestGuard({
    assistantRoot: root,
    logPath,
    getSettings: () => ({ enabled: true, dailyRequestLimit }),
  });

  try {
    guard({ task: 'custom' });
    assert.throws(() => guard({ task: 'custom' }), (error) => error?.code === 'AI_DAILY_REQUEST_LIMIT');
    dailyRequestLimit = 3;
    guard({ task: 'custom' });
    assert.equal(readDailyAttempts(logPath, localDateKey()), 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
