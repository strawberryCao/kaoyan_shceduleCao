const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, ensurePrivateDirectory } = require('./runtime-paths.cjs');

const DEVICE_CONFIG_VERSION = 1;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class SyncAuthenticationError extends Error {
  constructor(code, message, statusCode = 401) {
    super(message);
    this.name = 'SyncAuthenticationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeDeviceConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    schemaVersion: DEVICE_CONFIG_VERSION,
    devices: (Array.isArray(source.devices) ? source.devices : [])
      .filter((device) => DEVICE_ID_PATTERN.test(String(device?.deviceId || '')) && /^[a-f0-9]{64}$/.test(String(device?.tokenHash || '')))
      .map((device) => ({
        deviceId: String(device.deviceId),
        label: String(device.label || device.deviceId).slice(0, 120),
        tokenHash: String(device.tokenHash),
        status: device.status === 'revoked' ? 'revoked' : 'active',
        createdAt: String(device.createdAt || ''),
        revokedAt: device.revokedAt ? String(device.revokedAt) : null,
      })),
  };
}

function readDeviceConfig(configPath) {
  if (!fs.existsSync(configPath)) return normalizeDeviceConfig(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (Number(parsed?.schemaVersion || 0) > DEVICE_CONFIG_VERSION) {
      const error = new Error(`Sync device configuration schema ${parsed.schemaVersion} is newer than this runtime supports.`);
      error.code = 'SYNC_DEVICE_CONFIG_TOO_NEW';
      throw error;
    }
    return normalizeDeviceConfig(parsed);
  } catch (error) {
    if (error?.code === 'SYNC_DEVICE_CONFIG_TOO_NEW') throw error;
    const wrapped = new Error(`Unable to read sync device configuration: ${error.message}`);
    wrapped.code = 'SYNC_DEVICE_CONFIG_INVALID';
    throw wrapped;
  }
}

function writeDeviceConfig(configPath, config) {
  ensurePrivateDirectory(path.dirname(configPath));
  atomicWriteJson(configPath, normalizeDeviceConfig(config));
  try {
    fs.chmodSync(configPath, 0o600);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function createDevice(configPath, options = {}) {
  const deviceId = String(options.deviceId || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('deviceId must use letters, numbers, dot, underscore, colon or dash.');
  const config = readDeviceConfig(configPath);
  const existing = config.devices.find((device) => device.deviceId === deviceId && device.status === 'active');
  if (existing) throw new Error(`Device ${deviceId} is already active. Revoke it before creating a replacement token.`);
  const token = `ksc_sync_${crypto.randomBytes(32).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  config.devices = config.devices.filter((device) => device.deviceId !== deviceId);
  config.devices.push({
    deviceId,
    label: String(options.label || deviceId).trim().slice(0, 120) || deviceId,
    tokenHash: tokenHash(token),
    status: 'active',
    createdAt,
    revokedAt: null,
  });
  writeDeviceConfig(configPath, config);
  return { deviceId, token, createdAt };
}

function revokeDevice(configPath, deviceId) {
  const config = readDeviceConfig(configPath);
  const target = config.devices.find((device) => device.deviceId === String(deviceId || '').trim());
  if (!target) return false;
  target.status = 'revoked';
  target.revokedAt = new Date().toISOString();
  writeDeviceConfig(configPath, config);
  return true;
}

function listDevices(configPath) {
  return readDeviceConfig(configPath).devices.map(({ tokenHash: _hidden, ...device }) => device);
}

function authenticateRequest(request, configPath) {
  const authorization = String(request.headers?.authorization || '');
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) throw new SyncAuthenticationError('SYNC_AUTH_REQUIRED', 'A sync device bearer token is required.');
  const presentedHash = tokenHash(match[1]);
  const config = readDeviceConfig(configPath);
  const device = config.devices.find((candidate) => candidate.status === 'active' && safeEqual(candidate.tokenHash, presentedHash));
  if (!device) throw new SyncAuthenticationError('SYNC_AUTH_INVALID', 'The sync device token is invalid or revoked.');
  return { deviceId: device.deviceId, label: device.label };
}

module.exports = {
  SyncAuthenticationError,
  authenticateRequest,
  createDevice,
  listDevices,
  normalizeDeviceConfig,
  readDeviceConfig,
  revokeDevice,
  tokenHash,
  writeDeviceConfig,
};
