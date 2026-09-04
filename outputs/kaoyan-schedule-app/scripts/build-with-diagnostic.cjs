const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const diagnosticPath = 'data/diagnostics/learning-record-build-error.json';
const migrationMarker = path.join(__dirname, '.apply-real-learning-records-v1');
const liveDistPath = path.join(root, 'dist');
const stagedDistPath = path.join(root, `.dist-build-${process.pid}`);
const backupDistPath = path.join(root, `.dist-previous-${process.pid}`);

function runNodeScript(modulePath, args) {
  return spawnSync(process.execPath, [modulePath, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}

async function publishDiagnostic(phase, result) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const token = String(process.env.CAOBIJI_GITHUB_TOKEN || '').trim();
  if (!token) return;
  const repository = String(process.env.DATA_REPOSITORY || 'strawberryCao/Caobijidata');
  const branch = String(process.env.DATA_BRANCH || 'main');
  const url = `https://api.github.com/repos/${repository}/contents/${diagnosticPath}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'kaoyan-learning-record-build',
  };
  let sha = '';
  const current = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
  if (current.ok) {
    const payload = await current.json();
    sha = typeof payload.sha === 'string' ? payload.sha : '';
  } else if (current.status !== 404) {
    throw new Error(`Unable to inspect build diagnostic target: HTTP ${current.status}`);
  }
  const diagnostic = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    phase,
    exitCode: result.status,
    signal: result.signal || '',
    stdout: String(result.stdout || '').slice(-40000),
    stderr: String(result.stderr || '').slice(-40000),
    actionRunId: String(process.env.GITHUB_RUN_ID || ''),
    sourceCommit: String(process.env.GITHUB_SHA || ''),
  };
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: 'diagnostic: update learning record build error',
      content: Buffer.from(`${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Unable to publish build diagnostic: HTTP ${response.status}`);
}

function publishStaticBuild(stagedPath, livePath, backupPath) {
  if (!fs.existsSync(path.join(stagedPath, 'index.html'))) {
    throw new Error('Staged build is incomplete: index.html is missing.');
  }
  fs.rmSync(backupPath, { recursive: true, force: true });
  const hadLiveBuild = fs.existsSync(livePath);
  try {
    if (hadLiveBuild) fs.renameSync(livePath, backupPath);
    fs.renameSync(stagedPath, livePath);
  } catch (error) {
    if (!fs.existsSync(livePath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, livePath);
    }
    throw error;
  }
  fs.rmSync(backupPath, { recursive: true, force: true });
}

async function main() {
  fs.rmSync(stagedDistPath, { recursive: true, force: true });
  const tsc = require.resolve('typescript/bin/tsc');
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const stages = [
    ['typescript', tsc, ['-p', 'tsconfig.json', '--noEmit']],
    ['vite', vite, ['build', '--config', 'vite.config.mjs', '--outDir', stagedDistPath, '--emptyOutDir']],
  ];
  if (process.env.GITHUB_ACTIONS === 'true' && fs.existsSync(migrationMarker)) {
    stages.push([
      'wrangler-dry-run',
      path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      ['deploy', '--dry-run'],
    ]);
  }
  for (const [phase, modulePath, args] of stages) {
    const result = runNodeScript(modulePath, args);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      fs.rmSync(stagedDistPath, { recursive: true, force: true });
      await publishDiagnostic(phase, result);
      process.exitCode = result.status || 1;
      return;
    }
    if (phase === 'vite') publishStaticBuild(stagedDistPath, liveDistPath, backupDistPath);
  }
}

if (require.main === module) main().catch(async (error) => {
  const stack = String(error?.stack || error || 'Unknown build runner error');
  console.error(stack);
  try {
    await publishDiagnostic('build-runner', {
      status: 1,
      signal: '',
      stdout: '',
      stderr: stack,
    });
  } catch (diagnosticError) {
    console.error(diagnosticError?.stack || diagnosticError);
  }
  process.exitCode = 1;
});

module.exports = { publishStaticBuild };
