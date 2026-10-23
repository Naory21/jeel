# Jeel

<img src="web/icons/icon.svg" width="72" alt="Jeel logo" align="left">

Shared tasks, reminders and a shopping list for a household of two.
It's in Hebrew, right-to-left and built for phones, with live sync between both people and reminders on WhatsApp.

<br clear="left">

## What it does

- **Tasks:** assign to me, my partner, or both, with a date (shortcuts or a calendar) and an optional time.
  Edit, filter, mark done, and undo.
- **Reminders:** a date and time, with optional repeat: daily, weekly, monthly, or fixed weekdays ("כל שני וחמישי").
  Overdue reminders are flagged, you can snooze for 30 minutes, and reminders arrive on WhatsApp with **בוצע** / **עוד 30 דק׳** buttons.
- **Shopping:** grouped by store aisle, with the category guessed and remembered.
  Adding the same item again merges the quantities, and a checked item stays put for a moment before it moves to the cart.
- **Saved lists:** save the shopping list under a name ("קנייה שבועית"). The list bar shows which list is on screen and whether it changed since saving.
  **פתיחה** shows a saved list, **הוספה** merges it into the current one (quantities added), and **רשימה חדשה** starts empty.
- **Notes on items:** "ללא לקטוז", "המותג הכחול". Add them with the item or edit later with ✎. They are kept in saved lists.
- **Home:** what's next, today's tasks, and an activity feed in correct Hebrew for each person.
- **Audit trail (⚙ הגדרות → "יומן פעולות"):** every action, by whom, when, from where (app / WhatsApp / system), and each changed field from old to new.
  Nobody can edit or delete it, and undo is recorded rather than erased.
- **Look:** light and dark mode, following the phone or chosen in ⚙ הגדרות. Tasks can be sorted by any field.
- **Offline:** anything you add without a connection is kept and sent when you're back online.
  Two people editing the same field at once get a warning instead of a silent overwrite.

## Run it locally (no accounts needed)

```bash
node server.js --open      # or double-click start.bat on Windows
```

This serves `web/` at http://localhost:8787 with demo data in `db.json`. Phones on the same Wi-Fi can use the address it prints.

## Layout

```
web/                  the app (index.html), service worker, manifest, icons
server.js             local development server
supabase/
  migrations/         schema, row-level security, triggers, RPCs, every-minute scheduler
  functions/          send-due-reminders, whatsapp-webhook (+ _shared logic)
  templates/          the login email (code + link)
scripts/              setup-household.mjs: creates the two logins and the household
tests/                functions (Node), db (Postgres in Docker), e2e (PostgREST + headless Chrome)
brand/                the logo
docs/                 the original handoff spec and the UI prototype
.github/workflows/    Pages deploy, tests, daily keep-alive
```

## Deploy

See **[DEPLOY.md](DEPLOY.md)**. It needs GitHub Pages, a free Supabase project, and, for reminders, the WhatsApp Cloud API.
Running costs are about $0, plus a few cents a month in WhatsApp messages.
