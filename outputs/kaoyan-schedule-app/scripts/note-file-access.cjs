const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IMAGE_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
]);

function isInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveNoteImage(notesRoot, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    const error = new Error('缺少笔记图片路径');
    error.code = 'NOTE_PATH_REQUIRED';
    throw error;
  }

  const filePath = path.resolve(requestedPath);
  if (!isInside(notesRoot, filePath)) {
    const error = new Error('不允许访问笔记目录以外的文件');
    error.code = 'NOTE_PATH_FORBIDDEN';
    throw error;
  }

  const mime = IMAGE_MIME_BY_EXT.get(path.extname(filePath).toLowerCase());
  if (!mime) {
    const error = new Error('不支持的笔记文件类型');
    error.code = 'NOTE_FILE_UNSUPPORTED';
    throw error;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    const error = new Error('笔记图片不存在');
    error.code = 'NOTE_FILE_NOT_FOUND';
    throw error;
  }

  return { filePath, mime };
}

function revealNoteImage(notesRoot, requestedPath, options = {}) {
  const resolved = resolveNoteImage(notesRoot, requestedPath);
  if ((options.platform || process.platform) !== 'win32') {
    const error = new Error('当前系统暂不支持在资源管理器中显示');
    error.code = 'NOTE_REVEAL_UNSUPPORTED';
    throw error;
  }
  const launch = options.spawn || spawn;
  const child = launch('explorer.exe', ['/select,', resolved.filePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  if (typeof child?.unref === 'function') child.unref();
  return resolved;
}

module.exports = {
  IMAGE_MIME_BY_EXT,
  isInside,
  resolveNoteImage,
  revealNoteImage,
};
