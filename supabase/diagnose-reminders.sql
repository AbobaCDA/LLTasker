-- LLTasker — почему не приходят напоминания в Telegram.
-- Supabase → SQL Editor → New query. Запускайте блоки по одному, сверху вниз.

-- ── Блок A. Общая картина одним запросом ──────────────────────────────────────
select
  (select count(*) from public.profiles where access_status = 'active')          as "активных профилей",
  (select count(*) from public.telegram_accounts)                                 as "привязок Telegram",
  (select count(*) from public.tasks where status = 'open' and due_at is not null) as "открытых задач со сроком",
  (select count(*) from public.task_reminders where status = 'pending')           as "напоминаний в очереди",
  (select count(*) from public.task_reminders where status = 'sent')              as "отправлено всего",
  (select count(*) from public.task_reminders where status = 'failed')            as "провалено",
  (select count(*) from cron.job where jobname = 'lltasker-reminders' and active) as "cron-задание активно (1 = да)",
  (select count(*) from vault.secrets where name = 'lltasker_cron_secret')        as "секрет в Vault (1 = да)";
-- Если «привязок Telegram» = 0 — бот не привязан: в приложении Настройки → код → боту /start <код>.
-- Если «открытых задач со сроком» = 0, а в приложении они есть — задачи не долетают в облако (нет входа / оффлайн).
-- Если «напоминаний в очереди» = 0 при задачах со сроком — не отработал триггер (см. блок D).

-- ── Блок A2. Применена ли миграция 0.3.6 (диапазон напоминаний) ───────────────
select exists (select 1 from pg_proc where proname = 'remind_offsets_ok') as "миграция remind_offsets_range применена";
-- false — выполните supabase/migrations/202610090001_remind_offsets_range.sql в SQL Editor:
-- без неё задачи с напоминаниями не из списка 5/15/30/60/… не проходят в облако (ошибка check constraint),
-- а значит и напоминаний по ним нет.

-- ── Блок B. Что реально происходило в последние 15 минут: ответы функции send-reminders ──
select
  to_char(created, 'DD.MM HH24:MI:SS') as "когда",
  status_code                           as "HTTP",
  left(coalesce(content, error_msg, ''), 160) as "ответ"
from net._http_response
order by id desc
limit 10;
-- Ожидаемо: раз в минуту HTTP 200 и {"ok":true,...}.
-- 401 — не совпадают CRON_SECRET (Edge Secrets) и lltasker_cron_secret (Vault).
-- 404 — функция send-reminders не задеплоена или другой проект в URL cron-задания.
-- 500 — смотреть Edge Functions → send-reminders → Logs.
-- Пусто — cron не стреляет: смотрите блок C.

-- ── Блок C. Журнал cron ────────────────────────────────────────────────────────
select to_char(start_time, 'DD.MM HH24:MI:SS') as "запуск", status, left(coalesce(return_message, ''), 80) as "сообщение"
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'lltasker-reminders')
order by start_time desc
limit 5;
-- Ожидаемо: каждую минуту succeeded (return_message — номер запроса pg_net, это нормально).

-- ── Блок D. Последние напоминания с причинами ─────────────────────────────────
select
  t.title                                                        as "задача",
  to_char(t.due_at at time zone p.timezone, 'DD.MM HH24:MI')       as "срок",
  r.offset_minutes                                               as "за, мин",
  to_char(r.fire_at at time zone p.timezone, 'DD.MM HH24:MI')      as "отправить в",
  r.status,
  r.attempts,
  left(coalesce(r.last_error, ''), 80)                           as "ошибка",
  p.access_status                                                as "профиль",
  ta.chat_id is not null                                         as "есть Telegram"
from public.task_reminders r
join public.tasks t on t.user_id = r.user_id and t.id = r.task_id
join public.profiles p on p.id = r.user_id
left join public.telegram_accounts ta on ta.user_id = r.user_id
order by r.fire_at desc
limit 15;
-- «профиль» должен быть active, «есть Telegram» — true, иначе функция такие напоминания не берёт.

-- ── Блок E. Тест: дёрнуть функцию вручную прямо сейчас ───────────────────────
select net.http_post(
  url := 'https://stvcucfgvbvihsnxsrte.supabase.co/functions/v1/send-reminders',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'lltasker_cron_secret' limit 1)
  ),
  body := '{}'::jsonb
) as "номер запроса";
-- Подождите 5 секунд и повторите блок B: сверху должна появиться строка с HTTP 200.

-- ── Блок F. Тест доставки: созревшее напоминание по существующей задаче ───────
-- Берёт первую открытую задачу со сроком и ставит ей напоминание «на сейчас».
-- Через минуту (следующий запуск cron) в Telegram должно прийти сообщение.
insert into public.task_reminders (user_id, task_id, due_at, fire_at, offset_minutes, kind, status)
select user_id, id, due_at, now(), 1, 'deadline', 'pending'
from public.tasks
where status = 'open' and due_at is not null
order by due_at
limit 1
on conflict do nothing
returning task_id as "задача", fire_at as "отправить в";
-- Если вернулось 0 строк — нет открытых задач со сроком в облаке (см. блок A).
-- Проверить результат через минуту: блок D — статус sent и время отправки.


-- ── Блок G. Что случилось с конкретной задачей (подставьте часть названия) ────
select t.title, t.status as "задача", to_char(t.due_at at time zone p.timezone, 'DD.MM HH24:MI') as "срок",
       r.offset_minutes as "за, мин", to_char(r.fire_at at time zone p.timezone, 'DD.MM HH24:MI') as "отправить в",
       r.status, r.attempts, left(coalesce(r.last_error, ''), 80) as "ошибка", to_char(r.updated_at at time zone p.timezone, 'DD.MM HH24:MI:SS') as "изменено"
from public.tasks t
join public.profiles p on p.id = t.user_id
left join public.task_reminders r on r.user_id = t.user_id and r.task_id = t.id
where t.title ilike '%Дифы%'
order by r.fire_at;
-- Нет строк вообще — задача не долетела в облако (в приложении нет входа или синхронизация в ошибке).
-- status = cancelled при открытой задаче с тем же сроком — «залипшее» напоминание: выполните
--   supabase/migrations/202610090002_reminders_revive.sql (чинит на будущее и оживляет текущие).
-- status = pending с attempts > 0 и ошибкой — проблема доставки (токен бота / chat_id), смотрите текст ошибки.
