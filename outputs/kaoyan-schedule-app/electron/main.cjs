const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { resolveNoteImage } = require('../scripts/note-file-access.cjs');

const isDev = !app.isPackaged;
const devServerUrl = 'http://127.0.0.1:5173';
const noteAppFlag = '--note-app';
const noteAppCloseFlag = '--close-note-app';
const launchAsNoteApp = process.argv.includes(noteAppFlag);
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

function showNoteWindow() {
  if (!noteWindow || noteWindow.isDestroyed()) {
    return;
  }
  if (noteWindow.isMinimized()) {
    noteWindow.restore();
  }
  noteWindow.show();
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

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
    return mainWindow;
  }

  const bounds = readSavedBounds() ?? getDefaultBounds();

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 540,
    frame: true,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    transparent: false,
    hasShadow: true,
    resizable: true,
    movable: true,
    title: '考研学习课表',
    backgroundColor: '#f2ede4',
    icon: createTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadRendererRoute(mainWindow);

  mainWindow.once('ready-to-show', () => {
    showWindow();
  });

  mainWindow.on('move', queueSaveCurrentBounds);
  mainWindow.on('resize', queueSaveCurrentBounds);

  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
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
    noteWindow?.setAlwaysOnTop(true, 'floating');
    showNoteWindow();
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
  createWindow();
  ensureTray();
  showWindow();
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
    if (argv.includes(noteAppFlag)) {
      createNoteWindow();
      return;
    }
    ensureMainExperience();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.local.kaoyan.schedule');
    registerIpcHandlers();

    if (launchAsNoteAppClose) {
      quitting = true;
      app.quit();
      return;
    }

    if (launchAsNoteApp) {
      createNoteWindow();
      return;
    }

    setAutoLaunch(false);
    ensureMainExperience();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      if (noteWindow) {
        showNoteWindow();
      } else {
        showWindow();
      }
      return;
    }
    if (launchAsNoteApp) {
      createNoteWindow();
    } else {
      ensureMainExperience();
    }
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
