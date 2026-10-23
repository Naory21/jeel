// One-time setup on the real Supabase project: create the two logins (sign-up is closed),
// one household, and the two member rows. Safe to run again: existing users/rows are reused
// and names/phones are updated.
//
//   SUPABASE_URL=https://<ref>.supabase.co  SUPABASE_SERVICE_ROLE_KEY=<service_role or sb_secret_ key>
//   NAOR_EMAIL=...  PARTNER_EMAIL=...  PARTNER_NAME=...   [NAOR_NAME=נאור] [PARTNER_GENDER=f]
//   [NAOR_PHONE=+9725XXXXXXXX] [PARTNER_PHONE=+9725XXXXXXXX]
//   node scripts/setup-household.mjs
//
// The service key never leaves this machine; don't commit it or paste it into the web app.

const env = (k, d) => process.env[k]?.trim() || d;
const need = (k) => { const v = env(k); if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const URL_ = need('SUPABASE_URL').replace(/\/$/, '');
const KEY = need('SUPABASE_SERVICE_ROLE_KEY');
const people = [
  { slot: 1, email: need('NAOR_EMAIL').toLowerCase(), name: env('NAOR_NAME', 'נאור'), gender: env('NAOR_GENDER', 'm'), phone: env('NAOR_PHONE') },
  { slot: 2, email: need('PARTNER_EMAIL').toLowerCase(), name: need('PARTNER_NAME'), gender: env('PARTNER_GENDER', 'f'), phone: env('PARTNER_PHONE') }
];
for (const p of people) if (p.phone && !/^\+[1-9]\d{7,14}$/.test(p.phone)) { console.error(`phone must look like +972501234567: ${p.phone}`); process.exit(1); }

// legacy service_role keys are JWTs (Authorization + apikey); new sb_secret_ keys go in apikey only
const headers = { apikey: KEY, 'Content-Type': 'application/json', ...(KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` }) };
async function call(method, p, body, extra = {}) {
  const res = await fetch(URL_ + p, { method, headers: { ...headers, ...extra }, body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// 1. auth users
const existing = [];
for (let page = 1; ; page++) {
  const r = await call('GET', `/auth/v1/admin/users?page=${page}&per_page=200`);
  existing.push(...(r.users || []));
  if (!r.users?.length || r.users.length < 200) break;
}
for (const p of people) {
  const found = existing.find((u) => u.email?.toLowerCase() === p.email);
  p.id = found?.id ?? (await call('POST', '/auth/v1/admin/users', { email: p.email, email_confirm: true })).id;
  console.log(`${found ? '✓ existing' : '+ created'} login ${p.email}`);
}

// 2. household (reuse the one either person already belongs to)
const mine = await call('GET', `/rest/v1/members?select=household_id&id=in.(${people.map((p) => p.id).join(',')})`);
let household = mine[0]?.household_id;
if (!household) {
  household = (await call('POST', '/rest/v1/households', {}, { Prefer: 'return=representation' }))[0].id;
  console.log('+ created household');
} else console.log('✓ existing household');

// 3. members
await call('POST', '/rest/v1/members?on_conflict=id',
  people.map((p) => ({ id: p.id, household_id: household, slot: p.slot, display_name: p.name, gender: p.gender, whatsapp_phone: p.phone || null })),
  { Prefer: 'resolution=merge-duplicates,return=minimal' });
for (const p of people) console.log(`✓ member slot ${p.slot}: ${p.name}${p.phone ? ' ' + p.phone.slice(0, 6) + '…' : ' (no WhatsApp number yet)'}`);
console.log('\nDone. Both can now sign in with their email address.');
