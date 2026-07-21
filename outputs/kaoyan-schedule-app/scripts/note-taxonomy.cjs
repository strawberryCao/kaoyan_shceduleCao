const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { unlinkFileIfExists } = require('./safe-file-ops.cjs');

const TAXONOMY_SCHEMA_VERSION = 1;
const DEFAULT_SUBJECTS = [
  '高等数学',
  '线性代数',
  '概率论',
  '数据结构',
  '计算机组成',
  '操作系统',
  '计算机网络',
  '英语',
  '政治',
  '默认文件夹',
];

const DEFAULT_ALIASES = {
  高等数学: ['高数', '数学'],
  线性代数: ['线代'],
  概率论: ['概率'],
  计算机组成: ['组成原理', '计组'],
  计算机网络: ['计网', '网络'],
  操作系统: ['OS'],
  英语: ['考研英语', '英语一', '英语二'],
  政治: ['考研政治', '思想政治理论'],
  默认文件夹: ['默认', '未分类'],
};

function nowIso(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function sanitizeCategoryName(input, fallback = '未分类') {
  return String(input || fallback)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/^[.\s_]+|[.\s_]+$/g, '')
    .slice(0, 60) || fallback;
}

function lookupKey(input) {
  return sanitizeCategoryName(input, '')
    .replace(/[\s_-]+/g, '')
    .toLocaleLowerCase('zh-CN');
}

function uniqueAliases(items, name) {
  const nameKey = lookupKey(name);
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const alias = sanitizeCategoryName(item, '');
    const key = lookupKey(alias);
    if (!key || key === nameKey || seen.has(key)) continue;
    seen.add(key);
    result.push(alias);
  }
  return result;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeKnowledgePoint(input, now) {
  const name = sanitizeCategoryName(input?.name, '未分类知识点');
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : makeId('kp'),
    name,
    aliases: uniqueAliases(input?.aliases, name),
    createdBy: input?.createdBy === 'ai' ? 'ai' : 'user',
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : now,
  };
}

function normalizeSubject(input, now) {
  const name = sanitizeCategoryName(input?.name, '默认文件夹');
  const points = Array.isArray(input?.knowledgePoints) ? input.knowledgePoints : [];
  const pointIds = new Set();
  const knowledgePoints = [];
  for (const point of points) {
    const normalized = normalizeKnowledgePoint(point, now);
    if (pointIds.has(normalized.id)) normalized.id = makeId('kp');
    pointIds.add(normalized.id);
    knowledgePoints.push(normalized);
  }
  return {
    id: typeof input?.id === 'string' && input.id ? input.id : makeId('subject'),
    name,
    aliases: uniqueAliases(input?.aliases, name),
    createdBy: input?.createdBy === 'ai' ? 'ai' : 'user',
    createdAt: typeof input?.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : now,
    knowledgePoints,
  };
}

function normalizeTaxonomy(input, options = {}) {
  const now = nowIso(options.now);
  const source = input && typeof input === 'object' ? input : {};
  const subjectIds = new Set();
  const subjects = [];
  for (const subject of Array.isArray(source.subjects) ? source.subjects : []) {
    const normalized = normalizeSubject(subject, now);
    if (subjectIds.has(normalized.id)) normalized.id = makeId('subject');
    subjectIds.add(normalized.id);
    subjects.push(normalized);
  }
  return {
    schemaVersion: TAXONOMY_SCHEMA_VERSION,
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : now,
    subjects,
  };
}

function createDefaultTaxonomy(options = {}) {
  const timestamp = nowIso(options.now);
  return normalizeTaxonomy({
    schemaVersion: TAXONOMY_SCHEMA_VERSION,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    subjects: DEFAULT_SUBJECTS.map((name) => ({
      id: makeId('subject'),
      name,
      aliases: DEFAULT_ALIASES[name] || [],
      createdBy: 'user',
      createdAt: timestamp,
      updatedAt: timestamp,
      knowledgePoints: [],
    })),
  }, { now: options.now });
}

function atomicWriteJson(filePath, payload) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tempPath = `${filePath}.tmp-${token}`;
  const backupPath = `${filePath}.bak-${token}`;
  let backedUp = false;
  try {
    const fd = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      if (!fs.existsSync(filePath)) throw error;
      fs.renameSync(filePath, backupPath);
      backedUp = true;
      try {
        fs.renameSync(tempPath, filePath);
      } catch (replaceError) {
        if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) {
          fs.renameSync(backupPath, filePath);
          backedUp = false;
        }
        throw replaceError;
      }
    }

    if (backedUp) unlinkFileIfExists(backupPath);
  } finally {
    unlinkFileIfExists(tempPath);
    if (backedUp && fs.existsSync(backupPath) && !fs.existsSync(filePath)) {
      fs.renameSync(backupPath, filePath);
    }
  }
}

function saveTaxonomyAtomic(filePath, taxonomy, options = {}) {
  const normalized = normalizeTaxonomy(taxonomy, options);
  normalized.revision += 1;
  normalized.updatedAt = nowIso(options.now);
  atomicWriteJson(filePath, normalized);
  return normalized;
}

function loadTaxonomy(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    const taxonomy = createDefaultTaxonomy(options);
    return options.createIfMissing === false ? taxonomy : saveTaxonomyAtomic(filePath, taxonomy, options);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const taxonomy = normalizeTaxonomy(parsed, options);
  // Older installations may have been created while only part of the exam
  // subject list was available. Add missing standard roots in memory without
  // disturbing ids, aliases or user-created roots; the next normal save will
  // persist the migrated list atomically.
  for (const name of DEFAULT_SUBJECTS) {
    if (!resolveSubject(taxonomy, name)) {
      ensureSubject(taxonomy, name, {
        aliases: DEFAULT_ALIASES[name] || [],
        createdBy: 'user',
        now: options.now,
      });
    }
  }
  return taxonomy;
}

function matchesNode(node, value) {
  const target = lookupKey(value);
  return Boolean(target) && [node.name, ...(node.aliases || [])].some((candidate) => lookupKey(candidate) === target);
}

function resolveSubject(taxonomy, value) {
  return taxonomy.subjects.find((subject) => matchesNode(subject, value)) || null;
}

function resolveKnowledgePoint(subject, value) {
  if (!subject || !value) return null;
  return subject.knowledgePoints.find((point) => matchesNode(point, value)) || null;
}

function addAliases(node, aliases, timestamp) {
  const next = uniqueAliases([...(node.aliases || []), ...(aliases || [])], node.name);
  if (JSON.stringify(next) !== JSON.stringify(node.aliases || [])) {
    node.aliases = next;
    node.updatedAt = timestamp;
  }
}

function ensureSubject(taxonomy, name, options = {}) {
  const safeName = sanitizeCategoryName(name, '默认文件夹');
  const timestamp = nowIso(options.now);
  const existing = resolveSubject(taxonomy, safeName);
  if (existing) {
    addAliases(existing, options.aliases, timestamp);
    return existing;
  }
  const subject = normalizeSubject({
    name: safeName,
    aliases: options.aliases,
    createdBy: options.createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    knowledgePoints: [],
  }, timestamp);
  taxonomy.subjects.push(subject);
  taxonomy.updatedAt = timestamp;
  return subject;
}

function ensureKnowledgePoint(taxonomy, subjectValue, name, options = {}) {
  const subject = typeof subjectValue === 'object' && subjectValue
    ? subjectValue
    : ensureSubject(taxonomy, subjectValue, options);
  const safeName = sanitizeCategoryName(name, '未分类知识点');
  const timestamp = nowIso(options.now);
  const existing = resolveKnowledgePoint(subject, safeName);
  if (existing) {
    addAliases(existing, options.aliases, timestamp);
    return existing;
  }
  const point = normalizeKnowledgePoint({
    name: safeName,
    aliases: options.aliases,
    createdBy: options.createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
  }, timestamp);
  subject.knowledgePoints.push(point);
  subject.updatedAt = timestamp;
  taxonomy.updatedAt = timestamp;
  return point;
}

function renameSubject(taxonomy, subjectId, nextName, options = {}) {
  const subject = taxonomy.subjects.find((item) => item.id === subjectId);
  if (!subject) throw new Error(`Unknown subject id: ${subjectId}`);
  const safeName = sanitizeCategoryName(nextName, subject.name);
  const collision = resolveSubject(taxonomy, safeName);
  if (collision && collision.id !== subject.id) throw new Error(`Subject name already exists: ${safeName}`);
  const previous = subject.name;
  subject.name = safeName;
  addAliases(subject, [previous], nowIso(options.now));
  subject.updatedAt = nowIso(options.now);
  return subject;
}

function renameKnowledgePoint(subject, pointId, nextName, options = {}) {
  const point = subject.knowledgePoints.find((item) => item.id === pointId);
  if (!point) throw new Error(`Unknown knowledge point id: ${pointId}`);
  const safeName = sanitizeCategoryName(nextName, point.name);
  const collision = resolveKnowledgePoint(subject, safeName);
  if (collision && collision.id !== point.id) throw new Error(`Knowledge point name already exists: ${safeName}`);
  const previous = point.name;
  point.name = safeName;
  addAliases(point, [previous], nowIso(options.now));
  point.updatedAt = nowIso(options.now);
  return point;
}

function categorySegments(subject, knowledgePoint) {
  if (!subject) return [];
  return knowledgePoint
    ? [sanitizeCategoryName(subject.name), sanitizeCategoryName(knowledgePoint.name)]
    : [sanitizeCategoryName(subject.name)];
}

module.exports = {
  DEFAULT_SUBJECTS,
  TAXONOMY_SCHEMA_VERSION,
  atomicWriteJson,
  categorySegments,
  createDefaultTaxonomy,
  ensureKnowledgePoint,
  ensureSubject,
  loadTaxonomy,
  lookupKey,
  normalizeTaxonomy,
  renameKnowledgePoint,
  renameSubject,
  resolveKnowledgePoint,
  resolveSubject,
  sanitizeCategoryName,
  saveTaxonomyAtomic,
};
