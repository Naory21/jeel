-- e2e fixtures: one household with two members, a little data, and a second household for isolation
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'naor@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'maya@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'eve@example.com');
insert into households (id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into members (id, household_id, slot, display_name, gender, whatsapp_phone) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'נאור', 'm', '+972500000001'),
  ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, 'מאיה', 'f', '+972500000002'),
  ('33333333-3333-4333-8333-333333333333', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, 'איב', 'f', null);

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', false);
insert into tasks (title, assignee_id, due_date) values
  ('להזמין טכנאי למזגן', null, (now() at time zone 'Asia/Jerusalem')::date),
  ('להחזיר חבילה לדואר', '22222222-2222-4222-8222-222222222222', (now() at time zone 'Asia/Jerusalem')::date + 1);
insert into shopping_items (name, qty, category) values ('חלב 3%', '2', 'מוצרי חלב'), ('בננות', 'אשכול', 'פירות וירקות'), ('לחם', '1', 'מאפים');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}', false);
insert into tasks (title, due_date) values ('סוד של בית אחר', current_date);
select set_config('request.jwt.claims', '', false);
