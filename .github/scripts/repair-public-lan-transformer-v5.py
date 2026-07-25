from pathlib import Path
import subprocess
import sys

subprocess.run([sys.executable, '.github/scripts/repair-public-lan-transformer-v4.py'], check=True)

path = Path('.github/scripts/apply-public-lan-parity.cjs')
source = path.read_text(encoding='utf-8')

injection = r'''
// Keep runtime exports byte-stable until a local configuration file actually changes.
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "  const includedFiles = [];\n  const excludedCounts = {};",
  "  const includedFiles = [];\n  const excludedCounts = {};\n  let latestConfigModifiedAt = 0;",
  'exporter deterministic publication timestamp state',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "    const parsed = readJson(filePath, {});",
  "    try { latestConfigModifiedAt = Math.max(latestConfigModifiedAt, fs.statSync(filePath).mtimeMs); } catch {}\n    const parsed = readJson(filePath, {});",
  'exporter deterministic publication timestamp input',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/export-agent-runtime.cjs',
  "  const publishedAt = new Date().toISOString();",
  "  const publishedAt = latestConfigModifiedAt > 0 ? new Date(latestConfigModifiedAt).toISOString() : null;",
  'exporter deterministic publication timestamp',
);

replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/install-note-folder-sync.ps1',
  "  version = 10",
  "  version = 11",
  'installer configuration version 11',
);
replaceOnce(
  'outputs/kaoyan-schedule-app/scripts/install-note-folder-sync.ps1',
  "全局同步 v10 已启用。",
  "全局同步 v11 已启用。",
  'installer completion text v11',
);
write('outputs/kaoyan-schedule-app/scripts/__tests__/install-note-folder-sync-v10.test.cjs', String.raw`const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptsRoot = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(scriptsRoot, 'install-note-folder-sync.ps1'), 'utf8');
const runtime = fs.readFileSync(path.join(scriptsRoot, 'windows-note-folder-sync.ps1'), 'utf8');

test('v11 installer deploys the source-complete synchronization runtime', () => {
  assert.match(installer, /20260725-public-lan-parity-v11/);
  assert.match(installer, /version = 11/);
  assert.match(installer, /optionalGitPathsAreFiltered = \$true/);
  assert.match(installer, /learningDataDirection = 'bidirectional-structured-merge'/);
  assert.match(installer, /agent-workflow-contracts\.cjs/);
  assert.doesNotMatch(installer, /enable structured learning-data merge/);
});

test('source runtime filters absent optional Git paths and merges cloud learning data directly', () => {
  assert.match(runtime, /Test-Path -LiteralPath \(Join-Path \$ClonePath \$candidate\)/);
  assert.match(runtime, /Invoke-Git @\('ls-files', '--', \$candidate\)/);
  assert.match(runtime, /Invoke-Git \(@\('add', '-A', '--'\) \+ \$paths\)/);
  assert.match(runtime, /'data\/cloud\/learning-data\.json'/);
  assert.match(runtime, /merge-learning-data\.cjs/);
  assert.match(runtime, /Learning data merge failed/);
});
`);

write('outputs/kaoyan-schedule-app/scripts/note-capture-foreground.test.cjs', String.raw`'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'NoteDropApp.tsx'), 'utf8');

test('mobile multi-question capture stays in the foreground', () => {
  const start = source.indexOf('const buildDetectedBatch');
  const end = source.indexOf('const confirmBatchCrop', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /detectQuestionRegions\(src\)/);
  assert.match(block, /cropManyImages\(src, detection\.regions\)/);
  assert.doesNotMatch(block, /enqueueMultiQuestionJob/);
  assert.match(block, /setMobileStep\('batch'\)/);
  assert.match(block, /detectionRunRef/);
});

test('single and batch image saves retry idempotently after mobile network loss', () => {
  assert.match(source, /const saveImageReliably/);
  assert.match(source, /load failed\|failed to fetch\|network/);
  assert.equal((source.match(/await saveImageReliably\(/g) || []).length, 2);
  assert.match(source, /连接中断，正在自动确认保存结果/);
});
`);

'''
marker = "process.stdout.write('public LAN parity source patch applied\\n');"
if injection not in source:
    if source.count(marker) != 1:
        raise SystemExit('transformer completion marker missing for V5')
    source = source.replace(marker, injection + marker)

path.write_text(source, encoding='utf-8')
print('public LAN transformer repaired v5')
