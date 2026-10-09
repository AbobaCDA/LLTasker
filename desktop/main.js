// Главный процесс LLTasker: окно, трей, автозапуск, автообновление,
// локальные напоминания Windows и синхронизация с облаком.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } from 'electron';
// electron-updater — CommonJS-пакет: именованный импорт { autoUpdater } падает в ESM,
// поэтому берём default-экспорт и достаём autoUpdater из него.
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { extname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLocalDays, formatDue, localDateString } from '../supabase/functions/_shared/time.js';
import { parseTaskInput } from '../supabase/functions/_shared/parser.js';
import { computeUpcomingReminders, notificationText } from './reminders.js';
import { AUTH_FILE, STATE_FILE, createStore, queueDelete, queueUpsert } from './store.js';
import * as cloud from './cloud.js';
import { reconcileAfterSync } from './sync-merge.js';
import { createLogger, describeChanges, describeTask } from './logger.js';

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
const logger = createLogger(join(app.getPath('userData'), 'logs'));
/** Запись в журнал действий (никогда не бросает). */
function log(event, details = '') { logger.log(event, details); }
/** Срок задачи для журнала — в часовом поясе из настроек. */
function dueForLog(iso, allDay) { return formatDue(iso, settings().timezone || 'Europe/Moscow', allDay); }

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

/** Файл картинки → data URL (CSP интерфейса разрешает картинки только как data:). */
function imageDataUrl(path) {
  if (!path || !existsSync(path)) return null;
  const mime = { '.png': 'image/png', '.webp': 'image/webp' }[extname(path).toLowerCase()] ?? 'image/jpeg';
  try {
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Своя картинка фона в виде data URL (или null, если не задана). */
function customWallpaperDataUrl() {
  const { wallpaperFile } = settings();
  return wallpaperFile ? imageDataUrl(join(app.getPath('userData'), wallpaperFile)) : null;
}

/** Встроенные обои «Лес в тумане». */
function forestWallpaperDataUrl() {
  return imageDataUrl(join(directory, '..', 'assets', 'wallpaper-forest.jpg'));
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
  log('напоминание показано', `${describeTask(task)} · ${dueLabel}`);
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

let syncQueued = false;
async function syncNow({ silent = true } = {}) {
  if (syncInFlight) {
    // Кто-то сохранил задачи, пока идёт синхронизация: повторим сразу после неё.
    syncQueued = true;
    return { ok: false, reason: 'busy' };
  }
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
    let changedDuringSync = 0;
    store.update((draft) => {
      // Пока ходили в облако, пользователь мог что-то поменять: снимок `state` сделан до запроса,
      // всё, что изменилось после него, важнее ответа облака (иначе перетаскивания «отпрыгивали» назад).
      const reconciled = reconcileAfterSync(state, draft, result.tasks);
      changedDuringSync = reconciled.changedDuringSync;
      draft.tasks = reconciled.tasks;
      draft.pending = reconciled.pending;
      draft.sync = { ...draft.sync, lastPushAt: result.syncedAt, userId: cloudState.userId, status: 'ok', message: '' };
      return draft;
    });
    if (changedDuringSync > 0) syncQueued = true;
    rescheduleReminders();
    sendToWindow('tasks:changed', store.read().tasks);
    sendToWindow('cloud:status', { ...(await currentCloudState()), sync: 'idle', lastSyncAt: result.syncedAt });
    if (result.pushed > 0 || result.deleted > 0 || result.removedLocally > 0) {
      log('синхронизация', `отправлено ${result.pushed}, удалено ${result.deleted}, получено ${result.pulled}`);
    }
    return { ok: true, ...result };
  } catch (error) {
    const message = String(error?.message ?? error);
    store.update((draft) => {
      draft.sync.status = 'error';
      draft.sync.message = message;
      return draft;
    });
    sendToWindow('cloud:status', { ...(await currentCloudState()), sync: 'error', error: message });
    log('ошибка синхронизации', message);
    return { ok: false, error: message };
  } finally {
    syncInFlight = false;
    if (syncQueued) {
      syncQueued = false;
      setTimeout(() => syncNow({ silent: true }).catch(() => {}), 50);
    }
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
    lastUpdateCheckAt = Date.now();
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
autoUpdater.on('update-downloaded', (info) => { log('обновление скачано', String(info?.version ?? '')); sendUpdateStatus('ready', { version: info?.version ?? null }); });
let publishRetries = 0;
let publishRetryTimer = null;
autoUpdater.on('error', (error) => {
  const message = String(error?.message ?? error);
  log('ошибка обновления', message);
  // 404 на установщике: latest.yml уже виден, а .exe (100 МБ) ещё грузится на GitHub. Подождём и повторим.
  if (/status 404|HttpError: 404|404/.test(message) && publishRetries < 5) {
    publishRetries += 1;
    clearTimeout(publishRetryTimer);
    publishRetryTimer = setTimeout(() => checkForUpdates(), 60_000);
    sendUpdateStatus('publishing', { error: null });
    return;
  }
  sendUpdateStatus('error', { error: message });
});
autoUpdater.on('update-downloaded', () => { publishRetries = 0; });
autoUpdater.on('update-not-available', () => { publishRetries = 0; });
let lastUpdateCheckAt = 0;
/** Проверка «по случаю»: при показе окна, но не чаще раза в час. */
function checkForUpdatesIfStale() {
  if (Date.now() - lastUpdateCheckAt < 60 * 60_000) return;
  checkForUpdates();
}

// --- Окно, трей, автозапуск ----------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: settings().theme === 'light' ? '#e9edf2' : '#12151c',
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
    log('окно свёрнуто в трей');
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
        if (!previous) {
          log('задача добавлена', `${describeTask(task)} · ${task.due_at ? dueForLog(task.due_at, task.all_day) : 'без срока'}${task.project ? ` · #${task.project}` : ''}`);
        } else if (changed) {
          const changes = describeChanges(previous, task, dueForLog);
          if (changes.length) log('задача изменена', `${describeTask(task)} · ${changes.join('; ')}`);
        }
      }
      return draft;
    });
    rescheduleReminders();
    const result = await syncNow({ silent: true });
    return { saved: normalized.length, sync: result };
  });

  ipcMain.handle('tasks:delete', async (_event, taskId) => {
    log('задача удалена', describeTask(store.read().tasks.find((task) => task.id === String(taskId))) || String(taskId));
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
    const shown = Object.entries(patch ?? {}).map(([key, value]) => `${key}=${key === 'supabaseKey' ? '…' : String(value)}`).join(', ');
    if (shown) log('настройки изменены', shown);
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
    log('аккаунт создан', String(email).trim());
    return { ...result, state: await currentCloudState() };
  });
  ipcMain.handle('cloud:sign-in', async (_event, email, password) => {
    cloud.configure(settings());
    await cloud.signIn(email, password);
    log('вход в аккаунт', String(email).trim());
    const state = await currentCloudState();
    if (state.signedIn) syncNow({ silent: true }).catch(() => {});
    return state;
  });
  ipcMain.handle('cloud:sign-out', async () => {
    cloud.configure(settings());
    await cloud.signOut();
    log('выход из аккаунта');
    return currentCloudState();
  });
  ipcMain.handle('cloud:sync', () => syncNow({ silent: false }));
  ipcMain.handle('cloud:link-telegram', async (_event, code) => {
    cloud.configure(settings());
    const result = await cloud.linkTelegram(code);
    log('Telegram привязан');
    return { ...result, state: await currentCloudState() };
  });

  ipcMain.handle('startup:set', (_event, enabled) => { log('автозапуск', enabled ? 'включён' : 'выключен'); return setStartup(enabled); });
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:install', () => {
    app.isQuitting = true;
    log('обновление: установка', String(updateState.version ?? ''));
    // Установщик у нас пошаговый (oneClick: false — выбор папки при первой установке).
    // Без isSilent=true он показывает весь мастер заново, как при переустановке.
    // isSilent=true: тихая замена файлов в уже выбранной папке; isForceRunAfter=true: сразу запустить приложение.
    autoUpdater.quitAndInstall(true, true);
  });
  ipcMain.handle('shell:open-data-folder', () => shell.openPath(app.getPath('userData')));

  // --- Журнал действий ---
  ipcMain.handle('log:write', (_event, event, details) => { log(String(event ?? '').slice(0, 80), String(details ?? '').slice(0, 500)); return true; });
  ipcMain.handle('log:tail', (_event, limit) => ({ lines: logger.tail(Number(limit) || 300), file: logger.currentFile(), directory: logger.directory }));
  ipcMain.handle('log:open-file', () => { if (!existsSync(logger.currentFile())) log('журнал открыт'); return shell.openPath(logger.currentFile()); });
  ipcMain.handle('log:open-folder', () => { if (!existsSync(logger.directory)) mkdirSync(logger.directory, { recursive: true }); return shell.openPath(logger.directory); });

  // --- Обои: своя картинка копируется в папку данных и отдаётся интерфейсу как data URL ---
  ipcMain.handle('wallpaper:get', () => ({ forest: forestWallpaperDataUrl(), custom: customWallpaperDataUrl() }));
  ipcMain.handle('wallpaper:choose', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: 'Выбери картинку для фона',
      properties: ['openFile'],
      filters: [{ name: 'Картинки', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (canceled || !filePaths?.[0]) return { ok: false, reason: 'cancelled' };
    const source = filePaths[0];
    const extension = extname(source).toLowerCase() || '.jpg';
    const fileName = `wallpaper${extension}`;
    const target = join(app.getPath('userData'), fileName);
    try {
      // Сначала убираем старую картинку (могла быть с другим расширением).
      for (const old of ['wallpaper.jpg', 'wallpaper.jpeg', 'wallpaper.png', 'wallpaper.webp']) {
        const path = join(app.getPath('userData'), old);
        if (existsSync(path) && path !== target) unlinkSync(path);
      }
      copyFileSync(source, target);
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
    const state = store.update((draft) => {
      draft.settings = { ...draft.settings, wallpaper: 'custom', wallpaperFile: fileName };
      return draft;
    });
    log('фон выбран', source);
    return { ok: true, settings: state.settings, dataUrl: customWallpaperDataUrl() };
  });
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
    log('приложение запущено', `версия ${app.getVersion()}${process.argv.includes('--hidden') ? ' · скрыто (автозапуск)' : ''}`);
    registerIpc();
    createWindow();
    createTray();
    startLoops();
    cloud.onStatusChange((state) => sendToWindow('cloud:status', state));
    cloud.configure(settings());
    if (!process.argv.includes('--hidden')) mainWindow.show();
    checkForUpdates();
    setInterval(() => checkForUpdates(), 4 * 60 * 60_000); // и дальше каждые 4 часа, пока приложение живёт в трее
    mainWindow.on('show', () => checkForUpdatesIfStale());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    log('приложение закрыто');
  });

  app.on('window-all-closed', () => {
    // Приложение живёт в трее: выход только через меню трея.
  });
}

export { syncNow, rescheduleReminders };
