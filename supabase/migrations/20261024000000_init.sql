-- Jeel: schema, row-level security, activity log and reminder logic.
-- Every table is household-scoped; the browser only ever uses the anon key + the user's session,
-- so these policies are the whole access model. Times are stored as Asia/Jerusalem local
-- date + time for reminders (repeat rules are calendar rules), instants are timestamptz.

create schema if not exists internal;   -- helpers; not exposed through the API
revoke all on schema internal from public;
grant usage on schema internal to authenticated, service_role;

-- ---------------------------------------------------------------- tables

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'הבית שלנו',
  created_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  slot smallint not null check (slot in (1, 2)),          -- 1 = blue avatar, 2 = orange avatar
  display_name text not null check (length(display_name) between 1 and 30),
  gender text not null default 'm' check (gender in ('m', 'f')),   -- for Hebrew verb forms
  whatsapp_phone text check (whatsapp_phone ~ '^\+[1-9][0-9]{7,14}$'),  -- E.164
  created_at timestamptz not null default now(),
  unique (household_id, slot)
);

create or replace function public.my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from public.members where id = auth.uid()
$$;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households (id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  assignee_id uuid references public.members (id) on delete set null,   -- null = both
  due_date date not null,
  due_time time,
  done_at timestamptz,
  created_by uuid default auth.uid() references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null,
  updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households (id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  recipient_id uuid references public.members (id) on delete set null,  -- null = both
  remind_date date not null,                 -- Asia/Jerusalem calendar date of the next occurrence
  remind_time time not null,                 -- Asia/Jerusalem wall-clock time
  repeat text not null default 'none' check (repeat in ('none', 'daily', 'weekly', 'monthly', 'days')),
  repeat_days smallint[],                    -- 0=Sun..6=Sat, with repeat = 'days'
  repeat_anchor smallint check (repeat_anchor between 1 and 31),   -- day of month, with repeat = 'monthly'
  snooze_until timestamptz,                  -- overrides this occurrence only
  done_at timestamptz,                       -- one-off reminders only; repeating ones roll forward
  last_completed_at timestamptz,
  last_sent_at timestamptz,
  created_by uuid default auth.uid() references public.members (id) on delete set null,
  updated_by uuid references public.members (id) on delete set null,
  updated_at timestamptz,
  created_at timestamptz not null default now(),
  check (repeat <> 'days' or (cardinality(repeat_days) between 1 and 7 and repeat_days <@ '{0,1,2,3,4,5,6}'::smallint[]))
);

create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  qty text not null default '1' check (length(qty) between 1 and 30),
  category text not null default 'אחר'
    check (category in ('פירות וירקות', 'מוצרי חלב', 'מאפים', 'יבשים', 'ניקיון ובית', 'אחר')),
  added_by uuid default auth.uid() references public.members (id) on delete set null,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

-- the category each item name was last filed under, so the app can guess it next time
create table public.item_categories (
  household_id uuid not null default public.my_household() references public.households (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  category text not null,
  primary key (household_id, name)
);

create table public.activity (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  actor_id uuid references public.members (id) on delete set null,
  via text not null default 'app' check (via in ('app', 'whatsapp', 'system')),
  verb text not null,
  subject text not null,
  created_at timestamptz not null default now()
);

create index on public.tasks (household_id, done_at, due_date);
create index on public.reminders (household_id, remind_date) where done_at is null;
create index on public.shopping_items (household_id, checked_at);
create index on public.activity (household_id, created_at desc);

-- ---------------------------------------------------------------- dates

-- the instant a reminder occurrence is due
create or replace function internal.due_at(d date, t time, snooze timestamptz) returns timestamptz
language sql immutable as $$
  select coalesce(snooze, (d + t) at time zone 'Asia/Jerusalem')
$$;

create or replace function internal.today_il() returns date
language sql stable as $$ select (now() at time zone 'Asia/Jerusalem')::date $$;

-- the occurrence after d
create or replace function internal.next_occurrence(d date, rep text, days smallint[], anchor smallint) returns date
language plpgsql immutable as $$
declare
  n date;
  last_day int;
begin
  case rep
    when 'daily' then return d + 1;
    when 'weekly' then return d + 7;
    when 'days' then
      n := d + 1;
      while not (extract(dow from n)::smallint = any (days)) loop n := n + 1; end loop;
      return n;
    when 'monthly' then
      -- same day of month as it was created on, clamped to short months (31st -> 30th / 28th)
      n := (date_trunc('month', d) + interval '1 month')::date;
      last_day := extract(day from (n + interval '1 month - 1 day'))::int;
      return n + (least(coalesce(anchor, extract(day from d)::int), last_day) - 1);
    else
      return d;
  end case;
end $$;

-- first occurrence after today
create or replace function internal.roll_forward(d date, rep text, days smallint[], anchor smallint) returns date
language plpgsql stable as $$
declare n date := d;
begin
  loop
    n := internal.next_occurrence(n, rep, days, anchor);
    exit when n > internal.today_il();
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- activity log (written only by triggers)

-- who did it: the signed-in member, or the member an Edge Function acts for (set per transaction)
create or replace function internal.actor() returns uuid
language sql stable as $$
  select coalesce(auth.uid(), nullif(current_setting('jeel.actor', true), '')::uuid)
$$;

create or replace function internal.log(p_household uuid, p_verb text, p_subject text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('jeel.skip_log', true), '') = 'on' then return; end if;
  insert into public.activity (household_id, actor_id, via, verb, subject)
  values (p_household, internal.actor(), coalesce(nullif(current_setting('jeel.via', true), ''), 'app'), p_verb, p_subject);
end $$;

create or replace function internal.tasks_stamp() returns trigger
language plpgsql as $$
begin
  if (old.title, old.assignee_id, old.due_date, old.due_time) is distinct from (new.title, new.assignee_id, new.due_date, new.due_time) then
    new.updated_by := internal.actor();
    new.updated_at := now();
  end if;
  return new;
end $$;

create or replace function internal.tasks_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform internal.log(new.household_id, 'task_added', new.title); return new; end if;
  if tg_op = 'DELETE' then perform internal.log(old.household_id, 'task_deleted', old.title); return old; end if;
  if old.done_at is null and new.done_at is not null then
    perform internal.log(new.household_id, 'task_done', new.title);
  elsif old.done_at is not null and new.done_at is null then
    perform internal.log(new.household_id, 'task_reopened', new.title);
  elsif (old.title, old.assignee_id, old.due_date, old.due_time) is distinct from (new.title, new.assignee_id, new.due_date, new.due_time) then
    perform internal.log(new.household_id, 'task_edited', new.title);
  end if;
  return new;
end $$;

create or replace function internal.reminders_stamp() returns trigger
language plpgsql as $$
begin
  if (old.title, old.recipient_id, old.remind_date, old.remind_time, old.repeat, old.repeat_days)
     is distinct from (new.title, new.recipient_id, new.remind_date, new.remind_time, new.repeat, new.repeat_days)
     and new.last_completed_at is not distinct from old.last_completed_at then
    new.updated_by := internal.actor();
    new.updated_at := now();
  end if;
  return new;
end $$;

create or replace function internal.reminders_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform internal.log(new.household_id, 'rem_added', new.title); return new; end if;
  if tg_op = 'DELETE' then perform internal.log(old.household_id, 'rem_deleted', old.title); return old; end if;
  if new.last_completed_at is not null and new.last_completed_at is distinct from old.last_completed_at then
    perform internal.log(new.household_id, 'rem_done', new.title);          -- repeating: rolled forward
  elsif old.done_at is null and new.done_at is not null then
    perform internal.log(new.household_id, 'rem_done', new.title);
  elsif old.done_at is not null and new.done_at is null then
    perform internal.log(new.household_id, 'rem_reopened', new.title);
  elsif new.snooze_until is not null and new.snooze_until is distinct from old.snooze_until then
    perform internal.log(new.household_id, 'rem_snoozed', new.title);
  elsif (old.title, old.recipient_id, old.remind_date, old.remind_time, old.repeat, old.repeat_days)
        is distinct from (new.title, new.recipient_id, new.remind_date, new.remind_time, new.repeat, new.repeat_days) then
    perform internal.log(new.household_id, 'rem_edited', new.title);
  end if;
  return new;
end $$;

create or replace function internal.items_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform internal.log(new.household_id, 'item_added', new.name); return new; end if;
  if tg_op = 'DELETE' then perform internal.log(old.household_id, 'item_deleted', old.name); return old; end if;
  if old.checked_at is null and new.checked_at is not null then
    perform internal.log(new.household_id, 'item_checked', new.name);
  elsif old.qty is distinct from new.qty and new.checked_at is null then
    perform internal.log(new.household_id, 'item_added', new.name);       -- added again: quantities merged
  end if;
  return new;
end $$;

create trigger tasks_stamp before update on public.tasks for each row execute function internal.tasks_stamp();
create trigger tasks_log after insert or update or delete on public.tasks for each row execute function internal.tasks_log();
create trigger reminders_stamp before update on public.reminders for each row execute function internal.reminders_stamp();
create trigger reminders_log after insert or update or delete on public.reminders for each row execute function internal.reminders_log();
create trigger items_log after insert or update or delete on public.shopping_items for each row execute function internal.items_log();

-- ---------------------------------------------------------------- row level security

alter table public.households      enable row level security;
alter table public.members         enable row level security;
alter table public.tasks           enable row level security;
alter table public.reminders       enable row level security;
alter table public.shopping_items  enable row level security;
alter table public.item_categories enable row level security;
alter table public.activity        enable row level security;

create policy "own household" on public.households for select to authenticated using (id = public.my_household());
create policy "own household" on public.members for select to authenticated using (household_id = public.my_household());
create policy "own household edit" on public.members for update to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "own household" on public.tasks for all to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "own household" on public.reminders for all to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "own household" on public.shopping_items for all to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "own household" on public.item_categories for all to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "own household" on public.activity for select to authenticated using (household_id = public.my_household());

revoke all on all tables in schema public from anon;
revoke all on function public.my_household() from anon;
-- members: only the friendly fields can be changed from the app
revoke insert, update, delete on public.members from authenticated;
grant update (display_name, gender, whatsapp_phone) on public.members to authenticated;
revoke insert, update, delete on public.households, public.activity from authenticated;

-- ---------------------------------------------------------------- app operations (RPC)

-- only the trusted server side (Edge Functions with the service role, or the SQL editor) may act for someone
create or replace function internal.act_as(p_actor uuid, p_via text) returns void
language plpgsql as $$
begin
  if p_actor is null then return; end if;
  if coalesce(auth.role(), '') <> 'service_role' and current_user not in ('postgres', 'service_role') then
    raise exception 'not allowed to act for another member' using errcode = '42501';
  end if;
  perform set_config('jeel.actor', p_actor::text, true);
  perform set_config('jeel.via', coalesce(p_via, 'app'), true);
end $$;

-- mark done: one-off reminders close, repeating ones roll to their next occurrence after today.
-- From WhatsApp (p_via = 'whatsapp') a second tap on the same message does nothing.
create or replace function public.complete_reminder(p_id uuid, p_actor uuid default null, p_via text default null)
returns public.reminders
language plpgsql security invoker set search_path = public as $$
declare r public.reminders;
begin
  perform internal.act_as(p_actor, p_via);
  perform set_config('jeel.op', 'complete', true);
  select * into r from public.reminders where id = p_id for update;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  if p_via = 'whatsapp' and (r.done_at is not null or r.last_sent_at is null) then return r; end if;
  if r.repeat = 'none' then
    update public.reminders set done_at = coalesce(done_at, now()), snooze_until = null where id = p_id returning * into r;
  else
    update public.reminders
       set remind_date = internal.roll_forward(remind_date, repeat, repeat_days, repeat_anchor),
           snooze_until = null, last_completed_at = now(), last_sent_at = null
     where id = p_id returning * into r;
  end if;
  return r;
end $$;

create or replace function public.snooze_reminder(p_id uuid, p_minutes int default 30, p_actor uuid default null, p_via text default null)
returns public.reminders
language plpgsql security invoker set search_path = public as $$
declare r public.reminders;
begin
  perform internal.act_as(p_actor, p_via);
  perform set_config('jeel.op', 'snooze', true);
  update public.reminders
     set snooze_until = now() + make_interval(mins => greatest(1, least(p_minutes, 24 * 60))), last_sent_at = null
   where id = p_id and done_at is null returning * into r;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  return r;
end $$;

-- partial update that refuses to overwrite a field someone else changed since you opened it.
-- p_base holds the values you started from (as the API returned them); returns {row} or {conflict: current row}
create or replace function public.update_checked(p_table text, p_id uuid, p_changes jsonb, p_base jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  allowed text[] := case p_table
    when 'tasks' then array['title', 'assignee_id', 'due_date', 'due_time']
    when 'reminders' then array['title', 'recipient_id', 'remind_date', 'remind_time', 'repeat', 'repeat_days', 'repeat_anchor']
    else null end;
  cur jsonb;
  cols text[];
  res jsonb;
begin
  if allowed is null then raise exception 'table not editable' using errcode = '22023'; end if;
  perform set_config('jeel.op', 'edit', true);
  execute format('select to_jsonb(t) from public.%I t where id = $1 for update', p_table) into cur using p_id;
  if cur is null then raise exception 'not found' using errcode = 'P0002'; end if;
  if exists (select 1 from jsonb_each(coalesce(p_base, '{}')) b where (cur -> b.key) is distinct from b.value) then
    return jsonb_build_object('conflict', cur);
  end if;
  select array_agg(k) into cols from jsonb_object_keys(coalesce(p_changes, '{}')) k where k = any (allowed);
  if cols is null then return jsonb_build_object('row', cur); end if;
  -- moving a reminder's date or time cancels a snooze of the old occurrence
  if p_table = 'reminders' and (cols && array['remind_date', 'remind_time']) then cols := cols || 'snooze_until'::text; end if;
  execute format(
    'update public.%I t set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where id = $2 returning to_jsonb(t)',
    p_table,
    (select string_agg(format('%I', c), ', ') from unnest(cols) c),
    (select string_agg(format('%I', c), ', ') from unnest(cols) c),
    p_table
  ) into res using p_changes || case when 'snooze_until' = any (cols) then '{"snooze_until": null}'::jsonb else '{}'::jsonb end, p_id;
  return jsonb_build_object('row', res);
end $$;

-- remove everything already in the cart, logged as one line; returns the removed rows (for undo)
create or replace function public.clear_cart() returns setof public.shopping_items
language plpgsql security invoker set search_path = public as $$
declare
  gone public.shopping_items[];
begin
  perform set_config('jeel.op', 'clear_cart', true);
  perform set_config('jeel.skip_log', 'on', true);
  with d as (delete from public.shopping_items where household_id = public.my_household() and checked_at is not null returning *)
  select coalesce(array_agg(d), '{}') into gone from d;
  perform set_config('jeel.skip_log', 'off', true);
  if cardinality(gone) > 0 then perform internal.log(public.my_household(), 'cart_cleared', cardinality(gone)::text); end if;
  return query select * from unnest(gone);
end $$;

-- undo: put rows back exactly as they were, without logging, and drop the activity lines the action wrote
create or replace function internal.forget_activity(p_verbs text[], p_count int) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.activity where id in (
    select id from public.activity
     where household_id = public.my_household() and actor_id = auth.uid() and verb = any (p_verbs)
       and created_at > now() - interval '10 minutes'
     order by created_at desc, id desc limit greatest(p_count, 0));
end $$;

create or replace function public.undo_restore(p_table text, p_rows jsonb, p_verbs text[], p_log_count int default 1)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  setlist text;
begin
  if p_table not in ('tasks', 'reminders', 'shopping_items') then raise exception 'table not restorable' using errcode = '22023'; end if;
  select string_agg(format('%I = excluded.%I', a.attname, a.attname), ', ') into setlist
    from pg_attribute a
   where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attname <> 'id';
  perform set_config('jeel.op', 'undo', true);
  perform set_config('jeel.skip_log', 'on', true);
  execute format('insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (id) do update set %s',
                 p_table, p_table, setlist) using p_rows;
  perform set_config('jeel.skip_log', 'off', true);
  perform internal.forget_activity(p_verbs, p_log_count);
end $$;

-- ---------------------------------------------------------------- reminder delivery (service role only)

-- claim the occurrences that are due now and not sent yet; safe to run concurrently (skip locked)
create or replace function public.claim_due_reminders()
returns table (reminder_id uuid, title text, local_time text, phones text[])
language plpgsql security definer set search_path = public as $$
begin
  -- repeating reminders nobody marked done for a day move on, so next time still gets sent
  perform set_config('jeel.via', 'system', true);
  perform set_config('jeel.op', 'auto_roll', true);
  perform set_config('jeel.skip_log', 'on', true);
  update public.reminders r
     set remind_date = internal.roll_forward(r.remind_date, r.repeat, r.repeat_days, r.repeat_anchor),
         snooze_until = null, last_sent_at = null
   where r.repeat <> 'none' and r.done_at is null and r.last_sent_at is not null
     and internal.due_at(r.remind_date, r.remind_time, r.snooze_until) < now() - interval '20 hours';
  perform set_config('jeel.skip_log', 'off', true);
  perform set_config('jeel.op', 'send', true);

  return query
  with due as (
    select r.id from public.reminders r
     where r.done_at is null
       and internal.due_at(r.remind_date, r.remind_time, r.snooze_until) <= now()
       and internal.due_at(r.remind_date, r.remind_time, r.snooze_until) > now() - interval '12 hours'  -- no burst after an outage
       and (r.last_sent_at is null or r.last_sent_at < internal.due_at(r.remind_date, r.remind_time, r.snooze_until))
     for update skip locked
  ), sent as (
    update public.reminders r set last_sent_at = now() from due where r.id = due.id returning r.*
  )
  select s.id, s.title,
         to_char(coalesce(s.snooze_until at time zone 'Asia/Jerusalem', s.remind_date + s.remind_time), 'HH24:MI'),
         array(select m.whatsapp_phone from public.members m
                where m.household_id = s.household_id and m.whatsapp_phone is not null
                  and (s.recipient_id is null or m.id = s.recipient_id)
                order by m.slot)
    from sent s;
end $$;

-- sending failed: let the next run try again
create or replace function public.unclaim_reminder(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.reminders set last_sent_at = null where id = p_id
$$;

revoke all on function public.claim_due_reminders() from public, anon, authenticated;
revoke all on function public.unclaim_reminder(uuid) from public, anon, authenticated;
grant execute on function public.claim_due_reminders() to service_role;
grant execute on function public.unclaim_reminder(uuid) to service_role;
revoke all on function public.complete_reminder(uuid, uuid, text), public.snooze_reminder(uuid, int, uuid, text),
  public.update_checked(text, uuid, jsonb, jsonb), public.clear_cart(), public.undo_restore(text, jsonb, text[], int) from public, anon;
grant execute on function public.complete_reminder(uuid, uuid, text), public.snooze_reminder(uuid, int, uuid, text),
  public.update_checked(text, uuid, jsonb, jsonb), public.clear_cart(), public.undo_restore(text, jsonb, text[], int) to authenticated, service_role;
revoke all on all functions in schema internal from public, anon;
grant execute on all functions in schema internal to authenticated, service_role;

-- a harmless query for the daily keep-alive (free projects pause after a week without activity)
create or replace function public.ping() returns text language sql stable as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon;

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table public.tasks, public.reminders, public.shopping_items, public.activity, public.members;
