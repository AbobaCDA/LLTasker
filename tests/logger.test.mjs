// Тесты журнала действий. Запуск: node tests/logger.test.mjs
import { createLogger, describeChanges, describeTask } from '../desktop/logger.js';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
function check(name, condition, details = '') {
  if (condition) passed += 1;
  else { failures.push(name); console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`); }
}
const group = (title) => console.log(`\n== ${title} ==`);

group('Запись и чтение');
{
  const dir = join(mkdtempSync(join(tmpdir(), 'lltasker-log-')), 'logs');
  let now = new Date(2026, 9, 8, 15, 4, 9);
  const logger = createLogger(dir, { now: () => now });
  logger.log('задача добавлена', '«Позвонить в банк» · завтра 10:00');
  logger.log('строка с\nпереводом\tи табом', 'x');
  const files = readdirSync(dir);
  check('файл за день создан', files.includes('actions-2026-10-08.log'), files.join(','));
  const text = readFileSync(join(dir, 'actions-2026-10-08.log'), 'utf8');
  check('время с секундами', text.startsWith('2026-10-08 15:04:09\t'), text.slice(0, 25));
  check('событие и подробности через табуляцию', text.includes('\tзадача добавлена\t«Позвонить в банк» · завтра 10:00\n'));
  check('переводы строк внутри события убраны', text.split('\n').filter(Boolean).length === 2);
  const tail = logger.tail(10);
  check('tail возвращает строки', tail.length === 2 && tail[0].includes('задача добавлена'));

  // Следующий день — новый файл; вчерашний тоже попадает в tail.
  now = new Date(2026, 9, 9, 9, 0, 0);
  logger.log('приложение запущено');
  check('новый день — новый файл', readdirSync(dir).includes('actions-2026-10-09.log'));
  check('tail склеивает вчера и сегодня', logger.tail(10).length === 3);
  check('tail ограничивает количество', logger.tail(1).length === 1 && logger.tail(1)[0].includes('приложение запущено'));
  check('currentFile — сегодняшний', logger.currentFile().endsWith('actions-2026-10-09.log'));

  // Старые файлы чистятся (старше 30 дней).
  writeFileSync(join(dir, 'actions-2026-08-01.log'), 'old\n');
  writeFileSync(join(dir, 'notes.txt'), 'keep\n');
  now = new Date(2026, 9, 10, 9, 0, 0);
  logger.log('ещё событие');
  const after = readdirSync(dir);
  check('старый журнал удалён', !after.includes('actions-2026-08-01.log'), after.join(','));
  check('чужие файлы не трогаем', after.includes('notes.txt'));
  check('свежие журналы на месте', after.includes('actions-2026-10-08.log') && after.includes('actions-2026-10-10.log'));
}

group('Описание изменений');
{
  const formatDue = (iso, allDay) => (allDay ? `день ${iso.slice(0, 10)}` : iso.slice(0, 16));
  const before = { title: 'A', due_at: null, all_day: false, status: 'open', priority: 1, project: null, recurrence: null, notes: '', tags: [], remind_offsets: [60], sort_order: 0 };
  const after = { ...before, title: 'B', due_at: '2026-10-09T10:00:00Z', status: 'done', priority: 3, project: 'дом', remind_offsets: [], sort_order: 20 };
  const changes = describeChanges(before, after, formatDue);
  check('название', changes.some((c) => c.startsWith('название: «A» → «B»')), changes.join(' | '));
  check('срок', changes.some((c) => c === 'срок: без срока → 2026-10-09T10:00'));
  check('статус по-русски', changes.some((c) => c === 'статус: в работе → выполнена'));
  check('приоритет', changes.some((c) => c === 'приоритет: 1 → 3'));
  check('проект', changes.some((c) => c === 'проект: — → дом'));
  check('напоминания выключены', changes.some((c) => c === 'напоминания: выключены мин'));
  check('порядок', changes.includes('порядок в списке'));
  check('без изменений — пустой список', describeChanges(before, { ...before }, formatDue).length === 0);
  check('describeTask', describeTask({ title: 'Купить\nхлеб' }) === '«Купить хлеб»');
}

console.log('\n====================================================');
if (failures.length) { console.log(`Провалено: ${failures.length}`); process.exit(1); }
console.log(`Все проверки пройдены: ${passed}`);
