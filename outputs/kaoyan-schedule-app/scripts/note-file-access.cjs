'use strict';

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
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);
const IMAGE_MIME_BY_EXT = new Map([...NOTE_MIME_BY_EXT].filter(([, mime]) => mime.startsWith('image/')));

function isInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveNoteFile(notesRoot, requestedPath, options = {}) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    const error = new Error('缺少笔记文件路径');
    error.code = 'NOTE_PATH_REQUIRED';
    throw error;
  }

  const normalized = requestedPath.trim().replaceAll('\\', '/');
  const cloneRoot = path.resolve(options.cloneRoot || process.env.KAOYAN_DATA_CLONE_PATH || 'D:\\kaoyandata\\Caobijidata');
  let filePath;
  let allowedRoot;
  const assetId = /^asset:\/\/([a-f0-9]{64})$/i.exec(normalized)?.[1]?.toLowerCase();
  if (assetId) {
    const recordPath = path.join(cloneRoot, 'data', 'v2', 'assets', `${assetId}.json`);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(recordPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      const error = new Error('找不到资料资源记录');
      error.code = 'NOTE_ASSET_NOT_FOUND';
      throw error;
    }
    if (
      String(record?.assetId || '').toLowerCase() !== assetId
      || typeof record?.path !== 'string'
      || !record.path.startsWith('data/assets/')
    ) {
      const error = new Error('资料资源记录无效');
      error.code = 'NOTE_ASSET_INVALID';
      throw error;
    }
    allowedRoot = path.join(cloneRoot, 'data', 'assets');
    filePath = path.resolve(cloneRoot, record.path);
  } else if (normalized.startsWith('github://data/assets/')) {
    allowedRoot = path.join(cloneRoot, 'data', 'assets');
    filePath = path.resolve(cloneRoot, normalized.slice('github://'.length));
  } else if (normalized.startsWith('github://source-notes/')) {
    allowedRoot = path.join(cloneRoot, 'source-notes');
    filePath = path.resolve(cloneRoot, normalized.slice('github://'.length));
  } else if (normalized.startsWith('data/assets/')) {
    allowedRoot = path.join(cloneRoot, 'data', 'assets');
    filePath = path.resolve(cloneRoot, normalized);
  } else {
    allowedRoot = path.resolve(notesRoot);
    filePath = path.resolve(requestedPath);
  }
  if (!isInside(allowedRoot, filePath)) {
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

function noteFileContentDisposition(resolved, fileName, preview = false) {
  const inline = resolved.inline || (preview === true && resolved.extension === '.pdf');
  return inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function resolveNoteImage(notesRoot, requestedPath, options = {}) {
  const resolved = resolveNoteFile(notesRoot, requestedPath, options);
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
  noteFileContentDisposition,
  resolveNoteFile,
  resolveNoteImage,
  revealNoteFile,
  revealNoteImage,
};
