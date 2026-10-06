// Тесты планировщика локальных напоминаний. Запуск: node tests/reminders.test.mjs
import { computeUpcomingReminders, reminderKey, notificationText, overdueTasks } from '../desktop/reminders.js';

let passed = 0;
const failures = [];
function check(name, condition, details = '') {
  if (condition) passed += 1;
  else { failures.push(`${name}${details ? ` — ${details}` : ''}`); console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`); }
}
const group = (title) => console.log(`\n== ${title} ==`);

const NOW = new Date('2026-10-06T06:00:00Z'); // 09:00 по Москве
const inMinutes = (minutes) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const task = (extra = {}) => ({
  id: 't1', title: 'Оплатить хостинг', status: 'open', project: 'работа', all_day: false,
  remind_offsets: [1440, 60, 10], due_at: inMinutes(120), ...extra,
});

group('Что покажет Windows');
{
  const reminders = computeUpcomingReminders([task()], { now: NOW });
  const deadline = reminders.filter((item) => item.kind === 'deadline');
  check('будущие напоминания по смещениям построены', deadline.length === 2 && deadline.map((item) => item.offset).join(',') === '60,10', JSON.stringify(deadline.map((item) => item.offset)));
  check('плюс одна подсказка после дедлайна', reminders.length === 3, `получено ${reminders.length}`);
  check('сортировка по времени срабатывания', reminders[0].fireAt < reminders[1].fireAt);
  check('напоминание за час срабатывает раньше напоминания за 10 минут', reminders[0].offset === 60 && reminders[1].offset === 10);
  check('прошедшие моменты не планируются (за сутки уже прошло)', !reminders.some((item) => item.offset === 1440));
  check('подсказка после дедлайна добавлена', reminders.some((item) => item.kind === 'overdue' && item.offset === -5));
}
{
  const fired = [reminderKey(task(), 10)];
  const reminders = computeUpcomingReminders([task()], { now: NOW, fired });
  check('уже показанное напоминание не повторяется', !reminders.some((item) => item.offset === 10), JSON.stringify(reminders.map((item) => item.offset)));
}
{
  const far = task({ due_at: inMinutes(60 * 24 * 30) });
  const reminders = computeUpcomingReminders([far], { now: NOW, horizonHours: 24 });
  check('за горизонтом планирования ничего не берём', reminders.length === 0, `получено ${reminders.length}`);
  const longHorizon = computeUpcomingReminders([far], { now: NOW, horizonHours: 24 * 40 });
  check('на длинном горизонте напоминания есть', longHorizon.length >= 1);
}
{
  const closed = task({ status: 'done' });
  check('закрытая задача не напоминает', computeUpcomingReminders([closed], { now: NOW }).length === 0);
  const noDate = task({ due_at: null });
  check('задача без срока не напоминает', computeUpcomingReminders([noDate], { now: NOW }).length === 0);
  const muted = task({ remind_offsets: [] });
  const mutedReminders = computeUpcomingReminders([muted], { now: NOW });
  check('выключенные напоминания: остаётся только подсказка после дедлайна', mutedReminders.length === 1 && mutedReminders[0].kind === 'overdue');
  const badOffsets = task({ remind_offsets: [999, 60] });
  check('недопустимые смещения игнорируются', computeUpcomingReminders([badOffsets], { now: NOW }).every((item) => item.offset !== 999));
}
{
  const reminders = computeUpcomingReminders([task({ due_at: inMinutes(-3) })], { now: NOW });
  check('просроченная задача даёт подсказку сразу', reminders.some((item) => item.kind === 'overdue') || reminders.length === 0);
  const overdue = overdueTasks([task({ due_at: inMinutes(-30) }), task({ id: 't2', due_at: inMinutes(60) })], NOW);
  check('в просроченные попадают только прошедшие сроки', overdue.length === 1 && overdue[0].id === 't1');
  check('закрытые задачи не считаются просроченными', overdueTasks([task({ due_at: inMinutes(-30), status: 'done' })], NOW).length === 0);
}
{
  const key = reminderKey(task(), 60);
  check('ключ дедупликации содержит задачу, срок и смещение', key === `t1:${task().due_at}:60`, key);
  const text = notificationText({ kind: 'deadline', title: 'Оплатить хостинг' }, 'завтра 19:00', 'работа');
  check('текст уведомления про напоминание', text.title.startsWith('Напоминание:') && text.body.includes('завтра 19:00') && text.body.includes('#работа'), JSON.stringify(text));
  const late = notificationText({ kind: 'overdue', title: 'Отчёт' }, 'сегодня 10:00', null);
  check('текст уведомления про просрочку', late.title.startsWith('Дедлайн прошёл:') && !late.body.includes('#'), JSON.stringify(late));
}
{
  const many = computeUpcomingReminders([task(), task({ id: 't2', due_at: inMinutes(300) })], { now: NOW, limit: 2 });
  check('лимит соблюдается', many.length === 2);
}

console.log('\n' + '='.repeat(52));
if (failures.length) {
  console.log(`Провалено: ${failures.length}, пройдено: ${passed}`);
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
console.log(`Все проверки пройдены: ${passed}`);
