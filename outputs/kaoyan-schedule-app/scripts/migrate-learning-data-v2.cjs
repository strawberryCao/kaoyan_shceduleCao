'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SUBJECTS = new Set([
  '默认文件夹', '高等数学', '线性代数', '概率论', '数据结构',
  '计算机组成', '操作系统', '计算机网络', '英语', '政治',
]);
const FACETS = new Set(['mistake', 'good', 'memory', 'knowledge', 'method']);
const JSON_PATTERN = /\.json$/i;
const CONFLICT_PATTERN = /sync-conflict-/i;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const IMPORTABLE_ASSET_PATTERN = /\.(?:avif|docx?|gif|heic|heif|html?|jpe?g|md|pdf|png|txt|webp)$/i;

function args(argv) {
  const value = { apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') value.apply = true;
    else if (token.startsWith('--')) value[token.slice(2)] = argv[++index];
  }
  return value;
}

function walk(root) {
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') stack.push(fullPath);
      } else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFile(filePath) {
  return hashBytes(fs.readFileSync(filePath));
}

function safeId(value, seed) {
  const candidate = String(value || '').trim();
  if (ENTRY_ID_PATTERN.test(candidate)) return candidate;
  return `legacy-${hashBytes(Buffer.from(String(seed || candidate))).slice(0, 40)}`;
}

function subject(value) {
  const candidate = String(value || '').normalize('NFKC').trim();
  return SUBJECTS.has(candidate) ? candidate : '默认文件夹';
}

function facets(note) {
  const result = new Set(Array.isArray(note?.facets) ? note.facets.filter((item) => FACETS.has(item)) : []);
  if (note?.noteType === 'mistake') result.add('mistake');
  if (note?.noteType === 'memory') result.add('memory');
  if (note?.noteType === 'knowledge') result.add('knowledge');
  if (note?.noteType === 'method') result.add('method');
  if (note?.goodQuestion === true) result.add('good');
  return [...result];
}

function date(value, fallback = new Date().toISOString()) {
  const parsed = new Date(value || fallback);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function capturedDate(note, timestamp) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(note?.capturedDate || ''))
    ? note.capturedDate
    : timestamp.slice(0, 10);
}

function assetCandidates(note) {
  const values = [];
  if (Array.isArray(note?.attachments)) {
    for (const attachment of note.attachments) {
      if (attachment && typeof attachment === 'object') {
        values.push({
          path: attachment.filePath || attachment.path || '',
          name: attachment.name || '',
          mime: attachment.mimeType || '',
          kind: attachment.kind || '',
        });
      }
    }
  }
  if (note?.filePath && !values.some((item) => item.path === note.filePath)) {
    values.unshift({ path: note.filePath, name: '', mime: '', kind: 'image' });
  }
  return values;
}

function resolveAsset(candidate, context) {
  const normalized = String(candidate.path || '').trim().replaceAll('\\', '/');
  const possible = [];
  if (/^[A-Za-z]:\//.test(normalized)) possible.push(normalized);
  if (normalized.startsWith('github://')) possible.push(path.join(context.repoRoot, normalized.slice('github://'.length)));
  if (normalized.startsWith('data/') || normalized.startsWith('source-notes/')) possible.push(path.join(context.repoRoot, normalized));
  if (normalized && !path.isAbsolute(normalized)) {
    possible.push(path.join(context.notesRoot, normalized), path.join(context.repoRoot, normalized));
  }
  for (const filePath of possible) {
    const resolved = path.resolve(filePath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return '';
}

function mimeFromExtension(extension) {
  return ({
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
    '.pdf': 'application/pdf', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown',
  })[extension] || 'application/octet-stream';
}

function assetKind(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (/word|officedocument/.test(mime)) return 'word';
  if (mime === 'text/html') return 'html';
  return 'file';
}

function migrateAsset(candidate, context, timestamp) {
  const sourcePath = resolveAsset(candidate, context);
  if (!sourcePath) {
    if (!candidate.path) return null;
    return { unresolved: true, originalPath: String(candidate.path).replaceAll('\\', '/') };
  }
  const bytes = fs.readFileSync(sourcePath);
  const assetId = hashBytes(bytes);
  const extension = path.extname(sourcePath).toLowerCase() || '.bin';
  const mime = String(candidate.mime || '').trim() || mimeFromExtension(extension);
  return {
    schemaVersion: 2,
    assetId,
    sha256: assetId,
    mime,
    originalFileName: String(candidate.name || path.basename(sourcePath)).slice(0, 240),
    size: bytes.length,
    path: `data/assets/${assetId}${extension}`,
    kind: candidate.kind || assetKind(mime),
    createdAt: timestamp,
    sourcePath,
  };
}

function noteToEntry(note, seed, context) {
  const timestamp = date(note?.updatedAt || note?.createdAt);
  const entryId = safeId(note?.entryId || note?.noteUid || note?.id, seed);
  const migratedAssets = assetCandidates(note).map((item) => migrateAsset(item, context, timestamp));
  const assets = [...new Map(
    migratedAssets
      .filter((item) => item && !item.unresolved)
      .map((item) => [item.assetId, item]),
  ).values()];
  const unresolvedAssets = [...new Set(
    migratedAssets.filter((item) => item?.unresolved).map((item) => item.originalPath),
  )];
  const body = String(note?.body ?? note?.remark ?? '').trim().slice(0, 8000);
  const title = String(note?.title || '').trim().slice(0, 240)
    || body.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120)
    || assets[0]?.originalFileName
    || '迁移记录';
  return {
    entry: {
      schemaVersion: 2,
      entryId,
      kind: note?.kind === 'quick' || note?.noteType === 'quick' || note?.facets?.includes?.('quick') ? 'quick' : 'note',
      title,
      body,
      subject: subject(note?.subject),
      facets: facets(note),
      tags: [...new Set(Array.isArray(note?.tags) ? note.tags.filter((item) => typeof item === 'string') : [])],
      assets: assets.map(({ sourcePath, ...asset }) => asset),
      renditions: Array.isArray(note?.renditions) ? note.renditions : [],
      thoughts: Array.isArray(note?.thoughts) ? note.thoughts : [],
      version: Math.max(1, Number(note?.version) || 1),
      state: note?.tombstone ? 'tombstoned' : note?.archivedAt ? 'archived' : 'active',
      archivedAt: note?.archivedAt || null,
      tombstone: note?.tombstone || null,
      capturedDate: capturedDate(note, timestamp),
      createdAt: date(note?.createdAt, timestamp),
      updatedAt: timestamp,
    },
    assetSources: assets.map((asset) => ({ record: asset, sourcePath: asset.sourcePath })),
    unresolvedAssets,
  };
}

function notesInJson(value) {
  if (!value || typeof value !== 'object') return [];
  if (value.schemaVersion === 2 && value.entryId) return [value];
  if (value.noteUid || value.id) return [value];
  const notes = [];
  const snapshot = value.learningData && typeof value.learningData === 'object' ? value.learningData : value;
  if (snapshot.days && typeof snapshot.days === 'object') {
    for (const day of Object.values(snapshot.days)) {
      if (Array.isArray(day?.autoNotes)) notes.push(...day.autoNotes);
    }
  }
  return notes;
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function summaryEntry(entry) {
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    title: entry.title,
    subject: entry.subject,
    facets: entry.facets,
    version: entry.version,
    state: entry.state,
    assetIds: entry.assets.map((asset) => asset.assetId),
    capturedDate: entry.capturedDate,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function importOrphanAssets({ notesRoot, entries, assetSources }) {
  const imported = [];
  for (const filePath of walk(notesRoot).filter((candidate) => IMPORTABLE_ASSET_PATTERN.test(candidate))) {
    const relative = path.relative(notesRoot, filePath).replaceAll('\\', '/');
    const segments = relative.split('/');
    if (segments.includes('.metadata') || segments.includes('.assets') || CONFLICT_PATTERN.test(relative)) continue;
    const assetId = hashFile(filePath);
    if (assetSources.has(assetId)) continue;
    const stat = fs.statSync(filePath);
    const extension = path.extname(filePath).toLowerCase() || '.bin';
    const timestamp = date(stat.mtime);
    const mime = mimeFromExtension(extension);
    const title = path.basename(filePath, extension).slice(0, 240) || '导入资料';
    const importedFacets = [];
    if (/错题/.test(title)) importedFacets.push('mistake');
    if (/背诵|记忆/.test(title)) importedFacets.push('memory');
    if (/知识/.test(title)) importedFacets.push('knowledge');
    if (/方法/.test(title)) importedFacets.push('method');
    const record = {
      schemaVersion: 2,
      assetId,
      sha256: assetId,
      mime,
      originalFileName: path.basename(filePath).slice(0, 240),
      size: stat.size,
      path: `data/assets/${assetId}${extension}`,
      kind: assetKind(mime),
      createdAt: timestamp,
    };
    const entryId = `import-${assetId}`;
    const entry = {
      schemaVersion: 2,
      entryId,
      kind: 'note',
      title,
      body: '',
      subject: subject(segments[0]),
      facets: importedFacets,
      tags: [],
      assets: [record],
      renditions: [],
      thoughts: [],
      version: 1,
      state: 'active',
      archivedAt: null,
      tombstone: null,
      capturedDate: timestamp.slice(0, 10),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    entries.set(entryId, entry);
    assetSources.set(assetId, { record: { ...record, sourcePath: filePath }, sourcePath: filePath });
    imported.push({ relativePath: relative, entryId, assetId });
  }
  return imported;
}

function main() {
  const options = args(process.argv);
  const repoRoot = path.resolve(options['repo-root'] || process.cwd());
  const notesRoot = path.resolve(options['notes-root'] || path.join(process.env.USERPROFILE || '', 'Desktop', '笔记'));
  const output = options.output ? path.resolve(options.output) : '';
  const roots = [
    { label: 'repo', root: repoRoot },
    ...(notesRoot !== repoRoot ? [{ label: 'notes', root: notesRoot }] : []),
  ];
  const jsonFiles = roots.flatMap(({ label, root }) => walk(root)
    .filter((filePath) => JSON_PATTERN.test(filePath))
    .filter((filePath) => (
      label !== 'repo'
      || !path.relative(root, filePath).replaceAll('\\', '/').startsWith('data/v2/')
    ))
    .map((filePath) => ({ label, root, filePath })));
  const manifest = [];
  const entries = new Map();
  const assetSources = new Map();
  const identities = new Map();
  const exactHashes = new Map();
  let absolutePathOccurrences = 0;

  for (const source of jsonFiles) {
    const relativePath = `${source.label}/${path.relative(source.root, source.filePath).replaceAll('\\', '/')}`;
    let raw;
    let value;
    try {
      raw = fs.readFileSync(source.filePath, 'utf8').replace(/^\uFEFF/, '');
      value = JSON.parse(raw);
    } catch (error) {
      manifest.push({ path: relativePath, classification: 'manual', reason: `invalid-json: ${error.message}` });
      continue;
    }
    absolutePathOccurrences += (raw.match(/[A-Za-z]:[\\/][^"\r\n]*/g) || []).length;
    const exactHash = hashBytes(Buffer.from(raw));
    if (exactHashes.has(exactHash)) {
      manifest.push({ path: relativePath, classification: 'duplicate', reason: `same-content-as:${exactHashes.get(exactHash)}` });
      continue;
    }
    exactHashes.set(exactHash, relativePath);
    const notes = notesInJson(value);
    if (!notes.length) {
      const knownSupport = relativePath.includes('/data/v2/assets/')
        || relativePath.includes('/data/v2/jobs/')
        || /metadata\.json$/i.test(relativePath)
        || /config|receipt|layout|taxonomy|state/i.test(relativePath);
      manifest.push({
        path: relativePath,
        classification: knownSupport ? 'adopt' : 'manual',
        reason: knownSupport ? 'recognized-support-record' : 'unrecognized-json-shape',
      });
      continue;
    }
    let adopted = 0;
    let duplicates = 0;
    let manual = 0;
    for (let index = 0; index < notes.length; index += 1) {
      const converted = noteToEntry(notes[index], `${relativePath}#${index}`, { repoRoot, notesRoot });
      const semanticHash = hashBytes(Buffer.from(JSON.stringify({
        title: converted.entry.title,
        body: converted.entry.body,
        subject: converted.entry.subject,
        facets: converted.entry.facets,
        assets: converted.entry.assets.map((asset) => asset.assetId),
      })));
      const previous = identities.get(converted.entry.entryId);
      if (previous?.semanticHash === semanticHash) {
        duplicates += 1;
        continue;
      }
      if (previous && previous.semanticHash !== semanticHash) {
        const previousTime = new Date(previous.entry.updatedAt).getTime();
        const nextTime = new Date(converted.entry.updatedAt).getTime();
        if (Number.isFinite(previousTime) && Number.isFinite(nextTime) && previousTime !== nextTime) {
          if (nextTime > previousTime) {
            entries.set(converted.entry.entryId, converted.entry);
            identities.set(converted.entry.entryId, { semanticHash, entry: converted.entry, source: relativePath });
          }
          duplicates += 1;
        } else {
          manual += 1;
        }
        continue;
      }
      entries.set(converted.entry.entryId, converted.entry);
      identities.set(converted.entry.entryId, { semanticHash, entry: converted.entry, source: relativePath });
      for (const asset of converted.assetSources) assetSources.set(asset.record.assetId, asset);
      adopted += 1;
      if (converted.unresolvedAssets.length) manual += converted.unresolvedAssets.length;
    }
    manifest.push({
      path: relativePath,
      classification: manual ? 'manual' : adopted ? 'adopt' : 'duplicate',
      reason: `entries:${notes.length};adopted:${adopted};duplicates:${duplicates};manual:${manual}${CONFLICT_PATTERN.test(relativePath) ? ';conflict-copy' : ''}`,
    });
  }
  const orphanAssets = importOrphanAssets({ notesRoot, entries, assetSources });

  const now = new Date().toISOString();
  const report = {
    schemaVersion: 2,
    generatedAt: now,
    mode: options.apply ? 'apply' : 'dry-run',
    roots: roots.map((item) => item.label),
    summary: {
      jsonFiles: manifest.length,
      adoptedFiles: manifest.filter((item) => item.classification === 'adopt').length,
      duplicateFiles: manifest.filter((item) => item.classification === 'duplicate').length,
      manualFiles: manifest.filter((item) => item.classification === 'manual').length,
      conflictCopies: manifest.filter((item) => CONFLICT_PATTERN.test(item.path)).length,
      entries: entries.size,
      assets: assetSources.size,
      orphanAssetsImported: orphanAssets.length,
      unresolvedAbsolutePathOccurrences: absolutePathOccurrences,
    },
    files: manifest,
    orphanAssets,
  };

  if (options.apply) {
    const entryRoot = path.join(repoRoot, 'data', 'v2', 'entries');
    const assetRecordRoot = path.join(repoRoot, 'data', 'v2', 'assets');
    const assetRoot = path.join(repoRoot, 'data', 'assets');
    for (const entry of entries.values()) atomicJson(path.join(entryRoot, `${entry.entryId}.json`), entry);
    for (const { record, sourcePath } of assetSources.values()) {
      const target = path.join(repoRoot, record.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(sourcePath, target);
      const { sourcePath: _localSourcePath, ...portableRecord } = record;
      atomicJson(path.join(assetRecordRoot, `${record.assetId}.json`), portableRecord);
    }
    atomicJson(path.join(repoRoot, 'data', 'v2', 'index.json'), {
      schemaVersion: 2,
      revision: 1,
      updatedAt: now,
      entries: [...entries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(summaryEntry),
    });
  }
  if (output) atomicJson(output, report);
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  if (report.summary.manualFiles > 0) process.exitCode = 2;
}

module.exports = {
  SUBJECTS,
  FACETS,
  atomicJson,
  hashFile,
  noteToEntry,
  summaryEntry,
  walk,
};

if (require.main === module) main();
