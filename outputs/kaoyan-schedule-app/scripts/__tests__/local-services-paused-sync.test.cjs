const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const launcher = fs.readFileSync(
  path.resolve(__dirname, '..', 'start-local-services-hidden.ps1'),
  'utf8',
);

test('starting LAN services does not run global sync while V13 is paused', () => {
  assert.match(launcher, /\$syncConfig\.autoSyncEnabled -eq \$true/);
  assert.match(launcher, /\$syncConfig\.persistenceMode -eq 'installed-paused'/);
  assert.match(launcher, /if \(-not \$autoSyncEnabled -or \$syncIsPaused\) \{ return \}/);
  assert.match(launcher, /Start-Process[\s\S]*\$runner/);
});
