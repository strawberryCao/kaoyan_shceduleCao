const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { unlinkFileIfExists } = require('./safe-file-ops.cjs');

const CANVAS_DOCUMENT_VERSION = 1;
const DOCUMENTS_DIRECTORY = '.canvas-documents';
const DOCUMENT_FILE = 'document.json';

// v1 deliberately allows embedded image data URLs so the first editable-canvas
// release remains simple. The limits below keep a project from becoming an
// unbounded JSON blob. A later schema should move originals into an assets/
// directory while keeping document.json as the lightweight graph/index.
const DEFAULT_LIMITS = Object.freeze({
  maxDocumentBytes: 24 * 1024 * 1024,
  maxDataUrlBytes: 16 * 1024 * 1024,
  maxDataUrlBytesTotal: 20 * 1024 * 1024,
  maxImages: 64,
  maxTexts: 500,
  maxAnchors: 1000,
  maxAnnotations: 500,
  maxRelations: 500,
  maxGroups: 100,
  maxAnchorsPerAnnotation: 64,
  maxTitleLength: 240,
  maxTextLength: 20_000,
  maxLabelLength: 500,
  maxSourceNameLength: 500,
  maxEntityIdLength: 120,
  maxDimension: 50_000,
  maxCoordinate: 10_000_000,
  maxFontSize: 512,
});

const CANVAS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const KNOWN_ARRAY_FIELDS = ['images', 'nodes', 'texts', 'anchors', 'annotations', 'relations', 'groups'];

class CanvasDocumentValidationError extends Error {
  constructor(issues) {
    const normalized = Array.isArray(issues) ? issues : [String(issues)];
    super(`Invalid canvas document: ${normalized.join('; ')}`);
    this.name = 'CanvasDocumentValidationError';
    this.code = 'CANVAS_DOCUMENT_INVALID';
    this.issues = normalized;
  }
}

class CanvasDocumentStoreError extends Error {
  constructor(message, code, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CanvasDocumentStoreError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeLimits(overrides) {
  if (overrides === undefined) return { ...DEFAULT_LIMITS };
  if (!isPlainObject(overrides)) {
    throw new TypeError('Canvas document limits must be a plain object');
  }
  const merged = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) continue;
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`Canvas document limit ${key} must be a positive integer`);
    }
    merged[key] = value;
  }
  return merged;
}

function assertCanvasId(canvasId) {
  if (
    typeof canvasId !== 'string'
    || !CANVAS_ID_PATTERN.test(canvasId)
    || canvasId === '.'
    || canvasId === '..'
    || WINDOWS_RESERVED_NAME_PATTERN.test(canvasId)
  ) {
    throw new CanvasDocumentValidationError(
      'id must be 1-80 path-safe ASCII characters (letters, numbers, dot, underscore or hyphen)',
    );
  }
  return canvasId;
}

function resolveCanvasId(document, explicitCanvasId) {
  const ids = [explicitCanvasId, document?.canvasId, document?.id]
    .filter((value) => value !== undefined && value !== null && value !== '');
  if (ids.length === 0) {
    throw new CanvasDocumentValidationError('id or canvasId is required');
  }
  const canvasId = assertCanvasId(ids[0]);
  for (const id of ids.slice(1)) {
    if (assertCanvasId(id) !== canvasId) {
      throw new CanvasDocumentValidationError('id, canvasId and requested canvasId must match');
    }
  }
  return canvasId;
}

function addIssue(issues, condition, message) {
  if (!condition) issues.push(message);
}

function checkString(issues, value, field, limit, options = {}) {
  if (value === undefined && options.optional) return;
  addIssue(issues, typeof value === 'string', `${field} must be a string`);
  if (typeof value !== 'string') return;
  if (!options.allowEmpty) {
    addIssue(issues, value.trim().length > 0, `${field} must not be empty`);
  }
  addIssue(issues, value.length <= limit, `${field} exceeds ${limit} characters`);
}

function checkNumber(issues, value, field, options = {}) {
  if (value === undefined && options.optional) return;
  addIssue(issues, Number.isFinite(value), `${field} must be a finite number`);
  if (!Number.isFinite(value)) return;
  if (options.min !== undefined) addIssue(issues, value >= options.min, `${field} must be >= ${options.min}`);
  if (options.max !== undefined) addIssue(issues, value <= options.max, `${field} must be <= ${options.max}`);
}

function checkEntityId(issues, value, field, limits) {
  checkString(issues, value, field, limits.maxEntityIdLength);
}

function addEntityId(issues, registry, id, owner, limits) {
  checkEntityId(issues, id, `${owner}.id`, limits);
  if (typeof id !== 'string' || !id.trim() || id.length > limits.maxEntityIdLength) return;
  const previous = registry.get(id);
  if (previous) {
    issues.push(`${owner}.id duplicates ${previous}.id (${id})`);
  } else {
    registry.set(id, owner);
  }
}

function checkPosition(issues, item, field, limits, options = {}) {
  checkNumber(issues, item.x, `${field}.x`, {
    optional: options.optional,
    min: options.normalized ? 0 : -limits.maxCoordinate,
    max: options.normalized ? 1 : limits.maxCoordinate,
  });
  checkNumber(issues, item.y, `${field}.y`, {
    optional: options.optional,
    min: options.normalized ? 0 : -limits.maxCoordinate,
    max: options.normalized ? 1 : limits.maxCoordinate,
  });
}

function checkSize(issues, item, field, limits, options = {}) {
  const max = options.normalized ? 1 : limits.maxDimension;
  checkNumber(issues, item.width, `${field}.width`, {
    optional: options.optional,
    min: options.allowZero ? 0 : Number.EPSILON,
    max,
  });
  checkNumber(issues, item.height, `${field}.height`, {
    optional: options.optional,
    min: options.allowZero ? 0 : Number.EPSILON,
    max,
  });
}

function collectDataUrls(value, state, seen = new Set()) {
  if (typeof value === 'string') {
    if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value)) {
      const bytes = Buffer.byteLength(value, 'utf8');
      state.count += 1;
      state.totalBytes += bytes;
      state.largestBytes = Math.max(state.largestBytes, bytes);
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectDataUrls(item, state, seen);
  } else {
    for (const item of Object.values(value)) collectDataUrls(item, state, seen);
  }
}

function validateCanvasDocument(document, options = {}) {
  const limits = mergeLimits(options.limits);
  const issues = [];
  if (!isPlainObject(document)) {
    throw new CanvasDocumentValidationError('document must be a plain object');
  }

  let canvasId;
  try {
    canvasId = resolveCanvasId(document, options.canvasId);
  } catch (error) {
    if (error instanceof CanvasDocumentValidationError) issues.push(...error.issues);
    else throw error;
  }

  const version = document.version ?? document.schemaVersion;
  addIssue(issues, version === CANVAS_DOCUMENT_VERSION, `version must be ${CANVAS_DOCUMENT_VERSION}`);
  if (document.version !== undefined && document.schemaVersion !== undefined) {
    addIssue(issues, document.version === document.schemaVersion, 'version and schemaVersion must match');
  }
  checkString(issues, document.title, 'title', limits.maxTitleLength, { allowEmpty: true });
  checkString(issues, document.createdAt, 'createdAt', 80, { optional: true, allowEmpty: false });
  checkString(issues, document.updatedAt, 'updatedAt', 80, { optional: true, allowEmpty: false });

  for (const field of KNOWN_ARRAY_FIELDS) {
    if (document[field] !== undefined && !Array.isArray(document[field])) {
      issues.push(`${field} must be an array`);
    }
  }

  const images = Array.isArray(document.images) ? document.images : [];
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  const texts = Array.isArray(document.texts) ? document.texts : [];
  const anchors = Array.isArray(document.anchors) ? document.anchors : [];
  const annotations = Array.isArray(document.annotations) ? document.annotations : [];
  const relations = Array.isArray(document.relations) ? document.relations : [];
  const groups = Array.isArray(document.groups) ? document.groups : [];

  addIssue(issues, images.length + nodes.length <= limits.maxImages, `images/nodes exceed ${limits.maxImages}`);
  addIssue(issues, texts.length <= limits.maxTexts, `texts exceed ${limits.maxTexts}`);
  addIssue(issues, anchors.length <= limits.maxAnchors, `anchors exceed ${limits.maxAnchors}`);
  addIssue(issues, annotations.length <= limits.maxAnnotations, `annotations exceed ${limits.maxAnnotations}`);
  addIssue(issues, relations.length <= limits.maxRelations, `relations exceed ${limits.maxRelations}`);
  addIssue(issues, groups.length <= limits.maxGroups, `groups exceed ${limits.maxGroups}`);

  const idRegistry = new Map();
  const imageIds = new Set();
  const anchorIds = new Set();
  const annotationIds = new Set();
  const addressableIds = new Set();

  const validateImage = (image, index, collection) => {
    const field = `${collection}[${index}]`;
    if (!isPlainObject(image)) {
      issues.push(`${field} must be an object`);
      return;
    }
    addEntityId(issues, idRegistry, image.id, field, limits);
    if (typeof image.id === 'string' && image.id.trim()) {
      imageIds.add(image.id);
      addressableIds.add(image.id);
    }
    checkString(issues, image.src, `${field}.src`, limits.maxDocumentBytes, { allowEmpty: false });
    checkString(issues, image.name, `${field}.name`, limits.maxSourceNameLength, { optional: true, allowEmpty: true });
    checkPosition(issues, image, field, limits);
    checkSize(issues, image, field, limits);
    checkNumber(issues, image.naturalWidth, `${field}.naturalWidth`, { optional: true, min: 1, max: limits.maxDimension });
    checkNumber(issues, image.naturalHeight, `${field}.naturalHeight`, { optional: true, min: 1, max: limits.maxDimension });
    checkNumber(issues, image.z, `${field}.z`, { optional: true, min: -limits.maxCoordinate, max: limits.maxCoordinate });
  };

  images.forEach((item, index) => validateImage(item, index, 'images'));
  nodes.forEach((item, index) => validateImage(item, index, 'nodes'));

  texts.forEach((item, index) => {
    const field = `texts[${index}]`;
    if (!isPlainObject(item)) {
      issues.push(`${field} must be an object`);
      return;
    }
    addEntityId(issues, idRegistry, item.id, field, limits);
    if (typeof item.id === 'string' && item.id.trim()) addressableIds.add(item.id);
    checkString(issues, item.text, `${field}.text`, limits.maxTextLength, { allowEmpty: true });
    checkPosition(issues, item, field, limits);
    checkSize(issues, item, field, limits, { optional: true });
    checkNumber(issues, item.fontSize, `${field}.fontSize`, { optional: true, min: 1, max: limits.maxFontSize });
    checkString(issues, item.color, `${field}.color`, limits.maxLabelLength, { optional: true, allowEmpty: true });
  });

  anchors.forEach((anchor, index) => {
    const field = `anchors[${index}]`;
    if (!isPlainObject(anchor)) {
      issues.push(`${field} must be an object`);
      return;
    }
    addEntityId(issues, idRegistry, anchor.id, field, limits);
    if (typeof anchor.id === 'string' && anchor.id.trim()) {
      anchorIds.add(anchor.id);
      addressableIds.add(anchor.id);
    }
    checkEntityId(issues, anchor.imageId, `${field}.imageId`, limits);
    if (typeof anchor.imageId === 'string') {
      addIssue(issues, imageIds.has(anchor.imageId), `${field}.imageId references a missing image (${anchor.imageId})`);
    }
    addIssue(issues, anchor.shape === 'point' || anchor.shape === 'rect', `${field}.shape must be point or rect`);
    checkPosition(issues, anchor, field, limits, { normalized: true });
    if (anchor.shape === 'rect') {
      checkSize(issues, anchor, field, limits, { normalized: true });
      if (Number.isFinite(anchor.x) && Number.isFinite(anchor.width)) {
        addIssue(issues, anchor.x + anchor.width <= 1 + Number.EPSILON, `${field} extends beyond the image width`);
      }
      if (Number.isFinite(anchor.y) && Number.isFinite(anchor.height)) {
        addIssue(issues, anchor.y + anchor.height <= 1 + Number.EPSILON, `${field} extends beyond the image height`);
      }
    } else {
      checkNumber(issues, anchor.width, `${field}.width`, { optional: true, min: 0, max: 1 });
      checkNumber(issues, anchor.height, `${field}.height`, { optional: true, min: 0, max: 1 });
    }
    checkString(issues, anchor.label, `${field}.label`, limits.maxLabelLength, { optional: true, allowEmpty: true });
  });

  annotations.forEach((annotation, index) => {
    const field = `annotations[${index}]`;
    if (!isPlainObject(annotation)) {
      issues.push(`${field} must be an object`);
      return;
    }
    addEntityId(issues, idRegistry, annotation.id, field, limits);
    if (typeof annotation.id === 'string' && annotation.id.trim()) {
      annotationIds.add(annotation.id);
      addressableIds.add(annotation.id);
    }
    addIssue(
      issues,
      annotation.kind === 'annotation' || annotation.kind === 'relation',
      `${field}.kind must be annotation or relation`,
    );
    checkString(issues, annotation.text, `${field}.text`, limits.maxTextLength, { allowEmpty: true });
    checkPosition(issues, annotation, field, limits);
    checkSize(issues, annotation, field, limits, { optional: true });
    checkString(issues, annotation.relationType, `${field}.relationType`, limits.maxLabelLength, { optional: true, allowEmpty: true });
    checkString(issues, annotation.color, `${field}.color`, limits.maxLabelLength, { optional: true, allowEmpty: true });
    if (!Array.isArray(annotation.anchorIds)) {
      issues.push(`${field}.anchorIds must be an array`);
      return;
    }
    addIssue(
      issues,
      annotation.anchorIds.length <= limits.maxAnchorsPerAnnotation,
      `${field}.anchorIds exceed ${limits.maxAnchorsPerAnnotation}`,
    );
    // Editable projects deliberately allow incomplete annotation/relation cards.
    // Publishing performs completeness checks; persistence only verifies that
    // every reference which is present is valid and unique.
    const seen = new Set();
    for (const [anchorIndex, anchorId] of annotation.anchorIds.entries()) {
      checkEntityId(issues, anchorId, `${field}.anchorIds[${anchorIndex}]`, limits);
      if (typeof anchorId !== 'string') continue;
      addIssue(issues, anchorIds.has(anchorId), `${field}.anchorIds references a missing anchor (${anchorId})`);
      addIssue(issues, !seen.has(anchorId), `${field}.anchorIds contains a duplicate (${anchorId})`);
      seen.add(anchorId);
    }
  });

  const checkGenericReference = (reference, field) => {
    checkEntityId(issues, reference, field, limits);
    if (typeof reference === 'string') {
      addIssue(issues, addressableIds.has(reference), `${field} references a missing entity (${reference})`);
    }
  };

  relations.forEach((relation, index) => {
    const field = `relations[${index}]`;
    if (!isPlainObject(relation)) {
      issues.push(`${field} must be an object`);
      return;
    }
    addEntityId(issues, idRegistry, relation.id, field, limits);
    if (typeof relation.id === 'string' && relation.id.trim()) addressableIds.add(relation.id);
    checkString(issues, relation.label ?? relation.text, `${field}.label`, limits.maxTextLength, { optional: true, allowEmpty: true });
    for (const key of ['fromId', 'toId', 'sourceId', 'targetId', 'fromAnchorId', 'toAnchorId', 'fromAnnotationId', 'toAnnotationId']) {
      if (relation[key] !== undefined) checkGenericReference(relation[key], `${field}.${key}`);
    }
    for (const key of ['anchorIds', 'annotationIds', 'memberIds', 'targetIds']) {
      if (relation[key] === undefined) continue;
      if (!Array.isArray(relation[key])) {
        issues.push(`${field}.${key} must be an array`);
        continue;
      }
      relation[key].forEach((id, refIndex) => checkGenericReference(id, `${field}.${key}[${refIndex}]`));
    }
  });

  groups.forEach((group, index) => {
    const field = `groups[${index}]`;
    if (!isPlainObject(group)) {
      issues.push(`${field} must be an object`);
      return;
    }
    addEntityId(issues, idRegistry, group.id, field, limits);
    if (typeof group.id === 'string' && group.id.trim()) addressableIds.add(group.id);
    checkString(issues, group.title, `${field}.title`, limits.maxTitleLength, { optional: true, allowEmpty: true });
    checkString(issues, group.remark, `${field}.remark`, limits.maxTextLength, { optional: true, allowEmpty: true });
    if (group.memberIds !== undefined) {
      if (!Array.isArray(group.memberIds)) issues.push(`${field}.memberIds must be an array`);
      else group.memberIds.forEach((id, memberIndex) => checkGenericReference(id, `${field}.memberIds[${memberIndex}]`));
    }
  });

  if (document.viewport !== undefined) {
    if (!isPlainObject(document.viewport)) {
      issues.push('viewport must be an object');
    } else {
      checkNumber(issues, document.viewport.zoom, 'viewport.zoom', { optional: true, min: 0.05, max: 20 });
      checkNumber(issues, document.viewport.scrollLeft, 'viewport.scrollLeft', { optional: true, min: -limits.maxCoordinate, max: limits.maxCoordinate });
      checkNumber(issues, document.viewport.scrollTop, 'viewport.scrollTop', { optional: true, min: -limits.maxCoordinate, max: limits.maxCoordinate });
    }
  }

  let serialized;
  try {
    serialized = JSON.stringify(document, null, 2);
  } catch (error) {
    issues.push(`document must be JSON serializable (${error.message})`);
  }
  if (serialized === undefined) issues.push('document must be JSON serializable');
  const byteLength = serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  addIssue(
    issues,
    byteLength <= limits.maxDocumentBytes,
    `document exceeds ${limits.maxDocumentBytes} bytes; v1 embeds images, so reduce/compress them or use external assets`,
  );

  const dataUrls = { count: 0, totalBytes: 0, largestBytes: 0 };
  collectDataUrls(document, dataUrls);
  addIssue(
    issues,
    dataUrls.largestBytes <= limits.maxDataUrlBytes,
    `an embedded image data URL exceeds ${limits.maxDataUrlBytes} bytes`,
  );
  addIssue(
    issues,
    dataUrls.totalBytes <= limits.maxDataUrlBytesTotal,
    `embedded image data URLs exceed ${limits.maxDataUrlBytesTotal} bytes in total`,
  );

  if (issues.length > 0) throw new CanvasDocumentValidationError(issues);
  return {
    canvasId,
    byteLength,
    dataUrlCount: dataUrls.count,
    dataUrlBytes: dataUrls.totalBytes,
    serialized,
  };
}

function atomicWriteFile(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { unlinkFileIfExists(tempPath); } catch {}
    throw error;
  }
}

function summarizeDocument(document, validation, documentPath) {
  return {
    id: validation.canvasId,
    title: typeof document.title === 'string' ? document.title : '',
    version: document.version ?? document.schemaVersion,
    createdAt: typeof document.createdAt === 'string' ? document.createdAt : null,
    updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : null,
    imageCount: (Array.isArray(document.images) ? document.images.length : 0)
      + (Array.isArray(document.nodes) ? document.nodes.length : 0),
    textCount: Array.isArray(document.texts) ? document.texts.length : 0,
    anchorCount: Array.isArray(document.anchors) ? document.anchors.length : 0,
    annotationCount: Array.isArray(document.annotations) ? document.annotations.length : 0,
    relationCount: (Array.isArray(document.relations) ? document.relations.length : 0)
      + (Array.isArray(document.annotations)
        ? document.annotations.filter((item) => item?.kind === 'relation').length
        : 0),
    byteLength: validation.byteLength,
    dataUrlCount: validation.dataUrlCount,
    documentPath,
  };
}

function createCanvasDocumentStore(options = {}) {
  const explicitRoot = options?.rootDir ?? options?.projectsRoot;
  if (
    (explicitRoot !== undefined && (typeof explicitRoot !== 'string' || !explicitRoot.trim()))
    || (explicitRoot === undefined && (typeof options?.notesRoot !== 'string' || !options.notesRoot.trim()))
  ) {
    throw new TypeError('createCanvasDocumentStore requires rootDir/projectsRoot, or notesRoot for legacy storage');
  }
  const notesRoot = typeof options.notesRoot === 'string' && options.notesRoot.trim()
    ? path.resolve(options.notesRoot)
    : null;
  // New integrations should pass ASSISTANT_ROOT/canvas-projects as rootDir.
  // notesRoot remains supported so previously wired callers still resolve to
  // NOTES_ROOT/.canvas-documents without changing their saved locations.
  const rootPath = explicitRoot !== undefined
    ? path.resolve(explicitRoot)
    : path.join(notesRoot, DOCUMENTS_DIRECTORY);
  const limits = mergeLimits(options.limits);
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  function getDocumentPath(canvasId) {
    return path.join(rootPath, assertCanvasId(canvasId), DOCUMENT_FILE);
  }

  function validateDocument(document, validationOptions = {}) {
    return validateCanvasDocument(document, {
      ...validationOptions,
      limits: { ...limits, ...(validationOptions.limits || {}) },
    });
  }

  function readDocument(canvasId, readOptions = {}) {
    const filePath = getDocumentPath(canvasId);
    if (!fs.existsSync(filePath)) return null;
    let document;
    try {
      document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new CanvasDocumentStoreError(
        `Unable to read canvas document ${canvasId}: ${error.message}`,
        'CANVAS_DOCUMENT_READ_FAILED',
        error,
      );
    }
    if (readOptions.validate !== false) {
      try {
        validateDocument(document, { canvasId });
      } catch (error) {
        if (error instanceof CanvasDocumentValidationError) {
          throw new CanvasDocumentStoreError(
            `Stored canvas document ${canvasId} is invalid: ${error.issues.join('; ')}`,
            'CANVAS_DOCUMENT_STORED_INVALID',
            error,
          );
        }
        throw error;
      }
    }
    return document;
  }

  function saveDocument(document, saveOptions = {}) {
    if (!isPlainObject(document)) {
      throw new CanvasDocumentValidationError('document must be a plain object');
    }
    const canvasId = resolveCanvasId(document, saveOptions.canvasId);
    const existing = readDocument(canvasId, { validate: false });
    const timestamp = now().toISOString();
    const candidate = {
      ...document,
      id: document.id || canvasId,
      version: document.version ?? document.schemaVersion ?? CANVAS_DOCUMENT_VERSION,
      createdAt: document.createdAt || existing?.createdAt || timestamp,
      updatedAt: document.updatedAt || timestamp,
    };
    const validation = validateDocument(candidate, { canvasId });
    const filePath = getDocumentPath(canvasId);
    try {
      atomicWriteFile(filePath, validation.serialized);
    } catch (error) {
      throw new CanvasDocumentStoreError(
        `Unable to save canvas document ${canvasId}: ${error.message}`,
        'CANVAS_DOCUMENT_WRITE_FAILED',
        error,
      );
    }
    return JSON.parse(validation.serialized);
  }

  function listDocuments(listOptions = {}) {
    if (!fs.existsSync(rootPath)) return [];
    const summaries = [];
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(rootPath, entry.name, DOCUMENT_FILE);
      if (!fs.existsSync(filePath)) continue;
      try {
        const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const validation = validateDocument(document, { canvasId: entry.name });
        summaries.push(summarizeDocument(document, validation, filePath));
      } catch (error) {
        if (listOptions.includeInvalid === true) {
          summaries.push({
            id: entry.name,
            invalid: true,
            error: error.message,
            documentPath: filePath,
          });
        }
      }
    }
    return summaries.sort((left, right) => {
      if (left.invalid !== right.invalid) return left.invalid ? 1 : -1;
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
        || String(left.id).localeCompare(String(right.id));
    });
  }

  return {
    notesRoot,
    rootPath,
    projectsRoot: rootPath,
    limits: { ...limits },
    getDocumentPath,
    validateDocument,
    saveDocument,
    readDocument,
    listDocuments,
  };
}

module.exports = {
  CANVAS_DOCUMENT_VERSION,
  DEFAULT_LIMITS,
  DOCUMENTS_DIRECTORY,
  DOCUMENT_FILE,
  CanvasDocumentStoreError,
  CanvasDocumentValidationError,
  assertCanvasId,
  createCanvasDocumentStore,
  validateCanvasDocument,
};
