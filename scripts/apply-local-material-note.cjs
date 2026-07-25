'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appRoot = path.join(root, 'outputs', 'kaoyan-schedule-app');
const serverPath = path.join(appRoot, 'scripts', 'note-server.cjs');
const accessPath = path.join(appRoot, 'scripts', 'note-file-access.cjs');

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) {
    if (source.includes(after)) return source;
    throw new Error(`Missing local material anchor: ${label}`);
  }
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Ambiguous local material anchor: ${label}`);
  }
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

const noteFileAccess = `'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NOTE_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
]);
const IMAGE_MIME_BY_EXT = new Map([...NOTE_MIME_BY_EXT].filter(([, mime]) => mime.startsWith('image/')));

function isInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveNoteFile(notesRoot, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    const error = new Error('缺少笔记文件路径');
    error.code = 'NOTE_PATH_REQUIRED';
    throw error;
  }
  const filePath = path.resolve(requestedPath);
  if (!isInside(notesRoot, filePath)) {
    const error = new Error('不允许访问笔记目录以外的文件');
    error.code = 'NOTE_PATH_FORBIDDEN';
    throw error;
  }
  const extension = path.extname(filePath).toLowerCase();
  const mime = NOTE_MIME_BY_EXT.get(extension);
  if (!mime) {
    const error = new Error('不支持的笔记文件类型');
    error.code = 'NOTE_FILE_UNSUPPORTED';
    throw error;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const error = new Error('笔记文件不存在');
    error.code = 'NOTE_FILE_NOT_FOUND';
    throw error;
  }
  return { filePath, mime, extension, inline: mime.startsWith('image/') };
}

function resolveNoteImage(notesRoot, requestedPath) {
  const resolved = resolveNoteFile(notesRoot, requestedPath);
  if (!resolved.inline) {
    const error = new Error('不支持的笔记图片类型');
    error.code = 'NOTE_FILE_UNSUPPORTED';
    throw error;
  }
  return resolved;
}

function makeRevealLaunchError(cause) {
  const detail = cause instanceof Error ? cause.message : String(cause || 'unknown error');
  const error = new Error(`无法启动资源管理器：${detail}`);
  error.code = 'NOTE_REVEAL_LAUNCH_FAILED';
  error.cause = cause;
  return error;
}

async function revealNoteFile(notesRoot, requestedPath, options = {}) {
  const resolved = resolveNoteFile(notesRoot, requestedPath);
  if ((options.platform || process.platform) !== 'win32') {
    const error = new Error('当前系统暂不支持在资源管理器中显示');
    error.code = 'NOTE_REVEAL_UNSUPPORTED';
    throw error;
  }
  const launch = options.spawn || spawn;
  const windowsRoot = options.windowsRoot || process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const explorerPath = options.explorerPath || path.join(windowsRoot, 'explorer.exe');
  let child;
  try {
    child = launch(explorerPath, ['/select,', resolved.filePath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch (error) {
    throw makeRevealLaunchError(error);
  }
  if (!child || typeof child.once !== 'function') {
    throw makeRevealLaunchError(new Error('资源管理器进程没有返回可监听的句柄'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (cause) => {
      if (settled) return;
      settled = true;
      reject(makeRevealLaunchError(cause));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      if (typeof child.unref === 'function') child.unref();
      resolve(resolved);
    });
  });
}

async function revealNoteImage(notesRoot, requestedPath, options = {}) {
  resolveNoteImage(notesRoot, requestedPath);
  return revealNoteFile(notesRoot, requestedPath, options);
}

module.exports = {
  IMAGE_MIME_BY_EXT,
  NOTE_MIME_BY_EXT,
  isInside,
  resolveNoteFile,
  resolveNoteImage,
  revealNoteFile,
  revealNoteImage,
};
`;
fs.writeFileSync(accessPath, noteFileAccess, 'utf8');

let server = fs.readFileSync(serverPath, 'utf8');
server = replaceOnce(
  server,
  "const { resolveNoteImage, revealNoteImage } = require('./note-file-access.cjs');",
  "const { resolveNoteFile, revealNoteImage } = require('./note-file-access.cjs');",
  'generic note file import',
);
server = replaceOnce(
  server,
  "const NOTE_SAVE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'note-save-receipts');\nconst DEFAULT_SUBJECT = '默认文件夹';",
  "const NOTE_SAVE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'note-save-receipts');\nconst MATERIAL_NOTE_RECEIPTS_ROOT = path.join(ASSISTANT_ROOT, 'material-note-receipts');\nconst MATERIAL_FILES_ROOT = path.join(NOTES_ROOT, '.materials');\nconst MAX_MATERIAL_FILE_BYTES = 8 * 1024 * 1024;\nconst MAX_MATERIAL_TOTAL_BYTES = 16 * 1024 * 1024;\nconst MAX_MATERIAL_FILES = 8;\nconst MATERIAL_MIME_BY_EXT = new Map([\n  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],\n  ['.gif', 'image/gif'], ['.bmp', 'image/bmp'], ['.avif', 'image/avif'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],\n  ['.pdf', 'application/pdf'], ['.doc', 'application/msword'],\n  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],\n  ['.html', 'text/html'], ['.htm', 'text/html'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],\n]);\nconst MATERIAL_EXT_BY_MIME = new Map([...MATERIAL_MIME_BY_EXT].map(([extension, mime]) => [mime, extension]));\nconst DEFAULT_SUBJECT = '默认文件夹';",
  'local material constants',
);
server = replaceOnce(
  server,
  "  if (method === 'POST' && pathname === '/save-note') return true;",
  "  if (method === 'POST' && (pathname === '/save-note' || pathname === '/save-material-note')) return true;",
  'local material LAN route',
);

const materialHelpers = `
function materialReceiptPath(noteUid) {
  return path.join(MATERIAL_NOTE_RECEIPTS_ROOT, \`${'${noteUid}'}.json\`);
}

function materialKind(mime, extension) {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (extension === '.doc' || extension === '.docx') return 'word';
  if (extension === '.html' || extension === '.htm') return 'html';
  return 'file';
}

function safeMaterialFileName(input, index, mimeType) {
  const raw = String(input || '').normalize('NFKC').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  let extension = path.extname(cleaned).toLowerCase();
  if (!MATERIAL_MIME_BY_EXT.has(extension)) extension = MATERIAL_EXT_BY_MIME.get(String(mimeType || '').toLowerCase()) || '';
  if (!extension || !MATERIAL_MIME_BY_EXT.has(extension)) {
    const error = new Error('不支持的资料文件类型');
    error.code = 'NOTE_FILE_UNSUPPORTED';
    throw error;
  }
  const stem = (path.basename(cleaned, path.extname(cleaned)).trim() || \`资料-\${index + 1}\`).slice(0, 96);
  return \`\${stem}\${extension}\`;
}

function decodeMaterialFile(input, index) {
  if (!input || typeof input !== 'object') {
    const error = new Error('资料文件无效');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(input.dataUrl || ''));
  if (!match) {
    const error = new Error('资料文件必须使用 base64 data URL');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const suppliedMime = match[1].toLowerCase();
  const fileName = safeMaterialFileName(input.name, index, suppliedMime);
  const extension = path.extname(fileName).toLowerCase();
  const mime = MATERIAL_MIME_BY_EXT.get(extension);
  const buffer = Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64');
  if (buffer.length > MAX_MATERIAL_FILE_BYTES) {
    const error = new Error(`${fileName} 超过 8 MB`);
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  return { fileName, extension, mime, buffer, kind: materialKind(mime, extension) };
}

function findMaterialLearningNote(snapshot, noteUid) {
  for (const day of Object.values(snapshot?.days || {})) {
    const found = Array.isArray(day?.autoNotes) ? day.autoNotes.find((note) => note?.noteUid === noteUid) : null;
    if (found) return found;
  }
  return null;
}

function readMaterialReceipt(noteUid) {
  const receipt = readJson(materialReceiptPath(noteUid), null);
  if (!receipt || receipt.noteUid !== noteUid || typeof receipt.requestHash !== 'string') return null;
  if (!Array.isArray(receipt.attachments) || !receipt.attachments.every((item) => typeof item?.filePath === 'string' && fs.existsSync(item.filePath))) return null;
  return receipt;
}

function writeMaterialReceipt(receipt) {
  fs.mkdirSync(MATERIAL_NOTE_RECEIPTS_ROOT, { recursive: true });
  atomicWriteJson(materialReceiptPath(receipt.noteUid), receipt);
}

async function handleSaveMaterial(req, res) {
  const raw = await readBody(req, 24 * 1024 * 1024);
  const payload = JSON.parse(raw || '{}');
  const noteUid = normalizeNoteUid(payload.noteUid);
  const rawFiles = Array.isArray(payload.files) ? payload.files : [];
  if (rawFiles.length > MAX_MATERIAL_FILES) {
    const error = new Error('资料文件最多 8 个');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const files = rawFiles.map(decodeMaterialFile);
  const totalBytes = files.reduce((sum, file) => sum + file.buffer.length, 0);
  if (totalBytes > MAX_MATERIAL_TOTAL_BYTES) {
    const error = new Error('资料文件合计超过 16 MB');
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 240) : '';
  const remark = typeof payload.remark === 'string' ? payload.remark.trim().slice(0, 8000) : '';
  if (!title && !remark && files.length === 0) {
    const error = new Error('至少写一点文字，或加入一个资料文件');
    error.code = 'INVALID_MATERIAL_NOTE';
    throw error;
  }
  const subject = sanitizeSegment(payload.subject || DEFAULT_SUBJECT, DEFAULT_SUBJECT, 60);
  const facets = Array.isArray(payload.facets)
    ? [...new Set(payload.facets.filter((item) => ['quick', 'mistake', 'good', 'memory', 'knowledge'].includes(item)))]
    : ['quick'];
  const tags = Array.isArray(payload.tags)
    ? [...new Set(payload.tags.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
  const fileHashes = files.map((file) => crypto.createHash('sha256').update(file.buffer).digest('hex'));
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    noteUid, title, remark, subject, facets, tags,
    files: files.map((file, index) => ({ name: file.fileName, mime: file.mime, hash: fileHashes[index] })),
  })).digest('hex');
  const existing = readMaterialReceipt(noteUid);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      const error = new Error('这个 noteUid 已用于另一条资料记录');
      error.code = 'SAVE_OPERATION_REUSED';
      throw error;
    }
    sendJson(res, 200, {
      ok: true,
      noteUid,
      attachments: existing.attachments,
      learningData: learningData.getSnapshot(),
      idempotentReplay: true,
    });
    return;
  }

  const finalDir = path.join(MATERIAL_FILES_ROOT, noteUid);
  const stagingDir = path.join(MATERIAL_FILES_ROOT, `.staging-${noteUid}-${crypto.randomUUID()}`);
  if (fs.existsSync(finalDir)) {
    const error = new Error('资料目录已存在但缺少有效保存凭据');
    error.code = 'SAVE_OPERATION_REUSED';
    throw error;
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  const createdAt = new Date().toISOString();
  let snapshot;
  try {
    const staged = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const storedName = `${String(index + 1).padStart(2, '0')}-${file.fileName}`;
      const filePath = path.join(stagingDir, storedName);
      fs.writeFileSync(filePath, file.buffer, { flag: 'wx' });
      staged.push({ file, storedName });
    }
    fs.mkdirSync(MATERIAL_FILES_ROOT, { recursive: true });
    fs.renameSync(stagingDir, finalDir);
    const attachments = staged.map(({ file, storedName }, index) => ({
      id: `material-${index + 1}`,
      kind: file.kind,
      name: file.fileName,
      mimeType: file.mime,
      size: file.buffer.length,
      filePath: path.join(finalDir, storedName),
      previewPath: '',
      posterPath: '',
      createdAt,
    }));
    const noteType = facets.includes('mistake') ? 'mistake'
      : facets.includes('memory') ? 'memory'
        : facets.includes('knowledge') ? 'knowledge' : 'quick';
    snapshot = learningData.createNote({
      noteUid,
      capturedDate: typeof payload.capturedDate === 'string' ? payload.capturedDate : undefined,
      title: title || remark.split(/\r?\n/)[0]?.slice(0, 120) || attachments[0]?.name || '快速记录',
      subject,
      remark,
      tags,
      facets: facets.length > 0 ? facets : ['quick'],
      noteType,
      goodQuestion: facets.includes('good'),
      attachments,
      createCard: false,
    });
    const storedNote = findMaterialLearningNote(snapshot, noteUid);
    const storedAttachments = storedNote?.attachments || attachments;
    writeMaterialReceipt({
      schemaVersion: 1,
      noteUid,
      requestHash,
      attachments: storedAttachments,
      createdAt,
      updatedAt: createdAt,
    });
    broadcastLearningData(snapshot);
    sendJson(res, 201, {
      ok: true,
      noteUid,
      attachments: storedAttachments,
      learningData: snapshot,
      idempotentReplay: false,
    });
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (!snapshot) fs.rmSync(finalDir, { recursive: true, force: true });
    throw error;
  }
}
`;

server = replaceOnce(
  server,
  "function publicCanvasOrganizationJob(job) {",
  `${materialHelpers}\nfunction publicCanvasOrganizationJob(job) {`,
  'local material handler insertion',
);
server = replaceOnce(
  server,
  "      const image = resolveNoteImage(NOTES_ROOT, requestUrl.searchParams.get('path'));\n      const stat = fs.statSync(image.filePath);\n      res.writeHead(200, {\n        'Content-Type': image.mime,\n        'Content-Length': stat.size,\n        'Cache-Control': 'private, no-store',\n        'X-Content-Type-Options': 'nosniff',\n      });\n      fs.createReadStream(image.filePath).pipe(res);",
  "      const file = resolveNoteFile(NOTES_ROOT, requestUrl.searchParams.get('path'));\n      const stat = fs.statSync(file.filePath);\n      const fileName = path.basename(file.filePath);\n      res.writeHead(200, {\n        'Content-Type': file.mime,\n        'Content-Length': stat.size,\n        'Content-Disposition': file.inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,\n        'Cache-Control': 'private, no-store',\n        'X-Content-Type-Options': 'nosniff',\n      });\n      fs.createReadStream(file.filePath).pipe(res);",
  'local generic note file route',
);
server = replaceOnce(
  server,
  "    if (req.method === 'POST' && req.url === '/save-note') {\n      await handleSave(req, res);\n      return;\n    }",
  "    if (req.method === 'POST' && pathname === '/save-material-note') {\n      await handleSaveMaterial(req, res);\n      return;\n    }\n\n    if (req.method === 'POST' && pathname === '/save-note') {\n      await handleSave(req, res);\n      return;\n    }",
  'local material endpoint route',
);
server = replaceOnce(
  server,
  "      : ['NOTE_ALREADY_EXISTS', 'CARD_ALREADY_EXISTS', 'NOTE_DELETED'].includes(error?.code) ? 409",
  "      : ['NOTE_ALREADY_EXISTS', 'CARD_ALREADY_EXISTS', 'NOTE_DELETED', 'SAVE_OPERATION_REUSED'].includes(error?.code) ? 409",
  'local material conflict mapping',
);
server = replaceOnce(
  server,
  "      : ['INVALID_LEARNING_NOTE', 'INVALID_LEARNING_CARD'].includes(error?.code) ? 400",
  "      : ['INVALID_LEARNING_NOTE', 'INVALID_LEARNING_CARD', 'INVALID_MATERIAL_NOTE'].includes(error?.code) ? 400",
  'local material validation mapping',
);
server = replaceOnce(
  server,
  "      : error?.code === 'NOTE_FILE_UNSUPPORTED' ? 415",
  "      : error?.code === 'PAYLOAD_TOO_LARGE' ? 413\n      : error?.code === 'NOTE_FILE_UNSUPPORTED' ? 415",
  'local material payload mapping',
);
fs.writeFileSync(serverPath, server, 'utf8');

const accessTest = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveNoteFile, resolveNoteImage } = require('./note-file-access.cjs');

test('generic local note access serves safe materials and keeps HTML non-inline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-material-'));
  try {
    const html = path.join(root, 'demo.html');
    fs.writeFileSync(html, '<h1>demo</h1>');
    const resolved = resolveNoteFile(root, html);
    assert.match(resolved.mime, /^text\/html/);
    assert.equal(resolved.inline, false);
    assert.throws(() => resolveNoteImage(root, html), (error) => error.code === 'NOTE_FILE_UNSUPPORTED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic local note access rejects executable and escaped paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-security-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'note-file-outside-'));
  try {
    const executable = path.join(root, 'run.exe');
    const escaped = path.join(outside, 'note.txt');
    fs.writeFileSync(executable, 'MZ');
    fs.writeFileSync(escaped, 'outside');
    assert.throws(() => resolveNoteFile(root, executable), (error) => error.code === 'NOTE_FILE_UNSUPPORTED');
    assert.throws(() => resolveNoteFile(root, escaped), (error) => error.code === 'NOTE_PATH_FORBIDDEN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
`;
fs.writeFileSync(path.join(appRoot, 'scripts', 'note-file-material.test.cjs'), accessTest, 'utf8');

console.log('Applied local text and multimaterial note support.');
