// Планировщик локальных напоминаний (уведомления Windows).
// Чистые функции: их проверяют тесты, а таймеры и показ уведомлений живут в main.js.

export const MAX_OFFSET = 20160;
export const isAllowedOffset = (value) => Number.isInteger(value) && ((value >= 1 && value <= MAX_OFFSET) || value === -5);

/**
 * @typedef {Object} UpcomingReminder
 * @property {string} taskId
 * @property {string} key       уникальный ключ срабатывания (для защиты от повторов)
 * @property {string} title
 * @property {string} fireAt    ISO-момент отправки
 * @property {number} offset    минуты относительно дедлайна (отрицательные — после дедлайна)
 * @property {'deadline'|'overdue'} kind
 */

/** @param {any} task @param {number} offset @returns {string} */
export function reminderKey(task, offset) {
  return `${task.id}:${String(task.due_at)}:${offset}`;
}

/**
 * Какие напоминания ещё предстоит показать.
 * @param {any[]} tasks
 * @param {{ now?: Date, fired?: string[], horizonHours?: number, limit?: number }} [options]
 * @returns {UpcomingReminder[]}
 */
export function computeUpcomingReminders(tasks, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const fired = new Set(options.fired ?? []);
  const horizonMs = (options.horizonHours ?? 24 * 14) * 3_600_000;
  /** @type {UpcomingReminder[]} */
  const upcoming = [];

  for (const task of tasks ?? []) {
    if (!task || task.status !== 'open' || !task.due_at) continue;
    const dueAt = Date.parse(String(task.due_at));
    if (!Number.isFinite(dueAt)) continue;

    for (const rawOffset of task.remind_offsets ?? []) {
      const offset = Number(rawOffset);
      if (!isAllowedOffset(offset)) continue;
      const fireAt = dueAt - offset * 60_000;
      const key = reminderKey(task, offset);
      if (fireAt <= now.getTime() || fireAt > now.getTime() + horizonMs) continue;
      if (fired.has(key)) continue;
      upcoming.push({
        taskId: String(task.id),
        key,
        title: String(task.title ?? ''),
        fireAt: new Date(fireAt).toISOString(),
        offset,
        kind: offset < 0 ? 'overdue' : 'deadline',
      });
    }

    // Подсказка через 5 минут после дедлайна — та же логика, что в очереди на сервере.
    const overdueAt = dueAt + 5 * 60_000;
    if (overdueAt > now.getTime() && overdueAt <= now.getTime() + horizonMs && !fired.has(reminderKey(task, -5))) {
      upcoming.push({
        taskId: String(task.id),
        key: reminderKey(task, -5),
        title: String(task.title ?? ''),
        fireAt: new Date(overdueAt).toISOString(),
        offset: -5,
        kind: 'overdue',
      });
    }
  }

  upcoming.sort((left, right) => Date.parse(left.fireAt) - Date.parse(right.fireAt));
  return options.limit ? upcoming.slice(0, options.limit) : upcoming;
}

/** Просроченные задачи: дедлайн прошёл, а задача открыта. */
export function overdueTasks(tasks, now = new Date()) {
  return (tasks ?? []).filter((task) => task?.status === 'open' && task.due_at && Date.parse(String(task.due_at)) < now.getTime());
}

/** Сколько задач нужно показать в блоке «Сегодня»: срок сегодня или раньше. */
export function isDueToday(task, localToday, timeZoneDate) {
  if (!task?.due_at) return false;
  return timeZoneDate(task.due_at) <= localToday;
}

/** Текст уведомления Windows. */
export function notificationText(reminder, dueLabel, project) {
  const prefix = reminder.kind === 'overdue' ? 'Дедлайн прошёл' : 'Напоминание';
  const tail = project ? ` · #${project}` : '';
  return { title: `${prefix}: ${reminder.title}`, body: `Срок: ${dueLabel}${tail}` };
}
