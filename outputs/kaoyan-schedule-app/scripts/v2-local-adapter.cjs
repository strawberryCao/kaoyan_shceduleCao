'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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

const hiddenDirectoryCache = new Set();

function ensureHiddenDirectory(directoryPath, apply) {
  if (!apply) return;
  fs.mkdirSync(directoryPath, { recursive: true });
  const resolved = path.resolve(directoryPath);
  if (hiddenDirectoryCache.has(resolved)) return;
  hiddenDirectoryCache.add(resolved);
  if (process.platform === 'win32') {
    spawnSync('attrib.exe', ['+H', resolved], {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
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
    // Asset bytes stay content-addressed, while originalFileName is the
    // user-facing semantic name. Both are part of entry truth; otherwise a
    // sync pass can consider an old display name unchanged and roll AI names
    // back into the learning snapshot.
    assets: (value?.assets || []).map((asset) => [asset.assetId, asset.originalFileName]),
    state: value?.state,
  });
}

function entryWithLearningTruth(entry, learningNote) {
  if (!learningNote || !entry) return entry;
  const learningUpdatedAt = String(learningNote.updatedAt || '');
  const entryUpdatedAt = String(entry.updatedAt || '');
  if (!learningUpdatedAt || learningUpdatedAt < entryUpdatedAt) return entry;
  const subject = canonicalSubject(learningNote.subject || entry.subject);
  const facets = [...new Set(Array.isArray(learningNote.facets) ? learningNote.facets : entry.facets || [])]
    .filter((facet) => entry.kind !== 'quick' || facet !== 'quick');
  const learningAttachments = Array.isArray(learningNote.attachments) ? learningNote.attachments : [];
  const assets = (Array.isArray(entry.assets) ? entry.assets : []).map((asset, index) => {
    const attachment = learningAttachments.find((item) => (
      String(item?.assetId || item?.id || '').toLowerCase() === String(asset?.assetId || '').toLowerCase()
    )) || learningAttachments[index];
    const displayName = String(attachment?.name || '').trim();
    return displayName ? { ...asset, originalFileName: displayName } : asset;
  });
  return {
    ...entry,
    title: String(learningNote.title || entry.title || '').trim(),
    body: String(learningNote.remark ?? entry.body ?? '').trim(),
    subject,
    facets,
    tags: Array.isArray(learningNote.tags) ? learningNote.tags : entry.tags || [],
    assets,
    updatedAt: learningUpdatedAt,
  };
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

function isInternalAssetPath(filePath) {
  return String(filePath || '').split(/[\\/]+/u).includes('.assets');
}

function existingVisiblePath(value, notesRoot) {
  const candidate = typeof value === 'string' && value.trim() ? path.resolve(value) : '';
  if (!candidate || isInternalAssetPath(candidate) || !fs.existsSync(candidate)) return '';
  const relative = path.relative(path.resolve(notesRoot), candidate);
  return relative.startsWith('..') || path.isAbsolute(relative) ? '' : candidate;
}

function mergeMaterializedAttachments(current, localAssets, notesRoot) {
  const visible = [];
  const currentAttachments = Array.isArray(current?.attachments) ? current.attachments : [];
  const currentPrimary = existingVisiblePath(current?.filePath, notesRoot);
  if (currentPrimary) {
    const existing = currentAttachments.find((item) => (
      existingVisiblePath(item?.filePath, notesRoot) === currentPrimary
    ));
    visible.push(existing || {
      id: 'primary-image',
      kind: 'image',
      name: current?.fileName || path.basename(currentPrimary),
      mimeType: current?.mime || '',
      size: fs.statSync(currentPrimary).size,
      filePath: currentPrimary,
      createdAt: current?.createdAt,
    });
  }
  for (const attachment of currentAttachments) {
    const filePath = existingVisiblePath(attachment?.filePath, notesRoot);
    if (filePath && !visible.some((item) => path.resolve(item.filePath) === filePath)) {
      visible.push({ ...attachment, filePath });
    }
  }
  const visibleAssetIds = new Set(visible.map((attachment) => {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(attachment.filePath)).digest('hex');
    } catch {
      return '';
    }
  }).filter(Boolean));
  const remoteOnlyAssets = localAssets.filter((attachment) => (
    !visibleAssetIds.has(String(attachment?.assetId || attachment?.id || '').toLowerCase())
  ));
  return [...visible, ...remoteOnlyAssets].filter((attachment, index, all) => (
    all.findIndex((candidate) => (
      String(candidate?.assetId || candidate?.id || '') === String(attachment?.assetId || attachment?.id || '')
      && path.resolve(String(candidate?.filePath || '')) === path.resolve(String(attachment?.filePath || ''))
    )) === index
  ));
}

function learningNotesByUid(config) {
  const snapshot = readJson(path.resolve(config.learningDataLocalPath || ''));
  const notes = new Map();
  for (const day of Object.values(snapshot?.days || {})) {
    for (const note of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      const noteUid = safeId(note?.noteUid);
      if (noteUid) notes.set(noteUid, note);
    }
  }
  return notes;
}

function attachmentSha256(attachment) {
  const assetId = String(attachment?.assetId || attachment?.id || '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(assetId)) return assetId;
  const declared = String(attachment?.checksum || attachment?.sha256 || '').replace(/^sha256:/i, '').toLowerCase();
  if (/^[a-f0-9]{64}$/.test(declared)) return declared;
  const filePath = String(attachment?.filePath || '');
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function reconcileExplicitMaterialNaming({ repoRoot, config, apply, report }) {
  const receiptRoot = path.join(path.resolve(config.assistantRoot || ''), 'material-note-receipts');
  if (!fs.existsSync(receiptRoot)) return;
  const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
  for (const receiptPath of walk(receiptRoot).filter((filePath) => /\.json$/i.test(filePath))) {
    const receipt = readJson(receiptPath);
    // Automatic and explicit AI naming produce the same authoritative display
    // names. Restricting reconciliation to manual retries made every automatic
    // success vulnerable to the next V2 sync restoring stale names.
    if (receipt?.aiNaming?.status !== 'complete') continue;
    const noteUid = safeId(receipt?.noteUid);
    const receiptAttachments = Array.isArray(receipt?.attachments) ? receipt.attachments : [];
    const entryPath = noteUid ? path.join(entryRoot, `${noteUid}.json`) : '';
    const entry = entryPath ? readJson(entryPath) : null;
    if (!entry || !Array.isArray(entry.assets) || entry.assets.length !== receiptAttachments.length) continue;

    const assetsByDigest = new Map();
    let mappingSafe = true;
    for (const asset of entry.assets) {
      const digest = attachmentSha256(asset);
      if (!digest || assetsByDigest.has(digest)) {
        mappingSafe = false;
        break;
      }
      assetsByDigest.set(digest, asset);
    }
    const orderedAssets = [];
    if (mappingSafe) {
      for (const attachment of receiptAttachments) {
        const digest = attachmentSha256(attachment);
        const asset = digest ? assetsByDigest.get(digest) : null;
        const displayName = String(attachment?.name || '').trim();
        if (!asset || !displayName) {
          mappingSafe = false;
          break;
        }
        orderedAssets.push({ ...asset, originalFileName: displayName });
      }
    }
    if (!mappingSafe || new Set(orderedAssets.map((asset) => asset.assetId)).size !== entry.assets.length) continue;
    const before = JSON.stringify(entry.assets.map((asset) => [asset.assetId, asset.originalFileName]));
    const after = JSON.stringify(orderedAssets.map((asset) => [asset.assetId, asset.originalFileName]));
    if (before === after) continue;
    const next = {
      ...entry,
      assets: orderedAssets,
      version: Math.max(1, Number(entry.version) || 1) + 1,
      updatedAt: receipt.aiNaming.completedAt || receipt.updatedAt || new Date().toISOString(),
    };
    if (apply) atomicJson(entryPath, next);
    report.explicitMaterialNamesReconciled += 1;
  }
}

function materializeMaterialReceipts({ config, notesRoot, learningNotes, apply, report }) {
  const receiptRoot = path.join(path.resolve(config.assistantRoot || ''), 'material-note-receipts');
  if (!fs.existsSync(receiptRoot)) return;
  for (const receiptPath of walk(receiptRoot).filter((filePath) => /\.json$/i.test(filePath))) {
    const receipt = readJson(receiptPath);
    const noteUid = safeId(receipt?.noteUid);
    const note = noteUid ? learningNotes.get(noteUid) : null;
    if (!note || !Array.isArray(receipt?.attachments)) continue;
    const subject = canonicalSubject(note.subject);
    const sidecarPath = path.join(notesRoot, subject, '.metadata', `${noteUid}.note.json`);
    const current = readJson(sidecarPath);
    const attachments = receipt.attachments
      .filter((attachment) => typeof attachment?.filePath === 'string' && fs.existsSync(attachment.filePath))
      .map((attachment, index) => ({
        ...attachment,
        id: safeId(attachment.id) || `material-${index + 1}`,
        filePath: path.resolve(attachment.filePath),
      }));
    const sidecar = {
      ...(current || {}),
      schemaVersion: 2,
      entryId: noteUid,
      id: noteUid,
      noteUid,
      kind: 'quick',
      subject,
      requestedSubject: subject,
      title: String(note.title || '').trim(),
      remark: String(note.remark || '').trim(),
      facets: [...new Set(['quick', ...(Array.isArray(note.facets) ? note.facets : [])])],
      tags: Array.isArray(note.tags) ? note.tags : [],
      fileName: attachments[0]?.name || '',
      filePath: attachments[0]?.filePath || '',
      attachments,
      state: 'active',
      createdAt: note.createdAt || receipt.createdAt,
      updatedAt: note.updatedAt || receipt.updatedAt,
      learning: { ...(current?.learning || {}), ...note },
    };
    const unchanged = current
      && current.filePath === sidecar.filePath
      && JSON.stringify(current.attachments || []) === JSON.stringify(sidecar.attachments)
      && String(current.updatedAt || '') === String(sidecar.updatedAt || '');
    if (unchanged) continue;
    if (apply) atomicJson(sidecarPath, sidecar);
    report.materialSidecarsCreated += 1;
  }
}

function reconcileLearningEntries({ repoRoot, learningNotes, apply, report }) {
  const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
  for (const [entryId, learningNote] of learningNotes) {
    const entryPath = path.join(entryRoot, `${entryId}.json`);
    const current = readJson(entryPath);
    if (!current) continue;
    const next = entryWithLearningTruth(current, learningNote);
    if (semantic(current) === semantic(next) && String(current.updatedAt || '') === String(next.updatedAt || '')) continue;
    next.version = Math.max(1, Number(current.version) || 1) + 1;
    if (apply) atomicJson(entryPath, next);
    report.learningEntriesReconciled += 1;
  }
}

function publishLocalEntries({ repoRoot, notesRoot, learningNotes, apply, report }) {
  const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
  const assetRecordRoot = path.join(repoRoot, 'data', 'v2', 'assets');
  const sidecars = walk(notesRoot).filter((filePath) => (
    /\.note\.json$/i.test(filePath)
    && !/\.cloud-note\.json$/i.test(filePath)
    && !/sync-conflict-/i.test(filePath)
  ));
  const preferredByEntryId = new Map();
  const sidecarPreference = (note, entryId) => {
    const learningNote = learningNotes.get(entryId);
    const subjectMatch = learningNote && canonicalSubject(note?.subject) === canonicalSubject(learningNote.subject) ? 1000 : 0;
    const materialGroup = note?.sourceType === 'material-note' || note?.sourceType === 'quick-material' ? 500 : 0;
    const attachments = Array.isArray(note?.attachments) ? note.attachments.length : 0;
    return subjectMatch + materialGroup + Math.min(8, attachments) * 20 + (Number(note?.v2Version) || 0);
  };
  for (const sidecarPath of sidecars) {
    const note = readJson(sidecarPath);
    const entryId = safeId(note?.entryId || note?.noteUid || note?.id);
    if (!entryId) {
      report.manual.push({ path: path.relative(notesRoot, sidecarPath).replaceAll('\\', '/'), reason: 'missing-stable-entry-id' });
      continue;
    }
    const current = preferredByEntryId.get(entryId);
    if (!current || sidecarPreference(note, entryId) > sidecarPreference(current.note, entryId)) {
      preferredByEntryId.set(entryId, { sidecarPath, note });
    }
  }
  for (const [entryId, { sidecarPath, note }] of preferredByEntryId) {
    const remotePath = path.join(entryRoot, `${entryId}.json`);
    const remote = readJson(remotePath);
    const localVersion = Number(note.v2Version) || 0;
    const remoteVersion = Number(remote?.version) || 0;
    if (remote && remoteVersion > localVersion) {
      report.remoteWins += 1;
      continue;
    }
    const converted = noteToEntry(note, sidecarPath, { repoRoot, notesRoot });
    const learningNote = learningNotes.get(entryId) || null;
    const next = entryWithLearningTruth(converted.entry, learningNote);
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

function materializeRemoteEntries({ repoRoot, notesRoot, learningNotes, apply, report }) {
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
    const storedEntry = readJson(entryPath);
    const storedEntryId = safeId(storedEntry?.entryId);
    const syncedNote = storedEntryId ? learningNotes.get(storedEntryId) || null : null;
    const entry = entryWithLearningTruth(storedEntry, syncedNote);
    const entryChangedByLearning = semantic(storedEntry) !== semantic(entry)
      || String(storedEntry?.updatedAt || '') !== String(entry?.updatedAt || '');
    if (entryChangedByLearning) entry.version = Math.max(1, Number(storedEntry?.version) || 1) + 1;
    const entryId = safeId(entry?.entryId);
    if (!entryId) {
      report.manual.push({ path: path.relative(repoRoot, entryPath).replaceAll('\\', '/'), reason: 'invalid-v2-entry' });
      continue;
    }
    const subject = canonicalSubject(entry.subject);
    const metadataRoot = path.join(notesRoot, subject, '.metadata');
    ensureHiddenDirectory(metadataRoot, apply);
    const canonicalSidecarPath = path.join(metadataRoot, `${entryId}.note.json`);
    const allExistingPaths = existingByEntryId.get(entryId) || [];
    const existingPaths = allExistingPaths
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
    const pruneStaleSubjectSidecars = () => {
      for (const stalePath of allExistingPaths) {
        if (path.resolve(path.dirname(stalePath)) === path.resolve(metadataRoot)) continue;
        const stale = readJson(stalePath);
        if (!stale?.v2Version || safeId(stale.entryId || stale.noteUid || stale.id) !== entryId) continue;
        if (apply && fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
        report.duplicateSidecarsPruned += 1;
      }
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
      ensureHiddenDirectory(path.join(notesRoot, subject, '.assets'), apply);
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
        filePath: destination,
        cloudPath: `github://${String(asset.path).replaceAll('\\', '/')}`,
        localPathKey: localRelative.replaceAll('\\', '/'),
        createdAt: asset.createdAt,
      });
    }
    const materializedAttachments = mergeMaterializedAttachments(current, localAssets, notesRoot);
    const visiblePrimaryPath = existingVisiblePath(current?.filePath, notesRoot)
      || existingVisiblePath(materializedAttachments[0]?.filePath, notesRoot);
    const primaryFilePath = visiblePrimaryPath || localAssets[0]?.filePath || '';
    const primaryFileName = visiblePrimaryPath
      ? (current?.fileName || path.basename(visiblePrimaryPath))
      : localAssets[0] ? path.basename(localAssets[0].localPathKey) : '';
    const primaryLocalPathKey = visiblePrimaryPath
      ? path.relative(notesRoot, visiblePrimaryPath).replaceAll('\\', '/')
      : localAssets[0]?.localPathKey || '';
    const materializedFacets = [...new Set(entry.kind === 'quick'
      ? ['quick', ...(entry.facets || [])]
      : entry.facets || [])];
    const sidecar = {
      ...(current || {}),
      schemaVersion: 2,
      entryId,
      id: visiblePrimaryPath ? (current?.id || path.parse(primaryFileName).name) : entryId,
      noteUid: entryId,
      kind: visiblePrimaryPath ? (current?.kind || 'single') : entry.kind,
      subject,
      requestedSubject: subject,
      title: entry.title,
      remark: entry.body,
      facets: materializedFacets,
      tags: entry.tags || [],
      fileName: primaryFileName,
      filePath: primaryFilePath,
      localPathKey: primaryLocalPathKey,
      attachments: materializedAttachments,
      v2Version: Number(entry.version) || 1,
      state: entry.state || 'active',
      tombstone: entry.tombstone || null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      learning: {
        ...(current?.learning || {}),
        ...(syncedNote || {}),
        capturedDate: entry.capturedDate,
        title: entry.title,
        subject,
        remark: entry.body,
        tags: entry.tags || [],
        facets: materializedFacets,
        noteType: syncedNote?.noteType || (entry.kind === 'quick' ? 'quick'
          : entry.facets?.includes('mistake') ? 'mistake'
            : entry.facets?.includes('memory') ? 'memory'
              : entry.facets?.includes('method') ? 'method' : 'note'),
      },
    };
    const currentFilePath = String(current?.filePath || '');
    const expectsAssets = localAssets.length > 0;
    const currentAttachments = Array.isArray(current?.attachments) ? current.attachments : [];
    const currentNeedsRepair = Boolean(current) && (
      expectsAssets && (
        currentFilePath !== sidecar.filePath
        || !path.isAbsolute(sidecar.filePath)
        || !fs.existsSync(sidecar.filePath)
        || JSON.stringify(currentAttachments) !== JSON.stringify(materializedAttachments)
        || materializedAttachments.some((attachment) => (
          typeof attachment?.filePath !== 'string'
          || !path.isAbsolute(attachment.filePath)
          || !fs.existsSync(attachment.filePath)
        ))
      )
    );
    const learningNeedsRefresh = Boolean(syncedNote) && (
      String(current?.learning?.updatedAt || current?.updatedAt || '')
      < String(syncedNote.updatedAt || '')
    );
    if (current && Number(current.v2Version) === Number(entry.version) && !currentNeedsRepair && !learningNeedsRefresh) {
      pruneGeneratedCanonical();
      pruneStaleSubjectSidecars();
      report.unchanged += 1;
      continue;
    }
    if (apply) {
      if (entryChangedByLearning) atomicJson(entryPath, entry);
      atomicJson(localSidecarPath, sidecar);
    }
    pruneGeneratedCanonical();
    pruneStaleSubjectSidecars();
    report.remoteMaterialized += 1;
  }
}

function parsedTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasHumanClassification(note, userEditedFields) {
  return userEditedFields.has('subject')
    || userEditedFields.has('knowledgePath')
    || String(note?.classificationSource || '') === 'manual'
    || ['accepted', 'corrected', 'ignored'].includes(String(note?.reviewStatus || ''));
}

function reconcileNewerEntryIntoLearningNote(note, entry) {
  const entryUpdatedAt = parsedTimestamp(entry?.updatedAt);
  const noteUpdatedAt = parsedTimestamp(note?.updatedAt);
  if (!entryUpdatedAt || entryUpdatedAt <= noteUpdatedAt) return false;

  const userEditedFields = new Set(Array.isArray(note?.userEditedFields) ? note.userEditedFields : []);
  let changed = false;
  const entryTitle = String(entry?.title || '').trim();
  if (!userEditedFields.has('title') && entryTitle && entryTitle !== String(note?.title || '')) {
    note.title = entryTitle;
    changed = true;
  }
  if (
    !userEditedFields.has('remark')
    && typeof entry?.body === 'string'
    && entry.body !== String(note?.remark || '')
  ) {
    note.remark = entry.body;
    changed = true;
  }
  const entrySubject = String(entry?.subject || '').trim();
  if (
    !hasHumanClassification(note, userEditedFields)
    && entrySubject
    && canonicalSubject(entrySubject) !== canonicalSubject(note?.subject)
  ) {
    note.subject = canonicalSubject(entrySubject);
    changed = true;
  }

  // Advance the record clock even when every newer field was protected by a
  // human edit. On the next pass the learning record becomes authoritative and
  // can safely push those protected values back into the V2 entry.
  if (String(note?.updatedAt || '') !== String(entry.updatedAt || '')) {
    note.updatedAt = entry.updatedAt;
    changed = true;
  }
  return changed;
}

function repairLearningAttachmentReferences({ repoRoot, notesRoot, config, apply, report }) {
  const localSnapshotPath = path.resolve(config.learningDataLocalPath || '');
  const remoteSnapshotPath = path.join(repoRoot, String(config.learningDataRemotePath || 'data/cloud/learning-data.json'));
  const snapshot = readJson(localSnapshotPath) || readJson(remoteSnapshotPath);
  if (!snapshot?.days) return;
  let changed = 0;
  let metadataChanged = 0;
  let attachmentsChanged = 0;
  for (const day of Object.values(snapshot.days)) {
    for (const note of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      const entryId = safeId(note?.noteUid);
      if (!entryId) continue;
      const entry = readJson(path.join(repoRoot, 'data', 'v2', 'entries', `${entryId}.json`));
      if (!entry) continue;
      let noteChanged = reconcileNewerEntryIntoLearningNote(note, entry);
      if (noteChanged) metadataChanged += 1;
      if (!Array.isArray(entry.assets) || entry.assets.length === 0) {
        if (noteChanged) changed += 1;
        continue;
      }
      const subject = canonicalSubject(note.subject || entry.subject);
      const existing = Array.isArray(note.attachments) ? note.attachments : [];
      const attachments = entry.assets.map((asset, index) => {
        const extension = path.extname(String(asset.path || '')) || '.bin';
        const localRelative = path.join(subject, '.assets', `${asset.assetId}${extension}`).replaceAll('\\', '/');
        const current = existing.find((attachment) => attachment?.assetId === asset.assetId)
          || existing.find((attachment) => String(attachment?.name || '') === String(asset.originalFileName || ''))
          || existing[index]
          || {};
        return {
          ...current,
          id: asset.assetId,
          assetId: asset.assetId,
          kind: asset.kind,
          name: asset.originalFileName,
          mimeType: asset.mime,
          size: asset.size,
          filePath: path.join(notesRoot, localRelative),
          cloudPath: `github://${String(asset.path || '').replaceAll('\\', '/')}`,
          localPathKey: localRelative,
          createdAt: asset.createdAt || current.createdAt,
        };
      });
      const before = JSON.stringify(existing.map((attachment) => ({
        assetId: attachment?.assetId || '',
        name: attachment?.name || '',
        cloudPath: attachment?.cloudPath || '',
        localPathKey: attachment?.localPathKey || '',
        filePath: attachment?.filePath || '',
      })));
      const after = JSON.stringify(attachments.map((attachment) => ({
        assetId: attachment.assetId,
        name: attachment.name,
        cloudPath: attachment.cloudPath,
        localPathKey: attachment.localPathKey,
        filePath: attachment.filePath,
      })));
      if (before !== after) {
        note.attachments = attachments;
        note.filePath = attachments[0]?.filePath || note.filePath;
        note.fileName = attachments[0]?.name || note.fileName;
        noteChanged = true;
        attachmentsChanged += 1;
      }
      if (noteChanged) changed += 1;
    }
  }
  if (changed === 0) return;
  report.learningAttachmentRefsRepaired += attachmentsChanged;
  report.learningMetadataRepaired += metadataChanged;
  if (!apply) return;
  const next = {
    ...snapshot,
    revision: Math.max(0, Number(snapshot.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  atomicJson(localSnapshotPath, next);
  atomicJson(remoteSnapshotPath, next);
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
  const learningNotes = learningNotesByUid(config);
  const report = {
    schemaVersion: 2,
    mode: options.apply ? 'apply' : 'dry-run',
    localPublished: 0,
    remoteMaterialized: 0,
    assetsPublished: 0,
    assetsMaterialized: 0,
    materialSidecarsCreated: 0,
    learningEntriesReconciled: 0,
    explicitMaterialNamesReconciled: 0,
    learningAttachmentRefsRepaired: 0,
    learningMetadataRepaired: 0,
    remoteWins: 0,
    localWins: 0,
    unchanged: 0,
    duplicateSidecarsPruned: 0,
    indexRebuilt: false,
    manual: [],
  };
  reconcileLearningEntries({ repoRoot, learningNotes, apply: options.apply, report });
  reconcileExplicitMaterialNaming({ repoRoot, config, apply: options.apply, report });
  materializeMaterialReceipts({
    config,
    notesRoot,
    learningNotes,
    apply: options.apply,
    report,
  });
  publishLocalEntries({ repoRoot, notesRoot, learningNotes, apply: options.apply, report });
  materializeRemoteEntries({
    repoRoot,
    notesRoot,
    learningNotes,
    apply: options.apply,
    report,
  });
  repairLearningAttachmentReferences({
    repoRoot,
    notesRoot,
    config,
    apply: options.apply,
    report,
  });
  rebuildIndex(repoRoot, options.apply, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.manual.length) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { canonicalSubject, semantic };
