// Журнал действий пользователя: %APPDATA%\LLTasker\logs\actions-ГГГГ-ММ-ДД.log
// Простые текстовые строки «время<TAB>событие<TAB>подробности», чтобы файл читался в Блокноте.
// Модуль без Electron — его можно тестировать отдельно.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_DAYS = 30;

function pad(value) { return String(value).padStart(2, '0'); }

function localStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Одна строка журнала без переводов строк и табуляций внутри полей. */
function sanitize(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * @param {string} directory папка журналов (создаётся при первом событии)
 * @param {{ now?: () => Date }} [options] now — для тестов
 */
export function createLogger(directory, options = {}) {
  const now = options.now ?? (() => new Date());
  let lastCleanupDay = '';

  const fileFor = (date) => join(directory, `actions-${dayKey(date)}.log`);

  const cleanup = (date) => {
    const key = dayKey(date);
    if (key === lastCleanupDay) return;
    lastCleanupDay = key;
    try {
      const limit = new Date(date.getFullYear(), date.getMonth(), date.getDate() - KEEP_DAYS);
      for (const name of readdirSync(directory)) {
        const match = /^actions-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
        if (!match) continue;
        const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (fileDate < limit) unlinkSync(join(directory, name));
      }
    } catch {
      // Чистка старых файлов не критична.
    }
  };

  /** Записывает событие. Никогда не бросает: журнал не должен ломать приложение. */
  const log = (event, details = '') => {
    try {
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
      const date = now();
      cleanup(date);
      appendFileSync(fileFor(date), `${localStamp(date)}\t${sanitize(event)}\t${sanitize(details)}\n`, 'utf8');
    } catch {
      // Нет прав или диск занят — молча пропускаем.
    }
  };

  /** Последние строки за сегодня (и вчера, если сегодня пусто/мало). */
  const tail = (limit = 300) => {
    const lines = [];
    const today = now();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    for (const date of [yesterday, today]) {
      const path = fileFor(date);
      if (!existsSync(path)) continue;
      try {
        lines.push(...readFileSync(path, 'utf8').split('\n').filter(Boolean));
      } catch {
        // Файл мог быть занят — пропускаем.
      }
    }
    return lines.slice(-limit);
  };

  return {
    directory,
    log,
    tail,
    currentFile: () => fileFor(now()),
  };
}

/** Короткое человекочитаемое описание задачи для журнала. */
export function describeTask(task) {
  if (!task) return '';
  return `«${sanitize(task.title)}»`;
}

/**
 * Что изменилось между двумя версиями задачи — список понятных фраз.
 * @param {any} previous
 * @param {any} next
 * @param {(iso: string|null, allDay: boolean) => string} formatDue форматирование срока
 */
export function describeChanges(previous, next, formatDue) {
  const changes = [];
  if (!previous) return changes;
  const due = (task) => (task.due_at ? formatDue(task.due_at, Boolean(task.all_day)) : 'без срока');
  if (previous.title !== next.title) changes.push(`название: «${sanitize(previous.title)}» → «${sanitize(next.title)}»`);
  if ((previous.due_at ?? null) !== (next.due_at ?? null) || Boolean(previous.all_day) !== Boolean(next.all_day)) changes.push(`срок: ${due(previous)} → ${due(next)}`);
  if (previous.status !== next.status) {
    const names = { open: 'в работе', done: 'выполнена', archived: 'в архиве' };
    changes.push(`статус: ${names[previous.status] ?? previous.status} → ${names[next.status] ?? next.status}`);
  }
  if (Number(previous.priority) !== Number(next.priority)) changes.push(`приоритет: ${previous.priority} → ${next.priority}`);
  if ((previous.project ?? '') !== (next.project ?? '')) changes.push(`проект: ${previous.project || '—'} → ${next.project || '—'}`);
  if ((previous.recurrence ?? '') !== (next.recurrence ?? '')) changes.push(`повтор: ${previous.recurrence || 'нет'} → ${next.recurrence || 'нет'}`);
  if ((previous.notes ?? '') !== (next.notes ?? '')) changes.push('заметки изменены');
  if (JSON.stringify(previous.tags ?? []) !== JSON.stringify(next.tags ?? [])) changes.push(`теги: ${(next.tags ?? []).join(' ') || '—'}`);
  if (JSON.stringify(previous.remind_offsets ?? []) !== JSON.stringify(next.remind_offsets ?? [])) changes.push(`напоминания: ${(next.remind_offsets ?? []).join(', ') || 'выключены'} мин`);
  if (Number(previous.sort_order ?? 0) !== Number(next.sort_order ?? 0)) changes.push('порядок в списке');
  return changes;
}
