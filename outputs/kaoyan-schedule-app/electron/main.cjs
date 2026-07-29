const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveNoteImage } = require('../scripts/note-file-access.cjs');

const isDev = !app.isPackaged;
const devServerUrl = 'http://127.0.0.1:5173';
const noteAppFlag = '--note-app';
const noteAppCloseFlag = '--close-note-app';
const materialPreviewArgPrefix = '--material-preview=';
const materialPreviewRequestRoot = path.join(require('os').tmpdir(), 'kaoyan-material-previews');
const launchAsNoteAppClose = process.argv.includes(noteAppCloseFlag);
const noteCompactSize = { width: 300, height: 132 };
const noteRemarkSize = { width: 400, height: 440 };
const windowStateFile = 'window-state.json';
const windowStateProfile = 'normal-desktop-v1';
const startupShortcutName = '考研学习课表.lnk';

let mainWindow = null;
let noteWindow = null;
let noteWindowMode = 'compact';
let noteCompactBounds = null;
let noteWindowDirty = false;
let noteWindowSaving = false;
let noteClosePromptOpen = false;
let noteCloseAfterSave = false;
let quitAfterNoteClose = false;
let tray = null;
let quitting = false;
let saveBoundsTimer = null;
const materialWindows = new Set();
const materialWindowDescriptors = new Map();
const materialSnapTimers = new Map();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createTrayIcon() {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="16" fill="#F7F1E7"/>
      <path d="M18 18h28v7H18zM18 29h20v7H18zM18 40h28v7H18z" fill="#315D72"/>
      <circle cx="48" cy="32" r="8" fill="#C8924D"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
}

function getWindowStatePath() {
  return path.join(app.getPath('userData'), windowStateFile);
}

function getStartupShortcutPath() {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    startupShortcutName,
  );
}

function getDefaultBounds() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = clamp(Math.round(workArea.width * 0.72), 980, Math.max(980, workArea.width));
  const height = clamp(Math.round(workArea.height * 0.86), 720, Math.max(720, workArea.height));

  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

function normalizeBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const width = clamp(Math.round(bounds.width), 720, Math.max(720, workArea.width));
  const height = clamp(Math.round(bounds.height), 540, Math.max(540, workArea.height));

  return {
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - Math.min(width, workArea.width)),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - Math.min(height, workArea.height)),
    width,
    height,
  };
}

function readSavedBounds() {
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed.profile === windowStateProfile &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y) &&
      Number.isFinite(parsed.width) &&
      Number.isFinite(parsed.height)
    ) {
      return normalizeBounds(parsed);
    }
  } catch {
    return null;
  }
  return null;
}

function saveCurrentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  const bounds = mainWindow.getBounds();
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getWindowStatePath(), JSON.stringify({ profile: windowStateProfile, ...bounds }, null, 2), 'utf8');
}

function queueSaveCurrentBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveCurrentBounds, 500);
}

function restoreDefaultPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setBounds(getDefaultBounds());
  saveCurrentBounds();
  showWindow();
}

function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: false,
    path: process.execPath,
  });
  syncStartupShortcut(enabled);
}

function getAutoLaunch() {
  const loginEnabled = app.getLoginItemSettings().openAtLogin;
  const shortcutEnabled = process.platform === 'win32' && fs.existsSync(getStartupShortcutPath());
  return loginEnabled || shortcutEnabled;
}

function syncStartupShortcut(enabled) {
  if (process.platform !== 'win32') {
    return;
  }

  const shortcutPath = getStartupShortcutPath();
  if (!enabled) {
    if (fs.existsSync(shortcutPath)) {
      fs.unlinkSync(shortcutPath);
    }
    return;
  }

  fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });

  if (app.isPackaged) {
    shell.writeShortcutLink(shortcutPath, {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: '启动考研学习课表桌面应用',
      icon: process.execPath,
      iconIndex: 0,
    });
  }
}

function buildTrayMenu() {
  const autoLaunch = getAutoLaunch();
  return Menu.buildFromTemplate([
    {
      label: '显示课表',
      click: () => showWindow(),
    },
    {
      label: '隐藏课表',
      click: () => mainWindow?.hide(),
    },
    { type: 'separator' },
    {
      label: '恢复默认窗口位置',
      click: () => restoreDefaultPosition(),
    },
    {
      label: '保存当前窗口位置',
      click: () => saveCurrentBounds(),
    },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: autoLaunch,
      click: (menuItem) => {
        setAutoLaunch(menuItem.checked);
        refreshTrayMenu();
      },
    },
    {
      label: '打开数据目录',
      click: () => shell.openPath(app.getPath('userData')),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        requestAppQuit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  tray?.setContextMenu(buildTrayMenu());
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function enforceNoteWindowOnTop() {
  if (!noteWindow || noteWindow.isDestroyed()) {
    return;
  }
  // Reasserting the stronger level matters on Windows after another Chromium
  // window is created or activated. It changes z-order without taking focus.
  noteWindow.setAlwaysOnTop(true, 'screen-saver', 1);
}

function showNoteWindow() {
  if (!noteWindow || noteWindow.isDestroyed()) {
    return;
  }
  enforceNoteWindowOnTop();
  if (noteWindow.isMinimized()) {
    noteWindow.restore();
  }
  noteWindow.show();
  enforceNoteWindowOnTop();
  noteWindow.focus();
}

async function closeNoteWindow() {
  if (!noteWindow || noteWindow.isDestroyed()) {
    return false;
  }

  if (noteWindowSaving) {
    noteCloseAfterSave = true;
    showNoteWindow();
    return false;
  }

  if (noteWindowDirty) {
    showNoteWindow();
    if (noteClosePromptOpen) {
      return false;
    }

    noteClosePromptOpen = true;
    try {
      const result = await dialog.showMessageBox(noteWindow, {
        type: 'warning',
        title: '笔记尚未保存',
        message: '这张图片的备注还没有保存。',
        detail: '你可以返回小窗继续编辑，或者放弃这次内容并关闭。',
        buttons: ['继续编辑', '放弃并关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) {
        quitAfterNoteClose = false;
        return false;
      }
      noteWindowDirty = false;
      noteCloseAfterSave = false;
    } finally {
      noteClosePromptOpen = false;
    }
  }

  noteWindow.close();
  return true;
}

function finishAppQuit() {
  quitAfterNoteClose = false;
  quitting = true;
  app.quit();
}

function requestAppQuit() {
  if (noteWindow && !noteWindow.isDestroyed() && (noteWindowDirty || noteWindowSaving)) {
    quitAfterNoteClose = true;
    void closeNoteWindow();
    return;
  }
  finishAppQuit();
}

function fitBoundsToWorkArea(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function setNoteWindowMode(mode) {
  if (!noteWindow || noteWindow.isDestroyed() || !['compact', 'remark'].includes(mode)) {
    return false;
  }

  if (mode === noteWindowMode) {
    return true;
  }

  if (mode === 'remark') {
    const current = noteWindow.getBounds();
    noteCompactBounds = { ...current, ...noteCompactSize };
    const expanded = fitBoundsToWorkArea({
      x: current.x + Math.round((current.width - noteRemarkSize.width) / 2),
      y: current.y + Math.round((current.height - noteRemarkSize.height) / 2),
      ...noteRemarkSize,
    });
    noteWindowMode = 'remark';
    noteWindow.setBounds(expanded, true);
    return true;
  }

  const current = noteWindow.getBounds();
  const compact = fitBoundsToWorkArea(noteCompactBounds ?? {
    x: current.x + Math.round((current.width - noteCompactSize.width) / 2),
    y: current.y + Math.round((current.height - noteCompactSize.height) / 2),
    ...noteCompactSize,
  });
  noteWindowMode = 'compact';
  noteWindow.setBounds(compact, true);
  noteCompactBounds = null;
  return true;
}

function loadRendererRoute(targetWindow, search = '') {
  if (isDev) {
    targetWindow.loadURL(`${devServerUrl}/${search}`);
    return;
  }
  targetWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    search: search.replace(/^\?/, ''),
  });
}

function materialPreviewRequestPath(argv = process.argv) {
  const raw = argv.find((argument) => String(argument).startsWith(materialPreviewArgPrefix));
  if (!raw) return '';
  const requested = path.resolve(String(raw).slice(materialPreviewArgPrefix.length));
  const relative = path.relative(materialPreviewRequestRoot, requested);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.endsWith('.json')
    ? requested
    : '';
}

function readMaterialPreviewRequest(argv = process.argv) {
  const requestPath = materialPreviewRequestPath(argv);
  if (!requestPath) return null;
  try {
    const stat = fs.statSync(requestPath);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const descriptor = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    return descriptor && descriptor.item && Array.isArray(descriptor.assets) ? descriptor : null;
  } catch {
    return null;
  } finally {
    if (requestPath) {
      try { fs.unlinkSync(requestPath); } catch {}
    }
  }
}

function materialDefaultSize(kind) {
  if (kind === 'image') return { width: 680, height: 430 };
  if (kind === 'pdf') return { width: 820, height: 680 };
  if (kind === 'html') return { width: 760, height: 600 };
  if (kind === 'word') return { width: 680, height: 620 };
  return { width: 520, height: 360 };
}

function materialBounds(descriptor) {
  const size = materialDefaultSize(descriptor?.item?.kind);
  const point = descriptor?.screenPoint || {};
  const display = Number.isFinite(point.x) && Number.isFinite(point.y) && (point.x || point.y)
    ? screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const origin = {
    x: Number.isFinite(point.x) && point.x ? Math.round(point.x - width / 2) : area.x + Math.round((area.width - width) / 2),
    y: Number.isFinite(point.y) && point.y ? Math.round(point.y - 28) : area.y + Math.round((area.height - height) / 2),
  };
  const candidates = [];
  for (let ring = 0; ring < 7; ring += 1) {
    const offset = ring * 34;
    candidates.push(
      { x: origin.x + offset, y: origin.y + offset },
      { x: origin.x - offset, y: origin.y + offset },
      { x: origin.x + offset, y: origin.y - offset },
    );
  }
  const occupied = [...materialWindows]
    .filter((window) => !window.isDestroyed() && !window.isFullScreen())
    .map((window) => window.getBounds());
  const overlaps = (candidate, other) => !(
    candidate.x + width + 10 <= other.x
    || other.x + other.width + 10 <= candidate.x
    || candidate.y + height + 10 <= other.y
    || other.y + other.height + 10 <= candidate.y
  );
  const selected = candidates.map((candidate) => ({
    x: clamp(candidate.x, area.x, area.x + area.width - width),
    y: clamp(candidate.y, area.y, area.y + area.height - height),
  })).find((candidate) => !occupied.some((other) => overlaps(candidate, other)))
    || { x: area.x + 18, y: area.y + 18 };
  return { ...selected, width, height };
}

function snapMaterialWindow(target) {
  if (!target || target.isDestroyed() || target.isFullScreen()) return;
  const bounds = target.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const threshold = 14;
  let x = bounds.x;
  let y = bounds.y;
  const trySnap = (value, candidate) => Math.abs(value - candidate) <= threshold ? candidate : value;
  x = trySnap(x, area.x);
  y = trySnap(y, area.y);
  x = trySnap(x, area.x + area.width - bounds.width);
  y = trySnap(y, area.y + area.height - bounds.height);
  for (const other of materialWindows) {
    if (other === target || other.isDestroyed() || other.isFullScreen()) continue;
    const peer = other.getBounds();
    const verticalOverlap = bounds.y < peer.y + peer.height + 24 && bounds.y + bounds.height + 24 > peer.y;
    const horizontalOverlap = bounds.x < peer.x + peer.width + 24 && bounds.x + bounds.width + 24 > peer.x;
    if (verticalOverlap) {
      x = trySnap(x, peer.x + peer.width + 10);
      x = trySnap(x, peer.x - bounds.width - 10);
    }
    if (horizontalOverlap) {
      y = trySnap(y, peer.y + peer.height + 10);
      y = trySnap(y, peer.y - bounds.height - 10);
    }
  }
  if (x !== bounds.x || y !== bounds.y) target.setPosition(x, y, true);
}

function createMaterialWindow(descriptor) {
  if (!descriptor?.item || !Array.isArray(descriptor.assets)) return null;
  const bounds = materialBounds(descriptor);
  const target = new BrowserWindow({
    ...bounds,
    minWidth: 240,
    minHeight: 150,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: true,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    title: descriptor.item.name || '学习资料',
    icon: createTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  materialWindows.add(target);
  materialWindowDescriptors.set(target.webContents.id, descriptor);
  loadRendererRoute(target, '?materialWindow=1');
  target.once('ready-to-show', () => target.show());
  target.on('moved', () => {
    clearTimeout(materialSnapTimers.get(target));
    materialSnapTimers.set(target, setTimeout(() => snapMaterialWindow(target), 90));
  });
  target.on('closed', () => {
    clearTimeout(materialSnapTimers.get(target));
    materialSnapTimers.delete(target);
    materialWindowDescriptors.delete(target.webContents.id);
    materialWindows.delete(target);
  });
  return target;
}

function openMaterialPreviewFromArgs(argv = process.argv) {
  const descriptor = readMaterialPreviewRequest(argv);
  if (!descriptor) return false;
  createMaterialWindow(descriptor);
  return true;
}

function createWindow() {
  // Electron is reserved for the tiny always-on-top note window. Keeping this
  // compatibility entry point prevents old shortcuts and packaged executables
  // from ever creating a second full-page Chromium renderer.
  return createNoteWindow();
}

function createNoteWindow() {
  if (noteWindow && !noteWindow.isDestroyed()) {
    showNoteWindow();
    return noteWindow;
  }

  noteWindow = new BrowserWindow({
    width: noteCompactSize.width,
    height: noteCompactSize.height,
    minWidth: 280,
    minHeight: 120,
    frame: false,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '考研笔记台',
    backgroundColor: '#00000000',
    icon: createTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadRendererRoute(noteWindow, '?noteApp=1');

  noteWindow.once('ready-to-show', () => {
    enforceNoteWindowOnTop();
    showNoteWindow();
  });

  noteWindow.on('show', enforceNoteWindowOnTop);
  noteWindow.on('restore', enforceNoteWindowOnTop);
  noteWindow.on('focus', enforceNoteWindowOnTop);
  noteWindow.on('blur', () => {
    setImmediate(enforceNoteWindowOnTop);
  });

  noteWindow.on('close', (event) => {
    if (noteWindowDirty) {
      event.preventDefault();
      void closeNoteWindow();
    }
  });

  noteWindow.on('closed', () => {
    const shouldQuitApp = quitAfterNoteClose;
    noteWindow = null;
    noteWindowMode = 'compact';
    noteCompactBounds = null;
    noteWindowDirty = false;
    noteWindowSaving = false;
    noteClosePromptOpen = false;
    noteCloseAfterSave = false;
    quitAfterNoteClose = false;
    if (shouldQuitApp) {
      finishAppQuit();
      return;
    }
    if (!mainWindow && !tray && !quitting) {
      finishAppQuit();
    }
  });

  return noteWindow;
}

function ensureTray() {
  if (tray) {
    return tray;
  }
  tray = new Tray(createTrayIcon());
  tray.setToolTip('考研学习课表');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
  return tray;
}

function ensureMainExperience() {
  return createNoteWindow();
}

function registerIpcHandlers() {
  ipcMain.handle('auto-launch:get', () => getAutoLaunch());
  ipcMain.handle('auto-launch:set', (_event, enabled) => {
    setAutoLaunch(Boolean(enabled));
    refreshTrayMenu();
    return getAutoLaunch();
  });
  ipcMain.handle('window:restore-default', () => {
    restoreDefaultPosition();
    return mainWindow?.getBounds();
  });
  ipcMain.handle('window:save-position', () => {
    saveCurrentBounds();
    return mainWindow?.getBounds();
  });
  ipcMain.handle('note-app:open', () => {
    createNoteWindow();
    return true;
  });
  ipcMain.handle('note-app:close', () => closeNoteWindow());
  ipcMain.handle('note-app:set-dirty', (event, dirty, saving) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow !== noteWindow) {
      return false;
    }
    noteWindowSaving = Boolean(saving);
    noteWindowDirty = Boolean(dirty) || noteWindowSaving;
    if (noteCloseAfterSave && !noteWindowSaving) {
      if (!noteWindowDirty) {
        noteCloseAfterSave = false;
        setImmediate(() => void closeNoteWindow());
      } else {
        // Saving ended with the pending note still present, so keep it open.
        noteCloseAfterSave = false;
        quitAfterNoteClose = false;
      }
    }
    return true;
  });
  ipcMain.handle('note-app:set-mode', (event, mode) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow !== noteWindow) {
      return false;
    }
    return setNoteWindowMode(mode);
  });
  ipcMain.handle('note-canvas:open', async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow !== noteWindow) {
      return false;
    }
    await shell.openExternal(`${devServerUrl}/?notes=1&mode=canvas`);
    return true;
  });
  ipcMain.handle('file:show-item-in-folder', (_event, filePath) => {
    const notesRoot = process.env.KAOYAN_NOTES_ROOT || path.join(app.getPath('desktop'), '笔记');
    const image = resolveNoteImage(notesRoot, filePath);
    shell.showItemInFolder(image.filePath);
    return true;
  });
  ipcMain.handle('file:open-path', async (_event, filePath) => {
    const notesRoot = process.env.KAOYAN_NOTES_ROOT || path.join(app.getPath('desktop'), '笔记');
    const image = resolveNoteImage(notesRoot, filePath);
    const error = await shell.openPath(image.filePath);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('material-window:open', (_event, descriptor) => Boolean(createMaterialWindow(descriptor)));
  ipcMain.handle('material-window:descriptor', (event) => materialWindowDescriptors.get(event.sender.id) || null);
  ipcMain.handle('material-window:toggle-fullscreen', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || !materialWindows.has(senderWindow)) return false;
    senderWindow.setFullScreen(!senderWindow.isFullScreen());
    return senderWindow.isFullScreen();
  });
  ipcMain.handle('material-window:fit-content', (event, width, height) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || !materialWindows.has(senderWindow) || senderWindow.isFullScreen()) return false;
    const display = screen.getDisplayMatching(senderWindow.getBounds());
    const safeWidth = clamp(Math.round(Number(width) || 0), 240, Math.min(1100, display.workArea.width));
    const safeHeight = clamp(Math.round(Number(height) || 0), 150, Math.min(850, display.workArea.height));
    const current = senderWindow.getBounds();
    senderWindow.setBounds(fitBoundsToWorkArea({
      x: current.x + Math.round((current.width - safeWidth) / 2),
      y: current.y + Math.round((current.height - safeHeight) / 2),
      width: safeWidth,
      height: safeHeight,
    }), true);
    return true;
  });
  ipcMain.handle('material-window:close', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || !materialWindows.has(senderWindow)) return false;
    senderWindow.close();
    return true;
  });
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('window:hide', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide();
  });
  ipcMain.on('window:close', (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow) {
      return;
    }
    if (senderWindow === mainWindow) {
      requestAppQuit();
      return;
    }
    if (senderWindow === noteWindow) {
      void closeNoteWindow();
      return;
    }
    senderWindow.close();
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes(noteAppCloseFlag)) {
      void closeNoteWindow();
      return;
    }
    if (openMaterialPreviewFromArgs(argv)) return;
    createNoteWindow();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.local.kaoyan.schedule');
    registerIpcHandlers();

    if (launchAsNoteAppClose) {
      quitting = true;
      app.quit();
      return;
    }

    // Remove any legacy full-desktop auto-start shortcut. Electron now owns
    // only the compact note window; full pages stay in the system browser.
    setAutoLaunch(false);
    if (!openMaterialPreviewFromArgs(process.argv)) createNoteWindow();
  });

  app.on('activate', () => {
    if (noteWindow && !noteWindow.isDestroyed()) {
      showNoteWindow();
      return;
    }
    createNoteWindow();
  });

  app.on('before-quit', (event) => {
    if (!quitting && noteWindow && !noteWindow.isDestroyed() && (noteWindowDirty || noteWindowSaving)) {
      event.preventDefault();
      requestAppQuit();
      return;
    }
    quitting = true;
    saveCurrentBounds();
  });

  app.on('window-all-closed', () => {
    if (!tray && process.platform !== 'darwin') {
      app.quit();
    }
  });
}
