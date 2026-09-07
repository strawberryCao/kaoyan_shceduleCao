const fs = require('node:fs');
const { SyncProtocolError } = require('./sync-core.cjs');
const { SyncAuthenticationError } = require('./sync-device-auth.cjs');

const MAX_OPERATION_BODY_BYTES = 32 * 1024 * 1024;

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(payload));
}

function readBuffer(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new SyncProtocolError('PAYLOAD_TOO_LARGE', 'Request body is too large.', 413);
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

function requestPath(request) {
  return new URL(request.url || '/', 'http://127.0.0.1').pathname;
}

function createSyncHttpApi(options) {
  const store = options.store;
  const authenticate = options.authenticate;
  const afterOperations = typeof options.afterOperations === 'function' ? options.afterOperations : null;
  const afterAsset = typeof options.afterAsset === 'function' ? options.afterAsset : null;
  const maxAssetBytes = Number(options.maxAssetBytes || 256 * 1024 * 1024);
  if (!store || typeof authenticate !== 'function') throw new Error('Sync HTTP API requires a store and authenticator.');

  async function handle(request, response) {
    const pathname = requestPath(request);
    if (!pathname.startsWith('/sync/v1/')) return false;
    try {
      const device = authenticate(request);
      if (request.method === 'GET' && pathname === '/sync/v1/status') {
        sendJson(response, 200, { ok: true, deviceId: device.deviceId, ...store.getStatus() });
        return true;
      }

      if (request.method === 'POST' && pathname === '/sync/v1/operations') {
        const body = await readBuffer(request, MAX_OPERATION_BODY_BYTES);
        let payload;
        try {
          payload = JSON.parse(body.toString('utf8') || '{}');
        } catch {
          throw new SyncProtocolError('INVALID_JSON', 'Operation request must contain valid JSON.');
        }
        const operations = Array.isArray(payload.operations) ? payload.operations : [];
        if (operations.length < 1 || operations.length > 100) {
          throw new SyncProtocolError('INVALID_OPERATION_BATCH', 'Operation batches must contain between 1 and 100 items.');
        }
        const receipts = [];
        for (const operation of operations) {
          if (String(operation?.deviceId || '') !== device.deviceId) {
            throw new SyncAuthenticationError('SYNC_DEVICE_MISMATCH', 'Token device does not match operation.deviceId.', 403);
          }
          receipts.push(store.applyOperation(operation));
        }
        if (afterOperations) await afterOperations(receipts);
        sendJson(response, 200, { ok: true, receipts });
        return true;
      }

      if (request.method === 'GET' && pathname === '/sync/v1/events') {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        sendJson(response, 200, { ok: true, ...store.readEvents(url.searchParams.get('after') || 0, url.searchParams.get('limit') || undefined) });
        return true;
      }

      const conflictMatch = /^\/sync\/v1\/entities\/([^/]+)\/([^/]+)\/conflicts$/.exec(pathname);
      if (request.method === 'GET' && conflictMatch) {
        sendJson(response, 200, {
          ok: true,
          conflicts: store.getOpenConflicts(decodeURIComponent(conflictMatch[1]), decodeURIComponent(conflictMatch[2])),
        });
        return true;
      }

      const conflictResolutionMatch = /^\/sync\/v1\/conflicts\/([^/]+)\/resolve$/.exec(pathname);
      if (request.method === 'POST' && conflictResolutionMatch) {
        const body = await readBuffer(request, MAX_OPERATION_BODY_BYTES);
        let payload;
        try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {
          throw new SyncProtocolError('INVALID_JSON', 'Conflict resolution must contain valid JSON.');
        }
        if (String(payload.operation?.deviceId || '') !== device.deviceId) {
          throw new SyncAuthenticationError('SYNC_DEVICE_MISMATCH', 'Token device does not match operation.deviceId.', 403);
        }
        const result = store.resolveConflict(decodeURIComponent(conflictResolutionMatch[1]), payload.operation);
        if (afterOperations) await afterOperations([result.receipt]);
        sendJson(response, 200, { ok: true, ...result });
        return true;
      }

      const assetMatch = /^\/sync\/v1\/assets\/([a-f0-9]{64})$/.exec(pathname);
      if (request.method === 'PUT' && assetMatch) {
        const buffer = await readBuffer(request, maxAssetBytes);
        const result = store.putAsset(assetMatch[1], buffer, request.headers['content-type']);
        if (afterAsset) await afterAsset(result);
        sendJson(response, result.created ? 201 : 200, { ok: true, asset: result });
        return true;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && assetMatch) {
        const asset = store.getAsset(assetMatch[1]);
        if (!asset) {
          sendJson(response, 404, { ok: false, code: 'ASSET_NOT_FOUND', error: 'Asset is not present on the authority.' });
          return true;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
        response.setHeader('Content-Length', asset.size);
        response.setHeader('Cache-Control', 'private, immutable, max-age=31536000');
        response.setHeader('ETag', `\"sha256-${asset.hash}\"`);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        if (request.method === 'HEAD') response.end();
        else fs.createReadStream(asset.filePath).pipe(response);
        return true;
      }

      sendJson(response, 404, { ok: false, code: 'SYNC_ROUTE_NOT_FOUND', error: 'Sync route not found.' });
      return true;
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      sendJson(response, statusCode, {
        ok: false,
        code: error?.code || 'SYNC_INTERNAL_ERROR',
        error: statusCode >= 500 ? 'Sync service failed to process the request.' : error.message,
        ...(Number.isInteger(error?.currentRevision) ? { currentRevision: error.currentRevision } : {}),
        ...(Number.isInteger(error?.lastSequence) ? { lastSequence: error.lastSequence } : {}),
      });
      return true;
    }
  }

  return { handle };
}

module.exports = { MAX_OPERATION_BODY_BYTES, createSyncHttpApi, readBuffer };
