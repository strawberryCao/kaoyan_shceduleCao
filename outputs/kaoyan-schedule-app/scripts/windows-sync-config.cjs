const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, ensurePrivateDirectory } = require('./runtime-paths.cjs');
const { normalizeBaseUrl } = require('./sync-client.cjs');

function configPaths(runtimePaths) {
  return {
    configPath: path.join(runtimePaths.configRoot, 'windows-sync.json'),
    tokenPath: path.join(runtimePaths.secretsRoot, 'windows-sync-token'),
    statusPath: path.join(runtimePaths.runRoot, 'windows-sync-status.json'),
  };
}

function readWindowsSyncConfig(runtimePaths) {
  const paths = configPaths(runtimePaths);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    const wrapped = new Error(`Windows sync configuration is unavailable: ${error.message}`);
    wrapped.code = 'WINDOWS_SYNC_CONFIG_MISSING';
    throw wrapped;
  }
  if (Number(config?.schemaVersion || 0) > 1) {
    const error = new Error(`Windows sync configuration schema ${config.schemaVersion} is newer than this runtime supports.`);
    error.code = 'WINDOWS_SYNC_CONFIG_TOO_NEW';
    throw error;
  }
  const deviceId = String(config.deviceId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) throw new Error('Windows sync deviceId is invalid.');
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const token = fs.readFileSync(paths.tokenPath, 'utf8').trim();
  if (!/^ksc_sync_[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('Windows sync token is invalid.');
  return { schemaVersion: 1, deviceId, baseUrl, token, paths };
}

function writeWindowsSyncConfig(runtimePaths, input) {
  const paths = configPaths(runtimePaths);
  if (fs.existsSync(paths.configPath)) {
    const existing = JSON.parse(fs.readFileSync(paths.configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (Number(existing?.schemaVersion || 0) > 1) {
      const error = new Error(`Windows sync configuration schema ${existing.schemaVersion} is newer than this runtime supports.`);
      error.code = 'WINDOWS_SYNC_CONFIG_TOO_NEW';
      throw error;
    }
  }
  const deviceId = String(input.deviceId || '').trim();
  const token = String(input.token || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) throw new Error('Windows sync deviceId is invalid.');
  if (!/^ksc_sync_[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('Windows sync token is invalid.');
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  ensurePrivateDirectory(runtimePaths.configRoot);
  ensurePrivateDirectory(runtimePaths.secretsRoot);
  atomicWriteJson(paths.configPath, { schemaVersion: 1, deviceId, baseUrl, updatedAt: new Date().toISOString() });
  const temporary = `${paths.tokenPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, paths.tokenPath);
  try { fs.chmodSync(paths.tokenPath, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
  return { deviceId, baseUrl, paths };
}

function publicWindowsSyncStatus(runtimePaths) {
  const paths = configPaths(runtimePaths);
  try {
    const config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
    return {
      configured: fs.existsSync(paths.tokenPath),
      deviceId: String(config.deviceId || ''),
      baseUrl: String(config.baseUrl || ''),
      configPath: paths.configPath,
      token: fs.existsSync(paths.tokenPath) ? 'stored privately' : 'missing',
    };
  } catch {
    return { configured: false, deviceId: '', baseUrl: '', configPath: paths.configPath, token: 'missing' };
  }
}

module.exports = { configPaths, publicWindowsSyncStatus, readWindowsSyncConfig, writeWindowsSyncConfig };
