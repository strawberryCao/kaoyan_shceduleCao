#!/usr/bin/env node

const http = require('node:http');
const path = require('node:path');
const { atomicWriteJson, provisionRuntimeLayout, resolveRuntimePaths } = require('./runtime-paths.cjs');
const { createSyncClient } = require('./sync-client.cjs');
const { createWindowsReplicaStore } = require('./windows-replica-store.cjs');
const { createLearningDataStore } = require('./learning-data-store.cjs');
const { createReplicaLearningMaterializer } = require('./replica-learning-materializer.cjs');
const { createCanvasDocumentStore } = require('./canvas-document-store.cjs');
const { createCanvasMaterializer } = require('./replica-canvas-sync.cjs');
const { readWindowsSyncConfig } = require('./windows-sync-config.cjs');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function notifyLocalNoteService(payload, options = {}) {
  const token = String(options.token ?? process.env.KAOYAN_INTERNAL_SYNC_TOKEN ?? '');
  const port = Number(options.port ?? process.env.KAOYAN_NOTE_PORT ?? 5174);
  if (!token || !Number.isInteger(port)) return Promise.resolve(false);
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/internal/replica/materialized',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-kaoyan-internal-sync-token': token,
      },
      timeout: 3_000,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode === 200));
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('error', () => resolve(false));
    request.end(body);
  });
}

async function run(options = {}) {
  const runtime = options.runtimePaths || resolveRuntimePaths({ env: { ...process.env, KAOYAN_RUNTIME_LAYOUT: 'managed' } });
  provisionRuntimeLayout(runtime);
  const config = options.config || readWindowsSyncConfig(runtime);
  const replica = options.replica || createWindowsReplicaStore({
    databasePath: path.join(runtime.dataRoot, 'sync', 'windows-replica.sqlite'),
    assetsRoot: path.join(runtime.notesRoot, '.sync-assets', 'sha256'),
    deviceId: config.deviceId,
  });
  const client = options.client || createSyncClient({ replica, baseUrl: config.baseUrl, token: config.token });
  const learningData = options.learningData || createLearningDataStore({ assistantRoot: runtime.assistantRoot });
  const materializer = options.materializer || createReplicaLearningMaterializer({ replica, learningData });
  const canvasStore = options.canvasStore || createCanvasDocumentStore({ rootDir: path.join(runtime.assistantRoot, 'canvas-projects') });
  const canvasMaterializer = options.canvasMaterializer || createCanvasMaterializer({
    source: replica,
    canvasStore,
    cursorScope: 'canvas',
  });
  const once = options.once === true || process.argv.includes('--once');
  const statusPath = path.join(runtime.runRoot, 'windows-sync-status.json');
  let stopped = false;
  let failures = 0;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      try {
        const result = await client.syncOnce();
        const materialized = materializer.reconcile();
        const materializedCanvas = canvasMaterializer.reconcile();
        const uiNotified = await notifyLocalNoteService({
          learningChanged: materialized.changed === true,
          canvasEvents: materializedCanvas.events || [],
        }, {
          token: options.internalSyncToken,
          port: options.notePort,
        });
        failures = 0;
        atomicWriteJson(statusPath, {
          schemaVersion: 1,
          state: result.replica.conflicts ? 'attention' : 'synchronized',
          synchronizedAt: new Date().toISOString(),
          pushed: result.pushed,
          pulled: result.pulled,
          cursor: result.cursor,
          replica: result.replica,
          materialized,
          materializedCanvas,
          uiNotification: uiNotified ? 'delivered' : 'unavailable',
        });
      } catch (error) {
        failures += 1;
        atomicWriteJson(statusPath, {
          schemaVersion: 1,
          state: 'offline',
          failedAt: new Date().toISOString(),
          errorCode: String(error?.code || 'SYNC_FAILED'),
          replica: replica.status(),
        });
        if (once) throw error;
      }
      if (!once && !stopped) await delay(Math.min(5 * 60_000, 5_000 * (2 ** Math.min(failures, 6))));
    } while (!once && !stopped);
  } finally {
    if (!options.replica) replica.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`Windows sync service failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { notifyLocalNoteService, run };
