-- 0.3.6: напоминания — любое смещение от 1 минуты до 14 дней (ползунок в карточке) вместо фиксированного списка.
-- Значение -5 остаётся служебным (подсказка через 5 минут после срока). По умолчанию — за 30 и за 5 минут.

create or replace function public.remind_offsets_ok(offsets smallint[])
returns boolean
language sql
immutable
as $$
  select coalesce(bool_and((v between 1 and 20160) or v = -5), true)
  from unnest(offsets) as v;
$$;

alter table public.tasks drop constraint if exists tasks_remind_offsets_check;
alter table public.tasks
  add constraint tasks_remind_offsets_check
  check (cardinality(remind_offsets) <= 6 and public.remind_offsets_ok(remind_offsets));

alter table public.tasks alter column remind_offsets set default '{30,5}';

comment on column public.tasks.remind_offsets is 'Минуты до дедлайна (1…20160) или -5 — подсказка после дедлайна.';
