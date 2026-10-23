-- Database tests for supabase/migrations/*_init.sql. Run with tests/db/run.mjs (plain Postgres in Docker).
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;

create function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAIL: %', msg; end if;
  raise notice 'PASS %', msg;
end $$;
-- run a statement and report whether it raised (and with which SQLSTATE)
create function pg_temp.fails(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlstate;
end $$;
grant execute on all functions in schema pg_temp to public;
set client_min_messages = notice;

-- ---------- fixtures: household 1 (naor + maya), household 2 (eve), and a user with no household
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'naor@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'maya@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'eve@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'stranger@example.com');
insert into households (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'בית 1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'בית 2');
insert into members (id, household_id, slot, display_name, gender, whatsapp_phone) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'נאור', 'm', '+972500000001'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 'מאיה', 'f', '+972500000002'),
  ('33333333-3333-4333-8333-333333333333', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 'איב', 'f', null);
insert into tasks (id, household_id, title, due_date, created_by) values
  ('99999999-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'סוד של בית 2', current_date, '33333333-3333-4333-8333-333333333333');

\set naor '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}'
\set maya '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}'
\set eve '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}'
\set stranger '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}'
\set service '{"role":"service_role"}'

-- ================================================================ access
set role anon;
select pg_temp.ok(pg_temp.fails('select * from tasks') = '42501', 'anon cannot read tasks');
select pg_temp.ok(pg_temp.fails('select * from members') = '42501', 'anon cannot read members');
select pg_temp.ok(public.ping() = 'ok', 'anon can call the keep-alive ping');
reset role;

set role authenticated; select set_config('request.jwt.claims', :'stranger', false);
select pg_temp.ok((select count(*) from tasks) = 0 and (select count(*) from members) = 0, 'signed-in user without a household sees nothing');
select pg_temp.ok(pg_temp.fails($$insert into tasks (title, due_date) values ('x', current_date)$$) is not null, 'user without a household cannot add');
reset role;

set role authenticated; select set_config('request.jwt.claims', :'naor', false);
select pg_temp.ok((select count(*) from members) = 2, 'naor sees the two members of his household');
select pg_temp.ok((select count(*) from tasks where title = 'סוד של בית 2') = 0, 'naor cannot see household 2 tasks');
select pg_temp.ok(pg_temp.fails($$insert into tasks (household_id, title, due_date) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'פריצה', current_date)$$) = '42501', 'naor cannot write into household 2');
update tasks set title = 'נפרץ' where id = '99999999-0000-4000-8000-000000000001';
reset role;
select pg_temp.ok((select title from tasks where id = '99999999-0000-4000-8000-000000000001') = 'סוד של בית 2', 'naor cannot update household 2 rows');
set role authenticated; select set_config('request.jwt.claims', :'naor', false);
select pg_temp.ok(pg_temp.fails($$update members set slot = 2 where id = '11111111-1111-4111-8111-111111111111'$$) = '42501', 'members.slot is read-only from the app');
select pg_temp.ok(pg_temp.fails($$insert into members (id, household_id, slot, display_name) values ('44444444-4444-4444-8444-444444444444', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 'x')$$) = '42501', 'app cannot add members');
update members set display_name = 'מאיה כהן' where id = '22222222-2222-4222-8222-222222222222';
select pg_temp.ok((select display_name from members where slot = 2) = 'מאיה כהן', 'partner name can be changed from the app');
select pg_temp.ok(pg_temp.fails($$insert into activity (household_id, verb, subject) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x', 'y')$$) = '42501', 'app cannot write the activity log');
select pg_temp.ok(pg_temp.fails('select * from claim_due_reminders()') = '42501', 'app cannot claim reminders');

-- ================================================================ tasks + activity
insert into tasks (id, title, assignee_id, due_date) values ('10000000-0000-4000-8000-000000000001', 'לקנות נורה', null, current_date);
select pg_temp.ok((select household_id from tasks where id = '10000000-0000-4000-8000-000000000001') = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'household and author filled in automatically');
select pg_temp.ok((select verb || '|' || actor_id || '|' || via from activity order by id desc limit 1) = 'task_added|11111111-1111-4111-8111-111111111111|app', 'add logged with actor and via');
insert into tasks (id, title, due_date) values ('10000000-0000-4000-8000-000000000001', 'כפילות', current_date) on conflict (id) do nothing;
select pg_temp.ok((select count(*) from tasks where id = '10000000-0000-4000-8000-000000000001') = 1 and (select title from tasks where id = '10000000-0000-4000-8000-000000000001') = 'לקנות נורה', 'retried insert with the same id is ignored');
update tasks set done_at = now() where id = '10000000-0000-4000-8000-000000000001';
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'task_done', 'done logged');
update tasks set done_at = null where id = '10000000-0000-4000-8000-000000000001';
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'task_reopened', 'reopen logged');
reset role;

-- conflict-checked edit: maya renames, naor's stale rename is refused, naor's change of another field merges
set role authenticated; select set_config('request.jwt.claims', :'maya', false);
select pg_temp.ok((update_checked('tasks', '10000000-0000-4000-8000-000000000001', '{"title":"נורה LED"}', '{"title":"לקנות נורה"}') -> 'row' ->> 'title') = 'נורה LED', 'maya edit applied');
select pg_temp.ok((select verb || '|' || actor_id from activity order by id desc limit 1) = 'task_edited|22222222-2222-4222-8222-222222222222', 'edit logged for maya');
reset role;
set role authenticated; select set_config('request.jwt.claims', :'naor', false);
select pg_temp.ok((update_checked('tasks', '10000000-0000-4000-8000-000000000001', '{"title":"נורה"}', '{"title":"לקנות נורה"}') -> 'conflict' ->> 'title') = 'נורה LED', 'stale edit of the same field returns a conflict with the current row');
select pg_temp.ok((update_checked('tasks', '10000000-0000-4000-8000-000000000001', '{"due_time":"08:30:00"}', '{"due_time":null}') -> 'row' ->> 'due_time') = '08:30:00', 'edit of another field merges');
select pg_temp.ok((select title || '|' || updated_by from tasks where id = '10000000-0000-4000-8000-000000000001') = 'נורה LED|11111111-1111-4111-8111-111111111111', 'title kept, updated_by stamped');
select pg_temp.ok(pg_temp.fails($$select update_checked('tasks', '10000000-0000-4000-8000-000000000001', '{"household_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}', '{}')$$) is null
  and (select household_id from tasks where id = '10000000-0000-4000-8000-000000000001') = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'update_checked ignores fields outside its allow-list');
select pg_temp.ok(pg_temp.fails($$select update_checked('members', '11111111-1111-4111-8111-111111111111', '{"slot":2}', '{}')$$) = '22023', 'update_checked refuses other tables');

-- undo a delete: row comes back, the "deleted" line disappears
delete from tasks where id = '10000000-0000-4000-8000-000000000001';
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'task_deleted', 'delete logged');
reset role;
select set_config('test.snap', (select jsonb_agg(to_jsonb(a)) from (select id, household_id, title, assignee_id, due_date, due_time, done_at, created_by, updated_by, updated_at, created_at
  from (values ('10000000-0000-4000-8000-000000000001'::uuid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'נורה LED', null::uuid, current_date, '08:30'::time, null::timestamptz,
                '11111111-1111-4111-8111-111111111111'::uuid, '11111111-1111-4111-8111-111111111111'::uuid, now(), now()))
       v(id, household_id, title, assignee_id, due_date, due_time, done_at, created_by, updated_by, updated_at, created_at)) a)::text, false);
set role authenticated; select set_config('request.jwt.claims', :'naor', false);
select undo_restore('tasks', current_setting('test.snap')::jsonb, array['task_deleted']);
select pg_temp.ok((select title from tasks where id = '10000000-0000-4000-8000-000000000001') = 'נורה LED', 'undo restores the deleted task');
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'task_edited', 'undo removed the task_deleted line and logged nothing');
select pg_temp.ok(pg_temp.fails($$select undo_restore('members', '[]', array['x'])$$) = '22023', 'undo_restore refuses other tables');
reset role;

-- ================================================================ reminders
select pg_temp.ok(internal.next_occurrence('2027-01-31', 'monthly', null, 31::smallint) = '2027-02-28', 'monthly: 31 Jan -> 28 Feb');
select pg_temp.ok(internal.next_occurrence('2027-02-28', 'monthly', null, 31::smallint) = '2027-03-31', 'monthly: 28 Feb -> 31 Mar (anchor)');
select pg_temp.ok(internal.next_occurrence('2028-01-31', 'monthly', null, 31::smallint) = '2028-02-29', 'monthly: leap year -> 29 Feb');
select pg_temp.ok(internal.next_occurrence('2027-12-15', 'monthly', null, 15::smallint) = '2028-01-15', 'monthly: across the year');
select pg_temp.ok(internal.next_occurrence('2027-01-04', 'days', '{1,4}', null) = '2027-01-07', 'days: Mon -> Thu');
select pg_temp.ok(internal.next_occurrence('2027-01-07', 'days', '{1,4}', null) = '2027-01-11', 'days: Thu -> next Mon');
select pg_temp.ok(internal.next_occurrence('2027-01-07', 'weekly', null, null) = '2027-01-14', 'weekly +7');
select pg_temp.ok(internal.due_at('2027-07-01', '09:00', null) = '2027-07-01 06:00:00+00', 'due_at: summer time is UTC+3');
select pg_temp.ok(internal.due_at('2027-01-01', '09:00', null) = '2027-01-01 07:00:00+00', 'due_at: winter time is UTC+2');

set role authenticated; select set_config('request.jwt.claims', :'naor', false);
insert into reminders (id, title, recipient_id, remind_date, remind_time) values
  ('20000000-0000-4000-8000-000000000001', 'לאסוף כביסה', null, internal.today_il(), '23:59');
insert into reminders (id, title, recipient_id, remind_date, remind_time, repeat, repeat_days) values
  ('20000000-0000-4000-8000-000000000002', 'פח', '11111111-1111-4111-8111-111111111111', internal.today_il(), '20:30', 'days', '{1,4}');
select pg_temp.ok(pg_temp.fails($$insert into reminders (title, remind_date, remind_time, repeat, repeat_days) values ('x', current_date, '10:00', 'days', '{}')$$) = '23514', 'repeat=days needs at least one day');
select pg_temp.ok(pg_temp.fails($$insert into reminders (title, remind_date, remind_time, repeat, repeat_days) values ('x', current_date, '10:00', 'days', '{7}')$$) = '23514', 'weekday must be 0..6');

select complete_reminder('20000000-0000-4000-8000-000000000001');
select pg_temp.ok((select done_at is not null from reminders where id = '20000000-0000-4000-8000-000000000001'), 'one-off reminder closes');
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'rem_done', 'done logged');
select complete_reminder('20000000-0000-4000-8000-000000000002');
select pg_temp.ok((select remind_date > internal.today_il() and extract(dow from remind_date) in (1, 4) and done_at is null
                     from reminders where id = '20000000-0000-4000-8000-000000000002'), 'repeating reminder rolls to the next Mon/Thu after today');
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'rem_done', 'roll logged as done');
select pg_temp.ok(pg_temp.fails($$select complete_reminder('20000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'whatsapp')$$) = '42501', 'the app cannot act for the other member');

select snooze_reminder('20000000-0000-4000-8000-000000000002', 30);
select pg_temp.ok((select abs(extract(epoch from snooze_until - (now() + interval '30 minutes'))) < 5 from reminders where id = '20000000-0000-4000-8000-000000000002'), 'snooze sets +30 minutes');
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'rem_snoozed', 'snooze logged');
select pg_temp.ok((update_checked('reminders', '20000000-0000-4000-8000-000000000002', '{"remind_time":"21:00:00"}', '{"remind_time":"20:30:00"}') -> 'row' ->> 'snooze_until') is null, 'moving the time cancels the snooze');
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'rem_edited', 'reminder edit logged');
reset role;

-- ================================================================ delivery (service role)
delete from reminders;
insert into reminders (id, household_id, title, recipient_id, remind_date, remind_time, created_by, repeat, last_sent_at, snooze_until) values
  -- due a minute ago, for both
  ('30000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'עכשיו לשנינו', null,
     ((now() - interval '1 minute') at time zone 'Asia/Jerusalem')::date, ((now() - interval '1 minute') at time zone 'Asia/Jerusalem')::time, '11111111-1111-4111-8111-111111111111', 'none', null, null),
  -- due 13 hours ago: too old to send
  ('30000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ישן', null,
     ((now() - interval '13 hours') at time zone 'Asia/Jerusalem')::date, ((now() - interval '13 hours') at time zone 'Asia/Jerusalem')::time, '11111111-1111-4111-8111-111111111111', 'none', null, null),
  -- in an hour
  ('30000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'עתידי', '22222222-2222-4222-8222-222222222222',
     ((now() + interval '1 hour') at time zone 'Asia/Jerusalem')::date, ((now() + interval '1 hour') at time zone 'Asia/Jerusalem')::time, '11111111-1111-4111-8111-111111111111', 'none', null, null),
  -- set for later today but snoozed until a minute ago, for maya
  ('30000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'נדחה', '22222222-2222-4222-8222-222222222222',
     ((now() - interval '2 hours') at time zone 'Asia/Jerusalem')::date, ((now() - interval '2 hours') at time zone 'Asia/Jerusalem')::time, '11111111-1111-4111-8111-111111111111', 'none', now() - interval '90 minutes', now() - interval '1 minute'),
  -- weekly, sent 21 hours ago and ignored: should move on
  ('30000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'שבועי שנשכח', null,
     ((now() - interval '21 hours') at time zone 'Asia/Jerusalem')::date, ((now() - interval '21 hours') at time zone 'Asia/Jerusalem')::time, '11111111-1111-4111-8111-111111111111', 'weekly', now() - interval '21 hours', null);

set role service_role; select set_config('request.jwt.claims', :'service', false);
create temp table claimed as select * from claim_due_reminders();
select pg_temp.ok((select count(*) from claimed) = 2, 'claims exactly the two due occurrences');
select pg_temp.ok((select phones from claimed where reminder_id = '30000000-0000-4000-8000-000000000001') = '{+972500000001,+972500000002}', 'reminder for both goes to both phones');
select pg_temp.ok((select phones from claimed where reminder_id = '30000000-0000-4000-8000-000000000004') = '{+972500000002}', 'snoozed reminder for maya goes to maya only');
select pg_temp.ok((select count(*) from claim_due_reminders()) = 0, 'a second run sends nothing again');
select pg_temp.ok((select remind_date > internal.today_il() - 1 and last_sent_at is null from reminders where id = '30000000-0000-4000-8000-000000000005')
                  and (select remind_date from reminders where id = '30000000-0000-4000-8000-000000000005') > ((now() - interval '21 hours') at time zone 'Asia/Jerusalem')::date, 'ignored weekly reminder moved to next week');
select unclaim_reminder('30000000-0000-4000-8000-000000000001');
select pg_temp.ok((select count(*) from claim_due_reminders()) = 1, 'after a failed send it is claimed again');

-- WhatsApp "done" acts for maya and is idempotent
select complete_reminder('30000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'whatsapp');
select pg_temp.ok((select actor_id || '|' || via || '|' || verb from activity order by id desc limit 1) = '22222222-2222-4222-8222-222222222222|whatsapp|rem_done', 'whatsapp done logged for maya via whatsapp');
select pg_temp.ok((select actor_id from activity order by id desc limit 1) = '22222222-2222-4222-8222-222222222222', 'actor kept');
insert into reminders (id, household_id, title, remind_date, remind_time, repeat, last_sent_at, created_by) values
  ('30000000-0000-4000-8000-000000000006', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'יומי', internal.today_il(), '00:00', 'daily', now(), '11111111-1111-4111-8111-111111111111');
select complete_reminder('30000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', 'whatsapp');
select complete_reminder('30000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111', 'whatsapp');
select pg_temp.ok((select remind_date from reminders where id = '30000000-0000-4000-8000-000000000006') = internal.today_il() + 1, 'double tap on WhatsApp rolls a daily reminder only once');
reset role;

-- ================================================================ shopping
set role authenticated; select set_config('request.jwt.claims', :'maya', false);
insert into shopping_items (id, name, qty, category) values
  ('40000000-0000-4000-8000-000000000001', 'חלב', '1', 'מוצרי חלב'),
  ('40000000-0000-4000-8000-000000000002', 'לחם', '1', 'מאפים'),
  ('40000000-0000-4000-8000-000000000003', 'עגבניות', '1 ק״ג', 'פירות וירקות');
update shopping_items set qty = '3' where id = '40000000-0000-4000-8000-000000000001';
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'item_added', 'merged quantity logged as an add');
update shopping_items set checked_at = now() where id in ('40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002');
select pg_temp.ok((select count(*) from activity where verb = 'item_checked') = 2, 'each check logged');
insert into item_categories (name, category) values ('חלב', 'מוצרי חלב') on conflict (household_id, name) do update set category = excluded.category;
select pg_temp.ok((select count(*) from item_categories) = 1, 'category memory stored');
select set_config('test.cart', (select jsonb_agg(to_jsonb(c)) from clear_cart() c)::text, false);
select pg_temp.ok(jsonb_array_length(current_setting('test.cart')::jsonb) = 2 and (select count(*) from shopping_items) = 1, 'clear cart removes the two checked items');
select pg_temp.ok((select verb || '|' || subject from activity order by id desc limit 1) = 'cart_cleared|2', 'one cart_cleared line, no per-item deletes');
select pg_temp.ok((select count(*) from activity where verb = 'item_deleted') = 0, 'no item_deleted lines from clearing');
select undo_restore('shopping_items', current_setting('test.cart')::jsonb, array['cart_cleared']);
select pg_temp.ok((select count(*) from shopping_items where checked_at is not null) = 2, 'undo brings the cart back');
select pg_temp.ok((select count(*) from activity where verb = 'cart_cleared') = 0, 'undo removed the cart_cleared line');
reset role;
set role authenticated; select set_config('request.jwt.claims', :'eve', false);
select pg_temp.ok((select count(*) from shopping_items) = 0 and (select count(*) from item_categories) = 0 and (select count(*) from activity where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 0 and (select count(*) from activity) = 1, 'household 2 sees none of it (only its own log line)');
reset role;

-- ================================================================ audit trail
set role authenticated; select set_config('request.jwt.claims', :'naor', false);
insert into tasks (id, title, due_date) values ('50000000-0000-4000-8000-000000000001', 'בדיקת יומן', current_date);
select pg_temp.ok((select action || '|' || entity || '|' || actor_id || '|' || via || '|' || label from audit_log order by id desc limit 1)
  = 'insert|tasks|11111111-1111-4111-8111-111111111111|app|בדיקת יומן', 'insert audited with actor, source and label');
select update_checked('tasks', '50000000-0000-4000-8000-000000000001', '{"title":"בדיקת יומן 2","due_time":"09:15:00"}', '{"title":"בדיקת יומן","due_time":null}');
select pg_temp.ok((select changes -> 'title' = '["בדיקת יומן","בדיקת יומן 2"]'::jsonb and changes -> 'due_time' = '[null,"09:15:00"]'::jsonb and op = 'edit'
                     from audit_log order by id desc limit 1), 'update audited: every changed field as [old, new], op = edit');
select pg_temp.ok((select not (changes ? 'updated_at') and not (changes ? 'updated_by') from audit_log order by id desc limit 1), 'bookkeeping fields left out of the diff');
update tasks set due_date = due_date where id = '50000000-0000-4000-8000-000000000001';
select pg_temp.ok((select label from audit_log order by id desc limit 1) = 'בדיקת יומן 2' and (select count(*) from audit_log where entity_id = '50000000-0000-4000-8000-000000000001') = 2, 'a no-op update writes nothing');
reset role;
select set_config('test.snap2', (select jsonb_agg(to_jsonb(t)) from tasks t where id = '50000000-0000-4000-8000-000000000001')::text, false);
set role authenticated; select set_config('request.jwt.claims', :'naor', false);
delete from tasks where id = '50000000-0000-4000-8000-000000000001';
select pg_temp.ok((select action || '|' || (changes ->> 'title') from audit_log order by id desc limit 1) = 'delete|בדיקת יומן 2', 'delete audited with the full row');
select undo_restore('tasks', current_setting('test.snap2')::jsonb, array['task_deleted']);
select pg_temp.ok((select action || '|' || op from audit_log order by id desc limit 1) = 'insert|undo', 'undo is itself audited');
select pg_temp.ok((select count(*) from audit_log where entity_id = '50000000-0000-4000-8000-000000000001' and action = 'delete') = 1, 'undo keeps the delete in the audit trail (the feed may hide it)');
select pg_temp.ok((select count(*) from audit_log where entity = 'members' and changes -> 'display_name' = '["מאיה","מאיה כהן"]'::jsonb) = 1, 'member rename audited');
select pg_temp.ok((select count(*) from audit_log where entity = 'shopping_items' and op = 'clear_cart' and action = 'delete') = 2, 'clear cart: each removed item audited');
select pg_temp.ok((select count(*) from audit_log where entity = 'shopping_items' and op = 'undo') >= 2, 'cart undo audited');
select pg_temp.ok((select count(*) from audit_log where entity = 'reminders' and op = 'complete' and via = 'whatsapp' and actor_id = '22222222-2222-4222-8222-222222222222') >= 1, 'WhatsApp done audited for maya via whatsapp');
select pg_temp.ok((select count(*) from audit_log where entity = 'reminders' and op = 'send' and via = 'system' and actor_id is null and changes ? 'last_sent_at') >= 2, 'reminder sending audited as the system');
select pg_temp.ok((select count(*) from audit_log where entity = 'reminders' and op = 'auto_roll') = 1, 'automatic roll-forward audited');
select pg_temp.ok((select count(*) from audit_log where entity = 'item_categories') >= 1, 'saved categories audited');
select log_event('signed_in');
select pg_temp.ok((select action || '|' || entity || '|' || op || '|' || actor_id from audit_log order by id desc limit 1) = 'event|session|signed_in|11111111-1111-4111-8111-111111111111', 'sign-in event recorded');
select pg_temp.ok(pg_temp.fails($$select log_event('hacked')$$) = '22023', 'only known events can be logged');
select pg_temp.ok(pg_temp.fails('update audit_log set op = null') = '42501', 'app cannot edit the audit log');
select pg_temp.ok(pg_temp.fails('delete from audit_log') = '42501', 'app cannot delete from the audit log');
select pg_temp.ok(pg_temp.fails($$insert into audit_log (household_id, action, entity) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'event', 'x')$$) = '42501', 'app cannot forge audit entries');
select pg_temp.ok(pg_temp.fails($$select log_delivery('30000000-0000-4000-8000-000000000001', true, 'x')$$) = '42501', 'app cannot log deliveries');
reset role;
set role service_role; select set_config('request.jwt.claims', :'service', false);
select log_delivery('30000000-0000-4000-8000-000000000001', false, 'WhatsApp 400: template not approved');
select pg_temp.ok((select op || '|' || via || '|' || (changes ->> 'detail') from audit_log order by id desc limit 1) = 'whatsapp_failed|system|WhatsApp 400: template not approved', 'delivery failure recorded');
select pg_temp.ok(pg_temp.fails('delete from audit_log') = '42501', 'even the service role cannot delete audit entries');
reset role;
select pg_temp.ok(pg_temp.fails('update audit_log set op = null') = '42501', 'even the database owner cannot edit audit entries');
set role authenticated; select set_config('request.jwt.claims', :'eve', false);
select pg_temp.ok((select count(*) from audit_log where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') = 0, 'household 2 cannot read household 1''s audit trail');
reset role;

-- ================================================================ saved shopping lists
set role authenticated; select set_config('request.jwt.claims', :'maya', false);
delete from shopping_items;
insert into shopping_items (name, qty, category) values ('חלב', '2', 'מוצרי חלב'), ('בננות', 'אשכול', 'פירות וירקות');
insert into saved_lists (id, name, items) values ('60000000-0000-4000-8000-000000000001', 'קנייה שבועית',
  '[{"name":"חלב","qty":"1","category":"מוצרי חלב"},{"name":"בננות","qty":"2","category":"פירות וירקות"},{"name":"  לחם   מחמצת ","qty":"","category":"מאפים"},{"name":"","qty":"1"}]');
select pg_temp.ok((select verb || '|' || subject || '|' || actor_id from activity order by id desc limit 1) = 'list_saved|קנייה שבועית|22222222-2222-4222-8222-222222222222', 'saving a list is in the feed');
select pg_temp.ok((select action || '|' || entity from audit_log order by id desc limit 1) = 'insert|saved_lists', 'and in the audit trail');
select pg_temp.ok(pg_temp.fails($$insert into saved_lists (name, items) values ('x', '{"not":"an array"}')$$) = '23514', 'items must be an array');
select set_config('test.added', (select load_saved_list('60000000-0000-4000-8000-000000000001'))::text, false);
select pg_temp.ok(cardinality(current_setting('test.added')::uuid[]) = 1, 'load inserts only what is missing (1 new row)');
select pg_temp.ok((select qty from shopping_items where name = 'חלב') = '3', 'numeric quantity merged: 2 + 1 = 3');
select pg_temp.ok((select qty from shopping_items where name = 'בננות') = 'אשכול', 'non-numeric quantity left alone');
select pg_temp.ok((select qty || '|' || category from shopping_items where name = 'לחם מחמצת') = '1|מאפים', 'name normalised, empty qty becomes 1, category kept');
select pg_temp.ok((select count(*) from shopping_items) = 3, 'blank names skipped');
select pg_temp.ok((select verb || '|' || subject from activity order by id desc limit 1) = 'list_loaded|קנייה שבועית'
                  and (select count(*) from activity where verb = 'item_added' and subject = 'לחם מחמצת') = 0, 'one feed line for the whole load');
select pg_temp.ok((select count(*) from audit_log where op = 'load_list') = 2, 'each row the load touched is audited (1 insert + 1 merge)');
select discard_items(current_setting('test.added')::uuid[]);
select pg_temp.ok((select count(*) from shopping_items where name = 'לחם מחמצת') = 0 and (select verb from activity order by id desc limit 1) = 'list_loaded', 'undo of a load removes its rows quietly');
select pg_temp.ok((select op from audit_log order by id desc limit 1) = 'undo', 'and is audited as undo');
select set_config('test.list', (select jsonb_agg(to_jsonb(l)) from saved_lists l)::text, false);
delete from saved_lists where id = '60000000-0000-4000-8000-000000000001';
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'list_deleted', 'deleting a list is in the feed');
select undo_restore('saved_lists', current_setting('test.list')::jsonb, array['list_deleted']);
select pg_temp.ok((select count(*) from saved_lists) = 1 and (select verb from activity order by id desc limit 1) <> 'list_deleted', 'undo brings the list back');
select pg_temp.ok(pg_temp.fails($$select load_saved_list('60000000-0000-4000-8000-0000000000ff')$$) = 'P0002', 'unknown list refused');
reset role;
set role authenticated; select set_config('request.jwt.claims', :'eve', false);
select pg_temp.ok((select count(*) from saved_lists) = 0, 'household 2 cannot see the saved list');
select pg_temp.ok(pg_temp.fails($$select load_saved_list('60000000-0000-4000-8000-000000000001')$$) = 'P0002', 'household 2 cannot load it either');
reset role;

-- ================================================================ item notes
set role authenticated; select set_config('request.jwt.claims', :'naor', false);
insert into shopping_items (id, name, qty, category, note) values ('70000000-0000-4000-8000-000000000001', 'יוגורט', '4', 'מוצרי חלב', 'ללא לקטוז');
select pg_temp.ok((select note from shopping_items where id = '70000000-0000-4000-8000-000000000001') = 'ללא לקטוז', 'item saved with a note');
select pg_temp.ok(pg_temp.fails($$insert into shopping_items (name, note) values ('x', repeat('א', 201))$$) = '23514', 'note is limited to 200 characters');
reset role;
set role authenticated; select set_config('request.jwt.claims', :'maya', false);
select pg_temp.ok((update_checked('shopping_items', '70000000-0000-4000-8000-000000000001', '{"note":"של יטבתה"}', '{"note":"ללא לקטוז"}') -> 'row' ->> 'note') = 'של יטבתה', 'maya edits the note');
select pg_temp.ok((select verb || '|' || subject || '|' || actor_id from activity order by id desc limit 1) = 'item_edited|יוגורט|22222222-2222-4222-8222-222222222222', 'note edit is in the feed as עדכנה פריט');
select pg_temp.ok((select changes -> 'note' from audit_log order by id desc limit 1) = '["ללא לקטוז","של יטבתה"]'::jsonb, 'audit trail has the note old → new');
reset role;
set role authenticated; select set_config('request.jwt.claims', :'naor', false);
select pg_temp.ok((update_checked('shopping_items', '70000000-0000-4000-8000-000000000001', '{"note":"ללא לקטוז, 3%"}', '{"note":"ללא לקטוז"}') -> 'conflict' ->> 'note') = 'של יטבתה', 'stale note edit is a conflict, not an overwrite');
select pg_temp.ok((update_checked('shopping_items', '70000000-0000-4000-8000-000000000001', '{"qty":"6","category":"אחר"}', '{"qty":"4","category":"מוצרי חלב"}') -> 'row' ->> 'qty') = '6', 'other fields of the item can be edited');
select pg_temp.ok(pg_temp.fails($$select update_checked('shopping_items', '70000000-0000-4000-8000-000000000001', '{"category":"לא קיים"}', '{"category":"אחר"}')$$) = '23514', 'invalid category refused');
select pg_temp.ok((update_checked('shopping_items', '70000000-0000-4000-8000-000000000001', '{"household_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}', '{}') -> 'row' ->> 'household_id') = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cannot move an item to another household');
update shopping_items set checked_at = now() where id = '70000000-0000-4000-8000-000000000001';
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'item_checked', 'checking an item is still item_checked, not an edit');
insert into saved_lists (id, name, items) values ('60000000-0000-4000-8000-000000000002', 'עם הערות',
  '[{"name":"גבינה צהובה","qty":"1","category":"מוצרי חלב","note":"פרוסה דק"},{"name":"עגבניות","qty":"1","category":"פירות וירקות","note":""}]');
select load_saved_list('60000000-0000-4000-8000-000000000002');
select pg_temp.ok((select note from shopping_items where name = 'גבינה צהובה') = 'פרוסה דק', 'saved list brings its notes back');
select pg_temp.ok((select note is null from shopping_items where name = 'עגבניות'), 'empty note stays empty');
reset role;

-- ================================================================ current list: open / new / undo
set role authenticated; select set_config('request.jwt.claims', :'maya', false);
select pg_temp.ok((select current_list_id is null from households), 'no current list to begin with');
select set_current_list('60000000-0000-4000-8000-000000000002');
select pg_temp.ok((select current_list_id from households) = '60000000-0000-4000-8000-000000000002', 'current list can be set');
select pg_temp.ok((select op || '|' || entity from audit_log order by id desc limit 1) = 'set_list|households', 'and that is audited');
select pg_temp.ok(pg_temp.fails($$select set_current_list('60000000-0000-4000-8000-0000000000ff')$$) = 'P0002', 'unknown list refused');
select set_config('test.before', (select count(*) from shopping_items)::text, false);
select set_config('test.ll', (select count(*) from activity where verb = 'list_loaded')::text, false);
select set_config('test.open', (select open_saved_list('60000000-0000-4000-8000-000000000001'))::text, false);
select pg_temp.ok((select count(*) from shopping_items) = 3 and (select count(*) from shopping_items where name = 'לחם מחמצת') = 1, 'opening a list replaces the items with the saved ones');
select pg_temp.ok((select current_list_id from households) = '60000000-0000-4000-8000-000000000001', 'the opened list becomes the current one');
select pg_temp.ok((select verb || '|' || subject from activity order by id desc limit 1) = 'list_opened|קנייה שבועית'
                  and (select count(*) from activity where verb = 'list_loaded') = current_setting('test.ll')::int, 'one feed line: list_opened');
select pg_temp.ok(jsonb_array_length(current_setting('test.open')::jsonb -> 'removed') = current_setting('test.before')::int
                  and (current_setting('test.open')::jsonb ->> 'previous') = '60000000-0000-4000-8000-000000000002', 'returns what undo needs');
-- undo of open, the way the app does it
select discard_items(array(select jsonb_array_elements_text(current_setting('test.open')::jsonb -> 'added'))::uuid[]);
select undo_restore('shopping_items', current_setting('test.open')::jsonb -> 'removed', array['list_opened']);
select set_current_list((current_setting('test.open')::jsonb ->> 'previous')::uuid);
select pg_temp.ok((select count(*) from shopping_items) = current_setting('test.before')::int and (select count(*) from shopping_items where name = 'לחם מחמצת') = 0, 'undo of open: previous items back');
select pg_temp.ok((select current_list_id from households) = '60000000-0000-4000-8000-000000000002', 'undo of open: previous current list back');
select set_config('test.new', (select new_shopping_list())::text, false);
select pg_temp.ok((select count(*) from shopping_items) = 0 and (select current_list_id is null from households), 'new list: empty, no current list');
select pg_temp.ok((select verb from activity order by id desc limit 1) = 'list_new', 'new list in the feed');
select undo_restore('shopping_items', current_setting('test.new')::jsonb -> 'removed', array['list_new']);
select set_current_list((current_setting('test.new')::jsonb ->> 'previous')::uuid);
select pg_temp.ok((select count(*) from shopping_items) = current_setting('test.before')::int and (select current_list_id from households) = '60000000-0000-4000-8000-000000000002', 'undo of new list');
delete from saved_lists where id = '60000000-0000-4000-8000-000000000002';
select pg_temp.ok((select current_list_id is null from households), 'deleting the current saved list clears the pointer');
select pg_temp.ok(pg_temp.fails('update households set current_list_id = null') = '42501', 'households can only change through the functions');
reset role;
set role authenticated; select set_config('request.jwt.claims', :'eve', false);
select pg_temp.ok(pg_temp.fails($$select open_saved_list('60000000-0000-4000-8000-000000000001')$$) = 'P0002', 'household 2 cannot open household 1''s list');
select pg_temp.ok(pg_temp.fails($$select set_current_list('60000000-0000-4000-8000-000000000001')$$) = 'P0002', 'or point to it');
reset role;

\echo ALL DB TESTS PASSED
