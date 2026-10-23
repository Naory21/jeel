# Jeel

A private, two-person household app: shared tasks, reminders and a shopping list.
It's in Hebrew, right-to-left and mobile-first, with live sync between both phones and reminders on WhatsApp.

- To deploy, follow `DEPLOY.md`.
- The original product spec is `docs/HANDOFF.md`. The UI reference is `docs/prototype-reference.html`, which is a spec, not runnable.

## Architecture (decided; don't migrate it to the HANDOFF's Next.js plan)

- **`web/index.html`:** the whole app, vanilla JS with no build step. Static hosting on GitHub Pages.
  `web/config.js` (git-ignored, written by `.github/workflows/pages.yml`) selects the backend:
  - **Supabase** (production): supabase-js 2.49.4 from jsDelivr, email OTP / magic-link login, Realtime → reload.
  - **Local** (no config): `server.js`, a zero-dependency Node server with `db.json` and Server-Sent Events. Used for development and the UI tests.

  Both implement one interface, `backend.call(op, args)`, which returns `{ state, undo?, note? } | { conflict } | { error }` and throws only when offline.
- **`supabase/migrations/`:** the whole data model and access control.
  - Row-level security keyed on `my_household()`.
  - The activity log is written only by triggers.
  - Repeat rules, conflict-checked edits (`update_checked`), undo (`undo_restore`), `clear_cart`, and the scheduler claim (`claim_due_reminders`, `for update skip locked`).
- **Audit trail** (`*_audit_trail.sql`): `audit_log` is append-only.
  - It's written by one generic trigger on every table, plus `log_event` (sign-in / sign-out) and `log_delivery` (WhatsApp results).
  - Updates store `{field: [old, new]}`.
  - RPCs tag what the user did via `set_config('jeel.op', …)` and `jeel.via`.
  - The friendly `activity` feed is separate: it may hide lines on undo; the audit trail never does.
  - `server.js` mirrors this as `db.audit`, which is served page by page from `/api/audit` and never shipped with the state.
- **Saved shopping lists** (`*_saved_lists.sql`, `*_current_list.sql`):
  - `saved_lists` + `load_saved_list()` (הוספה: merges quantities, one feed line, returns inserted ids for undo) + `discard_items()`.
  - `households.current_list_id` is the list on screen. Change it only through `set_current_list` / `open_saved_list` (פתיחה: replaces the items) / `new_shopping_list`.
- **Item notes** (`*_item_notes.sql`): `shopping_items.note`, editable through `update_checked` like tasks.
- **`supabase/functions/`:** `send-due-reminders` (called every minute by pg_cron with `x-cron-secret`) and `whatsapp-webhook` (Meta signature check; acts for the member who replied).
  The logic lives in `_shared/*.ts` so it can be tested under Node.

## Rules

- Always right-to-left. Use logical CSS properties only (`inset-inline-*`, `margin-inline-*`, `padding-inline`, `start`/`end`). Never left/right.
- **Time zone is Asia/Jerusalem for every date decision.** Reminders store a local `remind_date` + `remind_time`, because repeats are calendar rules. Instants are `timestamptz`.
  - "השבוע" = the coming Saturday.
  - On Friday and Saturday it means next week's Saturday, and the button reads "שבוע הבא".
- Every table is household-scoped. Never bypass row-level security from the browser.
  - The service-role key lives only in Edge Function secrets and in the one-off `scripts/setup-household.mjs`.
  - Only the anon / publishable key ships to the browser.
- **Every new table gets the audit trigger**: `create trigger audit after insert or update or delete on … execute function internal.audit_row();`. Every new RPC sets `jeel.op`. Add matching checks to `tests/db/db.test.sql`.
- Each user's add is tagged with a client-generated UUID, so a retried add from the offline outbox is a no-op.
- Edits send only the changed fields plus the values the editor started from. A different value on the server means a conflict, never a silent overwrite.
- Hebrew copy:
  - Use gershayim and geresh (ק״ג, דק׳), never ASCII quotes.
  - Activity verbs follow each member's `gender` (הוסיף / הוסיפה).
  - Write "הכול".
- Every tap target is at least 44×44px. Inputs use 16px text, so iOS doesn't zoom.

## Tests (run before every commit that touches these areas)

```bash
node --test tests/functions/functions.test.ts   # Edge Function logic
node tests/db/run.mjs                           # migrations + security + reminder logic, Postgres in Docker
node tests/e2e/run.mjs                          # real page + supabase-js against PostgREST, headless Chrome
```

When you add a migration, add the matching checks to `tests/db/db.test.sql`. The scheduler migration (`*_reminder_cron.sql`) is Supabase-only, so it isn't covered by these tests.
