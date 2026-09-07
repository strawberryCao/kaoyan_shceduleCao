const net = require('node:net');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function check(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function replicaConfigured() {
  const runtimeRoot = String(process.env.KAOYAN_RUNTIME_ROOT || '').trim()
    || path.join(process.env.LOCALAPPDATA || '', 'KaoyanStudyCenter');
  return Boolean(runtimeRoot && fs.existsSync(path.join(runtimeRoot, 'config', 'windows-sync.json')));
}

function noteServiceReady(timeoutMs = 750) {
  return new Promise((resolve) => {
    const request = http.get('http://127.0.0.1:5174/health', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        if (response.statusCode !== 200) return resolve(false);
        if (!replicaConfigured()) return resolve(true);
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(health?.sync?.role === 'windows-replica');
        } catch {
          resolve(false);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.once('error', () => resolve(false));
  });
}

Promise.all([
  check(5173),
  noteServiceReady(),
]).then((results) => {
  process.exitCode = results.every(Boolean) ? 0 : 1;
});
