-- Notes on shopping items ("ללא לקטוז", "המותג הכחול"), editable later like tasks: conflict-checked,
-- in the feed and the audit trail, and carried by saved lists.

alter table public.shopping_items add column note text check (note is null or length(note) <= 200);
alter table public.shopping_items add column updated_by uuid references public.members (id) on delete set null;
alter table public.shopping_items add column updated_at timestamptz;

-- who last edited the item (so a conflicting edit can say "מאיה שינתה את הפריט בינתיים")
create or replace function internal.items_stamp() returns trigger
language plpgsql as $$
begin
  if (old.name, old.qty, old.category, old.note) is distinct from (new.name, new.qty, new.category, new.note) then
    new.updated_by := internal.actor();
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger items_stamp before update on public.shopping_items for each row execute function internal.items_stamp();

-- feed: an edit of name / quantity / category / note by itself is "עדכן פריט"
create or replace function internal.items_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform internal.log(new.household_id, 'item_added', new.name); return new; end if;
  if tg_op = 'DELETE' then perform internal.log(old.household_id, 'item_deleted', old.name); return old; end if;
  if old.checked_at is null and new.checked_at is not null then
    perform internal.log(new.household_id, 'item_checked', new.name);
  elsif coalesce(current_setting('jeel.op', true), '') = 'edit'
        and (old.name, old.qty, old.category, old.note) is distinct from (new.name, new.qty, new.category, new.note) then
    perform internal.log(new.household_id, 'item_edited', new.name);
  elsif old.qty is distinct from new.qty and new.checked_at is null then
    perform internal.log(new.household_id, 'item_added', new.name);       -- added again: quantities merged
  end if;
  return new;
end $$;

-- update_checked now also edits shopping items
create or replace function public.update_checked(p_table text, p_id uuid, p_changes jsonb, p_base jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  allowed text[] := case p_table
    when 'tasks' then array['title', 'assignee_id', 'due_date', 'due_time']
    when 'reminders' then array['title', 'recipient_id', 'remind_date', 'remind_time', 'repeat', 'repeat_days', 'repeat_anchor']
    when 'shopping_items' then array['name', 'qty', 'category', 'note']
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

-- saved lists carry the note too
create or replace function public.load_saved_list(p_id uuid) returns uuid[]
language plpgsql security invoker set search_path = public as $$
declare
  l public.saved_lists;
  it jsonb;
  item_name text;
  item_qty text;
  item_note text;
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
    item_note := nullif(left(btrim(coalesce(it ->> 'note', '')), 200), '');
    continue when item_name is null or item_name = '';
    select * into dup from public.shopping_items
     where household_id = l.household_id and checked_at is null and name = item_name limit 1 for update;
    if found then
      if dup.qty ~ '^\d+$' and item_qty ~ '^\d+$' then
        update public.shopping_items set qty = (dup.qty::int + item_qty::int)::text, note = coalesce(note, item_note) where id = dup.id;
      elsif dup.note is null and item_note is not null then
        update public.shopping_items set note = item_note where id = dup.id;
      end if;
    else
      insert into public.shopping_items (name, qty, category, note)
      values (item_name, left(item_qty, 30), coalesce(nullif(it ->> 'category', ''), 'אחר'), item_note)
      returning id into new_id;
      added := added || new_id;
    end if;
  end loop;
  perform set_config('jeel.skip_log', 'off', true);
  perform internal.log(l.household_id, 'list_loaded', l.name);
  return added;
end $$;
