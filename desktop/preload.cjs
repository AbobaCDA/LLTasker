// Мост между интерфейсом и главным процессом. CommonJS обязателен: preload работает
// в песочнице Electron, где ESM недоступен.
const { contextBridge, ipcRenderer } = require('electron');

const channels = {
  onTasksChanged: 'tasks:changed',
  onCloudStatus: 'cloud:status',
  onUpdateStatus: 'update:status',
  onFocusTask: 'tasks:focus',
};

contextBridge.exposeInMainWorld('lltasker', {
  info: () => ipcRenderer.invoke('app:info'),
  load: () => ipcRenderer.invoke('tasks:load'),
  save: (tasks) => ipcRenderer.invoke('tasks:save', tasks),
  remove: (taskId) => ipcRenderer.invoke('tasks:delete', taskId),
  preview: (text) => ipcRenderer.invoke('tasks:preview', text),
  parse: (text) => ipcRenderer.invoke('tasks:parse', text),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  cloudState: () => ipcRenderer.invoke('cloud:state'),
  signUp: (email, password) => ipcRenderer.invoke('cloud:sign-up', email, password),
  signIn: (email, password) => ipcRenderer.invoke('cloud:sign-in', email, password),
  signOut: () => ipcRenderer.invoke('cloud:sign-out'),
  syncNow: () => ipcRenderer.invoke('cloud:sync'),
  linkTelegram: (code) => ipcRenderer.invoke('cloud:link-telegram', code),

  setStartup: (enabled) => ipcRenderer.invoke('startup:set', enabled),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  openDataFolder: () => ipcRenderer.invoke('shell:open-data-folder'),
  getWallpaper: () => ipcRenderer.invoke('wallpaper:get'),
  chooseWallpaper: () => ipcRenderer.invoke('wallpaper:choose'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),

  onTasksChanged: (handler) => ipcRenderer.on(channels.onTasksChanged, (_event, tasks) => handler(tasks)),
  onCloudStatus: (handler) => ipcRenderer.on(channels.onCloudStatus, (_event, state) => handler(state)),
  onUpdateStatus: (handler) => ipcRenderer.on(channels.onUpdateStatus, (_event, state) => handler(state)),
  onFocusTask: (handler) => ipcRenderer.on(channels.onFocusTask, (_event, taskId) => handler(taskId)),
});
