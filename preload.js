'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('writingAPI', {
  platform: process.platform,
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  chooseSyncFolder: () => ipcRenderer.invoke('sync:choose-folder'),
  setSyncEnabled: (enabled) => ipcRenderer.invoke('sync:set-enabled', enabled),
  runSync: () => ipcRenderer.invoke('sync:run'),
  openSyncFolder: () => ipcRenderer.invoke('sync:open-folder'),
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (data) => ipcRenderer.invoke('store:save', data),
  importText: () => ipcRenderer.invoke('file:import-text'),
  exportText: (payload) => ipcRenderer.invoke('file:export-text', payload),
  exportArticles: (payload) => ipcRenderer.invoke('file:export-many', payload),
  createBackup: (data) => ipcRenderer.invoke('backup:create', data),
  readBackup: () => ipcRenderer.invoke('backup:read'),
  openDataFolder: () => ipcRenderer.invoke('data:open-folder'),
  getAIConfig: () => ipcRenderer.invoke('ai:config-status'),
  useSessionAIApiKey: (value) => ipcRenderer.invoke('ai:use-session-key', value),
  unlockSavedAIApiKey: () => ipcRenderer.invoke('ai:unlock-saved-key'),
  saveAIApiKey: (value) => ipcRenderer.invoke('ai:save-api-key', value),
  removeAIApiKey: () => ipcRenderer.invoke('ai:remove-api-key'),
  reviewArticle: (payload) => ipcRenderer.invoke('ai:review-article', payload),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
  closeWindow: () => ipcRenderer.invoke('window:close')
});
