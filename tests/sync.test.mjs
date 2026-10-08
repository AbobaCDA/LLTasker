// Тесты слияния локальных и облачных задач + хранилища. Запуск: node tests/sync.test.mjs
import { mergeTasks, collectOutgoing, toCloudRow, CLOUD_FIELDS, reconcileAfterSync } from '../desktop/sync-merge.js';
import { createStore, normalizeState, queueDelete, queueUpsert, DEFAULT_SETTINGS } from '../desktop/store.js';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
function check(name, condition, details = '') {
  if (condition) passed += 1;
  else { failures.push(`${name}${details ? ` — ${details}` : ''}`); console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`); }
}
const group = (title) => console.log(`\n== ${title} ==`);

const task = (id, extra = {}) => ({
  id, title: `Задача ${id}`, notes: '', priority: 1, project: null, tags: [], due_at: null,
  all_day: false, remind_offsets: [1440, 60, 10], status: 'open', completed_at: null, recurrence: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...extra,
});

group('Слияние локального и облачного');
{
  const local = [task('a', { synced: true, title: 'Старое имя' })];
  const cloud = [task('a', { title: 'Новое имя', updated_at: '2026-10-05T10:00:00Z' })];
  const result = mergeTasks(local, cloud);
  check('облако новее — обновляем локальную задачу', result.tasks[0].title === 'Новое имя', result.tasks[0].title);
  check('задача помечена синхронизированной', result.tasks[0].synced === true && result.tasks[0].dirty === false);
  check('нечего отправлять наверх', result.pushedToCloud.length === 0);
}
{
  const local = [task('b', { dirty: true, synced: true, title: 'Правка на ПК', updated_at: '2026-10-06T10:00:00Z' })];
  const cloud = [task('b', { title: 'Старое из облака', updated_at: '2026-10-05T10:00:00Z' })];
  const result = mergeTasks(local, cloud);
  check('свежая локальная правка не перетирается', result.tasks[0].title === 'Правка на ПК', result.tasks[0].title);
  check('правка уходит в облако', result.pushedToCloud.length === 1 && result.pushedToCloud[0].id === 'b');
}
{
  const local = [task('c', { synced: true, dirty: false })];
  const result = mergeTasks(local, []);
  check('удалённая в облаке задача убирается локально', result.removedLocally.includes('c') && result.tasks.length === 0);
  const newLocal = mergeTasks([task('d', { synced: false })], []);
  check('новая локальная задача не удаляется, а отправляется', newLocal.tasks.length === 1 && newLocal.pushedToCloud[0].id === 'd');
}
{
  const local = [task('e', { synced: true, dirty: true })];
  const result = mergeTasks(local, [], { queuedDeletes: ['e'] });
  check('удаление, не дошедшее до сервера, не воскрешает задачу', result.tasks.length === 0);
}
{
  const local = [task('f', { synced: true, dirty: true, title: 'Локально' })];
  const cloud = [task('f', { title: 'В облаке', updated_at: '2026-10-06T23:00:00Z' })];
  const result = mergeTasks(local, cloud, { queuedUpserts: ['f'] });
  check('задача из очереди отправки не перетирается облаком', result.tasks[0].title === 'Локально', result.tasks[0].title);
}
{
  const cloud = [task('g', { updated_at: '2026-10-06T10:00:00Z' })];
  const result = mergeTasks([], cloud);
  check('новая задача из облака появляется локально', result.tasks.length === 1 && result.tasks[0].synced === true);
  check('счётчик полученных задач', result.pulledFromCloud === 1);
}
{
  const outgoing = collectOutgoing([task('h', { dirty: true }), task('i', { dirty: false, synced: true }), task('j', { synced: false })]);
  check('наверх уходят только изменённые и новые', outgoing.upserts.map((item) => item.id).sort().join(',') === 'h,j', outgoing.upserts.map((item) => item.id).join(','));
  const row = toCloudRow(task('k', { dirty: true, synced: false }), 'user-1');
  check('в облачную строку локальные пометки не попадают', row.user_id === 'user-1' && row.dirty === undefined && row.synced === undefined);
  check('все облачные поля перечислены', CLOUD_FIELDS.includes('remind_offsets') && CLOUD_FIELDS.includes('recurrence') && !CLOUD_FIELDS.includes('dirty'));
}

group('Локальное хранилище');
{
  const directory = mkdtempSync(join(tmpdir(), 'lltasker-store-'));
  const store = createStore(directory);
  check('пустое хранилище даёт настройки по умолчанию', store.read().settings.timezone === DEFAULT_SETTINGS.timezone);
  store.write({ ...store.read(), tasks: [task('x')] });
  check('задачи сохраняются и читаются', store.read().tasks.length === 1 && readFileSync(store.filePath, 'utf8').includes('"x"'));
  check('файл пишется атомарно (временный удалён)', !readdirSync(directory).some((name) => name.endsWith('.tmp')));

  // Битый файл не должен ломать запуск.
  writeFileSync(store.filePath, '{ это не json');
  const recovered = store.read();
  check('битый файл уводится в сторону, приложение стартует', recovered.tasks.length === 0 && readdirSync(directory).some((name) => name.includes('.broken-')));
}
{
  const normalized = normalizeState({ settings: { notifications: 'чушь', digestAt: '25:99' }, tasks: [{ id: 'ok' }, { bad: true }], pending: { deletes: ['z', 5] } });
  check('некорректный режим уведомлений заменяется', normalized.settings.notifications === 'both');
  check('некорректное время дайджеста заменяется', normalized.settings.digestAt === '09:00');
  check('мусор в задачах отфильтрован', normalized.tasks.length === 1 && normalized.tasks[0].id === 'ok');
  check('мусор в очереди удалений отфильтрован', normalized.pending.deletes.join(',') === 'z');
  check('состояние с нуля приводится к первой версии', normalizeState(null).version === 1);
}
{
  const pending = queueUpsert({ upserts: {}, deletes: ['t1'] }, task('t1', { dirty: true }));
  check('постановка в очередь снимает задачу из списка удалений', pending.deletes.length === 0 && Boolean(pending.upserts.t1));
  const afterDelete = queueDelete(pending, 't1');
  check('удаление убирает задачу из очереди отправки', !afterDelete.upserts.t1 && afterDelete.deletes.includes('t1'));
}

console.log('\n' + '='.repeat(52));

group('Правки во время синхронизации не теряются');
{
  // Снимок на старте синхронизации: a и b, без очереди.
  const snapshot = { tasks: [task('a', { due_at: '2026-10-08T10:00:00Z' }), task('b')], pending: { upserts: {}, deletes: [] } };
  // Пока шёл запрос: a перетащили на другой день, появилась новая c, b удалили.
  const current = {
    tasks: [task('a', { due_at: '2026-10-09T10:00:00Z', updated_at: '2026-10-08T12:00:00Z', dirty: true }), task('c', { updated_at: '2026-10-08T12:00:01Z', dirty: true })],
    pending: { upserts: {}, deletes: ['b'] },
  };
  // Облако вернуло старую a и b (оно про правки ещё не знает).
  const fromCloud = [task('a', { due_at: '2026-10-08T10:00:00Z', synced: true, dirty: false }), task('b', { synced: true, dirty: false })];
  const result = reconcileAfterSync(snapshot, current, fromCloud);
  const byId = Object.fromEntries(result.tasks.map((item) => [item.id, item]));
  check('перетаскивание сохранилось (срок не откатился)', byId.a?.due_at === '2026-10-09T10:00:00Z', byId.a?.due_at);
  check('перетащенная задача снова в очереди на отправку', byId.a?.dirty === true && result.pending.upserts.a);
  check('новая задача не пропала', Boolean(byId.c) && Boolean(result.pending.upserts.c));
  check('удалённая во время синхронизации не воскресла', !byId.b && result.pending.deletes.includes('b'));
  check('счётчик изменений: a, c и удаление b', result.changedDuringSync === 3, String(result.changedDuringSync));
}
{
  // Ничего не менялось во время синхронизации — берём ответ облака как есть.
  const snapshot = { tasks: [task('a', { title: 'Старое' })], pending: { upserts: {}, deletes: [] } };
  const current = { tasks: snapshot.tasks, pending: snapshot.pending };
  const fromCloud = [task('a', { title: 'Новое из облака', updated_at: '2026-10-08T13:00:00Z', synced: true })];
  const result = reconcileAfterSync(snapshot, current, fromCloud);
  check('без правок — обновление из облака применяется', result.tasks[0].title === 'Новое из облака');
  check('очередь пуста', Object.keys(result.pending.upserts).length === 0 && result.pending.deletes.length === 0 && result.changedDuringSync === 0);
}

if (failures.length) {
  console.log(`Провалено: ${failures.length}, пройдено: ${passed}`);
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
console.log(`Все проверки пройдены: ${passed}`);
