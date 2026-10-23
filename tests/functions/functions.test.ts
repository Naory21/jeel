// Edge Function logic, run under Node: node --test tests/functions/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateMessage, channelFromEnv, LogChannel, WhatsAppChannel } from '../../supabase/functions/_shared/channel.ts';
import { deliver } from '../../supabase/functions/_shared/deliver.ts';
import { handleActions, parseActions, verifySignature } from '../../supabase/functions/_shared/webhook.ts';

const RID = '0f8b5c7e-1d2a-4b3c-9e8f-7a6b5c4d3e2f';
const sign = async (body: string, secret: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
};
const inbound = (messages: unknown[]) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages } }] }] });

test('template message carries title, time and both button payloads', () => {
  const m = buildTemplateMessage('+972 50-000-0001', { reminderId: RID, title: 'להוציא\nאת   הפח', time: '20:30' }, 'household_reminder', 'he');
  assert.equal(m.to, '972500000001');
  assert.equal(m.template.name, 'household_reminder');
  assert.equal(m.template.language.code, 'he');
  assert.deepEqual(m.template.components[0].parameters.map((p: { text: string }) => p.text), ['להוציא את הפח', '20:30']);
  assert.equal(m.template.components[1].parameters[0].payload, `done:${RID}`);
  assert.equal(m.template.components[2].parameters[0].payload, `snooze:${RID}`);
});

test('WhatsApp channel posts to the Graph API and surfaces errors', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = new WhatsAppChannel({ phoneNumberId: '123', accessToken: 'tok', template: 't', language: 'he', apiVersion: 'v21.0' },
    (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); }) as typeof fetch);
  await ok.send('+972500000001', { reminderId: RID, title: 'x', time: '09:00' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/123/messages');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');
  const bad = new WhatsAppChannel({ phoneNumberId: '1', accessToken: 't', template: 't', language: 'he', apiVersion: 'v21.0' },
    (async () => new Response('{"error":{"message":"template not approved"}}', { status: 400 })) as typeof fetch);
  await assert.rejects(bad.send('+1', { reminderId: RID, title: 'x', time: '09:00' }), /WhatsApp 400: .*template not approved/);
});

test('channelFromEnv: log channel for testing, clear error on missing secrets', () => {
  assert.ok(channelFromEnv((k) => ({ NOTIFY_CHANNEL: 'log' } as Record<string, string>)[k]) instanceof LogChannel);
  assert.throws(() => channelFromEnv(() => undefined), /missing secret WHATSAPP_PHONE_NUMBER_ID/);
});

test('deliver: sends to every phone, releases a claim only when nobody got it', async () => {
  const sent: string[] = [];
  const channel = { async send(phone: string) { if (phone === '+bad') throw new Error('boom'); sent.push(phone); } };
  const released: string[] = [];
  const recorded: string[] = [];
  const r = await deliver([
    { reminder_id: 'a', title: 'לשנינו', local_time: '18:30', phones: ['+1', '+2'] },
    { reminder_id: 'b', title: 'חצי הצליח', local_time: '18:30', phones: ['+1', '+bad'] },
    { reminder_id: 'c', title: 'נכשל', local_time: '18:30', phones: ['+bad'] },
    { reminder_id: 'd', title: 'בלי טלפון', local_time: '18:30', phones: [] }
  ], channel, async (id) => { released.push(id); }, async (id, ok, detail) => { recorded.push(`${id}|${ok}|${detail}`); });
  assert.deepEqual(sent, ['+1', '+2', '+1']);
  assert.equal(recorded.length, 4, 'every claimed reminder gets an audit record');
  assert.match(recorded[1], /^b|true|.*✓.*✗ boom/);
  assert.match(recorded[2], /^c|false|/);
  assert.match(recorded[3], /^d|false|no WhatsApp number on file/);
  assert.deepEqual(released, ['c']);
  assert.equal(r.sent, 3);
  assert.equal(r.failed, 2);
});

test('signature: accepts Meta-signed body, rejects tampering and missing header', async () => {
  const body = JSON.stringify(inbound([]));
  const sig = await sign(body, 'app-secret');
  assert.equal(await verifySignature(body, sig, 'app-secret'), true);
  assert.equal(await verifySignature(body + ' ', sig, 'app-secret'), false);
  assert.equal(await verifySignature(body, sig, 'other-secret'), false);
  assert.equal(await verifySignature(body, null, 'app-secret'), false);
  assert.equal(await verifySignature(body, 'sha1=abc', 'app-secret'), false);
});

test('parse: template quick replies, interactive replies, typed בוצע; ignores the rest', () => {
  const actions = parseActions(inbound([
    { from: '972500000001', type: 'button', button: { payload: `done:${RID}`, text: 'בוצע' } },
    { from: '972500000002', type: 'button', button: { payload: `snooze:${RID.toUpperCase()}`, text: 'עוד 30 דק׳' } },
    { from: '972500000002', type: 'interactive', interactive: { button_reply: { id: `done:${RID}` } } },
    { from: '972500000001', type: 'text', text: { body: ' בוצע ' } },
    { from: '972500000001', type: 'text', text: { body: 'מה נשמע' } },
    { from: '972500000001', type: 'button', button: { payload: 'done:not-a-uuid' } },
    { type: 'button', button: { payload: `done:${RID}` } }
  ]));
  assert.deepEqual(actions, [
    { from: '972500000001', kind: 'done', reminderId: RID },
    { from: '972500000002', kind: 'snooze', reminderId: RID },
    { from: '972500000002', kind: 'done', reminderId: RID },
    { from: '972500000001', kind: 'done-latest' }
  ]);
  assert.deepEqual(parseActions({ entry: [{ changes: [{ field: 'statuses', value: { statuses: [{}] } }] }] }), []);
  assert.deepEqual(parseActions(null), []);
});

test('handleActions: acts for the member who replied, only inside their household', async () => {
  const done: string[] = [], snoozed: string[] = [];
  const deps = {
    async memberByPhone(d: string) { return d === '972500000001' ? { id: 'naor', household_id: 'h1' } : null; },
    async reminderHousehold(id: string) { return id === RID ? 'h1' : 'h2'; },
    async latestSentFor() { return RID; },
    async complete(id: string, actor: string) { done.push(`${id}|${actor}`); },
    async snooze(id: string, actor: string) { snoozed.push(`${id}|${actor}`); }
  };
  const other = '11111111-2222-4333-8444-555555555555';
  const log = await handleActions([
    { from: '972500000001', kind: 'done', reminderId: RID },
    { from: '972500000001', kind: 'snooze', reminderId: RID },
    { from: '972500000001', kind: 'done-latest' },
    { from: '972599999999', kind: 'done', reminderId: RID },
    { from: '972500000001', kind: 'done', reminderId: other }
  ], deps);
  assert.deepEqual(done, [`${RID}|naor`, `${RID}|naor`]);
  assert.deepEqual(snoozed, [`${RID}|naor`]);
  assert.deepEqual(log.filter((l) => l.startsWith('ignored')), ['ignored: unknown number', 'ignored: not this household']);
});
