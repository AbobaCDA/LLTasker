// Главный процесс LLTasker: окно, трей, автозапуск, автообновление,
// локальные напоминания Windows и синхронизация с облаком.
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, shell } from 'electron';
// electron-updater — CommonJS-пакет: именованный импорт { autoUpdater } падает в ESM,
// поэтому берём default-экспорт и достаём autoUpdater из него.
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLocalDays, formatDue, localDateString } from '../supabase/functions/_shared/time.js';
import { parseTaskInput } from '../supabase/functions/_shared/parser.js';
import { computeUpcomingReminders, notificationText } from './reminders.js';
import { AUTH_FILE, STATE_FILE, createStore, queueDelete, queueUpsert } from './store.js';
import * as cloud from './cloud.js';

const APP_DATA_FOLDER = 'LLTasker';
const LEGACY_DATA_FOLDER = 'ForgeTasks'; // папка версий до переименования
const APP_ID = 'com.abobacda.lltasker';
const SYNC_INTERVAL_MS = 60_000;
const REMINDER_TICK_MS = 30_000;

if (process.platform === 'win32') {
  // Без этого Windows-уведомления в собранном приложении приходят от «electron.app.…»,
  // а не от LLTasker, и могут не показываться вовсе.
  app.setAppUserModelId(APP_ID);
  if (app.isPackaged) app.setPath('userData', join(app.getPath('appData'), APP_DATA_FOLDER));
}

/** Однократный перенос данных версий до переименования: %APPDATA%\ForgeTasks -> %APPDATA%\LLTasker. */
function importLegacyData() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const target = join(app.getPath('userData'), STATE_FILE);
    if (existsSync(target)) return;
    const legacy = join(app.getPath('appData'), LEGACY_DATA_FOLDER, 'forge-tasks.json');
    if (!existsSync(legacy)) return;
    mkdirSync(app.getPath('userData'), { recursive: true });
    copyFileSync(legacy, target);
    const legacyAuth = join(app.getPath('appData'), LEGACY_DATA_FOLDER, AUTH_FILE);
    if (existsSync(legacyAuth)) copyFileSync(legacyAuth, join(app.getPath('userData'), AUTH_FILE));
    console.log('Перенесены данные из прошлой версии:', legacy, '->', target);
  } catch (error) {
    console.warn('Не удалось перенести данные прошлой версии:', error?.message ?? error);
  }
}

const directory = fileURLToPath(new URL('.', import.meta.url));
importLegacyData();
const store = createStore(app.getPath('userData'));

let mainWindow = null;
let tray = null;
let reminderTimer = null;
let syncTimer = null;
let syncInFlight = false;
let updateCheckPromise = null;
let updateState = { status: 'idle', version: null, error: '' };

function settings() {
  return store.read().settings;
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function currentCloudState() {
  try {
    cloud.configure(settings());
    return await cloud.getState();
  } catch (error) {
    return { configured: false, signedIn: false, error: String(error?.message ?? error) };
  }
}

// --- Напоминания Windows -------------------------------------------------------

function rescheduleReminders() {
  const state = store.read();
  if (state.settings.notifications === 'telegram' || state.settings.notifications === 'off') return;
  const timeZone = state.settings.timezone || 'Europe/Moscow';
  const [due] = computeUpcomingReminders(state.tasks, { now: new Date(), fired: state.sync.fired, limit: 1 });
  if (!due) return;
  const delay = Math.max(500, Date.parse(due.fireAt) - Date.now());
  setTimeout(() => {
    showReminder(due, timeZone);
    rescheduleReminders();
  }, Math.min(delay, 2_147_000_000)).unref?.();
}

function showReminder(reminder, timeZone) {
  const state = store.read();
  const task = state.tasks.find((item) => item.id === reminder.taskId);
  if (!task || task.status !== 'open') return;

  const dueLabel = formatDue(task.due_at, timeZone, task.all_day);
  const { title, body } = notificationText(reminder, dueLabel, task.project);
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        sendToWindow('tasks:focus', reminder.taskId);
      }
    });
    notification.show();
  }

  store.update((draft) => {
    if (!draft.sync.fired.includes(reminder.key)) draft.sync.fired.push(reminder.key);
    return draft;
  });
}

// --- Синхронизация -------------------------------------------------------------

async function syncNow({ silent = true } = {}) {
  if (syncInFlight) return { ok: false, reason: 'busy' };
  const state = store.read();
  cloud.configure(state.settings);
  if (!cloud.isConfigured()) {
    if (!silent) return { ok: false, reason: 'not-configured' };
    return { ok: false, reason: 'not-configured' };
  }
  const cloudState = await cloud.getState();
  if (!cloudState.signedIn) return { ok: false, reason: 'anonymous' };

  syncInFlight = true;
  sendToWindow('cloud:status', { ...cloudState, sync: 'running' });
  try {
    const result = await cloud.syncTasks(state.tasks, {
      deletes: state.pending.deletes,
      upsertIds: Object.keys(state.pending.upserts),
    });
    store.update((draft) => {
      draft.tasks = result.tasks;
      draft.pending = { upserts: {}, deletes: [] };
      draft.sync = { ...draft.sync, lastPushAt: result.syncedAt, userId: cloudState.userId, status: 'ok', message: '' };
      return draft;
    });
    rescheduleReminders();
    sendToWindow('tasks:changed', store.read().tasks);
    sendToWindow('cloud:status', { ...(await currentCloudState()), sync: 'idle', lastSyncAt: result.syncedAt });
    return { ok: true, ...result };
  } catch (error) {
    const message = String(error?.message ?? error);
    store.update((draft) => {
      draft.sync.status = 'error';
      draft.sync.message = message;
      return draft;
    });
    sendToWindow('cloud:status', { ...(await currentCloudState()), sync: 'error', error: message });
    return { ok: false, error: message };
  } finally {
    syncInFlight = false;
  }
}

function startLoops() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    syncNow({ silent: true }).catch(() => {});
  }, SYNC_INTERVAL_MS);

  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(() => rescheduleReminders(), REMINDER_TICK_MS);

  rescheduleReminders();
}

// --- Обновления ----------------------------------------------------------------

function sendUpdateStatus(status, extra = {}) {
  updateState = { ...updateState, status, ...extra };
  sendToWindow('update:status', updateState);
}

function checkForUpdates() {
  if (!app.isPackaged) {
    sendUpdateStatus('dev', { error: 'Проверка обновлений работает только в установленной версии.' });
    return Promise.resolve(updateState);
  }
  if (!updateCheckPromise) {
    updateCheckPromise = autoUpdater.checkForUpdates()
      .catch((error) => {
        sendUpdateStatus('error', { error: String(error?.message ?? error) });
        return null;
      })
      .finally(() => {
        updateCheckPromise = null;
      });
  }
  return updateCheckPromise;
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;
autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info?.version ?? null }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('current'));
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(Number(progress?.percent ?? 0)) }));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('ready', { version: info?.version ?? null }));
autoUpdater.on('error', (error) => sendUpdateStatus('error', { error: String(error?.message ?? error) }));

// --- Окно, трей, автозапуск ----------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#12151c',
    autoHideMenuBar: true,
    icon: join(directory, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(join(directory, '..', 'task-manager.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const iconPath = join(directory, '..', 'assets', 'icon.ico');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('LLTasker');
  const menu = Menu.buildFromTemplate([
    { label: 'Открыть LLTasker', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Синхронизировать сейчас', click: () => syncNow({ silent: false }) },
    { label: 'Начать с Windows', type: 'checkbox', checked: startupEnabled(), click: (item) => setStartup(item.checked) },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

function startupEnabled() {
  if (process.platform !== 'win32') return false;
  // Важно: путь и аргументы должны совпадать с теми, что передавались при включении,
  // иначе Windows не находит запись и всегда отвечает «выключено».
  return app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin;
}

function setStartup(enabled) {
  if (process.platform !== 'win32') return { enabled: false, unsupported: true };
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args: ['--hidden'] });
  return { enabled: startupEnabled() };
}

// --- IPC -----------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    dataFolder: app.getPath('userData'),
    platform: process.platform,
  }));

  ipcMain.handle('tasks:load', async () => {
    const state = store.read();
    return {
      tasks: state.tasks,
      settings: state.settings,
      sync: { lastSyncAt: state.sync.lastPushAt, status: state.sync.status, message: state.sync.message },
      pending: { upserts: Object.keys(state.pending.upserts).length, deletes: state.pending.deletes.length },
      cloud: await currentCloudState(),
      update: updateState,
      startup: startupEnabled(),
    };
  });

  ipcMain.handle('tasks:save', async (_event, tasks) => {
    const normalized = (Array.isArray(tasks) ? tasks : []).map((task) => ({ ...task, updated_at: task.updated_at ?? new Date().toISOString() }));
    store.update((draft) => {
      // Сравниваем с прошлым состоянием, иначе правка не попадёт в очередь отправки.
      const previousById = new Map(draft.tasks.map((task) => [task.id, task]));
      draft.tasks = normalized;
      draft.pending = { upserts: {}, deletes: draft.pending.deletes };
      for (const task of normalized) {
        const previous = previousById.get(task.id);
        const changed = !previous || previous.updated_at !== task.updated_at || sectionChanged(previous, task);
        if (changed) draft.pending = queueUpsert(draft.pending, { ...task, dirty: true, synced: false });
      }
      return draft;
    });
    rescheduleReminders();
    const result = await syncNow({ silent: true });
    return { saved: normalized.length, sync: result };
  });

  ipcMain.handle('tasks:delete', async (_event, taskId) => {
    store.update((draft) => {
      draft.tasks = draft.tasks.filter((task) => task.id !== String(taskId));
      draft.pending = queueDelete(draft.pending, String(taskId));
      return draft;
    });
    rescheduleReminders();
    await syncNow({ silent: true });
    return { ok: true };
  });

  ipcMain.handle('tasks:parse', (_event, text) => {
    const state = store.read();
    return parseTaskInput(String(text ?? ''), state.settings.timezone || 'Europe/Moscow');
  });

  ipcMain.handle('tasks:preview', (_event, text) => {
    const state = store.read();
    const timeZone = state.settings.timezone || 'Europe/Moscow';
    const parsed = parseTaskInput(String(text ?? ''), timeZone);
    const now = new Date();
    return {
      ...parsed,
      dueLabel: parsed.dueAt ? formatDue(parsed.dueAt, timeZone, parsed.allDay) : '',
      tomorrowLabel: localDateString(addLocalDays(now, 1, timeZone, 12, 0), timeZone),
    };
  });

  ipcMain.handle('settings:save', async (_event, patch) => {
    const state = store.update((draft) => {
      draft.settings = { ...draft.settings, ...(patch ?? {}) };
      return draft;
    });
    cloud.configure(state.settings);
    rescheduleReminders();
    // Если вошли в аккаунт, переносим часовой пояс и дайджест в облако (от него работают напоминания в боте).
    try {
      const cloudState = await cloud.getState();
      if (cloudState.signedIn) await cloud.pushProfileSettings(state.settings);
    } catch {
      // Настройки сохранились локально; в облако уйдут при следующей удачной синхронизации.
    }
    return state.settings;
  });

  ipcMain.handle('cloud:state', () => currentCloudState());
  ipcMain.handle('cloud:sign-up', async (_event, email, password) => {
    cloud.configure(settings());
    const result = await cloud.signUp(email, password);
    return { ...result, state: await currentCloudState() };
  });
  ipcMain.handle('cloud:sign-in', async (_event, email, password) => {
    cloud.configure(settings());
    await cloud.signIn(email, password);
    const state = await currentCloudState();
    if (state.signedIn) syncNow({ silent: true }).catch(() => {});
    return state;
  });
  ipcMain.handle('cloud:sign-out', async () => {
    cloud.configure(settings());
    await cloud.signOut();
    return currentCloudState();
  });
  ipcMain.handle('cloud:sync', () => syncNow({ silent: false }));
  ipcMain.handle('cloud:link-telegram', async (_event, code) => {
    cloud.configure(settings());
    const result = await cloud.linkTelegram(code);
    return { ...result, state: await currentCloudState() };
  });

  ipcMain.handle('startup:set', (_event, enabled) => setStartup(enabled));
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:install', () => {
    app.isQuitting = true;
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle('shell:open-data-folder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('window:hide', () => mainWindow?.hide());
}

function sectionChanged(previous, next) {
  const fields = ['title', 'notes', 'priority', 'project', 'due_at', 'all_day', 'status', 'recurrence', 'sort_order'];
  return fields.some((field) => JSON.stringify(previous?.[field] ?? null) !== JSON.stringify(next?.[field] ?? null))
    || JSON.stringify(previous?.remind_offsets ?? []) !== JSON.stringify(next?.remind_offsets ?? [])
    || JSON.stringify(previous?.tags ?? []) !== JSON.stringify(next?.tags ?? []);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    createWindow();
    createTray();
    startLoops();
    cloud.onStatusChange((state) => sendToWindow('cloud:status', state));
    cloud.configure(settings());
    if (!process.argv.includes('--hidden')) mainWindow.show();
    checkForUpdates();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('window-all-closed', () => {
    // Приложение живёт в трее: выход только через меню трея.
  });
}

export { syncNow, rescheduleReminders };
