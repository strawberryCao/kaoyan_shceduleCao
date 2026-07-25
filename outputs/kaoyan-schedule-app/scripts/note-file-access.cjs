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
