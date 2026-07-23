const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve(__dirname, '..', 'cloudflare', 'worker.js');
let value = fs.readFileSync(file, 'utf8');
const before = `  if (pathname !== null) {
    if (!isPublic || WRITE_METHODS.has(request.method)) {
      const authResponse = await requireBasicAuth(request, env);
      if (authResponse) return authResponse;
    }
    enforceWriteRequest(request, url, pathname);`;
const after = `  if (pathname !== null) {
    // Static application files stay loadable, but all data/configuration APIs
    // require the device-persisted password. The image endpoint remains a
    // narrow exception because ordinary <img> requests cannot attach the
    // authorization header stored by the application fetch wrapper.
    const publicImageRead = request.method === 'GET' && pathname === '/note-file';
    if (!publicImageRead) {
      const authResponse = await requireBasicAuth(request, env);
      if (authResponse) return authResponse;
    }
    enforceWriteRequest(request, url, pathname);`;
if (!value.includes(after)) {
  if (!value.includes(before)) throw new Error('Cloud auth patch anchor was not found');
  value = value.replace(before, after);
  fs.writeFileSync(file, value, 'utf8');
}
