const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseArguments } = require('../configure-windows-sync.cjs');
const { resolveRuntimePaths } = require('../runtime-paths.cjs');
const {
  configPaths,
  publicWindowsSyncStatus,
  readWindowsSyncConfig,
  writeWindowsSyncConfig,
} = require('../windows-sync-config.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-windows-sync-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = resolveRuntimePaths({
    platform: 'win32',
    env: { KAOYAN_RUNTIME_LAYOUT: 'managed', LOCALAPPDATA: root, PROGRAMDATA: path.join(root, 'program-data') },
    homeDir: root,
  });
  return { root, runtime };
}

test('Windows sync configuration separates and masks the device token', (t) => {
  const { root, runtime } = fixture(t);
  assert.equal(runtime.runtimeRoot, path.win32.join(root, 'KaoyanStudyCenter'));
  const token = `ksc_sync_${'a'.repeat(43)}`;
  writeWindowsSyncConfig(runtime, {
    deviceId: 'windows-laptop',
    baseUrl: 'https://study-mac.example.ts.net/',
    token,
  });
  const paths = configPaths(runtime);
  assert.doesNotMatch(fs.readFileSync(paths.configPath, 'utf8'), /ksc_sync_|a{20}/);
  assert.equal(fs.readFileSync(paths.tokenPath, 'utf8').trim(), token);
  assert.deepEqual(readWindowsSyncConfig(runtime), {
    schemaVersion: 1,
    deviceId: 'windows-laptop',
    baseUrl: 'https://study-mac.example.ts.net',
    token,
    paths,
  });
  assert.deepEqual(publicWindowsSyncStatus(runtime), {
    configured: true,
    deviceId: 'windows-laptop',
    baseUrl: 'https://study-mac.example.ts.net',
    configPath: paths.configPath,
    token: 'stored privately',
  });
});

test('unsafe endpoints and command-line token input fail before replacing a good config', (t) => {
  const { runtime } = fixture(t);
  const originalToken = `ksc_sync_${'b'.repeat(43)}`;
  writeWindowsSyncConfig(runtime, {
    deviceId: 'windows-main',
    baseUrl: 'https://study-mac.example.ts.net',
    token: originalToken,
  });
  assert.throws(() => writeWindowsSyncConfig(runtime, {
    deviceId: 'windows-main',
    baseUrl: 'http://100.64.0.10',
    token: `ksc_sync_${'c'.repeat(43)}`,
  }), /requires HTTPS/);
  assert.equal(readWindowsSyncConfig(runtime).token, originalToken);
  assert.throws(() => parseArguments(['wizard', '--token=visible-secret']), /Unknown argument/);

  fs.writeFileSync(configPaths(runtime).configPath, JSON.stringify({ schemaVersion: 99, deviceId: 'future' }));
  assert.throws(() => readWindowsSyncConfig(runtime), (error) => error.code === 'WINDOWS_SYNC_CONFIG_TOO_NEW');
  assert.throws(() => writeWindowsSyncConfig(runtime, {
    deviceId: 'windows-main',
    baseUrl: 'https://study-mac.example.ts.net',
    token: originalToken,
  }), (error) => error.code === 'WINDOWS_SYNC_CONFIG_TOO_NEW');
  assert.equal(JSON.parse(fs.readFileSync(configPaths(runtime).configPath, 'utf8')).schemaVersion, 99);
});
