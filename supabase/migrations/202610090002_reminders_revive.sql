-- LLTasker 0.3.15 — напоминания не «залипают» в cancelled.
-- Проблема: при смене срока/статуса задачи старые напоминания помечаются cancelled, а при возврате
-- к тому же сроку (перетащили и вернули, закрыли и снова открыли, перемерджилось при синхронизации)
-- вставка с тем же ключом попадала в on conflict do nothing — и напоминание уже никогда не отправлялось.
-- Теперь такие строки оживают (pending), а уже отправленные (sent) не трогаем — повторов не будет.

create or replace function public.rebuild_task_reminders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  offset_value integer;
  fire_at_value timestamptz;
  overdue_fire_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    update public.task_reminders
       set status = 'cancelled', lease_until = null, updated_at = now()
     where user_id = old.user_id
       and task_id = old.id
       and status in ('pending', 'sending');
  end if;

  if new.status = 'open' and new.due_at is not null then
    foreach offset_value in array new.remind_offsets loop
      fire_at_value := new.due_at - make_interval(mins => offset_value);
      if fire_at_value > now() then
        insert into public.task_reminders (
          user_id, task_id, due_at, fire_at, offset_minutes, kind, status, next_attempt_at
        ) values (
          new.user_id, new.id, new.due_at, fire_at_value, offset_value::smallint, 'deadline', 'pending', fire_at_value
        )
        on conflict (user_id, task_id, fire_at, offset_minutes, kind) do update
          set status = 'pending', attempts = 0, lease_until = null, last_error = null,
              next_attempt_at = excluded.fire_at, due_at = excluded.due_at, updated_at = now()
          where public.task_reminders.status in ('cancelled', 'failed');
      end if;
    end loop;

    -- Одна мягкая «догоняющая» подсказка через 5 минут после дедлайна.
    overdue_fire_at := new.due_at + interval '5 minutes';
    if overdue_fire_at > now() then
      insert into public.task_reminders (
        user_id, task_id, due_at, fire_at, offset_minutes, kind, status, next_attempt_at
      ) values (
        new.user_id, new.id, new.due_at, overdue_fire_at, '-5'::smallint, 'overdue', 'pending', overdue_fire_at
      )
      on conflict (user_id, task_id, fire_at, offset_minutes, kind) do update
        set status = 'pending', attempts = 0, lease_until = null, last_error = null,
            next_attempt_at = excluded.fire_at, due_at = excluded.due_at, updated_at = now()
        where public.task_reminders.status in ('cancelled', 'failed');
    end if;
  end if;
  return new;
end;
$$;

-- Разовый ремонт: оживить напоминания, которые уже залипли в cancelled у открытых задач с тем же сроком.
update public.task_reminders r
   set status = 'pending', attempts = 0, lease_until = null, last_error = null,
       next_attempt_at = r.fire_at, updated_at = now()
  from public.tasks t
 where t.user_id = r.user_id and t.id = r.task_id
   and t.status = 'open' and t.due_at = r.due_at
   and r.status = 'cancelled'
   and r.fire_at > now()
   and not exists (
     select 1 from public.task_reminders s
      where s.user_id = r.user_id and s.task_id = r.task_id and s.fire_at = r.fire_at
        and s.offset_minutes = r.offset_minutes and s.kind = r.kind and s.status in ('pending', 'sending', 'sent')
        and s.id <> r.id
   );

select count(*) as "оживлено напоминаний" from public.task_reminders where status = 'pending' and updated_at > now() - interval '10 seconds';
