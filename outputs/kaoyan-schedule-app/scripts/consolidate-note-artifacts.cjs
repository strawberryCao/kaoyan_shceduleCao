'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicJson, walk } = require('./migrate-learning-data-v2.cjs');

const HASH_IMAGE_STEM = /^[a-f0-9]{64}(?:_\d+)?$/i;

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

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function ensureInside(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escaped its root: ${target}`);
  return path.resolve(target);
}

function noteId(value) {
  return String(value?.entryId || value?.noteUid || value?.id || '').trim();
}

function metadataScore(value) {
  const learning = value?.learning || {};
  const review = String(learning.reviewStatus || '');
  return (review === 'corrected' ? 10_000 : review === 'accepted' ? 8_000 : 0)
    + (learning.classificationSource === 'manual' ? 5_000 : 0)
    + Math.max(0, Number(learning.decisionRevision) || 0) * 100
    + (Array.isArray(learning.userEditedFields) ? learning.userEditedFields.length : 0);
}

function bestAttachment(records, predicate) {
  for (const record of records) {
    const candidates = [
      ...(Array.isArray(record.value?.attachments) ? record.value.attachments : []),
      ...(Array.isArray(record.value?.learning?.attachments) ? record.value.learning.attachments : []),
    ];
    const found = candidates.find(predicate);
    if (found) return found;
  }
  return null;
}

function archiveFiles(files, roots, archiveRoot) {
  const archived = [];
  for (const filePath of files) {
    const owner = roots.find((root) => {
      const relative = path.relative(root.path, filePath);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!owner) throw new Error(`Cannot archive file outside approved roots: ${filePath}`);
    const relative = path.relative(owner.path, filePath);
    const destination = path.join(archiveRoot, owner.name, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(filePath, destination, fs.constants.COPYFILE_EXCL);
    const sourceHash = hashFile(filePath);
    if (hashFile(destination) !== sourceHash) throw new Error(`Archive verification failed: ${filePath}`);
    archived.push({ filePath, archivePath: destination, sha256: sourceHash });
  }
  return archived;
}

function consolidate(options) {
  const notesRoot = path.resolve(options.notesRoot || '');
  const assistantRoot = path.resolve(options.assistantRoot || '');
  const noteUid = String(options.noteUid || '').trim();
  const preferredFile = ensureInside(notesRoot, path.resolve(options.preferredFile || ''), 'preferred file');
  if (!noteUid || !fs.existsSync(notesRoot) || !fs.existsSync(preferredFile)) {
    throw new Error('Existing notes root, note UID and preferred file are required.');
  }
  if (path.basename(path.dirname(preferredFile)) === '.assets') throw new Error('Preferred file must be user-visible.');

  const subjectDir = path.dirname(preferredFile);
  const subject = String(options.subject || path.basename(subjectDir)).trim();
  const metadataDir = path.join(subjectDir, '.metadata');
  const preferredStem = path.parse(preferredFile).name;
  const preferredSidecar = path.join(metadataDir, `${preferredStem}.note.json`);
  const digest = hashFile(preferredFile);
  const extension = path.extname(preferredFile).toLowerCase() || '.bin';
  const hiddenAsset = path.join(subjectDir, '.assets', `${digest}${extension}`);
  if (fs.existsSync(hiddenAsset) && hashFile(hiddenAsset) !== digest) {
    throw new Error(`Hidden asset hash mismatch: ${hiddenAsset}`);
  }

  const records = walk(notesRoot)
    .filter((filePath) => /\.note\.json$/i.test(filePath))
    .map((filePath) => ({ filePath, value: readJson(filePath) }))
    .filter((record) => noteId(record.value) === noteUid)
    .sort((left, right) => metadataScore(right.value) - metadataScore(left.value));
  if (records.length === 0) throw new Error(`No metadata found for note UID: ${noteUid}`);

  const source = records[0].value;
  const allVersions = records.map((record) => Number(record.value?.v2Version) || 0);
  const visibleAttachment = bestAttachment(records, (attachment) => (
    path.basename(String(attachment?.name || attachment?.filePath || '')) === path.basename(preferredFile)
  ));
  const hiddenAttachment = bestAttachment(records, (attachment) => (
    String(attachment?.assetId || attachment?.id || '').toLowerCase() === digest
  ));
  const createdAt = source.createdAt || new Date().toISOString();
  const primary = {
    ...(visibleAttachment || {}),
    id: visibleAttachment?.id || 'primary-image',
    kind: 'image',
    name: path.basename(preferredFile),
    mimeType: visibleAttachment?.mimeType || source.mime || `image/${extension.slice(1)}`,
    size: fs.statSync(preferredFile).size,
    filePath: preferredFile,
    localPathKey: path.relative(notesRoot, preferredFile).replaceAll('\\', '/'),
    createdAt: visibleAttachment?.createdAt || createdAt,
  };
  const asset = {
    ...(hiddenAttachment || {}),
    id: digest,
    assetId: digest,
    kind: hiddenAttachment?.kind || 'image',
    name: hiddenAttachment?.name || path.basename(preferredFile),
    mimeType: hiddenAttachment?.mimeType || primary.mimeType,
    size: fs.statSync(preferredFile).size,
    filePath: hiddenAsset,
    localPathKey: path.relative(notesRoot, hiddenAsset).replaceAll('\\', '/'),
    createdAt: hiddenAttachment?.createdAt || createdAt,
  };
  const attachments = [primary, asset];
  const updatedAt = new Date().toISOString();
  const title = String(options.title || source.learning?.title || source.title || preferredStem).trim().slice(0, 120);
  const canonical = {
    ...source,
    schemaVersion: Math.max(2, Number(source.schemaVersion) || 0),
    v2Version: Math.max(...allVersions, 1),
    entryId: noteUid,
    noteUid,
    id: preferredStem,
    kind: source.kind === 'quick' ? 'quick' : 'single',
    subject,
    requestedSubject: subject,
    title,
    fileName: path.basename(preferredFile),
    filePath: preferredFile,
    localPathKey: primary.localPathKey,
    attachments,
    updatedAt,
    classification: {
      ...(source.classification || {}),
      subjectName: subject,
    },
    organizer: {
      ...(source.organizer || {}),
      status: source.learning?.reviewStatus === 'corrected' ? 'user_corrected' : source.organizer?.status,
    },
    learning: {
      ...(source.learning || {}),
      title,
      subject,
      fileName: path.basename(preferredFile),
      filePath: preferredFile,
      attachments,
      cards: Array.isArray(source.learning?.cards)
        ? source.learning.cards.map((card) => ({ ...card, sourceFilePath: preferredFile }))
        : source.learning?.cards,
    },
  };

  const redundantSidecars = records.map((record) => record.filePath)
    .filter((filePath) => path.resolve(filePath) !== path.resolve(preferredSidecar));
  const redundantImages = fs.readdirSync(subjectDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && HASH_IMAGE_STEM.test(path.parse(entry.name).name))
    .map((entry) => path.join(subjectDir, entry.name))
    .filter((filePath) => hashFile(filePath) === digest && path.resolve(filePath) !== path.resolve(preferredFile));
  const timestamp = updatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const archiveRoot = path.join(assistantRoot, 'note-artifact-quarantine', `${timestamp}-${noteUid}`);
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    noteUid,
    subject,
    title,
    sha256: digest,
    preferredFile,
    preferredSidecar,
    hiddenAsset,
    sourceSidecar: records[0].filePath,
    redundantImages,
    redundantSidecars,
    archiveRoot,
    archived: [],
  };
  if (!options.apply) return report;

  fs.mkdirSync(path.dirname(hiddenAsset), { recursive: true });
  if (!fs.existsSync(hiddenAsset)) fs.copyFileSync(preferredFile, hiddenAsset, fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(path.dirname(archiveRoot), { recursive: true });
  fs.mkdirSync(archiveRoot, { recursive: false });
  report.archived = archiveFiles(
    [...redundantImages, ...redundantSidecars],
    [{ name: 'notes', path: notesRoot }, { name: 'assistant', path: assistantRoot }],
    archiveRoot,
  );
  atomicJson(preferredSidecar, canonical);
  const metadataIndexPath = path.join(metadataDir, 'metadata.json');
  const existingIndex = readJson(metadataIndexPath, []);
  const nextIndex = (Array.isArray(existingIndex) ? existingIndex : [])
    .filter((item) => noteId(item) !== noteUid);
  nextIndex.push(canonical);
  atomicJson(metadataIndexPath, nextIndex);
  const receiptPath = path.join(assistantRoot, 'note-save-receipts', `${noteUid}.json`);
  atomicJson(receiptPath, {
    schemaVersion: 1,
    noteUid,
    filePath: preferredFile,
    fileName: path.basename(preferredFile),
    sidecarPath: preferredSidecar,
    subject,
    aiStatus: canonical.naming?.status || 'completed',
    learningSyncError: null,
    updatedAt,
  });
  for (const filePath of [...redundantImages, ...redundantSidecars]) fs.unlinkSync(filePath);
  atomicJson(path.join(archiveRoot, 'inventory.json'), report);
  return report;
}

function main() {
  const args = parseArgs(process.argv);
  const report = consolidate({
    notesRoot: args['notes-root'],
    assistantRoot: args['assistant-root'],
    noteUid: args['note-uid'],
    preferredFile: args['preferred-file'],
    subject: args.subject,
    title: args.title,
    apply: args.apply,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { consolidate };
