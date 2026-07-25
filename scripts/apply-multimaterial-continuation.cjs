'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.join(repoRoot, 'outputs', 'kaoyan-schedule-app');

function read(relative) {
  const filePath = path.join(repoRoot, relative);
  return { filePath, source: fs.readFileSync(filePath, 'utf8') };
}

function scriptKind(filePath) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function parse(filePath, source) {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind(filePath));
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function findFunction(sf, name) {
  let found = null;
  visit(sf, (node) => {
    if (!found && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
  });
  if (!found) throw new Error(`Function ${name} not found in ${sf.fileName}`);
  return found;
}

function findInterface(sf, name) {
  let found = null;
  visit(sf, (node) => {
    if (!found && ts.isInterfaceDeclaration(node) && node.name.text === name) found = node;
  });
  if (!found) throw new Error(`Interface ${name} not found in ${sf.fileName}`);
  return found;
}

function propertyName(node) {
  const name = node.name;
  if (!name) return '';
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return String(name.text);
  return '';
}

function hasObjectProperty(objectNode, name) {
  return objectNode.properties.some((property) => propertyName(property) === name);
}

function findReturnObject(fn, requiredNames) {
  let found = null;
  visit(fn.body, (node) => {
    if (found || !ts.isReturnStatement(node) || !node.expression || !ts.isObjectLiteralExpression(node.expression)) return;
    const objectNode = node.expression;
    if (requiredNames.every((name) => hasObjectProperty(objectNode, name))) found = objectNode;
  });
  if (!found) throw new Error(`Return object with [${requiredNames.join(', ')}] not found in ${fn.name?.text}`);
  return found;
}

function findCallObject(fn, calleeName, requiredNames) {
  let found = null;
  visit(fn.body, (node) => {
    if (found || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== calleeName) return;
    const objectNode = node.arguments[0];
    if (!objectNode || !ts.isObjectLiteralExpression(objectNode)) return;
    if (requiredNames.every((name) => hasObjectProperty(objectNode, name))) found = objectNode;
  });
  if (!found) throw new Error(`${calleeName} object with [${requiredNames.join(', ')}] not found in ${fn.name?.text}`);
  return found;
}

function findVariable(fn, name) {
  let found = null;
  visit(fn.body, (node) => {
    if (!found && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
  });
  if (!found) throw new Error(`Variable ${name} not found in ${fn.name?.text}`);
  return found;
}

function lineIndent(source, position) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  return source.slice(lineStart, position).match(/^\s*/)?.[0] ?? '';
}

function addObjectProperties(source, objectNode, propertyLines) {
  const missing = propertyLines.filter(({ name }) => !hasObjectProperty(objectNode, name));
  if (missing.length === 0) return source;
  const close = objectNode.getEnd() - 1;
  const closeIndent = lineIndent(source, close);
  const propertyIndent = `${closeIndent}  `;
  const last = objectNode.properties.at(-1);
  let prefix = '';
  if (last) {
    const between = source.slice(last.getEnd(), close);
    if (!between.includes(',')) prefix = ',';
  }
  const body = missing.map(({ code }) => `${propertyIndent}${code}`).join('\n');
  return `${source.slice(0, close)}${prefix}\n${body}\n${closeIndent}${source.slice(close)}`;
}

function addInterfaceMembers(source, interfaceNode, members) {
  const existing = new Set(interfaceNode.members.map(propertyName));
  const missing = members.filter(({ name }) => !existing.has(name));
  if (missing.length === 0) return source;
  const close = interfaceNode.getEnd() - 1;
  const indent = `${lineIndent(source, close)}  `;
  const body = missing.map(({ code }) => `${indent}${code}`).join('\n');
  return `${source.slice(0, close)}\n${body}\n${lineIndent(source, close)}${source.slice(close)}`;
}

function insertBeforeNode(source, node, code) {
  const position = node.getFullStart();
  return `${source.slice(0, position)}${code}${source.slice(position)}`;
}

function replaceNode(source, node, code) {
  return `${source.slice(0, node.getStart())}${code}${source.slice(node.getEnd())}`;
}

function replaceProperty(source, objectNode, name, code) {
  const property = objectNode.properties.find((item) => propertyName(item) === name);
  if (!property) throw new Error(`Property ${name} not found`);
  return replaceNode(source, property, code);
}

function addArrayStringItems(source, arrayNode, values) {
  if (!ts.isArrayLiteralExpression(arrayNode)) throw new Error('Expected array literal');
  const existing = new Set(arrayNode.elements.filter(ts.isStringLiteral).map((item) => item.text));
  const missing = values.filter((value) => !existing.has(value));
  if (missing.length === 0) return source;
  const close = arrayNode.getEnd() - 1;
  const before = source.slice(arrayNode.getStart(), close).trimEnd();
  const separator = arrayNode.elements.length > 0 && !before.endsWith(',') ? ', ' : arrayNode.elements.length > 0 ? ' ' : '';
  return `${source.slice(0, close)}${separator}${missing.map((value) => `'${value}'`).join(', ')}${source.slice(close)}`;
}

function write(relative, transform) {
  const { filePath, source } = read(relative);
  const next = transform(source, filePath);
  if (next === source) {
    console.log(`unchanged ${relative}`);
    return;
  }
  fs.writeFileSync(filePath, next, 'utf8');
  console.log(`updated ${relative}`);
}

const localHelpers = `
const LEARNING_ATTACHMENT_KINDS = new Set(['image', 'pdf', 'word', 'html', 'file']);
const LEARNING_RECORD_FACETS = new Set(['quick', 'mistake', 'good', 'memory', 'knowledge']);

function attachmentKind(name, mimeType) {
  const mime = asString(mimeType).toLowerCase();
  const extension = path.extname(asString(name)).toLowerCase();
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic', '.heif'].includes(extension)) return 'image';
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mime.includes('word') || mime.includes('officedocument.wordprocessingml') || ['.doc', '.docx'].includes(extension)) return 'word';
  if (mime === 'text/html' || ['.html', '.htm'].includes(extension)) return 'html';
  return 'file';
}

function attachmentMime(kind, name, value) {
  const explicit = asOptionalString(value);
  if (explicit) return explicit.slice(0, 160);
  const extension = path.extname(asString(name)).toLowerCase();
  if (kind === 'image') return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'word') return extension === '.doc' ? 'application/msword' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (kind === 'html') return 'text/html';
  return 'application/octet-stream';
}

function normalizeAttachments(value, legacy = {}) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.filter(isPlainObject).slice(0, 32).map((item, index) => {
    const filePath = asString(item.filePath ?? item.path ?? item.url).slice(0, 2000);
    const name = (asOptionalString(item.name) || (filePath ? path.basename(filePath.replaceAll('\\\\', '/')) : '') || \`资料 \${index + 1}\`).slice(0, 240);
    const inferred = attachmentKind(name, item.mimeType);
    const kind = LEARNING_ATTACHMENT_KINDS.has(item.kind) ? item.kind : inferred;
    const size = Number(item.size);
    return {
      id: (asOptionalString(item.id) || \`attachment-\${index + 1}\`).slice(0, 160),
      kind,
      name,
      mimeType: attachmentMime(kind, name, item.mimeType),
      size: Number.isFinite(size) && size >= 0 ? Math.round(size) : null,
      filePath,
      previewPath: asString(item.previewPath).slice(0, 2000),
      posterPath: asString(item.posterPath).slice(0, 2000),
      createdAt: asString(item.createdAt || legacy.createdAt || legacy.firstSyncedAt),
    };
  }).filter((item) => item.filePath || item.name);
  const legacyPath = asString(legacy.filePath).slice(0, 2000);
  if (legacyPath && !normalized.some((item) => item.filePath === legacyPath)) {
    const name = path.basename(legacyPath.replaceAll('\\\\', '/')) || '原始资料';
    const kind = attachmentKind(name, '');
    normalized.unshift({
      id: 'legacy-primary', kind, name, mimeType: attachmentMime(kind, name, ''), size: null,
      filePath: legacyPath, previewPath: '', posterPath: '',
      createdAt: asString(legacy.firstSyncedAt || legacy.createdAt),
    });
  }
  return [...new Map(normalized.map((item) => [item.id, item])).values()].slice(0, 32);
}

function normalizeFacets(value, note = {}) {
  const facets = new Set(uniqueStrings(value).filter((item) => LEARNING_RECORD_FACETS.has(item)));
  const noteType = asString(note.noteType).toLowerCase();
  if (noteType === 'quick') facets.add('quick');
  if (noteType === 'mistake') facets.add('mistake');
  if (noteType === 'memory') facets.add('memory');
  if (noteType === 'knowledge') facets.add('knowledge');
  if (note.goodQuestion === true) facets.add('good');
  for (const tag of uniqueStrings(note.tags)) {
    if (tag.includes('错题')) facets.add('mistake');
    if (tag.includes('好题')) facets.add('good');
    if (tag.includes('背诵') || tag.includes('记忆')) facets.add('memory');
    if (tag.includes('速记')) facets.add('quick');
    if (tag.includes('知识')) facets.add('knowledge');
  }
  return [...facets];
}

function primaryAttachmentPath(value) {
  return normalizeAttachments(value)[0]?.filePath || '';
}

`;

const clientHelpers = `
const LEARNING_ATTACHMENT_KINDS = new Set<LearningAttachmentKind>(['image', 'pdf', 'word', 'html', 'file']);
const LEARNING_RECORD_FACETS = new Set<LearningRecordFacet>(['quick', 'mistake', 'good', 'memory', 'knowledge']);

const attachmentKind = (name: string, mimeType: string): LearningAttachmentKind => {
  const mime = mimeType.toLowerCase();
  const extension = name.toLowerCase().match(/\\.[a-z0-9]+$/)?.[0] ?? '';
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic', '.heif'].includes(extension)) return 'image';
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mime.includes('word') || mime.includes('officedocument.wordprocessingml') || ['.doc', '.docx'].includes(extension)) return 'word';
  if (mime === 'text/html' || ['.html', '.htm'].includes(extension)) return 'html';
  return 'file';
};

const attachmentMime = (kind: LearningAttachmentKind, name: string, value: unknown): string => {
  if (typeof value === 'string' && value.trim()) return value.slice(0, 160);
  const extension = name.toLowerCase().match(/\\.[a-z0-9]+$/)?.[0] ?? '';
  if (kind === 'image') return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'word') return extension === '.doc' ? 'application/msword' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (kind === 'html') return 'text/html';
  return 'application/octet-stream';
};

const normalizeAttachments = (value: unknown, legacy: Record<string, unknown> = {}): LearningAttachment[] => {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.filter(isObject).slice(0, 32).map((item, index) => {
    const filePath = typeof (item.filePath ?? item.path ?? item.url) === 'string' ? String(item.filePath ?? item.path ?? item.url).slice(0, 2000) : '';
    const fallbackName = filePath.replaceAll('\\\\', '/').split('/').filter(Boolean).at(-1) ?? '';
    const name = (typeof item.name === 'string' && item.name.trim() ? item.name.trim() : fallbackName || \`资料 \${index + 1}\`).slice(0, 240);
    const inferred = attachmentKind(name, typeof item.mimeType === 'string' ? item.mimeType : '');
    const kind = LEARNING_ATTACHMENT_KINDS.has(item.kind as LearningAttachmentKind) ? item.kind as LearningAttachmentKind : inferred;
    const size = Number(item.size);
    return {
      id: (typeof item.id === 'string' && item.id.trim() ? item.id.trim() : \`attachment-\${index + 1}\`).slice(0, 160),
      kind,
      name,
      mimeType: attachmentMime(kind, name, item.mimeType),
      size: Number.isFinite(size) && size >= 0 ? Math.round(size) : null,
      filePath,
      previewPath: typeof item.previewPath === 'string' ? item.previewPath.slice(0, 2000) : '',
      posterPath: typeof item.posterPath === 'string' ? item.posterPath.slice(0, 2000) : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : typeof legacy.createdAt === 'string' ? legacy.createdAt : '',
    };
  }).filter((item) => item.filePath || item.name);
  const legacyPath = typeof legacy.filePath === 'string' ? legacy.filePath.slice(0, 2000) : '';
  if (legacyPath && !normalized.some((item) => item.filePath === legacyPath)) {
    const name = legacyPath.replaceAll('\\\\', '/').split('/').filter(Boolean).at(-1) ?? '原始资料';
    const kind = attachmentKind(name, '');
    normalized.unshift({
      id: 'legacy-primary', kind, name, mimeType: attachmentMime(kind, name, ''), size: null,
      filePath: legacyPath, previewPath: '', posterPath: '',
      createdAt: typeof legacy.firstSyncedAt === 'string' ? legacy.firstSyncedAt : typeof legacy.createdAt === 'string' ? legacy.createdAt : '',
    });
  }
  return [...new Map(normalized.map((item) => [item.id, item])).values()].slice(0, 32);
};

const normalizeFacets = (value: unknown, note: Record<string, unknown> = {}): LearningRecordFacet[] => {
  const facets = new Set(strings(value).filter((item): item is LearningRecordFacet => LEARNING_RECORD_FACETS.has(item as LearningRecordFacet)));
  const noteType = typeof note.noteType === 'string' ? note.noteType.toLowerCase() : '';
  if (noteType === 'quick') facets.add('quick');
  if (noteType === 'mistake') facets.add('mistake');
  if (noteType === 'memory') facets.add('memory');
  if (noteType === 'knowledge') facets.add('knowledge');
  if (note.goodQuestion === true) facets.add('good');
  for (const tag of strings(note.tags)) {
    if (tag.includes('错题')) facets.add('mistake');
    if (tag.includes('好题')) facets.add('good');
    if (tag.includes('背诵') || tag.includes('记忆')) facets.add('memory');
    if (tag.includes('速记')) facets.add('quick');
    if (tag.includes('知识')) facets.add('knowledge');
  }
  return [...facets];
};

`;

const cloudHelpers = `
const LEARNING_ATTACHMENT_KINDS = new Set(['image', 'pdf', 'word', 'html', 'file']);
const LEARNING_RECORD_FACETS = new Set(['quick', 'mistake', 'good', 'memory', 'knowledge']);

function attachmentKind(name, mimeType) {
  const mime = text(mimeType).toLowerCase();
  const extension = text(name).toLowerCase().match(/\\.[a-z0-9]+$/)?.[0] ?? '';
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.heic', '.heif'].includes(extension)) return 'image';
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mime.includes('word') || mime.includes('officedocument.wordprocessingml') || ['.doc', '.docx'].includes(extension)) return 'word';
  if (mime === 'text/html' || ['.html', '.htm'].includes(extension)) return 'html';
  return 'file';
}

function attachmentMime(kind, name, value) {
  const explicit = text(value, 160).trim();
  if (explicit) return explicit;
  const extension = text(name).toLowerCase().match(/\\.[a-z0-9]+$/)?.[0] ?? '';
  if (kind === 'image') return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'word') return extension === '.doc' ? 'application/msword' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (kind === 'html') return 'text/html';
  return 'application/octet-stream';
}

function normalizeAttachments(value, legacy = {}) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.filter(isObject).slice(0, 32).map((item, index) => {
    const filePath = text(item.filePath ?? item.path ?? item.url, 2000);
    const fallbackName = filePath.replaceAll('\\\\', '/').split('/').filter(Boolean).at(-1) ?? '';
    const name = (text(item.name, 240).trim() || fallbackName || \`资料 \${index + 1}\`).slice(0, 240);
    const inferred = attachmentKind(name, item.mimeType);
    const kind = LEARNING_ATTACHMENT_KINDS.has(item.kind) ? item.kind : inferred;
    const size = Number(item.size);
    return {
      id: (text(item.id, 160).trim() || \`attachment-\${index + 1}\`), kind, name,
      mimeType: attachmentMime(kind, name, item.mimeType),
      size: Number.isFinite(size) && size >= 0 ? Math.round(size) : null,
      filePath,
      previewPath: text(item.previewPath, 2000),
      posterPath: text(item.posterPath, 2000),
      createdAt: text(item.createdAt || legacy.createdAt || legacy.firstSyncedAt, 80),
    };
  }).filter((item) => item.filePath || item.name);
  const legacyPath = text(legacy.filePath, 2000);
  if (legacyPath && !normalized.some((item) => item.filePath === legacyPath)) {
    const name = legacyPath.replaceAll('\\\\', '/').split('/').filter(Boolean).at(-1) ?? '原始资料';
    const kind = attachmentKind(name, '');
    normalized.unshift({
      id: 'legacy-primary', kind, name, mimeType: attachmentMime(kind, name, ''), size: null,
      filePath: legacyPath, previewPath: '', posterPath: '', createdAt: text(legacy.firstSyncedAt || legacy.createdAt, 80),
    });
  }
  return [...new Map(normalized.map((item) => [item.id, item])).values()].slice(0, 32);
}

function normalizeFacets(value, note = {}) {
  const facets = new Set(uniqueStrings(value).filter((item) => LEARNING_RECORD_FACETS.has(item)));
  const noteType = text(note.noteType).toLowerCase();
  if (noteType === 'quick') facets.add('quick');
  if (noteType === 'mistake') facets.add('mistake');
  if (noteType === 'memory') facets.add('memory');
  if (noteType === 'knowledge') facets.add('knowledge');
  if (note.goodQuestion === true) facets.add('good');
  for (const tag of uniqueStrings(note.tags)) {
    if (tag.includes('错题')) facets.add('mistake');
    if (tag.includes('好题')) facets.add('good');
    if (tag.includes('背诵') || tag.includes('记忆')) facets.add('memory');
    if (tag.includes('速记')) facets.add('quick');
    if (tag.includes('知识')) facets.add('knowledge');
  }
  return [...facets];
}

function primaryAttachmentPath(value) {
  return normalizeAttachments(value)[0]?.filePath || '';
}

`;

write('outputs/kaoyan-schedule-app/scripts/learning-data-store.cjs', (original, filePath) => {
  let source = original;
  let sf = parse(filePath, source);
  if (!source.includes('function normalizeAttachments(')) {
    source = insertBeforeNode(source, findFunction(sf, 'normalizeAutoNote'), localHelpers);
    sf = parse(filePath, source);
  }

  let fn = findFunction(sf, 'normalizeAutoNote');
  let objectNode = findReturnObject(fn, ['noteUid', 'cardIds']);
  source = addObjectProperties(source, objectNode, [
    { name: 'sourceType', code: "sourceType: asString(value.sourceType).slice(0, 80)," },
    { name: 'sourceBatchId', code: "sourceBatchId: asString(value.sourceBatchId).slice(0, 160)," },
    { name: 'sourceSplitIndex', code: "sourceSplitIndex: Number.isFinite(Number(value.sourceSplitIndex)) ? Math.max(1, Math.round(Number(value.sourceSplitIndex))) : null," },
    { name: 'attachments', code: "attachments: normalizeAttachments(value.attachments, { filePath, createdAt: value.createdAt, firstSyncedAt: value.firstSyncedAt })," },
    { name: 'facets', code: "facets: normalizeFacets(value.facets, value)," },
    { name: 'wrongReasonSource', code: "wrongReasonSource: asString(value.wrongReasonSource).slice(0, 80)," },
    { name: 'wrongReasonConfidence', code: "wrongReasonConfidence: Number.isFinite(Number(value.wrongReasonConfidence)) ? Math.min(1, Math.max(0, Number(value.wrongReasonConfidence))) : null," },
  ]);
  sf = parse(filePath, source);

  fn = findFunction(sf, 'applyNoteSync');
  objectNode = findCallObject(fn, 'normalizeAutoNote', ['noteUid', 'capturedDate', 'cardIds']);
  source = addObjectProperties(source, objectNode, [
    { name: 'sourceType', code: "sourceType: metadata.sourceType ?? enrichment.sourceType ?? existingNote?.sourceType," },
    { name: 'sourceBatchId', code: "sourceBatchId: metadata.sourceBatchId ?? enrichment.sourceBatchId ?? existingNote?.sourceBatchId," },
    { name: 'sourceSplitIndex', code: "sourceSplitIndex: metadata.sourceSplitIndex ?? enrichment.sourceSplitIndex ?? existingNote?.sourceSplitIndex," },
    { name: 'attachments', code: "attachments: enrichment.attachments ?? metadata.attachments ?? existingNote?.attachments," },
    { name: 'facets', code: "facets: enrichment.facets ?? metadata.facets ?? existingNote?.facets," },
    { name: 'wrongReasonSource', code: "wrongReasonSource: enrichment.wrongReasonSource ?? existingNote?.wrongReasonSource," },
    { name: 'wrongReasonConfidence', code: "wrongReasonConfidence: enrichment.wrongReasonConfidence ?? existingNote?.wrongReasonConfidence," },
  ]);
  sf = parse(filePath, source);

  fn = findFunction(sf, 'createNote');
  objectNode = findCallObject(fn, 'normalizeAutoNote', ['noteUid', 'capturedDate', 'filePath']);
  source = replaceProperty(source, objectNode, 'filePath', 'filePath: primaryAttachmentPath(input.attachments)');
  sf = parse(filePath, source);
  fn = findFunction(sf, 'createNote');
  objectNode = findCallObject(fn, 'normalizeAutoNote', ['noteUid', 'capturedDate', 'filePath']);
  source = addObjectProperties(source, objectNode, [
    { name: 'attachments', code: "attachments: input.attachments," },
    { name: 'facets', code: "facets: input.facets," },
  ]);
  sf = parse(filePath, source);

  fn = findFunction(sf, 'updateNote');
  let declaration = findVariable(fn, 'contentKeys');
  source = addArrayStringItems(source, declaration.initializer, ['attachments', 'facets']);
  sf = parse(filePath, source);
  fn = findFunction(sf, 'updateNote');
  declaration = findVariable(fn, 'normalizedPatchValue');
  source = replaceNode(source, declaration.initializer, `(key) => {
            if (key === 'knowledgePath' || key === 'tags') return JSON.stringify(uniqueStrings(patch[key]));
            if (key === 'attachments') return JSON.stringify(normalizeAttachments(patch.attachments));
            if (key === 'facets') return JSON.stringify(normalizeFacets(patch.facets, { ...note, ...patch }));
            if (key === 'goodQuestion') return String(patch[key] === true);
            return asString(patch[key]).trim();
          }`);
  sf = parse(filePath, source);
  fn = findFunction(sf, 'updateNote');
  declaration = findVariable(fn, 'normalizedNoteValue');
  source = replaceNode(source, declaration.initializer, `(key) => {
            if (key === 'knowledgePath' || key === 'tags') return JSON.stringify(note[key] || []);
            if (key === 'attachments') return JSON.stringify(normalizeAttachments(note.attachments, note));
            if (key === 'facets') return JSON.stringify(normalizeFacets(note.facets, note));
            if (key === 'goodQuestion') return String(note[key] === true);
            return asString(note[key]).trim();
          }`);
  sf = parse(filePath, source);
  fn = findFunction(sf, 'updateNote');
  let commitReturn = null;
  visit(fn.body, (node) => {
    if (commitReturn || !ts.isReturnStatement(node) || !ts.isCallExpression(node.expression)) return;
    if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'commit') commitReturn = node;
  });
  if (!commitReturn) throw new Error('updateNote commit return not found');
  const indent = lineIndent(source, commitReturn.getStart(sf));
  const validation = `${indent}if (Object.hasOwn(patch, 'attachments') && !Array.isArray(patch.attachments)) {\n${indent}  throw learningError('Invalid note attachments', 'INVALID_LEARNING_NOTE');\n${indent}}\n${indent}if (Object.hasOwn(patch, 'facets') && !Array.isArray(patch.facets)) {\n${indent}  throw learningError('Invalid note facets', 'INVALID_LEARNING_NOTE');\n${indent}}\n`;
  if (!source.slice(fn.getStart(sf), commitReturn.getStart(sf)).includes('Invalid note attachments')) {
    source = `${source.slice(0, commitReturn.getFullStart())}${validation}${source.slice(commitReturn.getFullStart())}`;
  }
  sf = parse(filePath, source);
  fn = findFunction(sf, 'updateNote');
  objectNode = findCallObject(fn, 'normalizeAutoNote', ['updatedAt', 'studyNotes']);
  source = addObjectProperties(source, objectNode, [
    { name: 'attachments', code: "...(Object.hasOwn(patch, 'attachments') ? { attachments: patch.attachments, filePath: primaryAttachmentPath(patch.attachments) || note.filePath } : {})," },
    { name: 'facets', code: "...(Object.hasOwn(patch, 'facets') ? { facets: patch.facets } : {})," },
  ]);
  return source;
});

write('outputs/kaoyan-schedule-app/src/utils/learningData.ts', (original, filePath) => {
  let source = original;
  let sf = parse(filePath, source);
  if (!source.includes('export type LearningAttachmentKind')) {
    const insertionPoint = source.indexOf('export type LearningCardStatus');
    const types = `export type LearningAttachmentKind = 'image' | 'pdf' | 'word' | 'html' | 'file';\nexport type LearningRecordFacet = 'quick' | 'mistake' | 'good' | 'memory' | 'knowledge';\n\nexport interface LearningAttachment {\n  id: string;\n  kind: LearningAttachmentKind;\n  name: string;\n  mimeType: string;\n  size: number | null;\n  filePath: string;\n  previewPath: string;\n  posterPath: string;\n  createdAt: string;\n}\n\n`;
    source = `${source.slice(0, insertionPoint)}${types}${source.slice(insertionPoint)}`;
    sf = parse(filePath, source);
  }

  let iface = findInterface(sf, 'LearningNotePatch');
  source = addInterfaceMembers(source, iface, [
    { name: 'attachments', code: 'attachments?: LearningAttachment[];' },
    { name: 'facets', code: 'facets?: LearningRecordFacet[];' },
  ]);
  sf = parse(filePath, source);
  iface = findInterface(sf, 'LearningNoteCreateInput');
  source = addInterfaceMembers(source, iface, [
    { name: 'attachments', code: 'attachments?: LearningAttachment[];' },
    { name: 'facets', code: 'facets?: LearningRecordFacet[];' },
  ]);
  sf = parse(filePath, source);
  iface = findInterface(sf, 'LearningAutoNote');
  source = addInterfaceMembers(source, iface, [
    { name: 'attachments', code: 'attachments: LearningAttachment[];' },
    { name: 'facets', code: 'facets: LearningRecordFacet[];' },
  ]);
  sf = parse(filePath, source);

  if (!source.includes('const normalizeAttachments =')) {
    let normalizeAutoNote = null;
    visit(sf, (node) => {
      if (!normalizeAutoNote && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'normalizeAutoNote') normalizeAutoNote = node;
    });
    if (!normalizeAutoNote) throw new Error('normalizeAutoNote variable not found');
    source = insertBeforeNode(source, normalizeAutoNote.parent.parent, clientHelpers);
    sf = parse(filePath, source);
  }

  let normalizeDecl = null;
  visit(sf, (node) => {
    if (!normalizeDecl && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'normalizeAutoNote') normalizeDecl = node;
  });
  if (!normalizeDecl) throw new Error('normalizeAutoNote variable not found');
  let objectNode = null;
  visit(normalizeDecl.initializer, (node) => {
    if (!objectNode && ts.isObjectLiteralExpression(node) && ['noteUid', 'cardIds'].every((name) => hasObjectProperty(node, name))) objectNode = node;
  });
  if (!objectNode) throw new Error('client normalizeAutoNote return object not found');
  source = addObjectProperties(source, objectNode, [
    { name: 'attachments', code: "attachments: normalizeAttachments(value.attachments, { filePath, createdAt: value.createdAt, firstSyncedAt: value.firstSyncedAt })," },
    { name: 'facets', code: "facets: normalizeFacets(value.facets, value)," },
  ]);
  return source;
});

write('outputs/kaoyan-schedule-app/cloudflare/learning.js', (original, filePath) => {
  let source = original;
  let sf = parse(filePath, source);
  if (!source.includes('function normalizeAttachments(')) {
    source = insertBeforeNode(source, findFunction(sf, 'manualRecord'), cloudHelpers);
    sf = parse(filePath, source);
  }

  let fn = findFunction(sf, 'noteDefaults');
  let objectNode = findReturnObject(fn, ['noteUid', 'cardIds']);
  source = replaceProperty(source, objectNode, 'filePath', 'filePath: primaryAttachmentPath(input.attachments)');
  sf = parse(filePath, source);
  fn = findFunction(sf, 'noteDefaults');
  objectNode = findReturnObject(fn, ['noteUid', 'cardIds']);
  source = addObjectProperties(source, objectNode, [
    { name: 'attachments', code: "attachments: normalizeAttachments(input.attachments, { filePath: primaryAttachmentPath(input.attachments), createdAt: timestamp, firstSyncedAt: timestamp })," },
    { name: 'facets', code: "facets: normalizeFacets(input.facets, input)," },
  ]);
  sf = parse(filePath, source);

  fn = findFunction(sf, 'patchNote');
  let declaration = findVariable(fn, 'allowed');
  source = addArrayStringItems(source, declaration.initializer, ['attachments', 'facets']);
  sf = parse(filePath, source);
  fn = findFunction(sf, 'patchNote');
  declaration = findVariable(fn, 'contentEdited');
  const filterCall = declaration.initializer;
  if (!ts.isCallExpression(filterCall) || !ts.isPropertyAccessExpression(filterCall.expression) || !ts.isArrayLiteralExpression(filterCall.expression.expression)) {
    throw new Error('patchNote contentEdited shape changed');
  }
  source = addArrayStringItems(source, filterCall.expression.expression, ['attachments', 'facets']);
  sf = parse(filePath, source);
  fn = findFunction(sf, 'patchNote');
  objectNode = null;
  visit(fn.body, (node) => {
    if (!objectNode && ts.isObjectLiteralExpression(node) && ['subject', 'knowledgePath', 'updatedAt'].every((name) => hasObjectProperty(node, name))) objectNode = node;
  });
  if (!objectNode) throw new Error('patchNote updated object not found');
  source = addObjectProperties(source, objectNode, [
    { name: 'attachments', code: "...(Object.hasOwn(patch, 'attachments') ? { attachments: normalizeAttachments(patch.attachments, note), filePath: primaryAttachmentPath(patch.attachments) || note.filePath } : {})," },
    { name: 'facets', code: "...(Object.hasOwn(patch, 'facets') ? { facets: normalizeFacets(patch.facets, { ...note, ...patch }) } : {})," },
  ]);
  sf = parse(filePath, source);

  fn = findFunction(sf, 'createSavedImageNote');
  objectNode = findReturnObject(fn, ['sourceType', 'filePath', 'manualCreated']);
  const filePathProperty = objectNode.properties.find((item) => propertyName(item) === 'filePath');
  const imagePathText = filePathProperty && ts.isPropertyAssignment(filePathProperty) ? source.slice(filePathProperty.initializer.getStart(sf), filePathProperty.initializer.getEnd()) : '`github://${file.repoPath}`';
  source = addObjectProperties(source, objectNode, [
    { name: 'attachments', code: `attachments: normalizeAttachments([{ id: 'primary-image', kind: 'image', name: file.repoPath.split('/').at(-1), mimeType: '', filePath: ${imagePathText}, createdAt: timestamp }]),` },
  ]);
  return source;
});

const localTest = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLearningDataStore, normalizeSnapshot } = require('./learning-data-store.cjs');

test('legacy filePath becomes a primary attachment and synced provenance survives normalization', () => {
  const snapshot = normalizeSnapshot({
    version: 1, revision: 7, days: {
      '2026-07-24': { manual: {}, autoNotes: [{
        noteUid: 'legacy-note', capturedDate: '2026-07-24', title: 'legacy', subject: '高等数学',
        filePath: 'C:/Users/ASUS/Desktop/笔记/高等数学/legacy.png', sourceType: 'ai-multi-question',
        sourceBatchId: 'batch-1', sourceSplitIndex: 2, wrongReasonSource: 'ai', wrongReasonConfidence: 0.88,
        noteType: 'mistake', tags: ['错题'], cardIds: [],
      }] },
    }, cards: [], deletedNotes: {},
  });
  const note = snapshot.days['2026-07-24'].autoNotes[0];
  assert.equal(note.sourceType, 'ai-multi-question');
  assert.equal(note.sourceBatchId, 'batch-1');
  assert.equal(note.sourceSplitIndex, 2);
  assert.equal(note.wrongReasonSource, 'ai');
  assert.equal(note.wrongReasonConfidence, 0.88);
  assert.equal(note.attachments.length, 1);
  assert.equal(note.attachments[0].kind, 'image');
  assert.equal(note.attachments[0].filePath, note.filePath);
  assert.deepEqual(note.facets, ['mistake']);
});

test('manual notes can create and patch multiple attachments without losing legacy fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-multimaterial-'));
  const store = createLearningDataStore({ assistantRoot: root, now: () => new Date('2026-07-25T00:00:00.000Z') });
  let snapshot = store.createNote({
    noteUid: 'quick-1', capturedDate: '2026-07-25', title: '速记', subject: '高等数学', noteType: 'quick',
    remark: '同一条记录挂多份资料', facets: ['quick', 'knowledge'], attachments: [
      { id: 'img', name: '题图.png', mimeType: 'image/png', filePath: 'D:/kaoyandata/assets/题图.png', size: 12 },
      { id: 'pdf', name: '推导.pdf', mimeType: 'application/pdf', filePath: 'D:/kaoyandata/assets/推导.pdf', size: 34 },
    ],
  });
  let note = snapshot.days['2026-07-25'].autoNotes[0];
  assert.equal(note.filePath, 'D:/kaoyandata/assets/题图.png');
  assert.equal(note.attachments.length, 2);
  assert.deepEqual(note.facets, ['quick', 'knowledge']);

  snapshot = store.updateNote('quick-1', {
    facets: ['quick', 'memory'],
    attachments: [...note.attachments, { id: 'html', name: '演示.html', mimeType: 'text/html', filePath: 'D:/kaoyandata/assets/演示.html' }],
  });
  note = snapshot.days['2026-07-25'].autoNotes[0];
  assert.equal(note.attachments.length, 3);
  assert.deepEqual(note.facets, ['quick', 'memory']);
  assert.equal(note.remark, '同一条记录挂多份资料');
});
`;
const localTestPath = path.join(appRoot, 'scripts', 'learning-multimaterial.test.cjs');
if (!fs.existsSync(localTestPath)) fs.writeFileSync(localTestPath, localTest, 'utf8');

const cloudTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedImageNote } from './learning.js';

test('saved cloud image notes expose the image through the attachment collection', () => {
  const note = createSavedImageNote({ noteUid: 'cloud-note', remark: 'test' }, { repoPath: 'data/assets/cloud-note.png' }, '2026-07-25T00:00:00.000Z');
  assert.equal(note.filePath, 'github://data/assets/cloud-note.png');
  assert.equal(note.attachments.length, 1);
  assert.equal(note.attachments[0].kind, 'image');
  assert.equal(note.attachments[0].filePath, note.filePath);
});
`;
const cloudTestPath = path.join(appRoot, 'cloudflare', 'learning-multimaterial.test.mjs');
if (!fs.existsSync(cloudTestPath)) fs.writeFileSync(cloudTestPath, cloudTest, 'utf8');

console.log('Multimaterial learning-record continuation applied successfully.');
