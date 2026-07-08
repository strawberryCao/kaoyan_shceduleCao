const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kaoyanDesktop', {
  platform: process.platform,
  isElectron: true,
  getAutoLaunch: () => ipcRenderer.invoke('auto-launch:get'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('auto-launch:set', Boolean(enabled)),
  restoreDefaultPosition: () => ipcRenderer.invoke('window:restore-default'),
  savePosition: () => ipcRenderer.invoke('window:save-position'),
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  close: () => ipcRenderer.send('window:close'),
});
