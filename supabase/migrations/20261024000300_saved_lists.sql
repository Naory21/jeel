-- Saved shopping lists: keep what's on the list under a name ("קנייה שבועית") and add it back later.

create table public.saved_lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default public.my_household() references public.households (id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 200),
                                   -- [{ "name": "חלב", "qty": "2", "category": "מוצרי חלב" }, ...]
  created_by uuid default auth.uid() references public.members (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.saved_lists (household_id, name);

alter table public.saved_lists enable row level security;
create policy "own household" on public.saved_lists for all to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());
revoke all on public.saved_lists from anon;

-- activity feed lines for saving / deleting a list
create or replace function internal.lists_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform internal.log(new.household_id, 'list_saved', new.name); return new; end if;
  if tg_op = 'DELETE' then perform internal.log(old.household_id, 'list_deleted', old.name); return old; end if;
  if old.items is distinct from new.items or old.name is distinct from new.name then
    perform internal.log(new.household_id, 'list_saved', new.name);
  end if;
  return new;
end $$;
create trigger lists_log after insert or update or delete on public.saved_lists for each row execute function internal.lists_log();
create trigger audit after insert or update or delete on public.saved_lists for each row execute function internal.audit_row();

-- add a saved list to the shopping list: items already open get their quantities added when both are
-- plain numbers (otherwise left as they are); the rest are inserted. One feed line, every row audited.
-- Returns the ids of the rows it inserted, for undo.
create or replace function public.load_saved_list(p_id uuid) returns uuid[]
language plpgsql security invoker set search_path = public as $$
declare
  l public.saved_lists;
  it jsonb;
  item_name text;
  item_qty text;
  dup public.shopping_items;
  added uuid[] := '{}';
  new_id uuid;
begin
  select * into l from public.saved_lists where id = p_id;
  if not found then raise exception 'list not found' using errcode = 'P0002'; end if;
  perform set_config('jeel.op', 'load_list', true);
  perform set_config('jeel.skip_log', 'on', true);
  for it in select * from jsonb_array_elements(l.items) loop
    item_name := btrim(regexp_replace(it ->> 'name', '\s+', ' ', 'g'));
    item_qty := coalesce(nullif(btrim(it ->> 'qty'), ''), '1');
    continue when item_name is null or item_name = '';
    select * into dup from public.shopping_items
     where household_id = l.household_id and checked_at is null and name = item_name limit 1 for update;
    if found then
      if dup.qty ~ '^\d+$' and item_qty ~ '^\d+$' then
        update public.shopping_items set qty = (dup.qty::int + item_qty::int)::text where id = dup.id;
      end if;
    else
      insert into public.shopping_items (name, qty, category)
      values (item_name, left(item_qty, 30), coalesce(nullif(it ->> 'category', ''), 'אחר'))
      returning id into new_id;
      added := added || new_id;
    end if;
  end loop;
  perform set_config('jeel.skip_log', 'off', true);
  perform internal.log(l.household_id, 'list_loaded', l.name);
  return added;
end $$;

-- undo of "add a saved list": remove the rows it inserted (audited as undo, no feed noise)
create or replace function public.discard_items(p_ids uuid[]) returns void
language plpgsql security invoker set search_path = public as $$
begin
  perform set_config('jeel.op', 'undo', true);
  perform set_config('jeel.skip_log', 'on', true);
  delete from public.shopping_items where id = any (p_ids);
  perform set_config('jeel.skip_log', 'off', true);
end $$;

revoke all on function public.load_saved_list(uuid), public.discard_items(uuid[]) from public, anon;
grant execute on function public.load_saved_list(uuid), public.discard_items(uuid[]) to authenticated;

-- undo also covers saved lists (deleting a list can be undone)
create or replace function public.undo_restore(p_table text, p_rows jsonb, p_verbs text[], p_log_count int default 1)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  setlist text;
begin
  if p_table not in ('tasks', 'reminders', 'shopping_items', 'saved_lists') then raise exception 'table not restorable' using errcode = '22023'; end if;
  perform set_config('jeel.op', 'undo', true);
  select string_agg(format('%I = excluded.%I', a.attname, a.attname), ', ') into setlist
    from pg_attribute a
   where a.attrelid = format('public.%I', p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attname <> 'id';
  perform set_config('jeel.skip_log', 'on', true);
  execute format('insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (id) do update set %s',
                 p_table, p_table, setlist) using p_rows;
  perform set_config('jeel.skip_log', 'off', true);
  perform internal.forget_activity(p_verbs, p_log_count);
end $$;

alter publication supabase_realtime add table public.saved_lists;
