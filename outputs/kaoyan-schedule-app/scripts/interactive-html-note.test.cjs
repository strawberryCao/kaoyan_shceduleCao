'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Learning Center HTML creation has an independent configurable endpoint and timeout envelope', () => {
  const client = read('src/utils/notes.ts');
  const server = read('scripts/note-server.cjs');
  const studio = read('src/components/QuickHtmlStudio.tsx');
  assert.match(client, /\/ai\/html-note/);
  assert.match(client, /tasks\?\.interactive_note_generation/);
  assert.match(client, /timeoutMs \* \(1 \+ networkRetries \+ jsonRepairRetries\) \* candidateCount \+ 15_000/);
  assert.doesNotMatch(client, /\/ai\/widget[\s\S]{0,500}55_000/);
  assert.match(server, /handleGenerateWidget\(req, res, 'interactive_note_generation'\)/);
  assert.match(server, /AI_HTML_EVENTS_PATH/);
  assert.match(server, /new vm\.Script\(String\(js\)/);
  assert.match(server, /maxCandidateCount: isInteractiveNote \? 2/);
  assert.match(server, /overallTimeoutMs: isInteractiveNote \? 570_000/);
  assert.match(studio, /\?aiConfig=1&task=interactive_note_generation/);
});

test('HTML size settings survive into the saved safe artifact', () => {
  const client = read('src/utils/notes.ts');
  const studio = read('src/components/QuickHtmlStudio.tsx');
  const artifact = read('src/utils/safeHtmlArtifact.ts');
  assert.match(client, /width: Math\.max\(240/);
  assert.match(studio, /width: artifact\.width/);
  assert.match(studio, /height: artifact\.height/);
  assert.match(artifact, /data-kaoyan-artifact-width/);
  assert.match(artifact, /max-width:\$\{width\}px/);
});

test('cloud HTML generation uses the same independent task and structured-output compatibility option', () => {
  const worker = read('cloudflare/worker.js');
  const generation = read('cloudflare/widget-generation.js');
  const provider = read('cloudflare/agent-provider.js');
  assert.match(worker, /pathname === '\/ai\/html-note'/);
  assert.match(generation, /payload\.taskId === 'interactive_note_generation'/);
  assert.match(generation, /getTaskSettings\(env, taskId\)/);
  assert.match(generation, /settings\.customInstructions/);
  assert.match(generation, /options\.interactionLevel/);
  assert.match(generation, /maxCandidateCount: isInteractiveNote \? 2/);
  assert.match(provider, /options\.structuredOutputMode !== 'prompt_only'/);
  assert.match(provider, /jsonRepairRetries/);
  assert.match(provider, /repairedJsonRequest/);
});
