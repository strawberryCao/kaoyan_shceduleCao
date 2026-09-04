'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DAILY_LIMIT = 200;
const MAX_DAILY_LIMIT = 10_000;
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 15_000;

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeAiUsageProtection(value = {}) {
  const configuredLimit = Number(value?.dailyRequestLimit);
  return {
    enabled: value?.enabled !== false,
    dailyRequestLimit: Number.isInteger(configuredLimit) && configuredLimit > 0
      ? Math.min(configuredLimit, MAX_DAILY_LIMIT)
      : DEFAULT_DAILY_LIMIT,
  };
}

function readDailyAttempts(logPath, dateKey) {
  if (!fs.existsSync(logPath)) return 0;
  try {
    return fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((count, line) => {
        try {
          const entry = JSON.parse(line);
          return entry?.date === dateKey ? count + 1 : count;
        } catch {
          return count;
        }
      }, 0);
  } catch {
    return 0;
  }
}

function waitBriefly(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(handle, `${process.pid}\n`, 'utf8');
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      waitBriefly(25);
    }
  }
  const error = new Error('AI 请求保护器正忙，本次请求未发送；请稍后再试。');
  error.code = 'AI_REQUEST_BUDGET_BUSY';
  error.retryable = false;
  throw error;
}

function releaseLock(lockPath, handle) {
  try { fs.closeSync(handle); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}
}

function createPersistentAiRequestGuard(options = {}) {
  const assistantRoot = path.resolve(String(options.assistantRoot || process.cwd()));
  const logPath = path.resolve(String(options.logPath || path.join(assistantRoot, 'ai-request-attempts.jsonl')));
  const lockPath = `${logPath}.lock`;

  return function beforeAiRequest(event = {}) {
    const configured = typeof options.getSettings === 'function'
      ? options.getSettings()
      : options.usageProtection || {
          enabled: process.env.KAOYAN_AI_USAGE_PROTECTION !== '0',
          dailyRequestLimit: Number(process.env.KAOYAN_AI_DAILY_REQUEST_LIMIT),
        };
    const protection = normalizeAiUsageProtection(configured);
    const now = new Date();
    const date = localDateKey(now);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const lockHandle = acquireLock(lockPath);
    try {
      const used = readDailyAttempts(logPath, date);
      if (protection.enabled && used >= protection.dailyRequestLimit) {
        const error = new Error(`AI 每日请求安全上限已达到（${protection.dailyRequestLimit} 次）；可在 AI 配置页调整或关闭用量保护。`);
        error.code = 'AI_DAILY_REQUEST_LIMIT';
        error.retryable = false;
        throw error;
      }
      fs.appendFileSync(logPath, `${JSON.stringify({
        at: now.toISOString(),
        date,
        task: String(event.task || 'custom').slice(0, 80),
        provider: String(event.provider || '').slice(0, 80),
        model: String(event.model || '').slice(0, 160),
        phase: String(event.phase || 'request').slice(0, 40),
        attempt: Number(event.attempt) || 1,
        protectionEnabled: protection.enabled,
        dailyRequestLimit: protection.dailyRequestLimit,
      })}\n`, 'utf8');
      return {
        used: used + 1,
        remaining: protection.enabled ? Math.max(0, protection.dailyRequestLimit - used - 1) : null,
        ...protection,
      };
    } finally {
      releaseLock(lockPath, lockHandle);
    }
  };
}

module.exports = {
  DEFAULT_DAILY_LIMIT,
  MAX_DAILY_LIMIT,
  createPersistentAiRequestGuard,
  localDateKey,
  normalizeAiUsageProtection,
  readDailyAttempts,
};
