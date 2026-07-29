'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.heic', '.heif']);

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') result.apply = true;
    else if (value.startsWith('--')) result[value.slice(2)] = argv[++index];
  }
  return result;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function walk(root, output = []) {
  if (!fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) walk(filePath, output);
    else output.push(filePath);
  }
  return output;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function mimeFor(extension) {
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
  })[extension] || 'application/octet-stream';
}

function timestampToken(value) {
  return String(value || '').match(/\d{8}_\d{6}/)?.[0] || '';
}

function noteList(snapshot) {
  return Object.values(snapshot?.days || {}).flatMap((day) => Array.isArray(day?.autoNotes) ? day.autoNotes : []);
}

function attachmentSource(note) {
  const attachments = Array.isArray(note.attachments) ? note.attachments : [];
  return attachments.find((item) => item?.kind === 'image') || attachments[0] || {
    id: 'legacy-primary',
    kind: 'image',
    name: path.basename(String(note.filePath || '')) || '原图',
    mimeType: '',
    size: null,
    filePath: String(note.filePath || ''),
    previewPath: '',
    posterPath: '',
    createdAt: note.createdAt || '',
  };
}

function loadAssetRecords(repoRoot) {
  const recordRoot = path.join(repoRoot, 'data', 'v2', 'assets');
  const records = walk(recordRoot)
    .filter((filePath) => filePath.toLowerCase().endsWith('.json'))
    .map((filePath) => readJson(filePath))
    .filter((record) => /^[a-f0-9]{64}$/i.test(String(record?.assetId || '')))
    .filter((record) => typeof record.path === 'string' && record.path.startsWith('data/assets/'));
  const byId = new Map(records.map((record) => [record.assetId.toLowerCase(), record]));
  return { records, byId };
}

function existingLocalFile(note, attachment, notesRoot) {
  const candidates = [attachment.filePath, note.filePath]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => path.resolve(value));
  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate)
      && fs.statSync(candidate).isFile()
      && IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())
      && path.relative(path.resolve(notesRoot), candidate).split(path.sep)[0] !== '..'
    ) return candidate;
  }
  return '';
}

function existingRepositoryFile(attachment, repoRoot) {
  const normalized = String(attachment.filePath || attachment.cloudPath || '').trim().replaceAll('\\', '/');
  const relative = normalized.startsWith('github://')
    ? normalized.slice('github://'.length)
    : normalized.startsWith('data/assets/') ? normalized : '';
  if (!relative.startsWith('data/assets/') || relative.includes('..')) return '';
  const candidate = path.resolve(repoRoot, relative);
  const assetsRoot = path.resolve(repoRoot, 'data', 'assets');
  const inside = path.relative(assetsRoot, candidate);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return '';
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : '';
}

function matchLocalByTimestamp(note, attachment, imageFiles) {
  const token = timestampToken(attachment.filePath) || timestampToken(note.filePath);
  if (!token) return '';
  const candidates = imageFiles.filter((filePath) => path.basename(filePath).includes(token));
  return candidates.length === 1 ? candidates[0] : '';
}

function matchAssetRecord(note, attachment, records) {
  const declaredId = String(attachment.assetId || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(declaredId)) {
    const declared = records.find((record) => record.assetId.toLowerCase() === declaredId);
    if (declared) return declared;
  }
  const token = timestampToken(attachment.filePath) || timestampToken(note.filePath);
  if (!token) return null;
  const candidates = records.filter((record) => timestampToken(record.originalFileName) === token);
  return candidates.length === 1 ? candidates[0] : null;
}

function createAssetRecord(filePath, timestamp) {
  const assetId = sha256(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  return {
    schemaVersion: 2,
    assetId,
    sha256: assetId,
    mime: mimeFor(extension),
    originalFileName: path.basename(filePath).slice(0, 240),
    size: stat.size,
    path: `data/assets/${assetId}${extension}`,
    kind: 'image',
    createdAt: timestamp || stat.mtime.toISOString(),
  };
}

function repairedAttachment(note, current, record, localFile, notesRoot) {
  const cloudPath = `github://${record.path}`;
  return {
    ...current,
    id: String(current.id || record.assetId),
    assetId: record.assetId,
    kind: current.kind || record.kind || 'image',
    name: String(current.name || record.originalFileName || path.basename(localFile || record.path)).slice(0, 240),
    mimeType: String(current.mimeType || record.mime || ''),
    size: Number.isFinite(Number(current.size)) ? Number(current.size) : Number(record.size) || null,
    filePath: localFile || String(current.filePath || note.filePath || cloudPath),
    cloudPath,
    localPathKey: localFile ? path.relative(notesRoot, localFile).replaceAll('\\', '/') : String(current.localPathKey || ''),
    previewPath: String(current.previewPath || ''),
    posterPath: String(current.posterPath || ''),
    createdAt: String(current.createdAt || note.createdAt || record.createdAt || ''),
  };
}

function updateEntry(repoRoot, note, record, now, apply) {
  const entryPath = path.join(repoRoot, 'data', 'v2', 'entries', `${note.noteUid}.json`);
  const entry = readJson(entryPath);
  if (!entry || entry.schemaVersion !== 2 || entry.entryId !== note.noteUid) return { updated: false, version: 0 };
  const currentAssets = Array.isArray(entry.assets) ? entry.assets : [];
  if (currentAssets.some((asset) => asset?.assetId === record.assetId)) {
    return { updated: false, version: Number(entry.version) || 1 };
  }
  const next = {
    ...entry,
    assets: [record, ...currentAssets.filter((asset) => asset?.assetId !== record.assetId)],
    version: Math.max(1, Number(entry.version) || 1) + 1,
    updatedAt: now,
  };
  if (apply) atomicJson(entryPath, next);
  return { updated: true, version: next.version };
}

function updateSidecars(notesRoot, note, attachment, version, apply) {
  let updated = 0;
  for (const sidecarPath of walk(notesRoot).filter((filePath) => /\.note\.json$/i.test(filePath))) {
    const sidecar = readJson(sidecarPath);
    if (String(sidecar?.entryId || sidecar?.noteUid || sidecar?.id || '') !== note.noteUid) continue;
    const next = {
      ...sidecar,
      fileName: attachment.name,
      filePath: attachment.cloudPath,
      localPathKey: attachment.localPathKey,
      attachments: [attachment],
      v2Version: Math.max(Number(sidecar.v2Version) || 0, version || 1),
    };
    if (apply) atomicJson(sidecarPath, next);
    updated += 1;
  }
  return updated;
}

function rebuildIndex(repoRoot, apply) {
  const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
  const entries = walk(entryRoot)
    .filter((filePath) => filePath.toLowerCase().endsWith('.json'))
    .map((filePath) => readJson(filePath))
    .filter((entry) => entry?.schemaVersion === 2 && entry.entryId)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const indexPath = path.join(repoRoot, 'data', 'v2', 'index.json');
  const current = readJson(indexPath, { schemaVersion: 2, revision: 0, entries: [] });
  const summaries = entries.map((entry) => ({
    entryId: entry.entryId,
    kind: entry.kind,
    title: entry.title,
    subject: entry.subject,
    facets: entry.facets,
    version: entry.version,
    state: entry.state,
    assetIds: (entry.assets || []).map((asset) => asset.assetId),
    capturedDate: entry.capturedDate,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
  const changed = JSON.stringify(current.entries || []) !== JSON.stringify(summaries);
  if (changed && apply) atomicJson(indexPath, {
    schemaVersion: 2,
    revision: Math.max(0, Number(current.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
    entries: summaries,
  });
  return changed;
}

function repairLearningAssets(options) {
  const learningDataPath = path.resolve(options.learningData);
  const notesRoot = path.resolve(options.notesRoot);
  const repoRoot = path.resolve(options.repoRoot);
  const apply = options.apply === true;
  const snapshot = readJson(learningDataPath);
  if (!snapshot?.days) throw new Error(`学习数据文件无效：${learningDataPath}`);
  if (!fs.existsSync(notesRoot)) throw new Error(`笔记目录不存在：${notesRoot}`);
  if (!fs.existsSync(path.join(repoRoot, '.git'))) throw new Error(`数据仓库无效：${repoRoot}`);

  const imageFiles = walk(notesRoot).filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const loaded = loadAssetRecords(repoRoot);
  const now = new Date().toISOString();
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    scannedNotes: 0,
    repairedNotes: 0,
    copiedAssets: 0,
    createdAssetRecords: 0,
    updatedEntries: 0,
    updatedSidecars: 0,
    unresolved: [],
  };

  for (const note of noteList(snapshot)) {
    report.scannedNotes += 1;
    const attachment = attachmentSource(note);
    const alreadyUsable = /^[a-f0-9]{64}$/i.test(String(attachment.assetId || ''))
      && loaded.byId.has(String(attachment.assetId).toLowerCase());
    if (alreadyUsable) continue;
    let localFile = existingLocalFile(note, attachment, notesRoot)
      || matchLocalByTimestamp(note, attachment, imageFiles);
    const repositoryFile = existingRepositoryFile(attachment, repoRoot);
    let record = localFile || repositoryFile
      ? createAssetRecord(localFile || repositoryFile, note.createdAt)
      : matchAssetRecord(note, attachment, loaded.records);
    if (!record) {
      if (attachment.filePath || note.filePath) {
        report.unresolved.push({
          noteUid: note.noteUid,
          title: note.title,
          filePath: attachment.filePath || note.filePath,
        });
      }
      continue;
    }
    const binaryPath = path.resolve(repoRoot, record.path);
    if (!localFile && fs.existsSync(binaryPath)) localFile = '';
    const sourceFile = localFile || repositoryFile;
    if (sourceFile && !fs.existsSync(binaryPath)) {
      if (apply) {
        fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
        fs.copyFileSync(sourceFile, binaryPath, fs.constants.COPYFILE_EXCL);
      }
      report.copiedAssets += 1;
    }
    const recordPath = path.join(repoRoot, 'data', 'v2', 'assets', `${record.assetId}.json`);
    if (!fs.existsSync(recordPath)) {
      if (apply) atomicJson(recordPath, record);
      report.createdAssetRecords += 1;
      loaded.records.push(record);
      loaded.byId.set(record.assetId, record);
    }
    const nextAttachment = repairedAttachment(note, attachment, record, localFile, notesRoot);
    const attachments = Array.isArray(note.attachments) ? [...note.attachments] : [];
    const imageIndex = attachments.findIndex((item) => item?.id === attachment.id);
    if (imageIndex >= 0) attachments[imageIndex] = nextAttachment;
    else attachments.unshift(nextAttachment);
    note.attachments = attachments;
    if (localFile) note.filePath = localFile;
    const entryUpdate = updateEntry(repoRoot, note, record, now, apply);
    if (entryUpdate.updated) report.updatedEntries += 1;
    report.updatedSidecars += updateSidecars(notesRoot, note, nextAttachment, entryUpdate.version, apply);
    report.repairedNotes += 1;
  }

  if (report.repairedNotes > 0) {
    snapshot.revision = Math.max(0, Number(snapshot.revision) || 0) + 1;
    snapshot.updatedAt = now;
    if (apply) {
      const backup = `${learningDataPath}.asset-repair-${now.replace(/[:.]/g, '-')}.bak`;
      fs.copyFileSync(learningDataPath, backup, fs.constants.COPYFILE_EXCL);
      atomicJson(learningDataPath, snapshot);
      report.backupPath = backup;
    }
    report.indexRebuilt = rebuildIndex(repoRoot, apply);
  } else {
    report.indexRebuilt = false;
  }
  return report;
}

function main() {
  const options = parseArgs(process.argv);
  const required = ['learning-data', 'notes-root', 'repo-root'];
  for (const key of required) {
    if (!options[key]) throw new Error(`缺少 --${key}`);
  }
  const report = repairLearningAssets({
    learningData: options['learning-data'],
    notesRoot: options['notes-root'],
    repoRoot: options['repo-root'],
    apply: options.apply,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  matchAssetRecord,
  repairLearningAssets,
  timestampToken,
};
