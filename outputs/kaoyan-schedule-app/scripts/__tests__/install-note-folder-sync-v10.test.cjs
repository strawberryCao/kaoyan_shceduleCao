const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptsRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(scriptsRoot, 'install-note-folder-sync.ps1'), 'utf8');
const runtime = fs.readFileSync(path.join(scriptsRoot, 'windows-note-folder-sync.ps1'), 'utf8');

test('v14 installer deploys the source-complete V2 synchronization runtime', () => {
  assert.match(installer, /20260729-entry-v2-v14/);
  assert.match(installer, /version = 14/);
  assert.match(installer, /v2-local-adapter\.cjs/);
  assert.match(runtime, /V2 local data adapter/);
  assert.match(installer, /optionalGitPathsAreFiltered = \$true/);
  assert.match(installer, /learningDataDirection = 'bidirectional-structured-merge'/);
  assert.match(installer, /agent-workflow-contracts\.cjs/);
  assert.match(installer, /note-ai-analyzer\.cjs/);
  assert.doesNotMatch(installer, /20260725-public-lan-parity-v11/);
  assert.doesNotMatch(installer, /enable structured learning-data merge/);
});

test('source runtime filters absent optional Git paths and merges cloud learning data directly', () => {
  assert.match(runtime, /Test-Path -LiteralPath \(Join-Path \$ClonePath \$candidate\)/);
  assert.match(runtime, /Invoke-Git @\('ls-files', '--', \$candidate\)/);
  assert.match(runtime, /Invoke-Git \(@\('add', '-A', '--'\) \+ \$paths\)/);
  assert.match(runtime, /'data\/cloud\/learning-data\.json'/);
  assert.match(runtime, /merge-learning-data\.cjs/);
  assert.match(runtime, /Learning data merge failed/);
  assert.match(runtime, /github:\/\/source-notes\//);
  assert.match(runtime, /Write-JsonAtomic \$remoteSidecar \$sidecar/);
  assert.doesNotMatch(runtime, /remoteSidecarValue|remoteItems/);
});
