#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startManagedRuntime } = require('./macmini-runtime.cjs');
const { resolveRuntimePaths } = require('./runtime-paths.cjs');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 20_000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForChildrenToStop(children, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (children.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (children.size > 0) throw new Error(`Runtime children did not stop: ${[...children.keys()].join(', ')}`);
}

function removeVerifiedTemporaryRoot(runtimeRoot) {
  const temporaryBase = fs.realpathSync(os.tmpdir());
  const resolved = fs.realpathSync(runtimeRoot);
  const relative = path.relative(temporaryBase, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('kaoyan-macmini-smoke-')) {
    throw new Error(`Refusing to remove unexpected smoke-test path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function runSmokeTest() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-macmini-smoke-'));
  const runtimePaths = resolveRuntimePaths({ env: { KAOYAN_RUNTIME_ROOT: runtimeRoot } });
  const webPort = await reservePort();
  let notePort = await reservePort();
  while (notePort === webPort) notePort = await reservePort();
  let runtime;
  try {
    runtime = startManagedRuntime(runtimePaths, { webPort, notePort });
    const ready = await waitFor(`http://127.0.0.1:${webPort}/readyz`);
    const readyPayload = await ready.json();
    if (!readyPayload.ok || readyPayload.dependencies?.noteService !== 'ready') {
      throw new Error(`Unexpected readiness payload: ${JSON.stringify(readyPayload)}`);
    }
    const rejectedCredentialWrite = await fetch(`http://127.0.0.1:${notePort}/ai/providers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'qwen', apiKey: 'sk-smoke-must-never-be-written' }),
    });
    if (rejectedCredentialWrite.status !== 403 || fs.existsSync(runtimePaths.aiConfigPath)) {
      throw new Error('Managed runtime unexpectedly accepted a browser-originated provider credential.');
    }
    const taskConfiguration = await fetch(`http://127.0.0.1:${notePort}/ai/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: {}, usageProtection: { enabled: true, maxAttemptsPerDay: 100 } }),
    });
    if (!taskConfiguration.ok || !fs.existsSync(runtimePaths.aiConfigPath)) {
      throw new Error('Managed runtime could not persist a non-secret AI task configuration.');
    }
    const secretDirectoryEntries = fs.readdirSync(runtimePaths.secretsRoot);
    if (secretDirectoryEntries.some((name) => name.endsWith('.bak'))
      || fs.readFileSync(runtimePaths.aiConfigPath, 'utf8').includes('sk-smoke-must-never-be-written')) {
      throw new Error('Managed runtime leaked a rejected credential or created a secret backup.');
    }
    const learning = await waitFor(`http://127.0.0.1:${webPort}/api/learning-data`);
    const snapshot = await learning.json();
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.days) throw new Error('Learning-data smoke response is invalid.');
    if (!fs.existsSync(runtimePaths.runtimeConfigPath)) throw new Error('Managed runtime manifest was not created.');
    process.stdout.write(`Mac mini managed-runtime smoke test passed on ${webPort}/${notePort}.\n`);
  } finally {
    if (runtime) {
      runtime.stop();
      await waitForChildrenToStop(runtime.children);
    }
    if (fs.existsSync(runtimeRoot)) removeVerifiedTemporaryRoot(runtimeRoot);
  }
}

if (require.main === module) {
  runSmokeTest().catch((error) => {
    process.stderr.write(`Mac mini smoke test failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  removeVerifiedTemporaryRoot,
  reservePort,
  runSmokeTest,
  waitFor,
  waitForChildrenToStop,
};
