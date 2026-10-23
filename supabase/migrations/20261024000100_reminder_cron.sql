-- Every minute, ask the send-due-reminders Edge Function to deliver what is due.
-- The project URL and the shared secret live in Supabase Vault (see DEPLOY.md), so nothing secret is in git.
-- Until both secrets exist the job does nothing.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'jeel-send-due-reminders';

select cron.schedule('jeel-send-due-reminders', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'jeel_project_url') || '/functions/v1/send-due-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jeel_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'jeel_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'jeel_project_url');
$job$);
