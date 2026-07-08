const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const isDev = !app.isPackaged;
const devServerUrl = 'http://127.0.0.1:5173';
const windowStateFile = 'window-state.json';
const windowStateProfile = 'right-widget-v2';
const startupShortcutName = '考研学习课表.lnk';

let mainWindow = null;
let tray = null;
let quitting = false;
let saveBoundsTimer = null;
let attachedToDesktop = false;

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
  const marginRight = 10;
  const marginBottom = 8;
  const width = clamp(Math.round(workArea.width * 0.295), 340, 620);
  const height = Math.max(560, workArea.height - marginBottom);

  return {
    x: workArea.x + workArea.width - width - marginRight,
    y: workArea.y,
    width,
    height,
  };
}

function normalizeBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const width = clamp(Math.round(bounds.width), 340, Math.max(340, workArea.width));
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
  const bounds = getDefaultBounds();
  mainWindow.setBounds(bounds);
  saveCurrentBounds();
  showWindow();
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 6000 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
        });
      },
    );
  });
}

function getWindowHandleDecimal() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }
  const handle = mainWindow.getNativeWindowHandle();
  if (handle.length >= 8) {
    return handle.readBigUInt64LE(0).toString();
  }
  return BigInt(handle.readUInt32LE(0)).toString();
}

async function attachToDesktopLayer() {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const hwnd = getWindowHandleDecimal();
  if (!hwnd) {
    return false;
  }

  const bounds = mainWindow.getBounds();
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32DesktopLayer {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam, UInt32 fuFlags, UInt32 uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, UInt32 uFlags);
}
"@
$target = [IntPtr]::new([Int64]${hwnd})
$progman = [Win32DesktopLayer]::FindWindow("Progman", $null)
$result = [IntPtr]::Zero
[void][Win32DesktopLayer]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result)
$script:workerw = [IntPtr]::Zero
$callback = [Win32DesktopLayer+EnumWindowsProc]{
  param([IntPtr]$topHandle, [IntPtr]$lParam)
  $defView = [Win32DesktopLayer]::FindWindowEx($topHandle, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
  if ($defView -ne [IntPtr]::Zero) {
    $candidate = [Win32DesktopLayer]::FindWindowEx([IntPtr]::Zero, $topHandle, "WorkerW", $null)
    if ($candidate -ne [IntPtr]::Zero) {
      $script:workerw = $candidate
    }
  }
  return $true
}
[void][Win32DesktopLayer]::EnumWindows($callback, [IntPtr]::Zero)
if ($script:workerw -eq [IntPtr]::Zero) {
  $script:workerw = $progman
}
if ($script:workerw -eq [IntPtr]::Zero) {
  throw "Desktop WorkerW/Progman not found"
}
[void][Win32DesktopLayer]::SetParent($target, $script:workerw)
[void][Win32DesktopLayer]::SetWindowPos($target, [IntPtr]::Zero, ${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height}, 0x0040)
Write-Output "attached=$($script:workerw)"
`;

  const result = await runPowerShell(script);
  attachedToDesktop = result.ok && result.stdout.includes('attached=');
  refreshTrayMenu();
  return attachedToDesktop;
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
      description: '启动考研学习课表桌面组件',
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
      label: '恢复到红框位置',
      click: () => restoreDefaultPosition(),
    },
    {
      label: attachedToDesktop ? '已贴到桌面' : '重新贴到桌面',
      enabled: !attachedToDesktop,
      click: () => {
        void attachToDesktopLayer();
      },
    },
    {
      label: '保存当前位置',
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
  mainWindow.showInactive();
}

function createWindow() {
  const bounds = readSavedBounds() ?? getDefaultBounds();

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 540,
    frame: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    title: '考研学习课表',
    backgroundColor: '#00000000',
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
    setTimeout(() => {
      void attachToDesktopLayer();
    }, 700);
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
  setAutoLaunch(true);

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
  ipcMain.handle('window:attach-desktop', () => attachToDesktopLayer());
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
