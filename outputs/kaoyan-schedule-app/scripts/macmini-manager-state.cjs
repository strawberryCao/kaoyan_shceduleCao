const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function extractTailscaleHttpsUrl(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  const matches = text.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.ts\.net(?::\d+)?/ig) || [];
  return [...new Set(matches.map((item) => item.replace(/\/$/, '')))][0] || '';
}

function readCloudflareFallback(runtimeRoot, fsModule = fs) {
  const configPath = path.join(runtimeRoot, 'config', 'cloudflare-tunnel.json');
  try {
    const value = JSON.parse(fsModule.readFileSync(configPath, 'utf8'));
    return value?.enabled === true && typeof value.hostname === 'string'
      ? `https://${value.hostname}`
      : '';
  } catch {
    return '';
  }
}

function readLatestBackup(runtimeRoot, fsModule = fs) {
  const backupRoot = path.join(runtimeRoot, 'backups');
  try {
    const candidates = fsModule.readdirSync(backupRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.partial-'))
      .map((entry) => {
        try {
          const manifest = JSON.parse(fsModule.readFileSync(path.join(backupRoot, entry.name, 'manifest.json'), 'utf8'));
          return manifest?.kind === 'kaoyan-macmini-snapshot'
            && typeof manifest.createdAt === 'string'
            && Number.isFinite(Date.parse(manifest.createdAt))
            ? { name: entry.name, createdAt: manifest.createdAt, files: Number(manifest?.totals?.files) || 0 }
            : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return candidates[0] || null;
  } catch {
    return null;
  }
}

function probeGateway(options = {}) {
  const port = Number(options.port || 5173);
  const timeoutMs = Number(options.timeoutMs || 1800);
  const requestModule = options.httpModule || http;
  return new Promise((resolve) => {
    const request = requestModule.get({ host: '127.0.0.1', port, path: '/readyz', timeout: timeoutMs }, (response) => {
      response.resume();
      resolve({ online: response.statusCode === 200, statusCode: response.statusCode || 0 });
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', (error) => resolve({ online: false, statusCode: 0, error: error.message }));
  });
}

module.exports = { extractTailscaleHttpsUrl, probeGateway, readCloudflareFallback, readLatestBackup };
