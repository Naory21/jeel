# Deploying Jeel

This runbook is for **Claude Code running under Naor's personal account**, working together with Naor.
It takes the finished, tested project in this folder to production:

- the app on **GitHub Pages**,
- data, login and the reminder scheduler on **Supabase** (free plan),
- reminders delivered by **WhatsApp**.

Steps marked **👤 Naor** need a person: a browser sign-in, a payment-free account signup, or a phone. Do the rest yourself.
Stop and ask whenever a step fails in a way this file doesn't cover.

## Ground rules

- **Personal accounts only.** Work only in this folder, and only with Naor's *personal* GitHub and Supabase accounts.
  This computer may also be signed in to work accounts:
  - Check `gh auth status` before any GitHub command.
  - The global git identity here may be a work one. Set a repo-local identity in step 2.
- **Never commit or paste secrets.** That means the service-role / secret key, `CRON_SECRET`, the WhatsApp tokens, and `web/config.js`.
  `.gitignore` already excludes `db.json`, `web/config.js` and `.env*`.
  The Supabase URL and the anon / publishable key are public by design. The database's row-level security protects the data.
- **Don't change the architecture.** `docs/HANDOFF.md` was the original plan (Next.js on Vercel). The app was then deliberately built as a single static page plus Supabase. Read `CLAUDE.md` first.

## 0. Check the tools

```bash
node --version        # needs 24+
git --version
gh --version
npx --yes supabase@latest --version   # Supabase CLI via npx; nothing to install
docker info           # optional: only for the database / end-to-end tests
```

Run the tests once. The first command needs no Docker; the other two need Docker, and the last also needs Chrome:

```bash
node --test tests/functions/functions.test.ts   # WhatsApp logic: 7 tests
node tests/db/run.mjs                           # database: ~110 checks in a throwaway Postgres container
node tests/e2e/run.mjs                          # the real page + supabase-js against Postgres/PostgREST: ~50 checks
```

## 1. Decide: public or private repository (👤 Naor)

GitHub Pages is free only for **public** repositories. Pages on a private repository needs GitHub Pro (about $4/month).

| Option | Cost | Notes |
|---|---|---|
| **Public repo + GitHub Pages** (recommended) | $0 | The code contains no secrets and no personal data. Names and data live only in Supabase. |
| Private repo + GitHub Pro | ~$4/mo | Same setup, just flip the repo to private. |
| Private repo + Cloudflare Pages | $0 | Connect the repo in Cloudflare and publish the `web/` folder. `web/config.js` must then be created by a Cloudflare build command instead of `pages.yml`. Only do this if Naor insists. |

Ask Naor which one. The rest of this file assumes the first or second option.

## 2. Create the GitHub repository (👤 Naor for the login)

```bash
gh auth status                          # which accounts are logged in?
gh auth login                           # 👤 only if the personal account isn't there: GitHub.com → HTTPS → browser
gh auth switch --user <personal-user>   # make the personal account active

git init -b main
git config user.name  "<Naor's name>"
git config user.email "<personal email, or <id>+<user>@users.noreply.github.com>"
git add -A
git status   # check: no db.json, no web/config.js, no .env
git commit -m "Jeel: initial version"
gh repo create <personal-user>/jeel --public --source . --remote origin --push   # or --private (see step 1)
```

Write the commit message in plain words. If this computer's `gh` was on a work account before, switch back afterwards with `gh auth switch --user <work-user>`, so Naor's work repos keep working.

## 3. Create the Supabase project (👤 Naor)

1. 👤 Sign up or sign in at https://supabase.com/dashboard with a **personal** account and create a project:
   - Name: `jeel`
   - Region: **Central EU (Frankfurt)**, the closest to Israel
   - A strong database password. Naor keeps it.
   - Free plan.
2. From **Project Settings → API**, note:
   - **Project URL**: `https://<ref>.supabase.co`
   - **anon / publishable key**: public; goes into GitHub variables
   - **service_role / secret key**: secret; used only in your shell in step 6. Never commit it.
3. Link the folder and apply the database:

```bash
npx supabase login                         # 👤 browser
npx supabase link --project-ref <ref>      # asks for the database password
npx supabase db push                       # applies supabase/migrations/* (tables, security, scheduler)
```

4. Store the two values the every-minute scheduler needs in Supabase Vault (**SQL Editor** in the dashboard).
   Generate the secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep it for step 5.

```sql
select vault.create_secret('https://<ref>.supabase.co', 'jeel_project_url');
select vault.create_secret('<the random secret>', 'jeel_cron_secret');
```

## 4. Login settings (👤 Naor clicks, or you guide)

In the dashboard, under **Authentication**:

- **Sign In / Providers → Email:**
  - Enabled.
  - **"Allow new users to sign up" = OFF.** Only the two accounts from step 6 can ever sign in.
  - Email OTP length 6.
- **URL Configuration:**
  - Site URL = `https://<personal-user>.github.io/jeel/`
  - Add the same address to **Redirect URLs**.
- **Emails → Magic Link:**
  - Subject: `קוד הכניסה שלך ל-Jeel`
  - Body: paste the contents of `supabase/templates/magic_link.html`. It contains both the 6-digit code and the link. The code matters on iPhone, because a link opened from Mail doesn't sign in the home-screen app.
- **Emails → SMTP Settings: required.** Supabase's built-in mailer sends only to members of the Supabase organisation, a few emails an hour, so the partner would never get a code. Either option below works:
  - **Gmail:**
    - Turn on 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords.
    - Host `smtp.gmail.com`, port `587`, username = the Gmail address, password = the app password.
    - Sender name `Jeel`.
  - **Brevo (free, 300 emails a day):** verify a single sender address, then use their SMTP credentials.

## 5. Edge Functions (reminder sending + WhatsApp replies)

Start in **log mode**, so reminders are only written to the function log until WhatsApp is ready in step 9:

```bash
npx supabase secrets set CRON_SECRET=<the same random secret as in Vault> NOTIFY_CHANNEL=log
npx supabase functions deploy send-due-reminders --no-verify-jwt
npx supabase functions deploy whatsapp-webhook --no-verify-jwt
```

Check after a couple of minutes, in the **SQL Editor**:

```sql
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;   -- "succeeded"
select status_code, content from net._http_response order by created desc limit 5;                      -- 200 {"claimed":0,...}
```

A 403 means the Vault secret and `CRON_SECRET` don't match.

## 6. Create the two logins and the household

Sign-up is closed, so the accounts are created here. Run it in your shell. The service key is used only for this command; don't save it to a file.

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service_role or secret key> \
NAOR_EMAIL=<Naor's email> PARTNER_EMAIL=<partner's email> PARTNER_NAME=<partner's first name> \
NAOR_PHONE=+9725XXXXXXXX PARTNER_PHONE=+9725XXXXXXXX \
node scripts/setup-household.mjs
```

- Phones are optional now. Re-run with the same values plus phones at any time; the script is safe to repeat.
- Slot 1 (blue avatar) is Naor, slot 2 (orange) is the partner. `PARTNER_GENDER=m` switches the activity text to masculine verbs.

## 7. Publish the app

```bash
gh variable set SUPABASE_URL --body "https://<ref>.supabase.co"
gh variable set SUPABASE_ANON_KEY --body "<anon / publishable key>"
gh api -X POST repos/<personal-user>/jeel/pages -f build_type=workflow   # turn on Pages with GitHub Actions
gh workflow run "Deploy app" && gh run watch
```

The app is now at `https://<personal-user>.github.io/jeel/`. Pushes that change `web/` redeploy it automatically. The "Keep Supabase awake" workflow pings the project daily, using the same two variables.

## 8. First sign-in on both phones (👤 Naor and partner)

On each phone:
1. Open the address **in Safari** (iPhone) or **Chrome** (Android).
2. Enter your email and type the 6-digit code from the email.
3. Then **Share → Add to Home Screen** (iPhone) or **Install app** (Android).
4. Sign in again inside the home-screen app if it asks; on iPhone it keeps a separate session.

## 9. WhatsApp reminders (👤 Naor; takes hours to days because of Meta's approval)

1. 👤 At https://developers.facebook.com, create an app of type **Business** and add the **WhatsApp** product.
2. 👤 Add a phone number that is **not** registered on regular WhatsApp (a prepaid SIM is fine) and verify it by SMS.
   Note the **Phone number ID**.
3. 👤 In Business Settings → System users, create a system user with full control of the app. Generate a **permanent token** with `whatsapp_business_messaging` and `whatsapp_business_management`.
4. 👤 Create the message template in WhatsApp Manager:

   | Field | Value |
   |---|---|
   | Name | `household_reminder` |
   | Category | **Utility** |
   | Language | **Hebrew (he)** |
   | Body | `⏰ תזכורת: {{1}}` (new line) `לשעה {{2}}` |
   | Buttons | two **Quick reply** buttons: `בוצע` and `עוד 30 דק׳` |

   Wait for "Approved".
5. Set the secrets and turn on real sending:

```bash
npx supabase secrets set \
  WHATSAPP_PHONE_NUMBER_ID=<id> WHATSAPP_ACCESS_TOKEN=<permanent token> \
  WHATSAPP_APP_SECRET=<App settings → Basic → App secret> WHATSAPP_VERIFY_TOKEN=<any random string> \
  WHATSAPP_TEMPLATE_NAME=household_reminder WHATSAPP_TEMPLATE_LANG=he NOTIFY_CHANNEL=whatsapp
```

6. 👤 In the Meta app → WhatsApp → Configuration → Webhook:
   - Callback URL `https://<ref>.supabase.co/functions/v1/whatsapp-webhook`
   - Verify token: the same `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to **messages**.
7. Make sure both phones are saved on the members (step 6 with `NAOR_PHONE` / `PARTNER_PHONE`, in `+972…` form).
8. Each person sends any message to the business number once. Meta needs this before replies work smoothly, and it opens the free 24-hour window.

If Meta approval stalls, the sender sits behind one interface (`supabase/functions/_shared/channel.ts`). A Telegram channel is a single new class plus `NOTIFY_CHANNEL=telegram`.

## 10. Acceptance checklist (from the original plan)

Run through it together with Naor and tick each line:

- [ ] Both people can sign in. A third email address gets "הכתובת הזו לא מורשית".
- [ ] An item added on one phone appears on the other within ~2 seconds. Check, clear and delete all sync.
- [ ] Undo works after delete, done, and "סיום קנייה".
- [ ] A task due "השבוע" lands on the coming Saturday. On Friday the button reads "שבוע הבא".
- [ ] A reminder set 2 minutes ahead arrives on WhatsApp.
- [ ] Tapping **בוצע** in WhatsApp marks it done in the app, and the feed says "… בוואטסאפ".
- [ ] **עוד 30 דק׳** sends it again 30 minutes later.
- [ ] A weekly reminder marked done moves to next week.
- [ ] No duplicate messages arrive. The scheduler is safe to run concurrently; check `net._http_response` for errors.
- [ ] Every change, from either phone or from WhatsApp, shows in the activity feed with the right name and verb form.
- [ ] **⚙ הגדרות → יומן פעולות** lists every action. That includes sign-in and the WhatsApp sends ("תזכורת נשלחה בוואטסאפ"), and edits show old → new.
- [ ] A saved shopping list can be added back. Items already on the list get their quantities merged.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "הכתובת הזו לא מורשית" for Naor or the partner | The login wasn't created (step 6), or the email has a typo. |
| No email arrives | SMTP isn't set (step 4), or it's in spam. Check Authentication → Logs. |
| Signed in, but "החשבון הזה לא משויך לבית" | The member row is missing. Re-run step 6. |
| App shows the local-server mode / can't connect | The repository variables are missing. Re-run the "Deploy app" workflow after step 7. |
| `cron.job_run_details` empty | `db push` didn't apply the scheduler migration, or the pg_cron extension is disabled (Database → Extensions). |
| HTTP 403 from send-due-reminders | `CRON_SECRET` ≠ the Vault `jeel_cron_secret`. |
| WhatsApp 400 "template" | The template isn't approved yet, or its name/language doesn't match the secrets. |
| Webhook verification fails in Meta | `WHATSAPP_VERIFY_TOKEN` mismatch, or the function was deployed without `--no-verify-jwt`. |

## Later changes

- **App:** edit `web/`, test locally with `node server.js` (no Supabase needed), then push. Pages redeploys.
- **Database:**
  1. Add a new file in `supabase/migrations/`; never edit an applied one.
  2. Run `node tests/db/run.mjs`.
  3. Run `npx supabase db push`.
- **Functions:** edit, run `node --test tests/functions/functions.test.ts`, then `npx supabase functions deploy <name> --no-verify-jwt`.
