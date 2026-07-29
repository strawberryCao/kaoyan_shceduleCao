import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function findPowerShell() {
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe']
    : ['pwsh'];
  for (const executable of candidates) {
    const probe = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
    });
    if (!probe.error && probe.status === 0) return executable;
  }
  return null;
}

const powershell = findPowerShell();

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

test('Windows note and assistant synchronization scripts parse without PowerShell errors', {
  skip: powershell ? false : 'PowerShell is not installed in this environment',
}, () => {
  const scripts = [
    'windows-note-folder-sync.ps1',
    'windows-assistant-config-sync.ps1',
    'install-note-folder-sync.ps1',
    'start-local-services-hidden.ps1',
  ].map((file) => path.resolve(import.meta.dirname, file));
  const command = `
$failed = $false
foreach ($file in @(${scripts.map(quote).join(',')})) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null
  if (@($errors).Count -gt 0) {
    $failed = $true
    $errors | ForEach-Object { Write-Error ($file + ' : ' + $_.Message) }
  }
}
if ($failed) { exit 1 }
`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`.trim());
});

test('legacy mirror excludes V2 metadata, hash assets, and old conflict copies', () => {
  const source = path.resolve(import.meta.dirname, 'windows-note-folder-sync.ps1');
  const script = fs.readFileSync(source, 'utf8');
  assert.match(script, /function Test-LegacyMirrorPath/);
  assert.match(script, /\$segments -contains '\.metadata'/);
  assert.match(script, /\$segments -contains '\.assets'/);
  assert.match(script, /\*sync-conflict-\*/);
  assert.match(script, /Test-LegacyMirrorPath \$relative/);
  assert.match(script, /function Push-WithStructuredRetry/);
  assert.match(script, /function Invoke-LearningMergeWithRetry/);
  assert.match(script, /Start-Sleep -Milliseconds \(200 \* \$attempt\)/);
  const commitFunction = script.indexOf('function Commit-Pending');
  const retryFunction = script.indexOf('function Push-WithStructuredRetry');
  assert.ok(commitFunction >= 0 && retryFunction > commitFunction);
  assert.match(script.slice(commitFunction, retryFunction), /return \$false\s*\r?\n\}/);
  assert.match(script, /rebase', '-X', 'ours'/);
  assert.match(script, /Learning data re-merge failed after a concurrent cloud write/);
  assert.match(script, /if \(-not \$meta\.updatedAt -or \$metadataChanged\)/);
});
