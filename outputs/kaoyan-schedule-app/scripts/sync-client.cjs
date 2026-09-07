const fs = require('node:fs');
const { sha256 } = require('./sync-core.cjs');

class SyncTransportError extends Error {
  constructor(code, message, statusCode = 0) {
    super(message);
    this.name = 'SyncTransportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('Windows sync requires HTTPS, except for loopback tests.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function responseJson(response) {
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    throw new SyncTransportError(payload.code || 'SYNC_HTTP_ERROR', payload.error || `Sync request failed with HTTP ${response.status}.`, response.status);
  }
  return payload;
}

function createSyncClient(options) {
  const replica = options.replica;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = String(options.token || '').trim();
  const fetchImpl = options.fetchImpl || fetch;
  if (!token) throw new Error('Sync device token is required.');
  const headers = () => ({ authorization: `Bearer ${token}` });

  async function request(pathname, init = {}) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: { ...headers(), ...(init.headers || {}) },
    });
    return response;
  }

  async function uploadAsset(hash) {
    const asset = replica.getAsset(hash);
    if (!asset) throw new SyncTransportError('LOCAL_ASSET_MISSING', `Local asset ${hash} is missing.`);
    const response = await request(`/sync/v1/assets/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': asset.mimeType, 'content-length': String(asset.size) },
      body: fs.createReadStream(asset.filePath),
      duplex: 'half',
    });
    return responseJson(response);
  }

  async function pushOne(pending) {
    const operation = pending.operation;
    try {
      const response = await request('/sync/v1/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operations: [operation] }),
      });
      const payload = await responseJson(response);
      const receipt = payload.receipts?.[0];
      if (!receipt || receipt.operationId !== operation.operationId) {
        throw new SyncTransportError('INVALID_SYNC_RECEIPT', 'Authority returned an invalid operation receipt.');
      }
      for (const hash of receipt.missingAssets || []) await uploadAsset(hash);
      replica.markReceipt(receipt);
      return receipt;
    } catch (error) {
      replica.recordAttempt(operation.operationId, error);
      throw error;
    }
  }

  async function pushPending(limit = 100) {
    const receipts = [];
    // Send one operation at a time. Its receipt rebases later local edits of
    // the same entity before those edits receive an immutable network identity.
    for (let index = 0; index < limit; index += 1) {
      const pending = replica.listPending(1)[0];
      if (!pending) break;
      receipts.push(await pushOne(pending));
    }
    return receipts;
  }

  async function downloadAsset(asset) {
    if (!asset?.hash || replica.getAsset(asset.hash)) return false;
    const response = await request(`/sync/v1/assets/${asset.hash}`);
    if (!response.ok) await responseJson(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== asset.hash) throw new SyncTransportError('DOWNLOADED_ASSET_HASH_MISMATCH', `Downloaded asset ${asset.hash} failed verification.`);
    replica.storeAssetBytes(bytes, asset.mimeType);
    return true;
  }

  async function pullEvents(pageLimit = 200) {
    let cursor = replica.getRemoteCursor();
    let pulled = 0;
    let downloaded = 0;
    for (;;) {
      const response = await request(`/sync/v1/events?after=${cursor}&limit=${pageLimit}`);
      const page = await responseJson(response);
      for (const event of page.events || []) {
        if (event.eventType === 'asset.available' && await downloadAsset(event.asset)) downloaded += 1;
      }
      cursor = replica.applyRemoteEvents(page.events || [], page.nextCursor);
      pulled += (page.events || []).length;
      if (!page.hasMore || (page.events || []).length === 0) break;
    }
    return { pulled, downloaded, cursor };
  }

  async function syncOnce() {
    const statusResponse = await request('/sync/v1/status');
    const remote = await responseJson(statusResponse);
    if (remote.deviceId !== replica.deviceId) throw new SyncTransportError('SYNC_DEVICE_MISMATCH', 'Authority token belongs to another replica.');
    const receipts = await pushPending();
    const pull = await pullEvents();
    return { ok: true, pushed: receipts.length, ...pull, replica: replica.status() };
  }

  return { downloadAsset, pullEvents, pushPending, syncOnce, uploadAsset };
}

module.exports = { SyncTransportError, createSyncClient, normalizeBaseUrl };
