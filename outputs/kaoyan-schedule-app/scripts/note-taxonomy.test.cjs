const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  categorySegments,
  ensureKnowledgePoint,
  ensureSubject,
  loadTaxonomy,
  renameKnowledgePoint,
  resolveKnowledgePoint,
  resolveSubject,
  saveTaxonomyAtomic,
} = require('./note-taxonomy.cjs');

test('keeps stable ids across aliases, rename and atomic reload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-taxonomy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'taxonomy.json');
  let taxonomy = loadTaxonomy(filePath);
  const subject = ensureSubject(taxonomy, '计网');
  assert.equal(subject.name, '计算机网络');
  const point = ensureKnowledgePoint(taxonomy, subject, 'TCP拥塞控制', { aliases: ['拥塞控制'] });
  const subjectId = subject.id;
  const pointId = point.id;
  renameKnowledgePoint(subject, point.id, 'TCP 拥塞控制机制');
  assert.equal(resolveKnowledgePoint(subject, 'TCP拥塞控制').id, pointId);
  taxonomy = saveTaxonomyAtomic(filePath, taxonomy);
  const reloaded = loadTaxonomy(filePath);
  const reloadedSubject = resolveSubject(reloaded, '网络');
  assert.equal(reloadedSubject.id, subjectId);
  assert.equal(resolveKnowledgePoint(reloadedSubject, '拥塞控制').id, pointId);
  assert.deepEqual(categorySegments(reloadedSubject, resolveKnowledgePoint(reloadedSubject, '拥塞控制')), ['计算机网络', 'TCP 拥塞控制机制']);
});
