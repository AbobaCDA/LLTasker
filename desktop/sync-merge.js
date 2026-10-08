// Слияние локального списка задач с облачным.
// Чистая функция без Electron и сети — поэтому её поведение закреплено тестами.
//
// Правила:
//  1. Побеждает более свежая запись по updated_at (последняя правка важнее).
//  2. Локальная задача с несинхронизированными правками (dirty) не перетирается облаком.
//  3. Задача, которая была в облаке, но пропала из него, удаляется локально
//     (её удалили с другого устройства) — но только если у неё нет локальных правок.
//  4. Новая локальная задача без отметки synced остаётся на месте и уйдёт в облако.

/** @typedef {Record<string, any> & { id: string, updated_at?: string }} TaskLike */

const timeOf = (task) => {
  const value = Date.parse(String(task?.updated_at ?? ''));
  return Number.isFinite(value) ? value : 0;
};

/**
 * @param {TaskLike[]} local      задачи из локального файла
 * @param {TaskLike[]} cloud      задачи, пришедшие из Supabase
 * @param {{ queuedDeletes?: string[], queuedUpserts?: string[] }} [options]
 *        очереди несинхронизированных операций: их результат перекрывает облако
 * @returns {{ tasks: TaskLike[], pushedToCloud: TaskLike[], removedLocally: string[], pulledFromCloud: number }}
 */
export function mergeTasks(local, cloud, options = {}) {
  const queuedDeletes = new Set(options.queuedDeletes ?? []);
  const queuedUpserts = new Set(options.queuedUpserts ?? []);
  const cloudById = new Map();
  for (const task of cloud ?? []) cloudById.set(String(task.id), task);

  /** @type {TaskLike[]} */
  const tasks = [];
  /** @type {TaskLike[]} */
  const pushedToCloud = [];
  /** @type {string[]} */
  const removedLocally = [];
  const seen = new Set();

  for (const localTask of local ?? []) {
    const id = String(localTask.id);
    seen.add(id);
    if (queuedDeletes.has(id)) continue; // удаление ещё не дошло до сервера — не воскрешаем

    const cloudTask = cloudById.get(id);
    const hasPendingEdit = Boolean(localTask.dirty) || queuedUpserts.has(id);

    if (!cloudTask) {
      // Либо задача ещё не загружалась в облако, либо её удалили с другого устройства.
      if (hasPendingEdit || !localTask.synced) {
        tasks.push(localTask);
        pushedToCloud.push(localTask);
      } else {
        removedLocally.push(id);
      }
      continue;
    }

    cloudById.delete(id);
    const localTime = timeOf(localTask);
    const cloudTime = timeOf(cloudTask);
    // Явно поставленная в очередь правка ещё не дошла до сервера — она главнее по определению.
    const queuedEditWins = queuedUpserts.has(id);
    if (queuedEditWins || (hasPendingEdit && localTime >= cloudTime)) {
      tasks.push(localTask);
      pushedToCloud.push(localTask);
    } else {
      tasks.push({ ...cloudTask, dirty: false, synced: true });
    }
  }

  for (const cloudTask of cloudById.values()) {
    const id = String(cloudTask.id);
    if (queuedDeletes.has(id) || seen.has(id)) continue;
    tasks.push({ ...cloudTask, dirty: false, synced: true });
  }

  return { tasks, pushedToCloud, removedLocally, pulledFromCloud: (cloud ?? []).length };
}

/** Что нужно отправить на сервер: новые, изменённые (dirty) и ожидающие отправки задачи. */
export function collectOutgoing(tasks) {
  const upserts = (tasks ?? []).filter((task) => task.dirty || !task.synced);
  return { upserts, deletes: [] };
}

/** Поля, которые реально есть в таблице public.tasks (всё остальное — локальное служебное). */
export const CLOUD_FIELDS = [
  'id', 'title', 'notes', 'priority', 'project', 'tags', 'due_at', 'all_day',
  'remind_offsets', 'status', 'recurrence', 'series_id', 'occurrence', 'sort_order', 'updated_at',
];

/** @param {TaskLike} task @param {string} userId */
export function toCloudRow(task, userId) {
  const row = { user_id: userId };
  for (const field of CLOUD_FIELDS) {
    if (task[field] === undefined) continue;
    row[field] = task[field];
  }
  return row;
}

/** @param {TaskLike} task */
export function fromCloudRow(task) {
  return { ...task, dirty: false, synced: true };
}

/**
 * Применяет результат синхронизации, не теряя правок, сделанных пока шёл запрос.
 * `snapshot` — состояние (tasks, pending) на момент начала синхронизации,
 * `current` — состояние сейчас, `resultTasks` — что вернула синхронизация.
 * Всё, что изменилось после снимка (новый updated_at, новая задача, новое удаление), важнее ответа облака
 * и остаётся в очереди на следующую синхронизацию.
 */
export function reconcileAfterSync(snapshot, current, resultTasks) {
  const before = new Map((snapshot.tasks ?? []).map((task) => [task.id, task]));
  const now = new Map((current.tasks ?? []).map((task) => [task.id, task]));
  const snapshotDeletes = snapshot.pending?.deletes ?? [];
  const newDeletes = (current.pending?.deletes ?? []).filter((id) => !snapshotDeletes.includes(id));
  const keepLocal = new Map();
  for (const [id, task] of now) {
    const previous = before.get(id);
    if (!previous || previous.updated_at !== task.updated_at) keepLocal.set(id, { ...task, dirty: true, synced: false });
  }
  const merged = resultTasks.map((task) => keepLocal.get(task.id) ?? task);
  const present = new Set(merged.map((task) => task.id));
  for (const [id, task] of keepLocal) if (!present.has(id)) merged.push(task);
  return {
    tasks: merged.filter((task) => !newDeletes.includes(task.id)),
    pending: { upserts: Object.fromEntries(Array.from(keepLocal.values()).map((task) => [task.id, task])), deletes: newDeletes },
    changedDuringSync: keepLocal.size + newDeletes.length,
  };
}
