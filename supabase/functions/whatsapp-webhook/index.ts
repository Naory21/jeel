// WhatsApp Cloud API webhook. GET = Meta's verification handshake; POST = incoming messages
// (the בוצע / עוד 30 דק׳ buttons, or a typed "בוצע"). Deploy with --no-verify-jwt.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handleActions, parseActions, verifySignature } from '../_shared/webhook.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const deps = {
  async memberByPhone(digits: string) {
    const { data } = await db.from('members').select('id, household_id').eq('whatsapp_phone', `+${digits}`).maybeSingle();
    return data;
  },
  async reminderHousehold(id: string) {
    const { data } = await db.from('reminders').select('household_id').eq('id', id).maybeSingle();
    return data?.household_id ?? null;
  },
  async latestSentFor(member: { id: string; household_id: string }) {
    const { data } = await db.from('reminders').select('id')
      .eq('household_id', member.household_id).is('done_at', null).not('last_sent_at', 'is', null)
      .or(`recipient_id.is.null,recipient_id.eq.${member.id}`)
      .order('last_sent_at', { ascending: false }).limit(1).maybeSingle();
    return data?.id ?? null;
  },
  async complete(id: string, actor: string) {
    const { error } = await db.rpc('complete_reminder', { p_id: id, p_actor: actor, p_via: 'whatsapp' });
    if (error) throw new Error(error.message);
  },
  async snooze(id: string, actor: string) {
    const { error } = await db.rpc('snooze_reminder', { p_id: id, p_minutes: 30, p_actor: actor, p_via: 'whatsapp' });
    if (error) throw new Error(error.message);
  }
};

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe'
      && url.searchParams.get('hub.verify_token') === Deno.env.get('WHATSAPP_VERIFY_TOKEN');
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '') : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get('x-hub-signature-256'), Deno.env.get('WHATSAPP_APP_SECRET') ?? ''))) {
    return new Response('bad signature', { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  // answer Meta right away; do the work after
  const work = handleActions(parseActions(payload), deps)
    .then((log) => log.length && console.log(log.join('\n')))
    .catch((e) => console.error('webhook action failed:', e));
  EdgeRuntime.waitUntil(work);
  return new Response('ok');
});
