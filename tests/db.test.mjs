// Прогон миграции Forge Tasks на настоящем PostgreSQL (PGlite, WASM) без сервера.
// Проверяем: триггеры перестройки напоминаний, повторяющиеся задачи, очередь claim/lease,
// утренний дайджест, одноразовую привязку Telegram и изоляцию RLS.
//
// Запуск:  cd tests && npm install && node db.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const migration = readFileSync(new URL('../supabase/migrations/202610060001_tasks_core.sql', import.meta.url), 'utf8');

let passed = 0;
const failures = [];
function check(name, condition, details = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${details ? ` — ${details}` : ''}`);
    console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`);
  }
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const db = new PGlite();

process.on('uncaughtException', (error) => {
  console.error(`\nОШИБКА БЕЗ ПРОВЕРКИ: ${String(error?.message ?? error).split('\n')[0]}`);
  process.exit(1);
});

// --- Заглушки, которые в Supabase уже есть -------------------------------------
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
`);

console.log('\n== Миграция ==');
await db.exec(migration);
check('миграция применилась целиком', true);
await db.exec(migration);
check('миграция идемпотентна (второй запуск без ошибок)', true);

// --- Пользователь и активация --------------------------------------------------
console.log('\n== Профиль и привязка Telegram ==');
const { rows: userRows } = await db.query(
  `insert into auth.users (email, raw_user_meta_data) values ('ivan@example.com', '{"name":"Иван"}') returning id`
);
const userId = userRows[0].id;
const { rows: profileRows } = await db.query(`select display_name, role, access_status, timezone, digest_at from public.profiles where id = $1`, [userId]);
check('профиль создан триггером на auth.users', profileRows.length === 1);
check('профиль по умолчанию pending/member/Москва', profileRows[0]?.access_status === 'pending' && profileRows[0]?.role === 'member' && profileRows[0]?.timezone === 'Europe/Moscow');

// RLS: пока профиль pending, задачи недоступны
await db.exec(`set role authenticated`);
await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false)`);
const pendingInsert = await db.query(`insert into public.tasks (user_id, id, title) values ($1, 'blocked', 'Не должно вставиться')`, [userId]).then(() => null, (error) => error);
check('RLS не даёт писать задачи до активации аккаунта', pendingInsert !== null);
await db.exec(`reset role`);

// Привязка: код в боте → ввод в приложении
const pairingCode = 'ABCD2345EF';
await db.query(
  `insert into public.telegram_pairing_requests (telegram_user_id, chat_id, telegram_username, first_name, code_hash, expires_at)
   values ('555001', '555001', 'ivan', 'Иван', $1, now() + interval '10 minutes')`,
  [sha256(pairingCode)]
);
const { rows: linked } = await db.query(`select * from public.consume_telegram_pairing_code($1, $2, null)`, [sha256(pairingCode), userId]);
check('код привязки активирует аккаунт', linked.length === 1 && linked[0].linked_telegram_user_id === '555001');
const { rows: activated } = await db.query(`select access_status from public.profiles where id = $1`, [userId]);
check('после привязки access_status = active', activated[0].access_status === 'active');
const reuse = await db.query(`select * from public.consume_telegram_pairing_code($1, $2, null)`, [sha256(pairingCode), userId]).then(() => null, (error) => error);
check('повторное использование кода отклоняется', reuse !== null);

// --- Напоминания ---------------------------------------------------------------
console.log('\n== Очередь напоминаний ==');
await db.query(
  `insert into public.tasks (user_id, id, title, priority, project, due_at, remind_offsets)
   values ($1, 't-pay', 'Оплатить хостинг', 2, 'Работа', now() + interval '2 days', '{1440,60,10}')`,
  [userId]
);
const { rows: reminderRows } = await db.query(
  `select offset_minutes, kind, status, fire_at from public.task_reminders where user_id = $1 and task_id = 't-pay' order by fire_at`,
  [userId]
);
check('на задачу создано 3 напоминания + догоняющая подсказка', reminderRows.length === 4, `получено ${reminderRows.length}`);
check('есть догоняющая подсказка после дедлайна', reminderRows.some((r) => r.kind === 'overdue' && r.offset_minutes === -5));
check('все напоминания в статусе pending', reminderRows.every((r) => r.status === 'pending'));
check('напоминания построены до дедлайна', reminderRows.filter((r) => r.kind === 'deadline').every((r) => new Date(r.fire_at) < new Date(Date.now() + 2 * 86400e3)));

// Перенос дедлайна гасит старые и строит новые
await db.query(`update public.tasks set due_at = now() + interval '5 days' where user_id = $1 and id = 't-pay'`, [userId]);
const { rows: afterMove } = await db.query(
  `select status, count(*)::int as n from public.task_reminders where user_id = $1 and task_id = 't-pay' group by status order by status`,
  [userId]
);
const pendingAfterMove = afterMove.find((r) => r.status === 'pending')?.n ?? 0;
const cancelledAfterMove = afterMove.find((r) => r.status === 'cancelled')?.n ?? 0;
check('после переноса дедлайна старые напоминания отменены', cancelledAfterMove === 4, `cancelled=${cancelledAfterMove}`);
check('после переноса дедлайна созданы новые напоминания', pendingAfterMove === 4, `pending=${pendingAfterMove}`);

// Задача без дедлайна и с пустым набором смещений — напоминаний нет
await db.query(`insert into public.tasks (user_id, id, title, remind_offsets) values ($1, 't-someday', 'Когда-нибудь', '{}')`, [userId]);
const { rows: noReminders } = await db.query(`select count(*)::int as n from public.task_reminders where task_id = 't-someday'`);
check('задача без дедлайна не порождает напоминаний', noReminders[0].n === 0);

// --- Выдача задач через RPC (то, что делает cron) -------------------------------
const { rows: claimed } = await db.query(`select * from public.claim_due_task_reminders(10)`);
check('RPC claim находит только созревшие напоминания', claimed.length === 0, 'только что созданные ещё не должны сработать');

await db.query(`update public.tasks set due_at = now() + interval '30 minutes' where user_id = $1 and id = 't-pay'`, [userId]);
// «Отматываем время»: в реальности оба поля двигает сама очередь, здесь эмулируем наступивший момент.
await db.query(
  `update public.task_reminders set fire_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
    where user_id = $1 and task_id = 't-pay' and status = 'pending' and kind = 'deadline'
      and id = (select id from public.task_reminders where user_id = $1 and task_id = 't-pay' and status = 'pending' and kind = 'deadline' order by fire_at limit 1)`,
  [userId]
);
const { rows: claimed2 } = await db.query(`select * from public.claim_due_task_reminders(10)`);
check('созревшие напоминания выдаются планировщику', claimed2.length === 1, `получено ${claimed2.length}`);
check('в выдаче есть название задачи и chat_id', claimed2[0]?.title === 'Оплатить хостинг' && claimed2[0]?.telegram_chat_id === '555001');
check('в выдаче есть дедлайн и смещение', claimed2[0]?.offset_minutes === 10 && claimed2[0]?.kind === 'deadline' && claimed2[0]?.due_at instanceof Date);
const { rows: claimed3 } = await db.query(`select * from public.claim_due_task_reminders(10)`);
check('повторный claim не отдаёт те же напоминания (лиз)', claimed3.length === 0);
await db.query(`update public.task_reminders set status = 'sent' where status = 'sending'`);

// Отменённое напоминание не отправляется
await db.query(`update public.task_reminders set status = 'cancelled' where status = 'pending'`);
const { rows: claimed4 } = await db.query(`select * from public.claim_due_task_reminders(10)`);
check('отменённые напоминания в выдачу не попадают', claimed4.length === 0);

// --- Просрочка и напоминание после дедлайна ------------------------------------
console.log('\n== Просрочка ==');
await db.query(`update public.tasks set due_at = now() + interval '1 minute' where user_id = $1 and id = 't-pay'`, [userId]);
const { rows: overdueScheduled } = await db.query(
  `select offset_minutes, fire_at - due_at as after_deadline from public.task_reminders
    where user_id = $1 and task_id = 't-pay' and status = 'pending' and kind = 'overdue'`,
  [userId]
);
check('догоняющая подсказка планируется через 5 минут после дедлайна', overdueScheduled.length === 1 && overdueScheduled[0].offset_minutes === -5);
await db.query(
  `update public.task_reminders set fire_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second'
    where user_id = $1 and task_id = 't-pay' and status = 'pending' and kind = 'overdue'`,
  [userId]
);
const { rows: overdueClaim } = await db.query(`select * from public.claim_due_task_reminders(10)`);
check('догоняющая подсказка уходит после дедлайна', overdueClaim.length === 1 && overdueClaim[0].kind === 'overdue' && overdueClaim[0].offset_minutes === -5);
await db.query(`update public.task_reminders set status = 'sent' where status = 'sending'`);

// Задача, которую закрыли, не отправляет напоминания
await db.query(`update public.tasks set due_at = now() + interval '20 minutes' where user_id = $1 and id = 't-pay'`, [userId]);
await db.query(`update public.tasks set status = 'done' where user_id = $1 and id = 't-pay'`, [userId]);
const { rows: afterDone } = await db.query(`select count(*)::int as n from public.task_reminders where task_id = 't-pay' and status in ('pending','sending')`);
check('закрытие задачи гасит её напоминания', afterDone[0].n === 0);
const { rows: completedAt } = await db.query(`select completed_at from public.tasks where user_id = $1 and id = 't-pay'`, [userId]);
check('completed_at выставляется автоматически', completedAt[0].completed_at !== null);

// --- Повторяющиеся задачи -------------------------------------------------------
console.log('\n== Повторения ==');
await db.query(
  `insert into public.tasks (user_id, id, title, due_at, recurrence, remind_offsets)
   values ($1, 't-standup', 'Стендап', date_trunc('day', now()) + interval '10 hours', 'weekly', '{60}')`,
  [userId]
);
await db.query(`update public.tasks set status = 'done' where user_id = $1 and id = 't-standup'`, [userId]);
const { rows: series } = await db.query(
  `select id, occurrence, status, due_at, recurrence, series_id from public.tasks where user_id = $1 and title = 'Стендап' order by occurrence`,
  [userId]
);
check('при закрытии создаётся следующее вхождение', series.length === 2, `вхождений: ${series.length}`);
check('вхождение 2 открыто и с дедлайном +7 дней', series[1]?.status === 'open' && series[1]?.occurrence === 2 && series[1]?.recurrence === 'weekly');
check('оба вхождения связаны общим series_id', series[0].series_id === series[0].id && series[1].series_id === series[0].id);
const { rows: nextDue } = await db.query(
  `select due_at, lag_days from (
     select due_at, extract(epoch from (due_at - lag(due_at) over (order by occurrence))) / 86400 as lag_days
       from public.tasks where user_id = $1 and title = 'Стендап'
   ) s order by due_at`,
  [userId]
);
check('шаг повторения ровно 7 дней', Math.abs(Number(nextDue[1].lag_days) - 7) < 0.01, `шаг=${nextDue[1].lag_days}`);
const { rows: spawnedReminders } = await db.query(
  `select count(*)::int as n from public.task_reminders r join public.tasks t on t.user_id = r.user_id and t.id = r.task_id
    where t.title = 'Стендап' and t.occurrence = 2 and r.status = 'pending'`,
  []
);
check('у нового вхождения своя очередь напоминаний', spawnedReminders[0].n >= 1);
await db.query(`update public.tasks set status = 'done' where user_id = $1 and id = $2`, [userId, series[1]?.id ?? 't-standup']);
const { rows: seriesAfter } = await db.query(`select count(*)::int as n from public.tasks where user_id = $1 and title = 'Стендап'`, [userId]);
check('повторное закрытие не создаёт дублей', seriesAfter[0].n === 3, `вхождений: ${seriesAfter[0].n}`);

// Будни: пропуск выходных
await db.query(
  `insert into public.tasks (user_id, id, title, due_at, recurrence)
   values ($1, 't-workdays', 'Отчёт', timestamptz '2026-10-09 18:00:00+03', 'weekdays')`,
  [userId]
);
await db.query(`update public.tasks set status = 'done' where user_id = $1 and id = 't-workdays'`, [userId]);
const { rows: weekdayNext } = await db.query(
  `select to_char(due_at at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI Dy') as local_due from public.tasks
    where user_id = $1 and title = 'Отчёт' and status = 'open'`,
  [userId]
);
check('будни: пятница → понедельник', weekdayNext[0]?.local_due?.startsWith('2026-10-12 18:00'), `получено ${weekdayNext[0]?.local_due}`);

// --- Утренний дайджест ---------------------------------------------------------
console.log('\n== Утренний дайджест ==');
const digestReady = (id) => db.query(
  `update public.profiles set digest_at = '00:05', digest_enabled = true, digest_last_sent_at = null,
          digest_attempts = 0, digest_next_attempt_at = now() where id = $1`,
  [id]
);
const addTelegram = (id, tgId) => db.query(
  `insert into public.telegram_accounts (user_id, telegram_user_id, chat_id) values ($1, $2, $2)`,
  [id, tgId]
);

await digestReady(userId);
await db.query(`insert into public.tasks (user_id, id, title, due_at, remind_offsets) values ($1, 't-today', 'Позвонить в банк', now() - interval '1 hour', '{10}')`, [userId]);
const { rows: digest1 } = await db.query(`select * from public.claim_due_digests(10)`);
check(
  'дайджест выдаётся один раз в локальный день',
  digest1.length === 1 && digest1[0].due_today >= 1 && digest1[0].local_date instanceof Date,
  JSON.stringify(digest1[0] ?? {})
);
const { rows: digest2 } = await db.query(`select * from public.claim_due_digests(10)`);
check('повторный вызов дайджеста в тот же день пуст', digest2.length === 0);
await db.query(`update public.profiles set digest_last_sent_at = now(), digest_attempts = 0 where id = $1`, [userId]);
const { rows: digest3 } = await db.query(`select * from public.claim_due_digests(10)`);
check('после отправки дайджест за день закрыт', digest3.length === 0);
await db.query(`update public.profiles set digest_last_sent_at = now() - interval '1 day', digest_next_attempt_at = now() where id = $1`, [userId]);
const { rows: digest4 } = await db.query(`select * from public.claim_due_digests(10)`);
check('на следующий день дайджест снова уходит', digest4.length === 1);
await db.query(`update public.profiles set digest_enabled = false, digest_last_sent_at = now() - interval '1 day' where id = $1`, [userId]);
const { rows: digest5 } = await db.query(`select * from public.claim_due_digests(10)`);
check('выключенный дайджест не отправляется', digest5.length === 0);

// Профиль только с просроченной задачей
const { rows: overdueUser } = await db.query(`insert into auth.users (email) values ('overdue@example.com') returning id`);
await db.query(`update public.profiles set access_status = 'active' where id = $1`, [overdueUser[0].id]);
await addTelegram(overdueUser[0].id, '999002');
await digestReady(overdueUser[0].id);
await db.query(`insert into public.tasks (user_id, id, title, due_at) values ($1, 'late', 'Просроченное дело', now() - interval '2 days')`, [overdueUser[0].id]);
const { rows: overdueDigest } = await db.query(`select * from public.claim_due_digests(10)`);
check(
  'просроченные задачи попадают в дайджест как overdue',
  overdueDigest.length === 1 && overdueDigest[0].overdue === 1 && overdueDigest[0].due_today === 0,
  JSON.stringify(overdueDigest[0] ?? {})
);

// Профиль, у которого на сегодня ничего нет
const { rows: emptyUser } = await db.query(`insert into auth.users (email) values ('empty@example.com') returning id`);
await db.query(`update public.profiles set access_status = 'active' where id = $1`, [emptyUser[0].id]);
await addTelegram(emptyUser[0].id, '999003');
await digestReady(emptyUser[0].id);
await db.query(`insert into public.tasks (user_id, id, title, due_at) values ($1, 'later', 'На следующей неделе', now() + interval '5 days')`, [emptyUser[0].id]);
const { rows: emptyDigest } = await db.query(`select * from public.claim_due_digests(10)`);
check('без задач на сегодня дайджест молчит', emptyDigest.length === 0, JSON.stringify(emptyDigest));

// --- Изоляция данных и настройки профиля ---------------------------------------
console.log('\n== Изоляция RLS ==');
const { rows: otherUser } = await db.query(`insert into auth.users (email) values ('petr@example.com') returning id`);
await db.query(`update public.profiles set access_status = 'active' where id = $1`, [otherUser[0].id]);
await db.query(`insert into public.tasks (user_id, id, title) values ($1, 'p-1', 'Чужая задача')`, [otherUser[0].id]);

await db.exec(`set role authenticated`);
await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false)`);
const { rows: ownTasks } = await db.query(`select title from public.tasks`);
check('пользователь видит только свои задачи', ownTasks.every((t) => t.title !== 'Чужая задача') && ownTasks.length > 0);
const crossRead = await db.query(`select * from public.tasks where user_id = $1`, [otherUser[0].id]);
check('прямой запрос чужих задач отдаёт пусто', crossRead.rows.length === 0);
await db.query(`update public.profiles set display_name = 'Иван П.' where id = $1`, [userId]);
const roleEscalation = await db.query(`update public.profiles set role = 'owner' where id = $1`, [userId]).then(() => null, (error) => error);
check('пользователь не может выдать себе роль owner', roleEscalation !== null);
const selfActivation = await db.query(`update public.profiles set access_status = 'active' where id = $1`, [userId]).then(() => null, (error) => error);
check('пользователь не может сам менять access_status', selfActivation !== null);
const reminderWrite = await db.query(`update public.task_reminders set status = 'sent'`).then(() => null, (error) => error);
check('клиент не может править очередь напоминаний', reminderWrite !== null);
await db.exec(`reset role`);

// --- Итог ----------------------------------------------------------------------
console.log(`\n${'='.repeat(52)}`);
if (failures.length) {
  console.log(`Провалено: ${failures.length}, пройдено: ${passed}`);
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
console.log(`Все проверки пройдены: ${passed}`);
process.exit(0);
