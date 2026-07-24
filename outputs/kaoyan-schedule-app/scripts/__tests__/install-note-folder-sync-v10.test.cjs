const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const installerPath = path.resolve(__dirname, '..', 'install-note-folder-sync.ps1');
const source = fs.readFileSync(installerPath, 'utf8');

test('v10 installer filters absent optional Git paths without losing tracked deletions', () => {
  assert.match(source, /version = 10/);
  assert.match(source, /optionalGitPathsAreFiltered = \$true/);
  assert.match(source, /Test-Path -LiteralPath \(Join-Path \$ClonePath \$candidate\)/);
  assert.match(source, /Invoke-Git @\('ls-files', '--', \$candidate\)/);
  assert.match(source, /Invoke-Git \(@\('add', '-A', '--'\) \+ \$paths\)/);
  assert.match(source, /'data\/cloud\/learning-data\.json'/);
});

test('v10 installer fails closed when the runtime patch anchor changes', () => {
  assert.match(source, /function Replace-Required/);
  assert.match(source, /安装器无法修补运行脚本/);
  assert.doesNotMatch(source, /New-Item[^\n]+data\\deletions/);
});
