const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');

const isDev = !app.isPackaged;
const devServerUrl = 'http://127.0.0.1:5173';
const windowStateFile = 'window-state.json';
const windowStateProfile = 'normal-desktop-v1';
const startupShortcutName = '考研学习课表.lnk';

let mainWindow = null;
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
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  tray?.setContextMenu(buildTrayMenu());
}

function showWindow() {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
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

  if (isDev) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    showWindow();
  });

  mainWindow.on('move', queueSaveCurrentBounds);
  mainWindow.on('resize', queueSaveCurrentBounds);

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.local.kaoyan.schedule');
  setAutoLaunch(false);

  createWindow();
  tray = new Tray(createTrayIcon());
  tray.setToolTip('考研学习课表');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());

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
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:hide', () => mainWindow?.hide());
  ipcMain.on('window:close', () => {
    quitting = true;
    app.quit();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    showWindow();
  }
});

app.on('before-quit', () => {
  quitting = true;
  saveCurrentBounds();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
