'use strict';

const fs = require('fs');
const path = require('path');
const {
  SUBJECTS,
  atomicJson,
  noteToEntry,
  summaryEntry,
  walk,
} = require('./migrate-learning-data-v2.cjs');

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--apply') result.apply = true;
    else if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[++index];
  }
  return result;
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function safeId(value) {
  const candidate = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(candidate) ? candidate : '';
}

function canonicalSubject(value) {
  const candidate = String(value || '').normalize('NFKC').trim();
  return SUBJECTS.has(candidate) ? candidate : '默认文件夹';
}

function semantic(value) {
  return JSON.stringify({
    kind: value?.kind,
    title: value?.title,
    body: value?.body,
    subject: value?.subject,
    facets: value?.facets,
    tags: value?.tags,
    assets: (value?.assets || []).map((asset) => asset.assetId),
    state: value?.state,
  });
}

function ensureCopy(source, destination, apply) {
  if (!source || !fs.existsSync(source)) return false;
  if (fs.existsSync(destination) && fs.statSync(destination).size === fs.statSync(source).size) return false;
  if (apply) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return true;
}

function publishLocalEntries({ repoRoot, notesRoot, apply, report }) {
  const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
  const assetRecordRoot = path.join(repoRoot, 'data', 'v2', 'assets');
  const sidecars = walk(notesRoot).filter((filePath) => (
    /\.note\.json$/i.test(filePath)
    && !/\.cloud-note\.json$/i.test(filePath)
    && !/sync-conflict-/i.test(filePath)
  ));
  for (const sidecarPath of sidecars) {
    const note = readJson(sidecarPath);
    const entryId = safeId(note?.entryId || note?.noteUid || note?.id);
    if (!entryId) {
      report.manual.push({ path: path.relative(notesRoot, sidecarPath).replaceAll('\\', '/'), reason: 'missing-stable-entry-id' });
      continue;
    }
    const remotePath = path.join(entryRoot, `${entryId}.json`);
    const remote = readJson(remotePath);
    const localVersion = Number(note.v2Version) || 0;
    const remoteVersion = Number(remote?.version) || 0;
    if (remote && remoteVersion > localVersion) {
      report.remoteWins += 1;
      continue;
    }
    const converted = noteToEntry(note, sidecarPath, { repoRoot, notesRoot });
    const next = converted.entry;
    next.entryId = entryId;
    next.subject = canonicalSubject(note.subject);
    next.version = remote ? remoteVersion + (semantic(remote) === semantic(next) ? 0 : 1) : 1;
    next.createdAt = remote?.createdAt || next.createdAt;
    if (remote && semantic(remote) === semantic(next)) {
      report.unchanged += 1;
      continue;
    }
    for (const asset of converted.assetSources) {
      const { sourcePath, ...record } = asset.record;
      const target = path.join(repoRoot, record.path);
      if (ensureCopy(asset.sourcePath, target, apply)) report.assetsPublished += 1;
      if (apply) atomicJson(path.join(assetRecordRoot, `${record.assetId}.json`), record);
    }
    if (apply) atomicJson(remotePath, next);
    report.localPublished += 1;
  }
}

function materializeRemoteEntries({ repoRoot, notesRoot, apply, report }) {
  const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
  const existingByEntryId = new Map();
  for (const sidecarPath of walk(notesRoot).filter((filePath) => (
    /\.note\.json$/i.test(filePath)
    && !/\.cloud-note\.json$/i.test(filePath)
    && !/sync-conflict-/i.test(filePath)
  ))) {
    const sidecar = readJson(sidecarPath);
    const entryId = safeId(sidecar?.entryId || sidecar?.noteUid || sidecar?.id);
    if (!entryId) continue;
    const existing = existingByEntryId.get(entryId) || [];
    existing.push(sidecarPath);
    existingByEntryId.set(entryId, existing);
  }
  for (const entryPath of walk(entryRoot).filter((filePath) => /\.json$/i.test(filePath))) {
    const entry = readJson(entryPath);
    const entryId = safeId(entry?.entryId);
    if (!entryId) {
      report.manual.push({ path: path.relative(repoRoot, entryPath).replaceAll('\\', '/'), reason: 'invalid-v2-entry' });
      continue;
    }
    const subject = canonicalSubject(entry.subject);
    const metadataRoot = path.join(notesRoot, subject, '.metadata');
    const canonicalSidecarPath = path.join(metadataRoot, `${entryId}.note.json`);
    const existingPaths = (existingByEntryId.get(entryId) || [])
      .filter((filePath) => path.resolve(path.dirname(filePath)) === path.resolve(metadataRoot));
    const originalSidecarPath = existingPaths.find((filePath) => path.resolve(filePath) !== path.resolve(canonicalSidecarPath));
    const localSidecarPath = originalSidecarPath || canonicalSidecarPath;
    const current = readJson(localSidecarPath);
    const generatedCanonical = originalSidecarPath ? readJson(canonicalSidecarPath) : null;
    const pruneGeneratedCanonical = () => {
      if (
        !generatedCanonical
        || !generatedCanonical.v2Version
        || safeId(generatedCanonical.entryId || generatedCanonical.noteUid || generatedCanonical.id) !== entryId
      ) return;
      if (apply && fs.existsSync(canonicalSidecarPath)) fs.unlinkSync(canonicalSidecarPath);
      report.duplicateSidecarsPruned += 1;
    };
    if (Number(current?.v2Version) > Number(entry.version)) {
      report.localWins += 1;
      continue;
    }
    const localAssets = [];
    for (const asset of Array.isArray(entry.assets) ? entry.assets : []) {
      const source = path.join(repoRoot, String(asset.path || ''));
      const extension = path.extname(source) || '.bin';
      const localRelative = path.join(subject, '.assets', `${asset.assetId}${extension}`);
      const destination = path.join(notesRoot, localRelative);
      if (!fs.existsSync(source)) {
        report.manual.push({ path: path.relative(repoRoot, entryPath).replaceAll('\\', '/'), reason: `missing-asset:${asset.assetId}` });
        continue;
      }
      if (ensureCopy(source, destination, apply)) report.assetsMaterialized += 1;
      localAssets.push({
        id: asset.assetId,
        assetId: asset.assetId,
        kind: asset.kind,
        name: asset.originalFileName,
        mimeType: asset.mime,
        size: asset.size,
        filePath: `github://${String(asset.path).replaceAll('\\', '/')}`,
        localPathKey: localRelative.replaceAll('\\', '/'),
        createdAt: asset.createdAt,
      });
    }
    const sidecar = {
      schemaVersion: 2,
      entryId,
      id: entryId,
      noteUid: entryId,
      kind: entry.kind,
      subject,
      requestedSubject: subject,
      title: entry.title,
      remark: entry.body,
      facets: entry.kind === 'quick' ? ['quick', ...(entry.facets || [])] : entry.facets || [],
      tags: entry.tags || [],
      fileName: localAssets[0] ? path.basename(localAssets[0].localPathKey) : '',
      filePath: localAssets[0]?.filePath || '',
      localPathKey: localAssets[0]?.localPathKey || '',
      attachments: localAssets,
      v2Version: Number(entry.version) || 1,
      state: entry.state || 'active',
      tombstone: entry.tombstone || null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      learning: {
        capturedDate: entry.capturedDate,
        title: entry.title,
        subject,
        remark: entry.body,
        tags: entry.tags || [],
        facets: entry.facets || [],
        noteType: entry.kind === 'quick' ? 'quick'
          : entry.facets?.includes('mistake') ? 'mistake'
            : entry.facets?.includes('memory') ? 'memory'
              : entry.facets?.includes('method') ? 'method' : 'note',
      },
    };
    if (current && Number(current.v2Version) === Number(entry.version)) {
      pruneGeneratedCanonical();
      report.unchanged += 1;
      continue;
    }
    if (apply) atomicJson(localSidecarPath, sidecar);
    pruneGeneratedCanonical();
    report.remoteMaterialized += 1;
  }
}

function rebuildIndex(repoRoot, apply, report) {
  const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
  const entries = walk(entryRoot)
    .filter((filePath) => /\.json$/i.test(filePath))
    .map((filePath) => readJson(filePath))
    .filter((entry) => entry?.schemaVersion === 2 && safeId(entry.entryId))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const currentPath = path.join(repoRoot, 'data', 'v2', 'index.json');
  const current = readJson(currentPath, { revision: 0, entries: [] });
  const nextEntries = entries.map(summaryEntry);
  if (JSON.stringify(current.entries || []) === JSON.stringify(nextEntries)) return;
  if (apply) atomicJson(currentPath, {
    schemaVersion: 2,
    revision: Math.max(0, Number(current.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
    entries: nextEntries,
  });
  report.indexRebuilt = true;
}

function main() {
  const options = parseArgs(process.argv);
  const config = readJson(path.resolve(options.config || ''));
  if (!config) throw new Error('Sync configuration is required.');
  const repoRoot = path.resolve(config.clonePath);
  const notesRoot = path.resolve(config.localPath);
  const report = {
    schemaVersion: 2,
    mode: options.apply ? 'apply' : 'dry-run',
    localPublished: 0,
    remoteMaterialized: 0,
    assetsPublished: 0,
    assetsMaterialized: 0,
    remoteWins: 0,
    localWins: 0,
    unchanged: 0,
    duplicateSidecarsPruned: 0,
    indexRebuilt: false,
    manual: [],
  };
  publishLocalEntries({ repoRoot, notesRoot, apply: options.apply, report });
  materializeRemoteEntries({ repoRoot, notesRoot, apply: options.apply, report });
  rebuildIndex(repoRoot, options.apply, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.manual.length) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { canonicalSubject, semantic };
