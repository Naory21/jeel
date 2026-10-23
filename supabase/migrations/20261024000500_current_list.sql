-- Which list you're looking at: the household remembers the saved list currently open on the
-- shopping tab (both phones see the same one). Opening a saved list replaces what's on the list;
-- adding one merges into it (load_saved_list); starting a new list empties it.

alter table public.households add column current_list_id uuid references public.saved_lists (id) on delete set null;

-- set (or clear) the current list; the list must belong to your household
create or replace function public.set_current_list(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_household() is null then raise exception 'no household' using errcode = '42501'; end if;
  if p_id is not null and not exists (select 1 from public.saved_lists where id = p_id and household_id = public.my_household()) then
    raise exception 'list not found' using errcode = 'P0002';
  end if;
  perform set_config('jeel.op', coalesce(nullif(current_setting('jeel.op', true), ''), 'set_list'), true);
  update public.households set current_list_id = p_id where id = public.my_household();
end $$;

-- open a saved list: the current items are replaced by the saved ones (one feed line, every row audited).
-- Returns what undo needs: the removed rows, the inserted ids and the previous current list.
create or replace function public.open_saved_list(p_id uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  l public.saved_lists;
  prev uuid;
  removed jsonb;
  added uuid[];
begin
  select * into l from public.saved_lists where id = p_id;
  if not found then raise exception 'list not found' using errcode = 'P0002'; end if;
  select current_list_id into prev from public.households where id = l.household_id;
  perform set_config('jeel.op', 'open_list', true);
  perform set_config('jeel.skip_log', 'on', true);
  with d as (delete from public.shopping_items where household_id = l.household_id returning *)
  select coalesce(jsonb_agg(to_jsonb(d)), '[]') into removed from d;
  perform set_config('jeel.skip_log', 'off', true);
  added := public.load_saved_list(p_id);                 -- inserts the saved items (logs list_loaded)
  perform internal.forget_activity(array['list_loaded'], 1);
  perform internal.log(l.household_id, 'list_opened', l.name);
  perform set_config('jeel.op', 'open_list', true);
  perform public.set_current_list(p_id);
  return jsonb_build_object('removed', removed, 'added', to_jsonb(added), 'previous', prev);
end $$;

-- start a new, empty list. Returns the removed rows and the previous current list, for undo.
create or replace function public.new_shopping_list() returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  prev uuid;
  removed jsonb;
begin
  if public.my_household() is null then raise exception 'no household' using errcode = '42501'; end if;
  select current_list_id into prev from public.households where id = public.my_household();
  perform set_config('jeel.op', 'new_list', true);
  perform set_config('jeel.skip_log', 'on', true);
  with d as (delete from public.shopping_items where household_id = public.my_household() returning *)
  select coalesce(jsonb_agg(to_jsonb(d)), '[]') into removed from d;
  perform set_config('jeel.skip_log', 'off', true);
  perform internal.log(public.my_household(), 'list_new', '');
  perform public.set_current_list(null);
  return jsonb_build_object('removed', removed, 'previous', prev);
end $$;

revoke all on function public.set_current_list(uuid), public.open_saved_list(uuid), public.new_shopping_list() from public, anon;
grant execute on function public.set_current_list(uuid), public.open_saved_list(uuid), public.new_shopping_list() to authenticated;

-- live updates when the other phone opens a list
alter publication supabase_realtime add table public.households;
