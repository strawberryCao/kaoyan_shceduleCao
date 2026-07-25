import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { agentRuntimeInternals, LEGACY_V11_WORKFLOW_COMPAT_PATH } from '../cloudflare/agent-runtime.js';

const root = path.resolve(import.meta.dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'cloudflare', 'agent-runtime.js'), 'utf8');

const legacySourceHash = '511f580d975f781567f37c5bf7ad9410b50c420c6622340b821e8191c40c1c22';

test('legacy V11 compatibility is bound to an exact local workflow source hash', () => {
  const runtime = {
    source: {
      workflowSources: [
        { path: 'note-ai-analyzer.cjs', sha256: 'unrelated' },
        { path: 'agent-workflow-contracts.cjs', sha256: legacySourceHash },
      ],
    },
  };
  assert.equal(agentRuntimeInternals.runtimeWorkflowSourceHash(runtime), legacySourceHash);
  assert.equal(LEGACY_V11_WORKFLOW_COMPAT_PATH, 'control-plane/compatibility/legacy-v11-analysis-workflows.json');
  assert.match(runtimeSource, /sourceHash !== LEGACY_V11_WORKFLOW_SOURCE_HASH/);
  assert.match(runtimeSource, /expiresWhenWorkflowSourceChanges !== true/);
});

test('compatibility content is independently hashed and never treated as a built-in fallback', () => {
  assert.match(runtimeSource, /workflowContentHash/);
  assert.match(runtimeSource, /actualHash = await sha256\(stableJson\(value\.workflows \|\| \{\}\)\)/);
  assert.match(runtimeSource, /declaredHash !== actualHash/);
  assert.match(runtimeSource, /allowBuiltInFallback: false/);
  assert.doesNotMatch(runtimeSource, /note-enrichment-v4[\s\S]*instructions:/);
});

test('only missing full-analysis workflows are supplied by the compatibility contract', () => {
  assert.deepEqual(agentRuntimeInternals.missingCompleteWorkflows({}), ['note_enrichment', 'note_image_understanding']);
  assert.deepEqual(agentRuntimeInternals.missingCompleteWorkflows({ note_enrichment: {} }), ['note_image_understanding']);
  assert.deepEqual(agentRuntimeInternals.missingCompleteWorkflows({ note_enrichment: {}, note_image_understanding: {} }), []);
  assert.match(runtimeSource, /workflows: \{ \.\.\.workflows, \.\.\.compatible \}/);
  assert.match(runtimeSource, /publishedWorkflowHash/);
  assert.match(runtimeSource, /compatibilityWorkflowHash/);
});


test('legacy compatibility path is outside every V11 synchronization-owned directory', () => {
  assert.ok(!LEGACY_V11_WORKFLOW_COMPAT_PATH.startsWith('data/config/local-assistant/'));
  assert.equal(LEGACY_V11_WORKFLOW_COMPAT_PATH, 'control-plane/compatibility/legacy-v11-analysis-workflows.json');
});
