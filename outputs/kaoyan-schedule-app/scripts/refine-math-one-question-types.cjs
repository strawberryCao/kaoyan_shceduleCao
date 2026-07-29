'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMathOneQuestionType } = require('./math-one-question-types.cjs');

function parseArgs(argv) {
  const result = { apply: false, file: '' };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--apply') result.apply = true;
    if (argv[index] === '--file') result.file = argv[index + 1] || '';
  }
  return result;
}

function resolveDefaultFile() {
  const configPath = process.env.KAOYAN_SYNC_CONFIG || 'D:\\kaoyandata\\NoteFolderSync\\config.json';
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const assistantRoot = config.assistantRoot || path.join(os.homedir(), 'Desktop', '考研桌面助手');
    return path.join(assistantRoot, 'learning-data.json');
  } catch {
    return path.join(os.homedir(), 'Desktop', '考研桌面助手', 'learning-data.json');
  }
}

function updateTags(tags, questionType) {
  const values = Array.isArray(tags) ? tags.filter((tag) => !String(tag).startsWith('题型:')) : [];
  if (questionType) values.push(`题型:${questionType}`);
  return [...new Set(values)];
}

function refineNote(note) {
  // Existing knowledge-point metadata may itself be the field being repaired.
  // Use only the user-visible title for conservative, high-confidence migration.
  const evidence = String(note.title || '');
  const questionType = normalizeMathOneQuestionType(note.subject, note.questionType, evidence);
  let changed = Boolean(questionType && questionType !== note.questionType);
  const items = Array.isArray(note.items) ? note.items.map((item) => {
    const itemType = normalizeMathOneQuestionType(
      note.subject,
      item.questionType,
      [item.title, evidence].filter(Boolean).join(' '),
    );
    if (itemType && itemType !== item.questionType) changed = true;
    return itemType && itemType !== item.questionType ? { ...item, questionType: itemType } : item;
  }) : note.items;
  if (!changed) return { note, changed: false };
  return {
    changed: true,
    note: {
      ...note,
      questionType: questionType || note.questionType,
      tags: updateTags(note.tags, questionType || note.questionType),
      ...(Array.isArray(items) ? { items } : {}),
      updatedAt: new Date().toISOString(),
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const filePath = path.resolve(args.file || resolveDefaultFile());
  const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let scanned = 0;
  let updated = 0;
  const changes = [];
  for (const day of Object.values(snapshot.days || {})) {
    if (!Array.isArray(day?.autoNotes)) continue;
    day.autoNotes = day.autoNotes.map((note) => {
      scanned += 1;
      const result = refineNote(note);
      if (result.changed) {
        updated += 1;
        changes.push({
          noteUid: note.noteUid,
          title: note.title,
          before: note.questionType || null,
          after: result.note.questionType || null,
        });
      }
      return result.note;
    });
  }
  if (args.apply && updated > 0) {
    snapshot.updatedAt = new Date().toISOString();
    snapshot.revision = Math.max(0, Number(snapshot.revision) || 0) + 1;
    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  }
  console.log(JSON.stringify({ filePath, apply: args.apply, scanned, updated, changes }, null, 2));
}

main();
