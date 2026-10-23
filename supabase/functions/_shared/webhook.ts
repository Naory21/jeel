// Inbound WhatsApp webhook: signature check and turning Meta's payload into actions.

const enc = new TextEncoder();

// Meta signs the raw body with the app secret: header "sha256=<hex>"
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header || !header.startsWith('sha256=') || !appSecret) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export type Action =
  | { from: string; kind: 'done' | 'snooze'; reminderId: string }
  | { from: string; kind: 'done-latest' };

const PAYLOAD = /^(done|snooze):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DONE_WORDS = new Set(['בוצע', 'בוצע!', 'done', 'ok בוצע']);

export const phoneDigits = (s: string) => s.replace(/\D/g, '');

// deno-lint-ignore no-explicit-any
export function parseActions(payload: any): Action[] {
  const out: Action[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      for (const m of change?.value?.messages ?? []) {
        const from = phoneDigits(String(m?.from ?? ''));
        if (!from) continue;
        const pressed = m.type === 'button' ? m.button?.payload : m.type === 'interactive' ? m.interactive?.button_reply?.id : null;
        const hit = typeof pressed === 'string' ? PAYLOAD.exec(pressed.trim()) : null;
        if (hit) {
          out.push({ from, kind: hit[1].toLowerCase() as 'done' | 'snooze', reminderId: hit[2].toLowerCase() });
        } else if (m.type === 'text' && DONE_WORDS.has(String(m.text?.body ?? '').trim().toLowerCase())) {
          out.push({ from, kind: 'done-latest' });
        }
      }
    }
  }
  return out;
}

export interface ActionDeps {
  memberByPhone(digits: string): Promise<{ id: string; household_id: string } | null>;
  reminderHousehold(reminderId: string): Promise<string | null>;
  latestSentFor(member: { id: string; household_id: string }): Promise<string | null>;
  complete(reminderId: string, actorId: string): Promise<void>;
  snooze(reminderId: string, actorId: string): Promise<void>;
}

// apply actions; replies from unknown numbers or about another household's reminders are ignored
export async function handleActions(actions: Action[], deps: ActionDeps): Promise<string[]> {
  const log: string[] = [];
  for (const a of actions) {
    const member = await deps.memberByPhone(a.from);
    if (!member) { log.push(`ignored: unknown number`); continue; }
    const id = a.kind === 'done-latest' ? await deps.latestSentFor(member) : a.reminderId;
    if (!id) { log.push(`ignored: nothing recently sent`); continue; }
    if ((await deps.reminderHousehold(id)) !== member.household_id) { log.push(`ignored: not this household`); continue; }
    if (a.kind === 'snooze') await deps.snooze(id, member.id);
    else await deps.complete(id, member.id);
    log.push(`${a.kind} ${id}`);
  }
  return log;
}
