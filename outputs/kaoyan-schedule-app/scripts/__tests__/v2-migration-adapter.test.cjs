'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptsRoot = path.resolve(__dirname, '..');
const migrationScript = path.join(scriptsRoot, 'migrate-learning-data-v2.cjs');
const adapterScript = path.join(scriptsRoot, 'v2-local-adapter.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('migration classifies every JSON and writes hash-addressed V2 data without absolute paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-migration-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const imagePath = path.join(notesRoot, '默认文件夹', 'question.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from('not-a-real-image-but-stable-test-bytes'));
  fs.mkdirSync(path.join(notesRoot, 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(notesRoot, 'pdf', '背诵整理.pdf'), Buffer.from('%PDF-orphan-test'));
  writeJson(path.join(notesRoot, '默认文件夹', '.metadata', 'entry-a.note.json'), {
    schemaVersion: 2,
    noteUid: 'entry-a',
    subject: '不应成为一级目录',
    title: '测试题',
    remark: '正文',
    filePath: imagePath,
    facets: ['knowledge', 'method'],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  });
  writeJson(path.join(repoRoot, 'data', 'cloud', 'learning-data.json'), {
    version: 1,
    days: { '2026-07-27': { autoNotes: [{ noteUid: 'legacy-b', subject: '高等数学', title: '旧题', remark: '' }] } },
    cards: [],
    deletedNotes: {},
  });
  fs.mkdirSync(path.join(repoRoot, 'data', 'cloud'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'data', 'cloud', 'learning-data.json'),
    path.join(repoRoot, 'data', 'cloud', 'learning-data.sync-conflict-local-copy.json'),
  );
  const manifestPath = path.join(root, 'manifest.json');

  try {
    execFileSync(process.execPath, [
      migrationScript,
      '--repo-root', repoRoot,
      '--notes-root', notesRoot,
      '--output', manifestPath,
      '--apply',
    ], { stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.files.length, 3);
    assert.equal(manifest.files.every((item) => ['adopt', 'duplicate', 'manual'].includes(item.classification)), true);
    assert.equal(manifest.summary.duplicateFiles, 1);
    assert.equal(manifest.summary.orphanAssetsImported, 1);
    assert.equal(manifest.orphanAssets[0].relativePath, 'pdf/背诵整理.pdf');
    const entry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'v2', 'entries', 'entry-a.json'), 'utf8'));
    assert.equal(entry.subject, '默认文件夹');
    assert.deepEqual(entry.facets, ['knowledge', 'method']);
    assert.match(entry.assets[0].path, /^data\/assets\/[a-f0-9]{64}\.png$/);
    assert.doesNotMatch(JSON.stringify(entry), /[A-Za-z]:[\\/]/);
    assert.equal(fs.existsSync(path.join(repoRoot, entry.assets[0].path)), true);
    const assetRecord = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'data', 'v2', 'assets', `${entry.assets[0].assetId}.json`),
      'utf8',
    ));
    assert.equal(assetRecord.sourcePath, undefined);
    assert.doesNotMatch(JSON.stringify(assetRecord), /[A-Za-z]:[\\/]/);
    execFileSync(process.execPath, [
      migrationScript,
      '--repo-root', repoRoot,
      '--notes-root', notesRoot,
      '--output', manifestPath,
      '--apply',
    ], { stdio: 'pipe' });
    const repeatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(repeatedManifest.files.length, 3);
    assert.equal(repeatedManifest.summary.assets, 2);
    assert.equal(repeatedManifest.summary.orphanAssetsImported, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('V2 local adapter converges after one apply cycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-adapter-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const configPath = path.join(root, 'config.json');
  const localImage = path.join(notesRoot, '默认文件夹', 'local.png');
  fs.mkdirSync(path.dirname(localImage), { recursive: true });
  fs.writeFileSync(localImage, Buffer.from('stable-local-asset'));
  const originalSidecarPath = path.join(notesRoot, '默认文件夹', '.metadata', '原始描述文件名.note.json');
  writeJson(originalSidecarPath, {
    schemaVersion: 2,
    noteUid: 'stable-entry',
    subject: '默认文件夹',
    title: '稳定条目',
    remark: '一次发布后不应反复变化',
    filePath: localImage,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  });
  writeJson(configPath, { clonePath: repoRoot, localPath: notesRoot });

  try {
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    const entryPath = path.join(repoRoot, 'data', 'v2', 'entries', 'stable-entry.json');
    const firstHash = fileHash(entryPath);
    const indexPath = path.join(repoRoot, 'data', 'v2', 'index.json');
    const firstIndexHash = fileHash(indexPath);
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    assert.equal(fileHash(entryPath), firstHash);
    assert.equal(fileHash(indexPath), firstIndexHash);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    const materialized = JSON.parse(fs.readFileSync(
      originalSidecarPath,
      'utf8',
    ));
    assert.equal(path.isAbsolute(materialized.filePath), true);
    assert.equal(fs.existsSync(materialized.filePath), true);
    assert.equal(materialized.filePath, localImage);
    assert.equal(materialized.attachments.length, 1);
    assert.equal(materialized.attachments[0].filePath, localImage);
    assert.equal(materialized.attachments[0].cloudPath, undefined);
    assert.equal(materialized.v2Version, entry.version);
    assert.equal(fs.existsSync(path.join(notesRoot, '默认文件夹', '.metadata', 'stable-entry.note.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('newer reviewed learning classification overrides a stale V2 subject and prunes its generated sidecar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-learning-truth-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const assistantRoot = path.join(root, 'assistant');
  const configPath = path.join(root, 'config.json');
  const noteUid = 'reviewed-entry';
  const learningPath = path.join(assistantRoot, 'learning-data.json');
  const assetBytes = Buffer.from('stable-asset');
  const assetId = crypto.createHash('sha256').update(assetBytes).digest('hex');
  const assetPath = path.join(repoRoot, 'data', 'assets', `${assetId}.png`);
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, assetBytes);
  writeJson(path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`), {
    schemaVersion: 2,
    entryId: noteUid,
    kind: 'quick',
    title: '旧标题',
    body: '正文',
    subject: '默认文件夹',
    facets: [],
    tags: [],
    assets: [{
      assetId,
      path: `data/assets/${assetId}.png`,
      originalFileName: '题目.png',
      mime: 'image/png',
      size: assetBytes.length,
      kind: 'image',
      sha256: assetId,
      schemaVersion: 2,
      createdAt: '2026-08-02T00:00:00.000Z',
    }],
    version: 2,
    state: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  writeJson(path.join(notesRoot, '默认文件夹', '.metadata', `${noteUid}.note.json`), {
    schemaVersion: 2,
    entryId: noteUid,
    noteUid,
    v2Version: 2,
    subject: '默认文件夹',
    title: '旧标题',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  writeJson(learningPath, {
    version: 1,
    revision: 3,
    updatedAt: '2026-08-02T00:00:00.000Z',
    days: { '2026-08-01': { autoNotes: [{
      noteUid,
      title: '函数差分关系与定积分平均值',
      subject: '高等数学',
      remark: '正文',
      facets: ['quick', 'good'],
      tags: ['好题'],
      updatedAt: '2026-08-02T00:00:00.000Z',
    }] } },
    cards: [],
    deletedNotes: {},
  });
  writeJson(configPath, { clonePath: repoRoot, localPath: notesRoot, assistantRoot, learningDataLocalPath: learningPath });

  try {
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    const entryPath = path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    assert.equal(entry.subject, '高等数学');
    assert.equal(entry.title, '函数差分关系与定积分平均值');
    assert.deepEqual(entry.facets, ['good']);
    assert.ok(entry.version >= 3);
    assert.equal(fs.existsSync(path.join(notesRoot, '默认文件夹', '.metadata', `${noteUid}.note.json`)), false);
    assert.equal(fs.existsSync(path.join(notesRoot, '高等数学', '.metadata', `${noteUid}.note.json`)), true);
    const firstEntryHash = fileHash(entryPath);
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    const repeated = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    assert.equal(repeated.subject, '高等数学');
    assert.equal(repeated.title, '函数差分关系与定积分平均值');
    assert.deepEqual(repeated, entry);
    assert.equal(fileHash(entryPath), firstEntryHash);
    assert.equal(fs.existsSync(path.join(notesRoot, '默认文件夹', '.metadata', `${noteUid}.note.json`)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('newer V2 AI naming repairs stale learning title even when attachment references already match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-ai-title-race-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const assistantRoot = path.join(root, 'assistant');
  const learningPath = path.join(assistantRoot, 'learning-data.json');
  const configPath = path.join(root, 'config.json');
  const noteUid = 'single-capture-race';
  const assetBytes = Buffer.from('single-capture-image');
  const assetId = crypto.createHash('sha256').update(assetBytes).digest('hex');
  const assetName = '高等数学_定积分arcsin根式凑微分_20260820_180852.png';
  const localPathKey = `高等数学/.assets/${assetId}.png`;
  const localAssetPath = path.join(notesRoot, '高等数学', '.assets', `${assetId}.png`);
  const entryUpdatedAt = '2026-08-20T10:09:05.385Z';
  fs.mkdirSync(path.join(repoRoot, 'data', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'data', 'assets', `${assetId}.png`), assetBytes);
  writeJson(path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`), {
    schemaVersion: 2,
    entryId: noteUid,
    kind: 'note',
    title: '定积分arcsin根式凑微分',
    body: '错题\n凑平分能力太弱',
    subject: '高等数学',
    facets: ['mistake'],
    tags: ['错题'],
    assets: [{
      schemaVersion: 2,
      assetId,
      sha256: assetId,
      mime: 'image/png',
      originalFileName: assetName,
      size: assetBytes.length,
      path: `data/assets/${assetId}.png`,
      kind: 'image',
      createdAt: entryUpdatedAt,
    }],
    version: 1,
    state: 'active',
    capturedDate: '2026-08-20',
    createdAt: '2026-08-20T10:08:52.976Z',
    updatedAt: entryUpdatedAt,
  });
  writeJson(learningPath, {
    version: 1,
    revision: 1,
    updatedAt: '2026-08-20T10:08:53.079Z',
    days: { '2026-08-20': { autoNotes: [{
      noteUid,
      capturedDate: '2026-08-20',
      title: '错题_凑平分能力太弱',
      subject: '默认文件夹',
      remark: '错题\n凑平分能力太弱',
      createdAt: '2026-08-20T10:08:52.976Z',
      updatedAt: '2026-08-20T10:08:53.079Z',
      classificationSource: 'ai',
      reviewStatus: 'auto_applied',
      userEditedFields: [],
      filePath: localAssetPath,
      fileName: assetName,
      attachments: [{
        id: assetId,
        assetId,
        kind: 'image',
        name: assetName,
        mimeType: 'image/png',
        size: assetBytes.length,
        filePath: localAssetPath,
        cloudPath: `github://data/assets/${assetId}.png`,
        localPathKey,
        createdAt: entryUpdatedAt,
      }],
    }] } },
    cards: [],
    deletedNotes: {},
  });
  writeJson(configPath, { clonePath: repoRoot, localPath: notesRoot, assistantRoot, learningDataLocalPath: learningPath });

  try {
    const report = JSON.parse(execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply'], { encoding: 'utf8' }));
    const learning = JSON.parse(fs.readFileSync(learningPath, 'utf8'));
    const repaired = learning.days['2026-08-20'].autoNotes[0];
    assert.equal(repaired.title, '定积分arcsin根式凑微分');
    assert.equal(repaired.subject, '高等数学');
    assert.equal(repaired.remark, '错题\n凑平分能力太弱');
    assert.equal(repaired.updatedAt, entryUpdatedAt);
    assert.equal(repaired.attachments[0].name, assetName);
    assert.equal(report.learningMetadataRepaired, 1);
    assert.equal(report.learningAttachmentRefsRepaired, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('newer V2 entry preserves user-edited content and a human classification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-human-edit-protection-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const assistantRoot = path.join(root, 'assistant');
  const learningPath = path.join(assistantRoot, 'learning-data.json');
  const configPath = path.join(root, 'config.json');
  const noteUid = 'human-edited-note';
  const entryPath = path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`);
  const entryUpdatedAt = '2026-08-20T11:00:00.000Z';
  writeJson(entryPath, {
    schemaVersion: 2,
    entryId: noteUid,
    kind: 'note',
    title: 'AI 标题',
    body: 'AI 备注',
    subject: '默认文件夹',
    facets: [],
    tags: [],
    assets: [],
    version: 1,
    state: 'active',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: entryUpdatedAt,
  });
  writeJson(learningPath, {
    version: 1,
    revision: 4,
    updatedAt: '2026-08-20T10:30:00.000Z',
    days: { '2026-08-20': { autoNotes: [{
      noteUid,
      capturedDate: '2026-08-20',
      title: '人工标题',
      subject: '高等数学',
      remark: '人工备注',
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:30:00.000Z',
      classificationSource: 'manual',
      reviewStatus: 'corrected',
      userEditedFields: ['title', 'remark'],
      facets: ['mistake'],
      tags: ['错题'],
      attachments: [],
    }] } },
    cards: [],
    deletedNotes: {},
  });
  writeJson(configPath, { clonePath: repoRoot, localPath: notesRoot, assistantRoot, learningDataLocalPath: learningPath });

  try {
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    let learning = JSON.parse(fs.readFileSync(learningPath, 'utf8'));
    let protectedNote = learning.days['2026-08-20'].autoNotes[0];
    assert.equal(protectedNote.title, '人工标题');
    assert.equal(protectedNote.remark, '人工备注');
    assert.equal(protectedNote.subject, '高等数学');
    assert.equal(protectedNote.updatedAt, entryUpdatedAt);

    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    const convergedEntry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    assert.equal(convergedEntry.title, '人工标题');
    assert.equal(convergedEntry.body, '人工备注');
    assert.equal(convergedEntry.subject, '高等数学');
    learning = JSON.parse(fs.readFileSync(learningPath, 'utf8'));
    protectedNote = learning.days['2026-08-20'].autoNotes[0];
    assert.deepEqual(protectedNote.userEditedFields, ['title', 'remark']);
    assert.equal(protectedNote.classificationSource, 'manual');
    assert.equal(protectedNote.reviewStatus, 'corrected');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatic and explicit material naming propagate display names while hash asset paths stay stable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-v2-material-names-'));
  const repoRoot = path.join(root, 'repo');
  const notesRoot = path.join(root, 'notes');
  const assistantRoot = path.join(root, 'assistant');
  const learningPath = path.join(assistantRoot, 'learning-data.json');
  const configPath = path.join(root, 'config.json');
  const noteUid = 'explicit-material-note';
  const oldNoteUid = 'old-material-note';
  const firstBytes = Buffer.from('first-material-bytes');
  const secondBytes = Buffer.from('second-material-bytes');
  const firstId = crypto.createHash('sha256').update(firstBytes).digest('hex');
  const secondId = crypto.createHash('sha256').update(secondBytes).digest('hex');
  const materialRoot = path.join(assistantRoot, 'material-files', noteUid);
  const firstMaterialPath = path.join(materialRoot, '01-核心公式表述.png');
  const secondMaterialPath = path.join(materialRoot, '02-数形结合证明过程.jpg');
  fs.mkdirSync(materialRoot, { recursive: true });
  fs.writeFileSync(firstMaterialPath, firstBytes);
  fs.writeFileSync(secondMaterialPath, secondBytes);
  fs.mkdirSync(path.join(repoRoot, 'data', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'data', 'assets', `${firstId}.png`), firstBytes);
  fs.writeFileSync(path.join(repoRoot, 'data', 'assets', `${secondId}.jpg`), secondBytes);
  const asset = (assetId, extension, originalFileName, size) => ({
    schemaVersion: 2,
    assetId,
    sha256: assetId,
    path: `data/assets/${assetId}.${extension}`,
    originalFileName,
    mime: extension === 'png' ? 'image/png' : 'image/jpeg',
    size,
    kind: 'image',
    createdAt: '2026-08-13T00:00:00.000Z',
  });
  const entry = (entryId) => ({
    schemaVersion: 2,
    entryId,
    kind: 'quick',
    title: '资料速记',
    body: '',
    subject: '高等数学',
    facets: [],
    tags: [],
    assets: [
      asset(firstId, 'png', `${firstId}.png`, firstBytes.length),
      asset(secondId, 'jpg', `${secondId}.jpg`, secondBytes.length),
    ],
    version: 1,
    state: 'active',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  });
  writeJson(path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`), entry(noteUid));
  writeJson(path.join(repoRoot, 'data', 'v2', 'entries', `${oldNoteUid}.json`), entry(oldNoteUid));
  const learningNote = (entryId) => ({
    noteUid: entryId,
    title: '资料速记',
    subject: '高等数学',
    remark: '',
    facets: ['quick'],
    tags: [],
    noteType: 'quick',
    attachments: [
      { id: secondId, assetId: secondId, name: `${secondId}.jpg`, mimeType: 'image/jpeg', size: secondBytes.length },
      { id: firstId, assetId: firstId, name: `${firstId}.png`, mimeType: 'image/png', size: firstBytes.length },
    ],
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  });
  writeJson(learningPath, {
    version: 1,
    revision: 1,
    updatedAt: '2026-08-13T00:00:00.000Z',
    days: { '2026-08-13': { autoNotes: [learningNote(noteUid), learningNote(oldNoteUid)] } },
    cards: [],
    deletedNotes: {},
  });
  const receipt = (entryId, explicit) => ({
    schemaVersion: 2,
    noteUid: entryId,
    attachments: [
      { id: 'material-2', name: '数形结合证明过程.jpg', mimeType: 'image/jpeg', size: secondBytes.length, filePath: secondMaterialPath, checksum: `sha256:${secondId}` },
      { id: 'material-1', name: '核心公式表述.png', mimeType: 'image/png', size: firstBytes.length, filePath: firstMaterialPath, checksum: `sha256:${firstId}` },
    ],
    aiNaming: { status: 'complete', ...(explicit ? { explicit: true, trigger: 'user' } : {}), completedAt: '2026-08-13T01:00:00.000Z' },
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T01:00:00.000Z',
  });
  writeJson(path.join(assistantRoot, 'material-note-receipts', `${noteUid}.json`), receipt(noteUid, true));
  writeJson(path.join(assistantRoot, 'material-note-receipts', `${oldNoteUid}.json`), receipt(oldNoteUid, false));
  writeJson(configPath, { clonePath: repoRoot, localPath: notesRoot, assistantRoot, learningDataLocalPath: learningPath });

  try {
    execFileSync(process.execPath, [adapterScript, '--config', configPath, '--apply']);
    const renamedEntry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'v2', 'entries', `${noteUid}.json`), 'utf8'));
    assert.deepEqual(renamedEntry.assets.map((item) => item.assetId), [secondId, firstId]);
    assert.deepEqual(renamedEntry.assets.map((item) => item.originalFileName), ['数形结合证明过程.jpg', '核心公式表述.png']);
    const oldEntry = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'v2', 'entries', `${oldNoteUid}.json`), 'utf8'));
    assert.deepEqual(oldEntry.assets.map((item) => item.assetId), [secondId, firstId]);
    assert.deepEqual(oldEntry.assets.map((item) => item.originalFileName), ['数形结合证明过程.jpg', '核心公式表述.png']);
    const learning = JSON.parse(fs.readFileSync(learningPath, 'utf8'));
    const updated = learning.days['2026-08-13'].autoNotes.find((note) => note.noteUid === noteUid);
    assert.deepEqual(updated.attachments.map((item) => item.assetId), [secondId, firstId]);
    assert.deepEqual(updated.attachments.map((item) => item.name), ['数形结合证明过程.jpg', '核心公式表述.png']);
    const autoUpdated = learning.days['2026-08-13'].autoNotes.find((note) => note.noteUid === oldNoteUid);
    assert.deepEqual(autoUpdated.attachments.map((item) => item.assetId), [secondId, firstId]);
    assert.deepEqual(autoUpdated.attachments.map((item) => item.name), ['数形结合证明过程.jpg', '核心公式表述.png']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
