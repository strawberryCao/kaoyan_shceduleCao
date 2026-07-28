const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const testFilePattern = /\.test\.(?:cjs|mjs|js)$/i;
const ignoredDirectories = new Set(['.git', '.e2e-runtime', 'dist', 'node_modules', 'test-results']);

function collectTestFiles(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collectTestFiles(path.join(directory, entry.name), results);
      continue;
    }
    if (entry.isFile() && testFilePattern.test(entry.name)) {
      results.push(path.relative(projectRoot, path.join(directory, entry.name)));
    }
  }
  return results;
}

const testFiles = collectTestFiles(projectRoot).sort();
if (testFiles.length === 0) {
  console.error('No offline *.test.* files were found.');
  process.exit(1);
}

console.log(`Running ${testFiles.length} offline test files. Live AI diagnostics are excluded.`);
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: false,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
