-- Forge Tasks — ядро схемы: профили, задачи, очередь напоминаний, привязка Telegram.
-- Применять в Supabase SQL Editor. Файл безопасно запускать повторно.
--
-- Отличия от LTT: вместо персонажей и «смен» — задачи с дедлайном, набором смещений
-- напоминаний и повторениями. Механика очереди уведомлений (claim + lease + attempts)
-- сохранена один в один, чтобы доставка не дублировалась при параллельных запусках cron.

-- gen_random_uuid() доступен в ядре PostgreSQL 13+, отдельные расширения не нужны.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'member' check (role in ('owner', 'member')),
  access_status text not null default 'pending' check (access_status in ('pending', 'active', 'suspended')),
  timezone text not null default 'Europe/Moscow',
  digest_enabled boolean not null default true,
  digest_at time not null default '09:00',
  digest_last_sent_at timestamptz,
  digest_attempts smallint not null default 0,
  digest_next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  user_id uuid not null references public.profiles(id) on delete cascade,
  id text not null check (length(id) between 1 and 64),
  title text not null check (length(trim(title)) between 1 and 200),
  notes text not null default '' check (length(notes) <= 4000),
  priority smallint not null default 1 check (priority between 0 and 3),
  project text check (project is null or length(trim(project)) between 1 and 60),
  tags text[] not null default '{}',
  due_at timestamptz,
  all_day boolean not null default false,
  remind_offsets smallint[] not null default '{1440,60,10}',
  status text not null default 'open' check (status in ('open', 'done', 'archived')),
  completed_at timestamptz,
  recurrence text check (recurrence is null or recurrence in ('daily', 'weekly', 'weekdays', 'monthly')),
  series_id text,
  occurrence integer not null default 1 check (occurrence between 1 and 1000),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint tasks_completed_at_check check (
    (status = 'done' and completed_at is not null)
    or (status <> 'done' and completed_at is null)
  ),
  constraint tasks_remind_offsets_check check (
    cardinality(remind_offsets) <= 6
    and remind_offsets <@ array[20160, 10080, 4320, 1440, 720, 360, 180, 60, 30, 15, 10, 5, -5]::smallint[]
  )
);

create index if not exists tasks_user_status_due_idx
  on public.tasks (user_id, status, due_at);

-- Снимок дедлайна на момент планирования: due_at задачи меняется — напоминание отменяется.
create table if not exists public.task_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  task_id text not null,
  due_at timestamptz not null,
  fire_at timestamptz not null,
  offset_minutes smallint not null,
  kind text not null default 'deadline' check (kind in ('deadline', 'overdue')),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_reminders_task_fk
    foreign key (user_id, task_id)
    references public.tasks(user_id, id)
    on delete cascade,
  constraint task_reminders_once_per_fire
    unique (user_id, task_id, fire_at, offset_minutes, kind)
);

create index if not exists task_reminders_due_idx
  on public.task_reminders (fire_at, next_attempt_at)
  where status = 'pending';

create table if not exists public.telegram_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text not null,
  chat_id text not null,
  telegram_username text,
  first_name text not null default '',
  code_hash text not null unique check (length(code_hash) = 64),
  status text not null default 'pending' check (status in ('pending', 'approved', 'consumed', 'rejected', 'expired')),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  linked_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists telegram_pairing_requests_pending_idx
  on public.telegram_pairing_requests (created_at desc)
  where status = 'pending';
create index if not exists telegram_pairing_requests_tg_idx
  on public.telegram_pairing_requests (telegram_user_id, created_at desc);

create table if not exists public.telegram_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  telegram_user_id text not null unique,
  chat_id text not null unique,
  telegram_username text,
  linked_at timestamptz not null default now()
);

-- Короткоживущее состояние диалога в боте: быстрый ввод «/add текст» и ручная дата.
create table if not exists public.telegram_input_sessions (
  telegram_user_id text primary key,
  chat_id text not null,
  mode text not null check (mode in ('add_task', 'set_due', 'set_recurrence')),
  task_id text,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.validate_profile_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'UNKNOWN_TIMEZONE';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists profiles_validate_timezone on public.profiles;
create trigger profiles_validate_timezone
before insert or update of timezone on public.profiles
for each row execute function public.validate_profile_timezone();

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

drop trigger if exists task_reminders_set_updated_at on public.task_reminders;
create trigger task_reminders_set_updated_at
before update on public.task_reminders
for each row execute function public.set_updated_at();

-- completed_at всегда согласован со статусом: клиенту не нужно помнить про него.
create or replace function public.normalize_task_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' then
    new.completed_at = coalesce(new.completed_at, now());
  else
    new.completed_at = null;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_normalize_status on public.tasks;
create trigger tasks_normalize_status
before insert or update on public.tasks
for each row execute function public.normalize_task_status();

-- Перестройка очереди: гасим несработавшие напоминания задачи и строим новые
-- по актуальному дедлайну и набору смещений. Дедлайн в прошлом — напоминаний нет.
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
        on conflict (user_id, task_id, fire_at, offset_minutes, kind) do nothing;
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
      on conflict (user_id, task_id, fire_at, offset_minutes, kind) do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_schedule_reminders_insert on public.tasks;
create trigger tasks_schedule_reminders_insert
after insert on public.tasks
for each row execute function public.rebuild_task_reminders();

drop trigger if exists tasks_schedule_reminders_update on public.tasks;
create trigger tasks_schedule_reminders_update
after update of due_at, remind_offsets, status on public.tasks
for each row
when (
  old.due_at is distinct from new.due_at
  or old.remind_offsets is distinct from new.remind_offsets
  or old.status is distinct from new.status
)
execute function public.rebuild_task_reminders();

-- Повторяющиеся задачи: следующее вхождение создаётся в момент закрытия текущего.
-- Дата считается в часовом поясе пользователя, чтобы «09:00» не сползало.
create or replace function public.spawn_next_occurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  user_timezone text;
  local_due timestamp;
  next_local timestamp;
  next_due timestamptz;
  dow integer;
  new_id text;
begin
  if new.status <> 'done' or old.status = 'done' or new.recurrence is null or new.due_at is null then
    return new;
  end if;

  select coalesce(p.timezone, 'Europe/Moscow') into user_timezone
    from public.profiles p where p.id = new.user_id;

  if exists (
    select 1 from public.tasks t
     where t.user_id = new.user_id
       and t.series_id = coalesce(new.series_id, new.id)
       and t.occurrence = new.occurrence + 1
  ) then
    return new;
  end if;

  local_due := new.due_at at time zone user_timezone;
  next_local := case new.recurrence
    when 'daily' then local_due + interval '1 day'
    when 'weekly' then local_due + interval '7 days'
    when 'monthly' then local_due + interval '1 month'
    when 'weekdays' then local_due + interval '1 day'
  end;

  if new.recurrence = 'weekdays' then
    loop
      dow := extract(isodow from next_local)::integer;
      exit when dow <= 5;
      next_local := next_local + interval '1 day';
    end loop;
  end if;

  next_due := next_local at time zone user_timezone;
  new_id := replace(gen_random_uuid()::text, '-', '');

  insert into public.tasks (
    user_id, id, title, notes, priority, project, tags, due_at, all_day,
    remind_offsets, status, recurrence, series_id, occurrence, sort_order
  ) values (
    new.user_id, new_id, new.title, new.notes, new.priority, new.project, new.tags,
    next_due, new.all_day, new.remind_offsets, 'open', new.recurrence,
    coalesce(new.series_id, new.id), new.occurrence + 1, new.sort_order
  );

  update public.tasks
     set series_id = coalesce(new.series_id, new.id)
   where user_id = new.user_id and id = new.id and series_id is null;

  return new;
end;
$$;

drop trigger if exists tasks_spawn_occurrence on public.tasks;
create trigger tasks_spawn_occurrence
after update of status on public.tasks
for each row
when (new.status = 'done' and old.status <> 'done')
execute function public.spawn_next_occurrence();

-- Одноразовый код из бота превращается в привязку аккаунта и активирует облако.
-- Вызывается только Edge Function с серверным ключом.
create or replace function public.consume_telegram_pairing_code(
  p_code_hash text,
  p_user_id uuid,
  p_owner_telegram_id text default null
)
-- Имена выходных колонок намеренно не совпадают с именами колонок таблиц:
-- это защищает функцию от ошибки «column reference is ambiguous».
returns table (linked_telegram_user_id text, linked_chat_id text, linked_telegram_username text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.telegram_pairing_requests%rowtype;
begin
  if p_user_id is null or not exists (
    select 1 from public.profiles where id = p_user_id and access_status <> 'suspended'
  ) then
    raise exception 'ACCOUNT_NOT_AVAILABLE';
  end if;

  select * into request_row
    from public.telegram_pairing_requests
   where code_hash = p_code_hash
     and status in ('pending', 'approved')
     and expires_at > now()
     and consumed_at is null
   for update;

  if not found then
    raise exception 'PAIRING_CODE_INVALID_EXPIRED_OR_NOT_APPROVED';
  end if;

  if exists (select 1 from public.telegram_accounts ta where ta.user_id = p_user_id)
     or exists (select 1 from public.telegram_accounts ta where ta.telegram_user_id = request_row.telegram_user_id) then
    raise exception 'TELEGRAM_ACCOUNT_ALREADY_LINKED';
  end if;

  insert into public.telegram_accounts (user_id, telegram_user_id, chat_id, telegram_username)
  values (p_user_id, request_row.telegram_user_id, request_row.chat_id, request_row.telegram_username);

  update public.telegram_pairing_requests
     set status = 'consumed', consumed_at = now(), approved_at = coalesce(approved_at, now()), linked_user_id = p_user_id
   where id = request_row.id;

  update public.profiles
     set role = case
       when nullif(p_owner_telegram_id, '') is not null
        and request_row.telegram_user_id = nullif(p_owner_telegram_id, '')
       then 'owner'
       else role
     end,
     access_status = 'active'
   where id = p_user_id;

  return query
    select request_row.telegram_user_id, request_row.chat_id, request_row.telegram_username;
  -- (без алиаса компилятор не смог бы отличить выходную колонку от колонки таблицы)
end;
$$;

revoke all on function public.consume_telegram_pairing_code(text, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_telegram_pairing_code(text, uuid, text) to service_role;

-- Выдача созревших напоминаний. Параллельные запуски cron не могут отправить одно и то же
-- дважды: строки помечаются sending с лизом на 3 минуты.
create or replace function public.claim_due_task_reminders(p_limit integer default 100)
returns table (
  job_id uuid,
  user_id uuid,
  task_id text,
  telegram_chat_id text,
  title text,
  priority smallint,
  due_at timestamptz,
  fire_at timestamptz,
  offset_minutes smallint,
  kind text,
  recurrence text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with candidates as (
    select r.id
      from public.task_reminders r
      join public.telegram_accounts ta on ta.user_id = r.user_id
      join public.profiles p on p.id = r.user_id and p.access_status = 'active'
      join public.tasks t on t.user_id = r.user_id and t.id = r.task_id
     where r.status in ('pending', 'sending')
       and r.fire_at <= now()
       and r.next_attempt_at <= now()
       and (r.lease_until is null or r.lease_until < now())
       and t.status = 'open'
       and t.due_at = r.due_at
     order by r.fire_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update of r skip locked
  ), claimed as (
    update public.task_reminders r
       set status = 'sending',
           attempts = r.attempts + 1,
           lease_until = now() + interval '3 minutes',
           updated_at = now()
      from candidates c
     where r.id = c.id
    returning r.*
  )
  select claimed.id, claimed.user_id, claimed.task_id, ta.chat_id, t.title, t.priority,
         claimed.due_at, claimed.fire_at, claimed.offset_minutes, claimed.kind, t.recurrence
    from claimed
    join public.telegram_accounts ta on ta.user_id = claimed.user_id
    join public.profiles p on p.id = claimed.user_id and p.access_status = 'active'
    join public.tasks t on t.user_id = claimed.user_id and t.id = claimed.task_id
   where t.status = 'open' and t.due_at = claimed.due_at;
end;
$$;

revoke all on function public.claim_due_task_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_due_task_reminders(integer) to service_role;

-- Утренний дайджест: одна попытка на локальный день пользователя, только если есть
-- что показать (задачи на сегодня или просроченные).
create or replace function public.claim_due_digests(p_limit integer default 50)
returns table (
  user_id uuid,
  telegram_chat_id text,
  timezone text,
  local_date date,
  due_today integer,
  overdue integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with candidates as (
    select p.id
      from public.profiles p
      join public.telegram_accounts ta on ta.user_id = p.id
     where p.access_status = 'active'
       and p.digest_enabled
       and p.digest_next_attempt_at <= now()
       and (now() at time zone p.timezone)::time >= p.digest_at
       and (
         p.digest_last_sent_at is null
         or (p.digest_last_sent_at at time zone p.timezone)::date < (now() at time zone p.timezone)::date
       )
       and exists (
         select 1 from public.tasks t
          where t.user_id = p.id
            and t.status = 'open'
            and t.due_at is not null
            and (t.due_at at time zone p.timezone)::date <= (now() at time zone p.timezone)::date
       )
     order by p.id
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update of p skip locked
  ), claimed as (
    update public.profiles p
       set digest_attempts = p.digest_attempts + 1,
           digest_next_attempt_at = now() + interval '5 minutes'
      from candidates c
     where p.id = c.id
    returning p.*
  )
  select claimed.id, ta.chat_id, claimed.timezone, (now() at time zone claimed.timezone)::date,
         (select count(*)::integer
            from public.tasks t
           where t.user_id = claimed.id
             and t.status = 'open'
             and t.due_at is not null
             and (t.due_at at time zone claimed.timezone)::date = (now() at time zone claimed.timezone)::date),
         (select count(*)::integer
            from public.tasks t
           where t.user_id = claimed.id
             and t.status = 'open'
             and t.due_at is not null
             and (t.due_at at time zone claimed.timezone)::date < (now() at time zone claimed.timezone)::date)
    from claimed
    join public.telegram_accounts ta on ta.user_id = claimed.id;
end;
$$;

revoke all on function public.claim_due_digests(integer) from public, anon, authenticated;
grant execute on function public.claim_due_digests(integer) to service_role;

-- Служебная сводка для владельца: /stats в боте.
create or replace function public.owner_stats()
returns table (users_total integer, users_active integer, tasks_open integer, tasks_done_7d integer, reminders_pending integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    (select count(*)::integer from public.profiles),
    (select count(*)::integer from public.profiles where access_status = 'active'),
    (select count(*)::integer from public.tasks where status = 'open'),
    (select count(*)::integer from public.tasks where status = 'done' and completed_at > now() - interval '7 days'),
    (select count(*)::integer from public.task_reminders where status = 'pending');
end;
$$;

revoke all on function public.owner_stats() from public, anon, authenticated;
grant execute on function public.owner_stats() to service_role;

-- Доступ клиентов: каждый авторизованный пользователь видит только свои строки.
-- Роль owner намеренно не получает доступа к чужим задачам.
alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.task_reminders enable row level security;
alter table public.telegram_pairing_requests enable row level security;
alter table public.telegram_accounts enable row level security;
alter table public.telegram_input_sessions enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.tasks from anon, authenticated;
revoke all on public.task_reminders from anon, authenticated;
revoke all on public.telegram_pairing_requests from anon, authenticated;
revoke all on public.telegram_accounts from anon, authenticated;
revoke all on public.telegram_input_sessions from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, timezone, digest_enabled, digest_at) on public.profiles to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select on public.task_reminders to authenticated;
grant select (user_id, telegram_username, linked_at) on public.telegram_accounts to authenticated;

grant all on public.profiles to service_role;
grant all on public.tasks to service_role;
grant all on public.task_reminders to service_role;
grant all on public.telegram_pairing_requests to service_role;
grant all on public.telegram_accounts to service_role;
grant all on public.telegram_input_sessions to service_role;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists tasks_select_self on public.tasks;
create policy tasks_select_self
  on public.tasks for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.access_status = 'active')
  );

drop policy if exists tasks_insert_self on public.tasks;
create policy tasks_insert_self
  on public.tasks for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.access_status = 'active')
  );

drop policy if exists tasks_update_self on public.tasks;
create policy tasks_update_self
  on public.tasks for update to authenticated
  using (
    user_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.access_status = 'active')
  )
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.access_status = 'active')
  );

drop policy if exists tasks_delete_self on public.tasks;
create policy tasks_delete_self
  on public.tasks for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.access_status = 'active')
  );

drop policy if exists task_reminders_select_self on public.task_reminders;
create policy task_reminders_select_self
  on public.task_reminders for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists telegram_accounts_select_self on public.telegram_accounts;
create policy telegram_accounts_select_self
  on public.telegram_accounts for select to authenticated
  using (user_id = (select auth.uid()));

comment on table public.profiles is 'Один приватный профиль на пользователя Supabase Auth; владелец не видит чужие профили.';
comment on table public.tasks is 'Задачи, изолированные по user_id через RLS.';
comment on table public.task_reminders is 'Очередь напоминаний; пишет только Edge Function с серверным ключом.';
comment on table public.telegram_pairing_requests is 'Одноразовые коды привязки Telegram; доступ только у Edge Functions.';
comment on table public.telegram_accounts is 'Связь аккаунта Telegram с профилем; доступ только у Edge Functions.';
comment on table public.telegram_input_sessions is 'Состояние диалога бота (быстрый ввод и ручные даты); доступ только у Edge Functions.';
comment on column public.tasks.remind_offsets is 'Минуты до дедлайна; отрицательные значения — после дедлайна.';
comment on column public.task_reminders.due_at is 'Снимок дедлайна задачи на момент планирования.';
comment on column public.profiles.digest_at is 'Время утреннего дайджеста в часовом поясе profiles.timezone.';
