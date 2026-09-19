#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCanvasDocumentStore } = require('./canvas-document-store.cjs');
const { createLaunchDaemonDefinition, LAUNCHD_LABEL, LAUNCHD_PLIST_PATH } = require('./macos-launchd.cjs');
const { fileHash, walk } = require('./macmini-migration-audit.cjs');
const { runDoctor } = require('./macmini-runtime.cjs');
const { createCanvasSyncBridge } = require('./replica-canvas-sync.cjs');
const { createReplicaLearningBridge } = require('./replica-learning-bridge.cjs');
const { defaultSnapshot, normalizeSnapshot } = require('./learning-data-store.cjs');
const {
  assertMacInstallEnvironment,
  install,
  lookupIdentity,
} = require('./install-macmini-service.cjs');
const {
  assertNoRuntimeSymlinks,
  assertSafeRuntimePaths,
  atomicWriteJson,
  provisionRuntimeLayout,
  resolveRuntimePaths,
} = require('./runtime-paths.cjs');
const { createSyncStore } = require('./sync-core.cjs');
const { prepareRuntime, verify: verifyBundle } = require('./windows-migration-bundle.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RUNTIME_ROOT = '/Library/Application Support/KaoyanStudyCenter';

function parseArguments(argv = process.argv.slice(2), environment = process.env) {
  const result = {
    command: argv[0] || 'plan',
    bundle: '',
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    serviceUser: String(environment.SUDO_USER || environment.USER || environment.USERNAME || '').trim(),
    nodePath: String(environment.KAOYAN_NODE_PATH || process.execPath),
    notePort: 5174,
    webPort: 5173,
    confirmed: false,
    json: false,
  };
  for (const argument of argv.slice(1)) {
    if (argument === '--confirm-windows-authoritative') result.confirmed = true;
    else if (argument === '--json') result.json = true;
    else if (argument.startsWith('--bundle=')) result.bundle = path.resolve(argument.slice('--bundle='.length).trim());
    else if (argument.startsWith('--runtime-root=')) result.runtimeRoot = path.resolve(argument.slice('--runtime-root='.length).trim());
    else if (argument.startsWith('--user=')) result.serviceUser = argument.slice('--user='.length).trim();
    else if (argument.startsWith('--node=')) result.nodePath = path.resolve(argument.slice('--node='.length).trim());
    else if (argument.startsWith('--note-port=')) result.notePort = Number(argument.slice('--note-port='.length));
    else if (argument.startsWith('--web-port=')) result.webPort = Number(argument.slice('--web-port='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.bundle) throw new Error('--bundle is required.');
  return result;
}

function pathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safePreparedPath(root, portablePath) {
  if (typeof portablePath !== 'string' || !/^data\//.test(portablePath)
    || portablePath.split('/').some((segment) => !segment || segment === '.' || segment === '..' || /[\\:\x00-\x1f]/.test(segment))) {
    throw new Error(`Unsafe prepared path: ${portablePath}`);
  }
  const target = path.resolve(root, ...portablePath.split('/'));
  if (!pathInside(root, target)) throw new Error(`Prepared path escapes its root: ${portablePath}`);
  return target;
}

function loadPreparedManifest(preparedRoot) {
  const manifestPath = path.join(preparedRoot, 'migration-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest?.kind !== 'kaoyan-mac-shadow-runtime' || manifest?.schemaVersion !== 1
    || !Array.isArray(manifest.preparedFiles)) {
    throw new Error('Invalid prepared migration manifest.');
  }
  if (manifest.activationReady !== true || manifest.unresolvedWindowsPaths?.length || manifest.brokenInternalPaths?.length) {
    throw new Error('Prepared migration is not activation-ready.');
  }
  return manifest;
}

function verifyPreparedRuntime(preparedRoot) {
  const root = path.resolve(preparedRoot);
  const manifest = loadPreparedManifest(root);
  const expected = new Set();
  for (const entry of manifest.preparedFiles) {
    const target = safePreparedPath(root, entry.path);
    const folded = entry.path.normalize('NFC').toLowerCase();
    if (expected.has(folded) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      throw new Error(`Invalid or duplicate prepared entry: ${entry.path}`);
    }
    expected.add(folded);
    const stats = fs.statSync(target);
    if (!stats.isFile() || stats.size !== entry.size || fileHash(target) !== entry.sha256) {
      throw new Error(`Prepared runtime verification failed: ${entry.path}`);
    }
  }
  const dataRoot = path.join(root, 'data');
  const actual = walk(dataRoot).map((file) => path.relative(root, file).split(path.sep).join('/').normalize('NFC').toLowerCase());
  if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) {
    throw new Error('Prepared runtime contains unlisted or missing files.');
  }
  return manifest;
}

function importDeletedLearningRecords(authority, bridge, snapshot) {
  let notes = 0;
  let cards = 0;
  for (const [noteUid, deleted] of Object.entries(snapshot.deletedNotes || {})) {
    if (!deleted?.note) continue;
    const temporary = defaultSnapshot();
    const capturedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(deleted.note.capturedDate || ''))
      ? deleted.note.capturedDate
      : /^\d{4}-\d{2}-\d{2}/.exec(String(deleted.note.createdAt || deleted.deletedAt || ''))?.[0] || '1970-01-01';
    temporary.days[capturedDate] = {
      manual: { completedTaskIds: [], note: '', debt: '', mistakes: '' },
      autoNotes: [{ ...deleted.note, noteUid, capturedDate }],
    };
    temporary.cards = Array.isArray(deleted.cards) ? deleted.cards : [];
    const imported = bridge.captureCommit(defaultSnapshot(), temporary, { syncSource: 'system' });
    authority.queueLocalMutation({
      deviceId: 'windows-migration',
      entityType: 'learning-note',
      entityId: noteUid,
      mutation: { kind: 'delete', source: 'system' },
    });
    notes += 1;
    cards += Math.max(0, Number(imported.queued || 0) - 1);
  }
  return { notes, cards };
}

function seedAuthority(preparedRoot) {
  const dataRoot = path.join(path.resolve(preparedRoot), 'data');
  const assistantRoot = path.join(dataRoot, 'assistant');
  const learningPath = path.join(assistantRoot, 'learning-data.json');
  if (!fs.existsSync(learningPath)) throw new Error('Prepared runtime has no learning-data.json.');
  const snapshot = normalizeSnapshot(JSON.parse(fs.readFileSync(learningPath, 'utf8').replace(/^\uFEFF/, '')));
  const authority = createSyncStore({
    databasePath: path.join(dataRoot, 'sync', 'authority.sqlite'),
    assetsRoot: path.join(dataRoot, 'assets', 'sha256'),
  });
  try {
    if (authority.listEntities().length !== 0) throw new Error('Prepared authority database must be empty before seeding.');
    const adapter = {
      getEntity: authority.getEntity,
      queueMutation: (input) => authority.queueLocalMutation({ ...input, deviceId: 'windows-migration' }),
      entityStatus: () => ({ state: 'acknowledged', pending: 0, conflicts: 0 }),
      status: () => ({ deviceId: 'windows-migration', pending: 0, conflicts: 0 }),
    };
    const learningBridge = createReplicaLearningBridge({ replica: adapter });
    const active = learningBridge.captureCommit(defaultSnapshot(), snapshot, { syncSource: 'system' });
    const deleted = importDeletedLearningRecords(authority, learningBridge, snapshot);

    const canvasStore = createCanvasDocumentStore({ rootDir: path.join(assistantRoot, 'canvas-projects') });
    const invalidCanvas = canvasStore.listDocuments({ includeInvalid: true }).filter((document) => document.invalid);
    if (invalidCanvas.length) throw new Error(`Invalid canvas documents block authority seeding: ${invalidCanvas.map((item) => item.id).join(', ')}`);
    const canvasBridge = createCanvasSyncBridge({ target: authority, deviceId: 'windows-migration' });
    let canvases = 0;
    for (const summary of canvasStore.listDocuments()) {
      canvasBridge.captureSave(null, canvasStore.readDocument(summary.id), { syncSource: 'system' });
      canvases += 1;
    }

    const entities = authority.listEntities();
    const missingAssets = [...new Set(entities.flatMap((entity) => entity.assetHashes || []))]
      .filter((hash) => !authority.hasAsset(hash));
    if (missingAssets.length) throw new Error(`Authority seed is missing ${missingAssets.length} synchronized assets.`);
    const status = authority.getStatus();
    if (status.openConflictCount !== 0) throw new Error('Authority seed unexpectedly created synchronization conflicts.');
    return {
      activeMutations: active.queued,
      deletedNotes: deleted.notes,
      deletedNoteCards: deleted.cards,
      canvases,
      status,
    };
  } finally {
    authority.close();
  }
}

function rewriteRootedStrings(value, sourceRoots, targetRoots, state, pointer = '$') {
  if (typeof value === 'string') {
    for (const kind of ['notes', 'assistant']) {
      if (!path.isAbsolute(value) || !pathInside(sourceRoots[kind], value)) continue;
      const relative = path.relative(sourceRoots[kind], value);
      state.rewritten += 1;
      return path.join(targetRoots[kind], relative);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => rewriteRootedStrings(item, sourceRoots, targetRoots, state, `${pointer}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, rewriteRootedStrings(child, sourceRoots, targetRoots, state, `${pointer}.${key}`)]));
}

function promotePreparedPaths(preparedRoot, runtimePaths) {
  const sourceRoots = {
    notes: path.join(path.resolve(preparedRoot), 'data', 'notes'),
    assistant: path.join(path.resolve(preparedRoot), 'data', 'assistant'),
  };
  const targetRoots = { notes: runtimePaths.notesRoot, assistant: runtimePaths.assistantRoot };
  const state = { rewritten: 0 };
  for (const file of walk(path.join(preparedRoot, 'data')).filter((candidate) => /\.json$/i.test(candidate))) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const rewritten = rewriteRootedStrings(parsed, sourceRoots, targetRoots, state, `$file:${path.relative(preparedRoot, file)}`);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(rewritten, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  return state;
}

function chownTree(root, uid, gid) {
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink()) throw new Error(`Refusing a symlink while assigning migration ownership: ${root}`);
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(root)) chownTree(path.join(root, entry), uid, gid);
  }
  fs.chownSync(root, uid, gid);
}

function command(commandPath, args, allowFailure = false) {
  const result = spawnSync(commandPath, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${commandPath} ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function stopService() {
  command('/bin/launchctl', ['bootout', 'system', LAUNCHD_PLIST_PATH], true);
}

function waitForHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1_500 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(true);
        else if (Date.now() >= deadline) reject(new Error(`Web health returned HTTP ${response.statusCode}.`));
        else setTimeout(attempt, 250);
      });
      request.once('timeout', () => request.destroy(new Error('timeout')));
      request.once('error', (error) => {
        if (Date.now() >= deadline) reject(new Error(`Web health did not become ready: ${error.message}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function runtimeFor(arguments_) {
  const environment = {
    ...process.env,
    KAOYAN_SERVICE_MODE: 'system',
    KAOYAN_RUNTIME_LAYOUT: 'managed',
    KAOYAN_RUNTIME_ROOT: arguments_.runtimeRoot,
  };
  return resolveRuntimePaths({ env: environment, platform: process.platform });
}

function activationPlan(arguments_) {
  const manifest = verifyBundle(arguments_.bundle);
  return {
    action: 'plan',
    readOnly: true,
    bundle: arguments_.bundle,
    verifiedFiles: manifest.files.length,
    verifiedBytes: manifest.files.reduce((total, entry) => total + entry.size, 0),
    excludedFiles: manifest.excluded?.length || 0,
    runtimeRoot: arguments_.runtimeRoot,
    authoritySource: 'Windows business data',
    preservesSecrets: true,
    preservesPreviousMacDataAsRollback: true,
    activationPerformed: false,
    applyCommandRequires: '--confirm-windows-authoritative and sudo',
  };
}

async function activate(arguments_) {
  assertMacInstallEnvironment();
  if (!arguments_.confirmed) throw new Error('Apply requires --confirm-windows-authoritative.');
  verifyBundle(arguments_.bundle);
  const runtimePaths = runtimeFor(arguments_);
  assertSafeRuntimePaths(runtimePaths);
  provisionRuntimeLayout(runtimePaths);
  assertNoRuntimeSymlinks(runtimePaths);
  const identity = lookupIdentity(arguments_.serviceUser);
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  const releaseRoot = path.join(runtimePaths.releasesRoot, `windows-authority-${stamp}`);
  fs.mkdirSync(releaseRoot, { mode: 0o700 });
  const preparedRoot = path.join(releaseRoot, 'prepared-shadow');
  const prepared = prepareRuntime(arguments_.bundle, preparedRoot);
  if (!prepared.activationReady) throw new Error('Migration prepare reported unresolved or broken paths; no service was stopped.');
  const preparedManifest = verifyPreparedRuntime(preparedRoot);
  const seeded = seedAuthority(preparedRoot);
  const promoted = promotePreparedPaths(preparedRoot, runtimePaths);
  const candidateData = path.join(preparedRoot, 'data');
  const rollbackData = path.join(releaseRoot, 'previous-mac-data');
  const failedData = path.join(releaseRoot, 'failed-candidate-data');
  const definition = createLaunchDaemonDefinition({
    runtimePaths,
    serviceUser: arguments_.serviceUser,
    projectRoot: PROJECT_ROOT,
    nodePath: arguments_.nodePath,
    notePort: arguments_.notePort,
    webPort: arguments_.webPort,
  });
  const report = {
    schemaVersion: 1,
    action: 'activate-windows-authority',
    createdAt: new Date().toISOString(),
    sourceBundle: arguments_.bundle,
    sourceFiles: preparedManifest.sourceFiles,
    preexistingMissingPaths: preparedManifest.preexistingMissingPaths?.length || 0,
    seeded,
    rewrittenPreparedPaths: promoted.rewritten,
    runtimeRoot: runtimePaths.runtimeRoot,
    rollbackData,
    activated: false,
    rolledBack: false,
  };
  atomicWriteJson(path.join(releaseRoot, 'activation-report.json'), report);

  stopService();
  try {
    fs.renameSync(runtimePaths.dataRoot, rollbackData);
    fs.renameSync(candidateData, runtimePaths.dataRoot);
    chownTree(runtimePaths.dataRoot, identity.uid, identity.gid);
    install(definition, runtimePaths);
    await waitForHealth(arguments_.webPort);
    const doctor = runDoctor(runtimePaths, { notePort: arguments_.notePort, webPort: arguments_.webPort });
    if (!doctor.ok) throw new Error('Mac runtime doctor failed after activation.');
    report.activated = true;
    report.activatedAt = new Date().toISOString();
    report.doctor = { ok: doctor.ok, failedChecks: doctor.checks.filter((check) => !check.ok).map((check) => check.id) };
    atomicWriteJson(path.join(releaseRoot, 'activation-report.json'), report);
    return report;
  } catch (error) {
    stopService();
    let rollbackError = null;
    try {
      if (fs.existsSync(runtimePaths.dataRoot)) fs.renameSync(runtimePaths.dataRoot, failedData);
      if (fs.existsSync(rollbackData)) fs.renameSync(rollbackData, runtimePaths.dataRoot);
      chownTree(runtimePaths.dataRoot, identity.uid, identity.gid);
      install(definition, runtimePaths);
      report.rolledBack = true;
    } catch (failure) {
      rollbackError = failure;
    }
    report.failure = error.message;
    report.rollbackFailure = rollbackError?.message || null;
    try { atomicWriteJson(path.join(releaseRoot, 'activation-report.json'), report); } catch {}
    throw new Error(`Activation failed${report.rolledBack ? ' and previous Mac data was restored' : ''}: ${error.message}${rollbackError ? `; rollback failed: ${rollbackError.message}` : ''}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  let result;
  if (arguments_.command === 'plan') result = activationPlan(arguments_);
  else if (arguments_.command === 'apply') result = await activate(arguments_);
  else throw new Error(`Unknown command: ${arguments_.command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Mac mini migration activation error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  activationPlan,
  chownTree,
  importDeletedLearningRecords,
  loadPreparedManifest,
  parseArguments,
  promotePreparedPaths,
  rewriteRootedStrings,
  safePreparedPath,
  seedAuthority,
  verifyPreparedRuntime,
};
