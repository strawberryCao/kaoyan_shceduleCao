const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, ensurePrivateDirectory } = require('./runtime-paths.cjs');

const CLOUDFLARE_TUNNEL_SCHEMA_VERSION = 1;
const CONFIG_FILE_NAME = 'cloudflare-tunnel.json';
const TOKEN_FILE_NAME = 'cloudflare-tunnel.token';

function pathsFor(runtimePaths) {
  return {
    configPath: path.join(runtimePaths.configRoot, CONFIG_FILE_NAME),
    tokenPath: path.join(runtimePaths.secretsRoot, TOKEN_FILE_NAME),
  };
}

function normalizeHostname(value) {
  const hostname = String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\.$/, '');
  if (hostname.length > 253
    || !hostname.includes('.')
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error('Cloudflare 备用域名格式无效。请填写类似 study.example.com 的完整域名。');
  }
  return hostname;
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  if (token.length < 80 || token.length > 4096 || /\s/.test(token)) {
    throw new Error('Cloudflare Tunnel token 格式无效。请粘贴控制台提供的完整 token。');
  }
  return token;
}

function readTunnelConfig(runtimePaths, options = {}) {
  const { configPath, tokenPath } = pathsFor(runtimePaths);
  if (!fs.existsSync(configPath)) {
    if (options.allowMissing) return null;
    throw new Error('Cloudflare 备用入口尚未配置。');
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cloudflare 备用入口配置无法读取：${error.message}`);
  }
  if (Number(config?.schemaVersion) !== CLOUDFLARE_TUNNEL_SCHEMA_VERSION
    || config?.mode !== 'remotely-managed-token-file'
    || typeof config?.enabled !== 'boolean') {
    throw new Error('Cloudflare 备用入口配置格式无效或版本不受支持。');
  }
  const hostname = normalizeHostname(config.hostname);
  const serviceUrl = String(config.serviceUrl || 'http://127.0.0.1:5173');
  if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(serviceUrl)) {
    throw new Error('Cloudflare origin 必须指向 Mac 回环 HTTP 端口。');
  }
  return {
    ...config,
    hostname,
    serviceUrl,
    tokenConfigured: fs.existsSync(tokenPath) && fs.statSync(tokenPath).isFile(),
  };
}

function writePrivateToken(tokenPath, token) {
  ensurePrivateDirectory(path.dirname(tokenPath));
  const temporaryPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${token}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try { fs.chmodSync(temporaryPath, 0o600); } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
    fs.renameSync(temporaryPath, tokenPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

function configureTunnel(runtimePaths, input = {}) {
  const { configPath, tokenPath } = pathsFor(runtimePaths);
  const previous = readTunnelConfig(runtimePaths, { allowMissing: true });
  const hostname = normalizeHostname(input.hostname || previous?.hostname);
  const webPort = Number(input.webPort || 5173);
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
    throw new Error('Cloudflare origin 端口必须是 1024–65535 之间的整数。');
  }
  const token = input.token ? normalizeToken(input.token) : '';
  if (!token && !previous?.tokenConfigured) throw new Error('首次配置必须填写 Cloudflare Tunnel token。');
  if (token) writePrivateToken(tokenPath, token);
  const timestamp = new Date().toISOString();
  atomicWriteJson(configPath, {
    schemaVersion: CLOUDFLARE_TUNNEL_SCHEMA_VERSION,
    mode: 'remotely-managed-token-file',
    enabled: input.enabled !== false,
    hostname,
    serviceUrl: `http://127.0.0.1:${webPort}`,
    sessionTtlDays: 7,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
  });
  return publicTunnelStatus(runtimePaths);
}

function publicTunnelStatus(runtimePaths) {
  const { configPath, tokenPath } = pathsFor(runtimePaths);
  const config = readTunnelConfig(runtimePaths, { allowMissing: true });
  return {
    configured: Boolean(config && config.tokenConfigured),
    enabled: Boolean(config?.enabled && config?.tokenConfigured),
    hostname: config?.hostname || '',
    serviceUrl: config?.serviceUrl || '',
    sessionTtlDays: Number(config?.sessionTtlDays) || 7,
    token: fs.existsSync(tokenPath) ? '已安全保存' : '未配置',
    configPath,
    tokenPath,
    updatedAt: config?.updatedAt || null,
  };
}

function disableTunnel(runtimePaths) {
  const current = readTunnelConfig(runtimePaths);
  const { configPath } = pathsFor(runtimePaths);
  atomicWriteJson(configPath, {
    schemaVersion: CLOUDFLARE_TUNNEL_SCHEMA_VERSION,
    mode: current.mode,
    enabled: false,
    hostname: current.hostname,
    serviceUrl: current.serviceUrl,
    sessionTtlDays: 7,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  });
  return publicTunnelStatus(runtimePaths);
}

function removeTunnel(runtimePaths) {
  const { configPath, tokenPath } = pathsFor(runtimePaths);
  fs.rmSync(configPath, { force: true });
  fs.rmSync(tokenPath, { force: true });
  return publicTunnelStatus(runtimePaths);
}

function createTunnelChildSpecification(runtimePaths, options = {}) {
  const config = readTunnelConfig(runtimePaths, { allowMissing: true });
  if (!config?.enabled || !config.tokenConfigured) return null;
  const { tokenPath } = pathsFor(runtimePaths);
  const command = String(options.command || '').trim();
  if (!command) throw new Error('Cloudflare Tunnel 已启用，但找不到 cloudflared。');
  return Object.freeze({
    id: 'cloudflare-tunnel',
    critical: false,
    command,
    args: ['tunnel', '--no-autoupdate', 'run', '--token-file', tokenPath],
    environment: { ...options.environment },
  });
}

module.exports = {
  CLOUDFLARE_TUNNEL_SCHEMA_VERSION,
  configureTunnel,
  createTunnelChildSpecification,
  disableTunnel,
  normalizeHostname,
  normalizeToken,
  pathsFor,
  publicTunnelStatus,
  readTunnelConfig,
  removeTunnel,
  writePrivateToken,
};
