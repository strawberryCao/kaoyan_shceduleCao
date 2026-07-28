'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
let mammoth = null;
let pdfModuleUrl = '';
try { mammoth = require('mammoth'); } catch {}
try { pdfModuleUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href; } catch {}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function text(value, limit = 40_000) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function resolveAttachmentPath(attachment, config) {
  const candidates = [
    attachment?.filePath,
    attachment?.localPathKey ? path.join(config.localPath, attachment.localPathKey) : '',
    String(attachment?.cloudPath || '').startsWith('github://')
      ? path.join(config.clonePath, String(attachment.cloudPath).slice('github://'.length))
      : '',
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate && fs.existsSync(candidate)) || '';
}

function htmlText(source) {
  return text(String(source)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>'));
}

async function extractFile(filePath, cached = null) {
  const extension = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  if (cached?.stamp === stamp && typeof cached.content === 'string') {
    return { stamp, content: cached.content };
  }
  try {
    if (extension === '.docx' && mammoth) {
      return { stamp, content: text((await mammoth.extractRawText({ path: filePath })).value) };
    }
    if (extension === '.pdf' && pdfModuleUrl) {
      const { getDocument } = await import(pdfModuleUrl);
      const document = await getDocument({
        data: new Uint8Array(fs.readFileSync(filePath)),
        disableWorker: true,
      }).promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 80); pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => typeof item.str === 'string' ? item.str : '').join(' '));
      }
      return { stamp, content: text(pages.join('\n')) };
    }
    if (['.html', '.htm'].includes(extension)) {
      return { stamp, content: htmlText(fs.readFileSync(filePath, 'utf8')) };
    }
    if (['.txt', '.md', '.json', '.css', '.js', '.mjs', '.svg'].includes(extension)) {
      return {
        stamp,
        content: extension === '.svg' ? htmlText(fs.readFileSync(filePath, 'utf8')) : text(fs.readFileSync(filePath, 'utf8')),
      };
    }
  } catch {
    return { stamp, content: typeof cached?.content === 'string' ? cached.content : '' };
  }
  return { stamp, content: typeof cached?.content === 'string' ? cached.content : '' };
}

function noteText(note) {
  return text([
    note.title,
    note.remark,
    note.subject,
    ...(Array.isArray(note.tags) ? note.tags : []),
    ...(Array.isArray(note.facets) ? note.facets : []),
    ...(Array.isArray(note.knowledgePath) ? note.knowledgePath : []),
    ...(Array.isArray(note.questions) ? note.questions : []),
    ...(Array.isArray(note.items) ? note.items.flatMap((item) => [
      item?.title,
      item?.question,
      item?.answer,
      item?.remark,
      ...(Array.isArray(item?.tags) ? item.tags : []),
    ]) : []),
    note.wrongReason,
  ].filter(Boolean).join('\n'));
}

async function main() {
  const configIndex = process.argv.indexOf('--config');
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : '';
  const config = readJson(path.resolve(configPath || ''));
  if (!config) throw new Error('Sync configuration is required.');
  const snapshot = readJson(path.resolve(config.learningDataLocalPath || ''));
  if (!snapshot?.days) throw new Error('Learning data is unavailable.');
  const cachePath = path.join(path.resolve(config.assistantRoot), 'search-extraction-cache.json');
  const previousCache = readJson(cachePath, { files: {} });
  const extractionCache = { schemaVersion: 1, updatedAt: new Date().toISOString(), files: {} };
  const documents = [];
  for (const [date, day] of Object.entries(snapshot.days)) {
    for (const note of Array.isArray(day?.autoNotes) ? day.autoNotes : []) {
      if (!note?.noteUid || note?.state === 'tombstoned') continue;
      const attachments = Array.isArray(note.attachments) ? note.attachments : [];
      const extracted = [];
      for (const attachment of attachments) {
        const filePath = resolveAttachmentPath(attachment, config);
        if (!filePath) continue;
        const result = await extractFile(filePath, previousCache?.files?.[filePath]);
        extractionCache.files[filePath] = result;
        if (result.content) extracted.push(result.content);
      }
      documents.push({
        noteUid: String(note.noteUid),
        capturedDate: String(note.capturedDate || date),
        updatedAt: String(note.updatedAt || ''),
        title: text(note.title, 500),
        subject: text(note.subject, 100),
        facets: Array.isArray(note.facets) ? note.facets.map((item) => text(item, 80)).filter(Boolean) : [],
        tags: Array.isArray(note.tags) ? note.tags.map((item) => text(item, 120)).filter(Boolean) : [],
        attachmentNames: attachments.map((attachment) => text(attachment?.name, 300)).filter(Boolean),
        content: text(`${noteText(note)}\n${extracted.join('\n')}`, 80_000),
      });
    }
  }
  documents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.capturedDate.localeCompare(left.capturedDate));
  const index = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sourceRevision: Number(snapshot.revision) || 0,
    documents,
  };
  const localPath = path.join(path.resolve(config.assistantRoot), 'search-index.json');
  const remotePath = path.join(path.resolve(config.clonePath), 'data', 'search', 'documents.json');
  atomicJson(localPath, index);
  atomicJson(remotePath, index);
  atomicJson(cachePath, extractionCache);
  process.stdout.write(`${JSON.stringify({ ok: true, documents: documents.length, localPath, remotePath })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
