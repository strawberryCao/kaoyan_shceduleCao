const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLearningDataStore } = require('./learning-data-store.cjs');
const { rebuildMetadataIndex } = require('./organize-notes.cjs');
const { atomicWriteJson, ensureKnowledgePoint, ensureSubject, loadTaxonomy, saveTaxonomyAtomic } = require('./note-taxonomy.cjs');

const noteUid = process.argv[2] || '6e9181e0-01ed-418e-9d57-0e1b1848075b';
const notesRoot = path.resolve(process.env.KAOYAN_NOTES_ROOT || path.join(os.homedir(), 'Desktop', '笔记'));
const assistantRoot = path.resolve(process.env.KAOYAN_ASSISTANT_ROOT || path.join(os.homedir(), 'Desktop', '考研桌面助手'));
const taxonomyPath = path.join(assistantRoot, 'note-taxonomy.json');
const learningPath = path.join(assistantRoot, 'learning-data.json');
const receiptPath = path.join(assistantRoot, 'material-note-receipts', `${noteUid}.json`);
const standardSubjects = ['高等数学', '线性代数', '概率论', '数据结构', '计算机组成', '操作系统', '计算机网络', '英语', '政治', '默认文件夹'];

function findNote(snapshot) {
  return Object.values(snapshot?.days || {})
    .flatMap((day) => Array.isArray(day?.autoNotes) ? day.autoNotes : [])
    .find((note) => note?.noteUid === noteUid);
}

function sidecarsWithUid() {
  const found = [];
  const directories = [notesRoot];
  while (directories.length > 0) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.materials' && entry.name !== '.assets') directories.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.note\.json$/i.test(entry.name)) continue;
      try {
        const metadata = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (metadata?.noteUid === noteUid) found.push(fullPath);
      } catch {}
    }
  }
  return found;
}

if (!fs.existsSync(learningPath)) throw new Error(`Learning data not found: ${learningPath}`);
if (!fs.existsSync(receiptPath)) throw new Error(`Material receipt not found: ${receiptPath}`);
const store = createLearningDataStore({ assistantRoot });
const current = findNote(store.getSnapshot());
if (!current) throw new Error(`Learning note not found: ${noteUid}`);
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
if (!Array.isArray(receipt.attachments) || receipt.attachments.length < 1) throw new Error('Material receipt has no attachments');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(assistantRoot, 'repair-backups', `${stamp}-${noteUid}`);
fs.mkdirSync(backupDir, { recursive: true });
fs.copyFileSync(learningPath, path.join(backupDir, path.basename(learningPath)));
fs.copyFileSync(receiptPath, path.join(backupDir, path.basename(receiptPath)));
for (const subject of standardSubjects) fs.mkdirSync(path.join(notesRoot, subject), { recursive: true });

const snapshot = store.updateNote(noteUid, {
  title: '函数差分关系与定积分平均值',
  subject: '高等数学',
  knowledgePath: ['高等数学', '定积分性质'],
  questionType: '函数差分关系与定积分',
  questionTypePath: ['一元函数积分学', '函数差分关系与定积分'],
  wrongReason: '',
  wrongReasonPath: [],
  learningTypePath: ['题型方法', '构造技巧'],
  goodQuestion: true,
  goodQuestionType: '方法好题',
  noteType: 'mistake',
}, { expectedRevision: store.getSnapshot().revision });
const repaired = findNote(snapshot);

const taxonomy = loadTaxonomy(taxonomyPath);
const subjectNode = ensureSubject(taxonomy, '高等数学', { createdBy: 'user' });
ensureKnowledgePoint(taxonomy, subjectNode, '定积分性质', { createdBy: 'user' });
ensureSubject(taxonomy, '概率论', { createdBy: 'user' });
saveTaxonomyAtomic(taxonomyPath, taxonomy);

const canonicalDir = path.join(notesRoot, '高等数学');
const canonicalPath = path.join(canonicalDir, '.metadata', `${noteUid}.note.json`);
fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
const duplicateDir = path.join(backupDir, 'duplicate-sidecars');
fs.mkdirSync(duplicateDir, { recursive: true });
let archivedSidecars = 0;
for (const sidecarPath of sidecarsWithUid()) {
  if (path.resolve(sidecarPath) === path.resolve(canonicalPath)) {
    fs.copyFileSync(sidecarPath, path.join(backupDir, `previous-${path.basename(sidecarPath)}`));
    continue;
  }
  const subjectName = path.basename(path.dirname(path.dirname(sidecarPath)));
  let targetPath = path.join(duplicateDir, `${subjectName}-${path.basename(sidecarPath)}`);
  let suffix = 2;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(duplicateDir, `${subjectName}-${suffix}-${path.basename(sidecarPath)}`);
    suffix += 1;
  }
  fs.renameSync(sidecarPath, targetPath);
  rebuildMetadataIndex(path.dirname(path.dirname(sidecarPath)));
  archivedSidecars += 1;
}

const primary = receipt.attachments[0];
atomicWriteJson(canonicalPath, {
  schemaVersion: 2,
  entryId: noteUid,
  id: noteUid,
  noteUid,
  kind: 'quick',
  sourceType: 'material-note',
  subject: repaired.subject,
  requestedSubject: repaired.subject,
  title: repaired.title,
  remark: repaired.remark,
  facets: repaired.facets,
  tags: repaired.tags,
  fileName: primary.name,
  filePath: primary.filePath,
  mime: primary.mimeType,
  attachments: receipt.attachments,
  state: 'active',
  createdAt: repaired.createdAt || receipt.createdAt,
  updatedAt: repaired.updatedAt,
  learning: { ...repaired, attachments: receipt.attachments },
  organizer: {
    status: 'organized',
    processedAt: new Date().toISOString(),
    reason: 'manual repair: consolidated whole material group and corrected stable classification',
    materialGroup: true,
  },
});
rebuildMetadataIndex(canonicalDir);
atomicWriteJson(receiptPath, {
  ...receipt,
  attachments: receipt.attachments,
  aiClassification: {
    status: 'corrected',
    subject: repaired.subject,
    correctedAt: new Date().toISOString(),
  },
  updatedAt: new Date().toISOString(),
});

console.log(JSON.stringify({
  ok: true,
  noteUid,
  title: repaired.title,
  subject: repaired.subject,
  knowledgePath: repaired.knowledgePath,
  canonicalPath,
  probabilityDirectory: path.join(notesRoot, '概率论'),
  archivedSidecars,
  backupDir,
  attachmentsPreserved: receipt.attachments.length,
}, null, 2));
