'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appRoot = path.join(root, 'outputs', 'kaoyan-schedule-app');
const serverPath = path.join(appRoot, 'scripts', 'note-server.cjs');
const handlerPath = path.join(__dirname, 'templates', 'local-material-handler.cjs.txt');
let source = fs.readFileSync(serverPath, 'utf8');
const handler = fs.readFileSync(handlerPath, 'utf8').trimEnd();

function replaceOnce(before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) {
    if (source.includes(after)) return;
    throw new Error(`Missing local material server anchor: ${label}`);
  }
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Ambiguous local material server anchor: ${label}`);
  }
  source = `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

replaceOnce(
  "const { resolveNoteImage, revealNoteImage } = require('./note-file-access.cjs');",
  "const { resolveNoteFile, revealNoteImage } = require('./note-file-access.cjs');",
  'generic note file import',
);

replaceOnce(
  "const NOTE_SAVE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'note-save-receipts');\nconst DEFAULT_SUBJECT = '默认文件夹';",
  "const NOTE_SAVE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'note-save-receipts');\nconst MATERIAL_NOTE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'material-note-receipts');\nconst MATERIAL_FILES_ROOT = path.join(NOTES_ROOT, '.materials');\nconst MAX_MATERIAL_FILE_BYTES = 8 * 1024 * 1024;\nconst MAX_MATERIAL_TOTAL_BYTES = 16 * 1024 * 1024;\nconst MAX_MATERIAL_FILES = 8;\nconst MATERIAL_MIME_BY_EXT = new Map([\n  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],\n  ['.gif', 'image/gif'], ['.bmp', 'image/bmp'], ['.avif', 'image/avif'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],\n  ['.pdf', 'application/pdf'], ['.doc', 'application/msword'],\n  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],\n  ['.html', 'text/html'], ['.htm', 'text/html'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\n]);\nconst MATERIAL_EXT_BY_MIME = new Map([...MATERIAL_MIME_BY_EXT].map(([extension, mime]) => [mime, extension]));\nconst DEFAULT_SUBJECT = '默认文件夹';",
  'material constants',
);

replaceOnce(
  "  if (method === 'POST' && pathname === '/save-note') return true;",
  "  if (method === 'POST' && (pathname === '/save-note' || pathname === '/save-material-note')) return true;",
  'LAN material route',
);

replaceOnce(
  'function publicCanvasOrganizationJob(job) {',
  `${handler}\n\nfunction publicCanvasOrganizationJob(job) {`,
  'material handler insertion',
);

replaceOnce(
  "      const image = resolveNoteImage(NOTES_ROOT, requestUrl.searchParams.get('path'));\n      const stat = fs.statSync(image.filePath);\n      res.writeHead(200, {\n        'Content-Type': image.mime,\n        'Content-Length': stat.size,\n        'Cache-Control': 'private, no-store',\n        'X-Content-Type-Options': 'nosniff',\n      });\n      fs.createReadStream(image.filePath).pipe(res);",
  "      const file = resolveNoteFile(NOTES_ROOT, requestUrl.searchParams.get('path'));\n      const stat = fs.statSync(file.filePath);\n      const fileName = path.basename(file.filePath);\n      res.writeHead(200, {\n        'Content-Type': file.mime,\n        'Content-Length': stat.size,\n        'Content-Disposition': file.inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,\n        'Cache-Control': 'private, no-store',\n        'X-Content-Type-Options': 'nosniff',\n      });\n      fs.createReadStream(file.filePath).pipe(res);",
  'generic note file response',
);

replaceOnce(
  "    if (req.method === 'POST' && req.url === '/save-note') {\n      await handleSave(req, res);\n      return;\n    }",
  "    if (req.method === 'POST' && pathname === '/save-material-note') {\n      await handleSaveMaterial(req, res);\n      return;\n    }\n\n    if (req.method === 'POST' && pathname === '/save-note') {\n      await handleSave(req, res);\n      return;\n    }",
  'material endpoint',
);

replaceOnce(
  "      : ['NOTE_ALREADY_EXISTS', 'CARD_ALREADY_EXISTS', 'NOTE_DELETED'].includes(error?.code) ? 409",
  "      : ['NOTE_ALREADY_EXISTS', 'CARD_ALREADY_EXISTS', 'NOTE_DELETED', 'SAVE_OPERATION_REUSED'].includes(error?.code) ? 409",
  'material conflict status',
);
replaceOnce(
  "      : ['INVALID_LEARNING_NOTE', 'INVALID_LEARNING_CARD'].includes(error?.code) ? 400",
  "      : ['INVALID_LEARNING_NOTE', 'INVALID_LEARNING_CARD', 'INVALID_MATERIAL_NOTE'].includes(error?.code) ? 400",
  'material validation status',
);
replaceOnce(
  "      : error?.code === 'NOTE_FILE_UNSUPPORTED' ? 415",
  "      : error?.code === 'PAYLOAD_TOO_LARGE' ? 413\n      : error?.code === 'NOTE_FILE_UNSUPPORTED' ? 415",
  'material payload status',
);

fs.writeFileSync(serverPath, source, 'utf8');
console.log('Applied local material note server support.');
