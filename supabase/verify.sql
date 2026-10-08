-- LLTasker — проверка развёртывания.
-- Запускайте блоки по одному в Supabase → SQL Editor → New query.
-- Если блок падает с ошибкой «relation cron.job does not exist» — расширение ещё не включено,
-- это и есть ответ на вопрос (расширения включаются в шаге 2.12 инструкции).

-- ── Блок 1. Схема: таблицы, триггеры, RPC ─────────────────────────────────────
select
  to_regclass('public.profiles') is not null                as "profiles",
  to_regclass('public.tasks') is not null                   as "tasks",
  to_regclass('public.task_reminders') is not null          as "task_reminders",
  to_regclass('public.telegram_accounts') is not null       as "telegram_accounts",
  to_regclass('public.telegram_input_sessions') is not null as "telegram_input_sessions",
  (select count(*) from pg_trigger where tgrelid = to_regclass('public.tasks') and not tgisinternal) as "триггеров на tasks",
  (select relrowsecurity from pg_class where oid = to_regclass('public.tasks'))                       as "RLS на tasks",
  exists (select 1 from pg_proc where proname = 'claim_due_task_reminders') as "RPC напоминаний",
  exists (select 1 from pg_proc where proname = 'claim_due_digests')        as "RPC дайджеста",
  exists (select 1 from pg_proc where proname = 'consume_telegram_pairing_code') as "RPC привязки";
-- Ожидаемо: все true, триггеров 5 (updated_at, статус, напоминания insert/update, повторения), RLS true.

-- ── Блок 2. Данные ────────────────────────────────────────────────────────────
select
  (select count(*) from public.profiles)                                  as профилей,
  (select count(*) from public.profiles where access_status = 'active')    as активных,
  (select count(*) from public.tasks)                                      as задач,
  (select count(*) from public.tasks where status = 'open')                as открытых,
  (select count(*) from public.task_reminders where status = 'pending')    as напоминаний_в_очереди,
  (select count(*) from public.telegram_accounts)                          as привязанных_telegram;

-- ── Блок 3. Ближайшие напоминания ─────────────────────────────────────────────
select
  to_char(r.fire_at at time zone p.timezone, 'DD.MM HH24:MI') as "когда (локально)",
  t.title                                                      as "задача",
  r.offset_minutes                                             as "смещение, мин",
  r.kind,
  r.status
from public.task_reminders r
join public.tasks t on t.user_id = r.user_id and t.id = r.task_id
join public.profiles p on p.id = r.user_id
where r.status = 'pending'
order by r.fire_at
limit 10;

-- ── Блок 4. Профили и привязки ────────────────────────────────────────────────
select
  p.display_name,
  p.access_status,
  p.role,
  p.timezone,
  p.digest_enabled,
  p.digest_at,
  to_char(p.digest_last_sent_at at time zone p.timezone, 'DD.MM HH24:MI') as "дайджест отправлен",
  ta.telegram_username,
  ta.chat_id
from public.profiles p
left join public.telegram_accounts ta on ta.user_id = p.id
order by p.created_at;

-- ── Блок 5. Cron-задание (нужны расширения pg_cron и pg_net) ──────────────────
select jobname, schedule, active, left(command, 60) as "команда"
from cron.job
where jobname = 'lltasker-reminders';
-- Ожидаемо: одна строка, schedule = * * * * *, active = true.

-- ── Блок 6. Журнал запусков cron ──────────────────────────────────────────────
select
  to_char(start_time, 'DD.MM HH24:MI:SS') as "запуск",
  status,
  left(coalesce(return_message, ''), 90)  as "ответ функции"
from cron.job_run_details
order by start_time desc
limit 10;
-- Ожидаемо: каждую минуту status = succeeded и в ответе {"ok":true,"summary":{...}}.
-- Если status = failed — смотрите return_message: чаще всего это несовпадение CRON_SECRET
-- или неверно указанный проект в URL.

-- ── Блок 7. Секрет в Vault ────────────────────────────────────────────────────
select name, description, created_at
from vault.secrets
where name = 'lltasker_cron_secret';
-- Значение не показывается специально: сравнить его можно только на стороне Vault и Edge Secrets.
