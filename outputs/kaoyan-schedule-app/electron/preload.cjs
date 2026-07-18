const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kaoyanDesktop', {
  platform: process.platform,
  isElectron: true,
  getAutoLaunch: () => ipcRenderer.invoke('auto-launch:get'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('auto-launch:set', Boolean(enabled)),
  restoreDefaultPosition: () => ipcRenderer.invoke('window:restore-default'),
  savePosition: () => ipcRenderer.invoke('window:save-position'),
  openNoteApp: () => ipcRenderer.invoke('note-app:open'),
  closeNoteApp: () => ipcRenderer.invoke('note-app:close'),
  setNoteAppDirty: (dirty, saving) => ipcRenderer.invoke('note-app:set-dirty', Boolean(dirty), Boolean(saving)),
  setNoteAppMode: (mode) => ipcRenderer.invoke('note-app:set-mode', mode),
  openNoteCanvas: () => ipcRenderer.invoke('note-canvas:open'),
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  close: () => ipcRenderer.send('window:close'),
});
