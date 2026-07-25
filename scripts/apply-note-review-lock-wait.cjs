'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(
  __dirname,
  '..',
  'outputs',
  'kaoyan-schedule-app',
  'scripts',
  'note-server.cjs',
);
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) {
    if (source.includes(after)) return;
    throw new Error(`Missing note-server anchor: ${label}`);
  }
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Ambiguous note-server anchor: ${label}`);
  }
  source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

const helperAnchor = `function queueAiNamingJob(noteUid) {
  if (aiNamingJobs.has(noteUid)) return;`;
const helperReplacement = `async function acquireOrganizerLockForHumanAction(timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      return acquireOrganizerLock(ORGANIZER_LOCK_PATH);
    } catch (error) {
      if (error?.code !== 'ORGANIZER_LOCKED') throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || Object.assign(new Error('Note organizer is still running'), { code: 'ORGANIZER_LOCKED' });
}

function queueAiNamingJob(noteUid) {
  if (aiNamingJobs.has(noteUid)) return;`;
replaceOnce(helperAnchor, helperReplacement, 'human organizer lock helper');

replaceOnce(
  `    if (reviewAction) {
      const releaseOrganizerLock = acquireOrganizerLock(ORGANIZER_LOCK_PATH);`,
  `    if (reviewAction) {
      // AI naming immediately queues a one-note organizer pass. A human correction
      // submitted at that moment must wait for the short-lived filesystem lock,
      // rather than surfacing a false 409 conflict to the user.
      const releaseOrganizerLock = await acquireOrganizerLockForHumanAction();`,
  'legacy note patch lock acquisition',
);

fs.writeFileSync(target, source, 'utf8');
console.log('Applied organizer-lock wait for human note corrections.');
