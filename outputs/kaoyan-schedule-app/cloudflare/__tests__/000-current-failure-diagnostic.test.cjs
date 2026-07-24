const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (/\.(?:test\.cjs|test\.mjs)$/.test(entry.name) && !entry.name.startsWith('000-current-failure-diagnostic')) output.push(full);
  }
  return output;
}

test('print current suite failures before ordinary TAP output', () => {
  if (process.env.KAOYAN_INNER_DIAGNOSTIC === '1') return;
  const root = path.resolve(__dirname, '..', '..');
  const files = [...walk(path.join(root, 'cloudflare')), ...walk(path.join(root, 'scripts'))].sort();
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KAOYAN_INNER_DIAGNOSTIC: '1', CAOBIJI_GITHUB_TOKEN: '' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const lines = output.split(/\r?\n/);
  const interesting = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/not ok|failureType|AssertionError|ERR_ASSERTION|SyntaxError|TypeError|ReferenceError/.test(lines[index])) continue;
    interesting.push(...lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 32)));
  }
  console.log('=== EARLY FULL-SUITE DIAGNOSTIC ===');
  console.log(`innerExit=${result.status}`);
  console.log(interesting.length > 0 ? [...new Set(interesting)].join('\n') : output.slice(-8000));
  console.log('=== END EARLY DIAGNOSTIC ===');
});
