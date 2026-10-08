// Локальное хранилище приложения: %APPDATA%\LLTasker\lltasker.json
// Отдельный модуль без Electron — его можно тестировать и переиспользовать.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_FILE = 'lltasker.json';
export const AUTH_FILE = 'cloud-auth.bin';

export const DEFAULT_SETTINGS = {
  timezone: 'Europe/Moscow',
  digestEnabled: true,
  digestAt: '09:00',
  notifications: 'both', // both | telegram | toast | off
  supabaseUrl: '',
  supabaseKey: '',
};

function emptyState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    tasks: [],
    pending: { upserts: {}, deletes: [] },
    sync: { userId: null, lastPullAt: null, lastPushAt: null, fired: [], status: 'idle', message: '' },
  };
}

/** Приводит любой прочитанный объект к ожидаемой форме — файл мог быть правлен руками. */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const settings = { ...base.settings, ...(raw.settings ?? {}) };
  if (!['both', 'telegram', 'toast', 'off'].includes(settings.notifications)) settings.notifications = 'both';
  const digestMatch = /^(\d{1,2}):(\d{2})$/.exec(String(settings.digestAt));
  const digestValid = digestMatch && Number(digestMatch[1]) <= 23 && Number(digestMatch[2]) <= 59;
  settings.digestAt = digestValid ? `${String(Number(digestMatch[1])).padStart(2, '0')}:${digestMatch[2]}` : '09:00';
  const pending = {
    upserts: raw.pending?.upserts && typeof raw.pending.upserts === 'object' ? raw.pending.upserts : {},
    deletes: Array.isArray(raw.pending?.deletes) ? raw.pending.deletes.filter((id) => typeof id === 'string') : [],
  };
  const sync = { ...base.sync, ...(raw.sync ?? {}) };
  sync.fired = Array.isArray(sync.fired) ? sync.fired.slice(-500) : [];
  return {
    version: 1,
    settings,
    tasks: Array.isArray(raw.tasks) ? raw.tasks.filter((task) => task && typeof task.id === 'string') : [],
    pending,
    sync,
  };
}

export function createStore(directory, file = STATE_FILE) {
  const filePath = join(directory, file);
  const ensureDirectory = () => {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  };

  const read = () => {
    try {
      if (!existsSync(filePath)) return emptyState();
      return normalizeState(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      // Битый файл не должен мешать запуску: уводим его в сторону и начинаем с чистого состояния.
      try {
        renameSync(filePath, `${filePath}.broken-${Date.now()}`);
      } catch {
        // Если переименовать не удалось — просто продолжаем.
      }
      return emptyState();
    }
  };

  const write = (state) => {
    ensureDirectory();
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    renameSync(temporary, filePath);
    return state;
  };

  /** Частичное обновление состояния с сохранением на диск. */
  const update = (mutate) => {
    const state = read();
    const result = mutate(state) ?? state;
    write(result);
    return result;
  };

  return { filePath, read, write, update };
}

/** Слияние очереди изменений: последняя правка задачи перекрывает предыдущую. */
export function queueUpsert(pending, task) {
  const upserts = { ...pending.upserts, [task.id]: task };
  const deletes = (pending.deletes ?? []).filter((id) => id !== task.id);
  return { upserts, deletes };
}

export function queueDelete(pending, taskId) {
  const upserts = { ...pending.upserts };
  delete upserts[taskId];
  const deletes = Array.from(new Set([...(pending.deletes ?? []), taskId]));
  return { upserts, deletes };
}
