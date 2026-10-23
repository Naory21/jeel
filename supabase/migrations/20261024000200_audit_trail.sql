-- Audit trail: an append-only record of every change on the platform, separate from the friendly
-- activity feed (which summarises, and drops lines on undo). Each row says who, when, from where
-- (app / whatsapp / system), what happened, and for updates every changed field as [old, new].
-- Written only by triggers and two narrow functions; nobody can edit it, and the app can't delete from it.

create table public.audit_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  at timestamptz not null default clock_timestamp(),
  actor_id uuid references public.members (id) on delete set null,   -- null = the system
  via text not null default 'app' check (via in ('app', 'whatsapp', 'system')),
  action text not null check (action in ('insert', 'update', 'delete', 'event')),
  entity text not null,          -- table name, or 'session' for sign-in / sign-out
  entity_id text,
  label text,                    -- title / name at the time, so deleted things stay readable
  changes jsonb,                 -- update: {field: [old, new]}; insert/delete: the row; event: details
  op text                        -- what the user did, when known: edit, complete, snooze, undo, clear_cart, send, ...
);
create index on public.audit_log (household_id, id desc);

alter table public.audit_log enable row level security;
create policy "own household" on public.audit_log for select to authenticated using (household_id = public.my_household());
revoke all on public.audit_log from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated, service_role;
grant select on public.audit_log to authenticated, service_role;

-- append-only, even for code running as the table owner
create or replace function internal.audit_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'the audit log is append-only' using errcode = '42501';
end $$;
create trigger audit_no_update before update on public.audit_log for each row execute function internal.audit_append_only();

-- fields that change on every write and say nothing about intent
create or replace function internal.audit_noise() returns text[]
language sql immutable as $$ select array['household_id', 'updated_at', 'updated_by'] $$;

create or replace function internal.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r jsonb := coalesce(n, o);
  diff jsonb;
  hh uuid;
begin
  hh := case when tg_table_name = 'households' then (r ->> 'id')::uuid else (r ->> 'household_id')::uuid end;
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_array(o -> k, n -> k)) into diff
      from jsonb_object_keys(n) k
     where (o -> k) is distinct from (n -> k) and k <> all (internal.audit_noise());
    if diff is null then return null; end if;   -- nothing meaningful changed
  else
    diff := r - internal.audit_noise();
  end if;
  insert into public.audit_log (household_id, actor_id, via, action, entity, entity_id, label, changes, op)
  values (
    hh,
    internal.actor(),
    coalesce(nullif(current_setting('jeel.via', true), ''), 'app'),
    lower(tg_op),
    tg_table_name,
    coalesce(r ->> 'id', r ->> 'name'),
    coalesce(n ->> 'title', n ->> 'name', n ->> 'display_name', o ->> 'title', o ->> 'name', o ->> 'display_name'),
    diff,
    nullif(current_setting('jeel.op', true), '')
  );
  return null;
end $$;

create trigger audit after insert or update or delete on public.tasks           for each row execute function internal.audit_row();
create trigger audit after insert or update or delete on public.reminders       for each row execute function internal.audit_row();
create trigger audit after insert or update or delete on public.shopping_items  for each row execute function internal.audit_row();
create trigger audit after insert or update or delete on public.item_categories for each row execute function internal.audit_row();
create trigger audit after insert or update or delete on public.members         for each row execute function internal.audit_row();
create trigger audit after insert or update or delete on public.households      for each row execute function internal.audit_row();

-- events the database can't see by itself: signing in / out (reported by the app for its own user)
create or replace function public.log_event(p_kind text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_kind not in ('signed_in', 'signed_out') then raise exception 'unknown event' using errcode = '22023'; end if;
  if public.my_household() is null then return; end if;
  insert into public.audit_log (household_id, actor_id, via, action, entity, entity_id, op)
  values (public.my_household(), auth.uid(), 'app', 'event', 'session', auth.uid()::text, p_kind);
end $$;

-- delivery results from the send-due-reminders Edge Function (service role only)
create or replace function public.log_delivery(p_reminder uuid, p_ok boolean, p_detail text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reminders;
begin
  select * into r from public.reminders where id = p_reminder;
  if not found then return; end if;
  insert into public.audit_log (household_id, actor_id, via, action, entity, entity_id, label, changes, op)
  values (r.household_id, null, 'system', 'event', 'reminders', r.id::text, r.title,
          jsonb_build_object('detail', left(p_detail, 500)), case when p_ok then 'whatsapp_sent' else 'whatsapp_failed' end);
end $$;

revoke all on function public.log_event(text) from public, anon;
grant execute on function public.log_event(text) to authenticated;
revoke all on function public.log_delivery(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.log_delivery(uuid, boolean, text) to service_role;
revoke all on function internal.audit_row(), internal.audit_append_only(), internal.audit_noise() from public, anon;
