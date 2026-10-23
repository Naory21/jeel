// Called every minute by pg_cron (see migrations/*_reminder_cron.sql) with the shared x-cron-secret.
// Claims due reminder occurrences and sends them. Deploy with --no-verify-jwt.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { channelFromEnv } from '../_shared/channel.ts';
import { deliver } from '../_shared/deliver.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'forbidden' }, 403);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  let channel;
  try {
    channel = channelFromEnv((k) => Deno.env.get(k));
  } catch (e) {
    return json({ error: (e as Error).message }, 500); // nothing claimed yet, so nothing is lost
  }

  const { data, error } = await db.rpc('claim_due_reminders');
  if (error) return json({ error: error.message }, 500);

  const result = await deliver(data ?? [], channel,
    (id) => db.rpc('unclaim_reminder', { p_id: id }),
    (id, ok, detail) => db.rpc('log_delivery', { p_reminder: id, p_ok: ok, p_detail: detail }));
  if (result.errors.length) console.error(result.errors.join('\n'));
  return json(result);
});
