# הבית שלנו — Handoff for Claude Code

A private, two-person household app: shared tasks, reminders, and a shopping list for Naor and his partner. Hebrew, RTL, mobile-first. Both users see changes in real time. Reminders are delivered over WhatsApp.

The interactive prototype is in `prototype-reference.html`, next to this file. It is the source of truth for screens, copy, colors, and behavior. Its markup uses a custom templating format (`{{…}}` holes, `sc-if`, `sc-for`), so read it as a spec, not as code to port verbatim. The logic class at the bottom of the file shows every state transition.

---

## 1. Scope

**Users:** exactly two, in one household. No public sign-up, no multi-tenant UI. Keep the schema household-scoped anyway, since it costs nothing and keeps the RLS clean.

**In scope (v1):**
- Tasks: create, assign (Naor / partner / both), due bucket (today / tomorrow / this week), complete, delete, filter.
- Reminders: create with day, time, recipient, and optional weekly repeat; complete; delete; WhatsApp delivery at the due time.
- Shopping list: add with quantity and category, check into the cart, clear checked items, show who added each item.
- Home: counts, next reminder today, today's tasks, activity feed.
- Real-time sync between both phones.
- Installable PWA (add to home screen).

**Out of scope (v1):** native apps, offline-first sync, attachments, multiple households, analytics.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript + Tailwind | Simple PWA, deploys free on Vercel |
| Data | Supabase Postgres | Free tier is far beyond two users' needs |
| Realtime | Supabase Realtime (`postgres_changes`) | Live updates on both phones |
| Auth | Supabase Auth, email magic link | No passwords. Two allow-listed emails only |
| Scheduling | `pg_cron` + `pg_net` → Edge Function | Fires due reminders every minute |
| Notifications | WhatsApp Cloud API (Meta), utility template | Push without a native app |
| Hosting | Vercel | Free |

**Expected cost:** about $0 for infra, plus under $2 a month for WhatsApp messages to Israeli numbers. Replies from the user open a free 24-hour window.

**Free-tier caveat:** Supabase pauses free projects after 7 days of inactivity. Daily use prevents this. If it becomes a problem, add a daily keep-alive ping.

---

## 3. Data model

All times are stored in UTC. Display and scheduling logic use `Asia/Jerusalem`.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'הבית שלנו',
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  display_name text not null,
  color text not null,               -- '#2457A6' (Naor) / '#B5531C' (partner)
  whatsapp_phone text,               -- E.164, e.g. +9725XXXXXXXX
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  assignee_id uuid references members(id),   -- null = both (שנינו)
  due_date date not null,                    -- UI buckets map to dates (see §5)
  done_at timestamptz,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  recipient_id uuid references members(id),  -- null = both
  remind_at timestamptz not null,
  repeat text not null default 'none' check (repeat in ('none','daily','weekly','weekdays_custom')),
  repeat_days smallint[],                    -- 0=Sun..6=Sat, used with weekdays_custom
  done_at timestamptz,
  last_sent_at timestamptz,
  created_by uuid not null references members(id),
  created_at timestamptz not null default now()
);

create table shopping_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  qty text not null default '1',             -- free text: '2', '1 ק״ג', 'אשכול'
  category text not null default 'אחר'
    check (category in ('פירות וירקות','מוצרי חלב','מאפים','יבשים','ניקיון ובית','אחר')),
  added_by uuid not null references members(id),
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create table activity (
  id bigint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  actor_id uuid references members(id),     -- null = system (e.g. WhatsApp reply)
  verb text not null,                        -- 'task_added','task_done','item_added', ...
  subject text not null,                     -- the title / item name
  created_at timestamptz not null default now()
);

create index on tasks (household_id, done_at, due_date);
create index on reminders (remind_at) where done_at is null;
create index on shopping_items (household_id, checked_at);
create index on activity (household_id, created_at desc);
```

### Row Level Security

```sql
create or replace function my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from members where id = auth.uid()
$$;

alter table households     enable row level security;
alter table members        enable row level security;
alter table tasks          enable row level security;
alter table reminders      enable row level security;
alter table shopping_items enable row level security;
alter table activity       enable row level security;

create policy "own household" on households     for all using (id = my_household());
create policy "own household" on members        for all using (household_id = my_household());
create policy "own household" on tasks          for all using (household_id = my_household()) with check (household_id = my_household());
create policy "own household" on reminders      for all using (household_id = my_household()) with check (household_id = my_household());
create policy "own household" on shopping_items for all using (household_id = my_household()) with check (household_id = my_household());
create policy "own household" on activity       for select using (household_id = my_household());
```

The activity table is written only by triggers (`security definer`), never by the client. Add `after insert/update/delete` triggers on `tasks`, `reminders`, and `shopping_items` that insert the matching verb.

### Realtime

```sql
alter publication supabase_realtime add table tasks, reminders, shopping_items, activity;
```

### Seeding

There is no sign-up screen. Create both auth users from the Supabase dashboard, using magic-link invites to two allow-listed emails. Then insert one `households` row and two `members` rows by hand. Store the allow-list in an env var, and reject any other email in an auth hook.

---

## 4. Reminders → WhatsApp

### Flow

1. `pg_cron` runs every minute and calls the Edge Function `send-due-reminders` via `pg_net`, using the service-role key.
2. The function selects `reminders where done_at is null and remind_at <= now() and (last_sent_at is null or last_sent_at < remind_at)`.
3. For each one, it resolves recipients (one member, or both if `recipient_id` is null) and sends the utility template to each `whatsapp_phone`.
4. It sets `last_sent_at = now()`. For repeating reminders, it advances `remind_at` to the next occurrence in `Asia/Jerusalem` and clears `done_at`.
5. It is idempotent. Guard with `last_sent_at` and use `select … for update skip locked`.

```sql
select cron.schedule('send-due-reminders', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/send-due-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key'))
  );
$$);
```

### Template (submit in Meta Business Manager, category: Utility, language: he)

- Name: `household_reminder`
- Body: `⏰ תזכורת: {{1}}\nלשעה {{2}}`
- Quick-reply buttons: `בוצע`, `עוד 30 דק׳`
- Put the reminder id in each button payload, e.g. `done:<uuid>` and `snooze:<uuid>`.

### Inbound webhook: Edge Function `whatsapp-webhook`

- `GET`: Meta verification. Echo `hub.challenge` when `hub.verify_token` matches.
- `POST`: verify `X-Hub-Signature-256` with the app secret.
  - `done:<id>` → set `done_at = now()` and write activity with a null actor (shown as "דרך וואטסאפ").
  - `snooze:<id>` → `remind_at = now() + interval '30 minutes'` and `last_sent_at = null`.
  - Free text equal to `בוצע` with no payload → mark the most recently sent open reminder for that phone as done.
- Always return 200 fast. Do the work after acknowledging.

### Meta setup checklist (manual, Naor)

- [ ] Meta Business account + WhatsApp Business app in developers.facebook.com
- [ ] A dedicated phone number not registered on regular WhatsApp (a prepaid SIM is fine)
- [ ] Permanent system-user access token
- [ ] Template `household_reminder` approved
- [ ] Webhook URL pointed at the Edge Function, subscribed to `messages`

**Fallback if Meta setup stalls:** Telegram Bot API. It's free, needs no approvals, and works the same way. Keep the sender behind a `NotificationChannel` interface so the switch is one file.

---

## 5. Frontend spec

### Global

- `<html lang="he" dir="rtl">`. Use logical CSS properties (`ms-*`/`me-*`, `ps-*`/`pe-*`, `start`/`end`) everywhere.
- Font: Rubik 400/500/600/700 via `next/font/google` with the `hebrew` subset.
- Mobile-first layout. Content max-width is 480px, centered on desktop.
- Bottom tab bar with four tabs: בית, משימות, תזכורות, קניות. The shopping tab shows a badge with the count of open items.
- Every interactive target is at least 44×44px.
- Use optimistic updates on every mutation, reconciled by Realtime events.

### Design tokens (from the prototype)

| Token | Value | Use |
|---|---|---|
| `ground` | `#EEF1F4` | App background |
| `surface` | `#FFFFFF` | Cards |
| `ink` | `#18212B` | Text, primary buttons, checked boxes |
| `muted` | `#56616E` | Secondary text |
| `line` | `#EDF0F3` | Row dividers |
| `field-border` | `#C9D0D8` | Inputs, unselected pills |
| `checkbox-border` | `#7D8792` | Unchecked boxes |
| `done-text` | `#5E6873` | Struck-through titles |
| `due-today` | `#9A4515` | "היום" label on open tasks |
| Naor | solid `#2457A6`, tint `#E3ECF8`, text `#1D4A8F` | Avatar, chips |
| Partner | solid `#B5531C`, tint `#F8E9DF`, text `#8F3F12` | Avatar, chips |
| Both | solid `#5B4AA0`, tint `#ECE8F6`, text `#4A3B8C` | Chips |

Radii: cards 18px, the dark hero card 20px, inputs and buttons 12px, pills 999px. Card shadow: `0 1px 2px rgba(24,33,43,0.06)`.

### Due buckets → dates (Asia/Jerusalem)

- היום = today
- מחר = today + 1
- השבוע = the coming Saturday. If today is Saturday, use today + 7.

When displaying a task, derive the bucket back from `due_date`. Overdue open tasks show "באיחור" in `due-today` color, sorted first.

### Screens

**בית (Home)**
- Three stat tiles: open tasks, open reminders today, and open shopping items. Each tile navigates to its tab.
- Dark hero card with the next open reminder today: title, time, recipient, and a "בוצע" button. Empty state: "אין עוד תזכורות להיום. ערב רגוע."
- Card "משימות להיום" lists open tasks due today, with checkboxes. Empty state: "הכול סגור להיום."
- Card "עדכונים אחרונים" shows the 4 latest activity rows: actor avatar, actor name in bold, the action text, and relative time.

**משימות (Tasks)**
- Filter chips: הכל / שלי / {partner} / משותף, each with a count of open tasks.
- Composer card: text input (Enter submits), assignee pills (Naor / partner / both), due pills (היום / מחר / השבוע), and a + button.
- Card "פתוחות · n", sorted by due date. Card "הושלמו · n" holds struck-through tasks, which can be toggled back.
- Row: checkbox, title, assignee chip, due label, and an × delete button.

**תזכורות (Reminders)**
- Composer: text, day pills, `<input type="time">` (default 19:00), a "חוזרת כל שבוע" toggle, and recipient pills.
- List grouped by היום / מחר / השבוע. Open items first by time, then done items.
- Row: round checkbox, title, time with clock icon, recipient chip, repeat tag, and delete.

**קניות (Shopping)**
- Dark progress card: "נאספו X מתוך Y" with a bar.
- Composer: name, qty (free text, default "1"), category `<select>`, and +.
- One card per category with open items. Row: checkbox, name, qty chip, initial-avatar of the person who added it, and delete.
- Card "בעגלה · n" holds checked items, with a "ניקוי מהרשימה" button that deletes all checked items.
- Empty state: "הרשימה ריקה."

### Copy rules

- Gendered verbs in the activity feed: Naor is masculine (הוסיף, סימן), and the partner is feminine (הוסיפה, סימנה). Store a `grammatical_gender` on `members`, or derive it from a per-member setting.
- Hebrew abbreviations use gershayim and geresh (ק״ג, דק׳), not ASCII quotes.

---

## 6. Suggested repo layout

```
/app
  layout.tsx            # RTL, font, PWA meta
  (app)/page.tsx        # Home
  (app)/tasks/page.tsx
  (app)/reminders/page.tsx
  (app)/shopping/page.tsx
  login/page.tsx        # magic link
/components             # TaskRow, ReminderRow, ItemRow, Pills, Composer, BottomNav, StatTile
/lib
  supabase/{client,server}.ts
  dates.ts              # bucket <-> date, Asia/Jerusalem
  realtime.ts           # one channel per table, scoped by household_id
/supabase
  migrations/0001_init.sql
  functions/send-due-reminders/index.ts
  functions/whatsapp-webhook/index.ts
  seed.sql
/public/manifest.webmanifest, icons
CLAUDE.md
```

---

## 7. Environment variables

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=            # Edge Functions only, never in the browser
ALLOWED_EMAILS=naor@…,partner@…
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_TEMPLATE_NAME=household_reminder
APP_TIMEZONE=Asia/Jerusalem
```

---

## 8. Milestones

Each milestone ends deployable.

**M0 — Scaffold.** Next.js, Tailwind tokens, RTL layout, bottom nav, and empty screens deployed to Vercel.
Done when: the app loads on both phones and can be added to the home screen.

**M1 — Data + auth.** Migration, RLS, magic-link login, allow-list, and seeded household.
Done when: both users can log in, a third email is rejected, and the anon key cannot read another household's rows (test with a second dummy household).

**M2 — Shopping list.** This ships first because it's the most-used feature in practice.
Done when: an item added on one phone appears on the other in under 2 seconds, and check, clear, and delete all sync.

**M3 — Tasks.** Includes filters and due buckets.
Done when: bucket math is correct across midnight and Saturday in Asia/Jerusalem (unit-test `dates.ts`).

**M4 — Reminders + WhatsApp.**
Done when: a reminder set two minutes ahead arrives on WhatsApp. "בוצע" from WhatsApp marks it done in the app live. Snooze re-sends after 30 minutes. A weekly reminder rolls forward correctly. No duplicate sends occur when the cron overlaps.

**M5 — Home + activity feed.** Stat tiles, next reminder, today's tasks, and the feed with gendered copy.
Done when: every mutation from either user, or from WhatsApp, shows in the feed.

---

## 9. Open decisions (confirm with Naor)

- Partner's display name and WhatsApp number. The prototype uses the placeholder "בת הזוג".
- The dedicated WhatsApp sender number, or fall back to Telegram.
- Whether reminders for "both" go to both phones (the current assumption) or only to the creator.
- Reminder recurrence: v1 ships `none` and `weekly`. Should "every day" and custom weekdays (the prototype shows "כל שני וחמישי") be in v1?

---

## 10. Suggested CLAUDE.md

```md
# הבית שלנו
Two-person Hebrew RTL household app. Spec: HANDOFF.md. UI reference: prototype-reference.html.

- Always RTL. Use logical properties only (ms/me, ps/pe, start/end). Never left/right.
- Timezone is Asia/Jerusalem for every date decision. Store UTC.
- Every table is household-scoped. Never bypass RLS from the browser.
- Service-role key lives only in Edge Functions.
- Optimistic UI + Realtime reconciliation for every mutation.
- Hebrew copy: gershayim/geresh, gendered verbs per member.
- Run `supabase db reset` + tests before every commit that touches migrations.
```
