// End-to-end test of the production (Supabase) mode without a Supabase project:
// Postgres + the migration (tests/db/run.mjs) + PostgREST in Docker, a small proxy that serves web/
// with a test config, and headless Chrome driving the real page and the real supabase-js.
// Auth is replaced by signed test tokens; realtime and Edge Functions are not part of this test.
//   node tests/e2e/run.mjs          (needs Docker and Chrome; CHROME_PATH to override)
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(root, 'web');
const OUT = process.env.E2E_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'jeel-e2e-'));
const SECRET = 'jeel-e2e-jwt-secret-that-is-long-enough-1234567890';
const DB = 'jeel-test-db', REST = 'jeel-test-rest', NET = 'jeel-test-net';
const REST_PORT = 54330, PORT = 5510, CDP = 9338;
const NAOR = '11111111-1111-4111-8111-111111111111', MAYA = '22222222-2222-4222-8222-222222222222';
const CHROME = process.env.CHROME_PATH || {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome'
}[process.platform];

const sh = (args, input) => { const r = spawnSync('docker', args, { input, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
};
const TOKENS = { anon: jwt({ role: 'anon' }), naor: jwt({ sub: NAOR, role: 'authenticated' }), maya: jwt({ sub: MAYA, role: 'authenticated' }) };

// ---------- backend: Postgres + migration + seed, then PostgREST ----------
let r = spawnSync(process.execPath, [path.join(root, 'tests', 'db', 'run.mjs'), '--keep', '--no-tests'], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
r = sh(['exec', '-i', DB, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', '-'], fs.readFileSync(path.join(root, 'tests', 'e2e', 'seed.sql'), 'utf8'));
if (r.code !== 0) { console.error(r.out); process.exit(1); }
sh(['rm', '-f', REST]);
r = sh(['run', '-d', '--name', REST, '--network', NET, '-p', `${REST_PORT}:3000`,
  '-e', `PGRST_DB_URI=postgres://authenticator:authpass@${DB}:5432/postgres`, '-e', 'PGRST_DB_SCHEMAS=public',
  '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${SECRET}`, 'postgrest/postgrest:v12.2.3']);
if (r.code !== 0) { console.error(r.out); process.exit(1); }
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${REST_PORT}/`)).ok) break; } catch {} await sleep(500); }

// ---------- proxy: /<user>/... serves web/ with that user's config; /rest/v1/... goes to PostgREST ----------
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json' };
const proxy = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/rest/v1/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
    const up = await fetch(`http://127.0.0.1:${REST_PORT}${u.pathname.slice(8)}${u.search}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const out = {}; for (const k of ['content-type', 'content-range', 'preference-applied']) if (up.headers.get(k)) out[k] = up.headers.get(k);
    res.writeHead(up.status, out);
    return res.end(Buffer.from(await up.arrayBuffer()));
  }
  const m = /^\/(naor|maya|anon)(\/.*)?$/.exec(u.pathname);
  if (!m) { res.writeHead(404); return res.end(); }
  const rel = !m[2] || m[2] === '/' ? '/index.html' : m[2];
  if (rel === '/config.js') {
    const cfg = { supabaseUrl: `http://localhost:${PORT}`, supabaseAnonKey: TOKENS.anon };
    if (m[1] !== 'anon') cfg.testAccessToken = TOKENS[m[1]];
    res.writeHead(200, { 'Content-Type': TYPES.js });
    return res.end(`window.JEEL_CONFIG = ${JSON.stringify(cfg)};`);
  }
  const file = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(PORT);

// PostgREST as maya, for "the other phone"
const asMaya = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${REST_PORT}${p}`, { method, headers: { Authorization: `Bearer ${TOKENS.maya}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body && JSON.stringify(body) });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
const sql = (q) => sh(['exec', DB, 'psql', '-U', 'postgres', '-X', '-At', '-c', q]).out.trim();

// ---------- browser ----------
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'jeel-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let tgt; for (let i = 0; i < 40 && !tgt; i++) { await sleep(250); try { tgt = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((res) => (ws.onopen = res));
let n = 0; const pend = new Map(); const errs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
const cmd = (method, params = {}) => new Promise((res) => { const id = ++n; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const x = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (x.result?.exceptionDetails) errs.push('eval: ' + (x.result.exceptionDetails.exception?.description || '').split('\n')[0]); return x.result?.result?.value; };
let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg); };
const q = JSON.stringify;
const click = (sel) => ev(`(()=>{const e=document.querySelector(${q(sel)}); if(!e) throw new Error('missing '+${q(sel)}); e.click();})()`);
const type = (sel, v) => ev(`(()=>{const i=document.querySelector(${q(sel)}); i.focus(); i.value=${q(v)}; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const text = (sel) => ev(`document.querySelector(${q(sel)})?.textContent ?? ''`);
const visible = (sel) => ev(`!!document.querySelector(${q(sel)})?.checkVisibility()`);
const toast = () => text('#toast-text');
const settle = (ms = 900) => sleep(ms);
const shot = async (name) => { await sleep(300); const x = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(x.result.data, 'base64')); };
const refresh = () => ev(`document.dispatchEvent(new Event('visibilitychange'))`);

try {
  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Network.enable');
  await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  // signed out: the login sheet, and it cannot be dismissed
  await cmd('Page.navigate', { url: `http://localhost:${PORT}/anon/` }); await sleep(2500);
  ok(await visible('#login-sheet') && await visible('#login-email'), 'signed out: login sheet shown');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  ok(await visible('#login-sheet'), 'login cannot be dismissed');
  await shot('c01-login');

  // signed in as naor
  await cmd('Page.navigate', { url: `http://localhost:${PORT}/naor/#home` }); await sleep(3000);
  ok(!(await visible('#login-sheet')) && (await text('#title')).endsWith('נאור'), 'signed in: greeting ' + await text('#title'));
  ok((await text('#feed')).includes('מאיה הוסיפה לרשימה'), 'feed reads maya\'s seeded actions with feminine verbs');
  ok(!(await text('body')).includes('סוד של בית אחר'), 'no data from the other household');
  await shot('c02-home');

  // tasks
  await click('nav [data-val=tasks]'); await settle(200);
  await type('#task-input', 'לתקן את הברז');
  await click('#task-who [data-val=partner]');
  await ev(`(()=>{const i=document.getElementById('task-time'); i.value='17:45'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('[data-act=add-task]'); await settle();
  ok(sql(`select assignee_id || '|' || due_time from tasks where title = 'לתקן את הברז'`) === `${MAYA}|17:45:00`, 'task saved with assignee and time');
  ok(sql(`select verb || '|' || actor_id from activity order by id desc limit 1`) === `task_added|${NAOR}`, 'logged as naor');
  const tid = sql(`select id from tasks where title = 'לתקן את הברז'`);

  // done + undo
  await ev(`[...document.querySelectorAll('#open-tasks .row')].find(r=>r.textContent.includes('לתקן את הברז')).querySelector('[data-act=toggle-task]').click()`); await settle();
  ok(sql(`select done_at is not null from tasks where id = '${tid}'`) === 't' && (await toast()) === 'סומן כבוצע', 'task done');
  await click('#toast-action'); await settle();
  ok(sql(`select done_at is null from tasks where id = '${tid}'`) === 't' && sql(`select count(*) from activity where verb = 'task_done'`) === '0', 'undo: reopened and the done line removed');

  // concurrent edit: maya changes the assignee (merges), then the title (conflicts)
  await ev(`[...document.querySelectorAll('#open-tasks [data-act=edit-task]')].find(b=>b.textContent.includes('לתקן את הברז')).click()`); await settle(200);
  await type('#edit-title', 'לתקן את הברז במטבח');
  await asMaya('POST', '/rpc/update_checked', { p_table: 'tasks', p_id: tid, p_changes: { assignee_id: null }, p_base: { assignee_id: MAYA } });
  await refresh(); await settle();
  ok(await ev(`document.querySelector('#edit-who [data-val=both]').getAttribute('aria-pressed')`) === 'true' && await ev(`document.getElementById('edit-title').value`) === 'לתקן את הברז במטבח', 'maya\'s other-field change flows into the open sheet; typing kept');
  ok((await text('#edit-note')).includes('מאיה עדכנה'), 'sheet says who: ' + await text('#edit-note'));
  await asMaya('POST', '/rpc/update_checked', { p_table: 'tasks', p_id: tid, p_changes: { title: 'ברז — מאיה' }, p_base: { title: 'לתקן את הברז' } });
  await ev(`document.querySelector('#edit-form button[type=submit]').click()`); await settle();
  ok(await visible('#edit-sheet') && (await text('#edit-note')).includes('שינתה את אותו פרט'), 'same-field conflict caught');
  await shot('c03-conflict');
  await ev(`document.querySelector('#edit-form button[type=submit]').click()`); await settle();
  ok(sql(`select title || '|' || coalesce(assignee_id::text, 'both') from tasks where id = '${tid}'`) === 'לתקן את הברז במטבח|both', 'second save wins knowingly, maya\'s assignee kept');

  // delete + undo
  await ev(`[...document.querySelectorAll('#open-tasks .row')].find(r=>r.textContent.includes('במטבח')).querySelector('[data-act=remove-task]').click()`); await settle();
  ok(sql(`select count(*) from tasks where id = '${tid}'`) === '0', 'task deleted');
  await click('#toast-action'); await settle();
  ok(sql(`select title from tasks where id = '${tid}'`) === 'לתקן את הברז במטבח' && sql(`select count(*) from activity where verb = 'task_deleted'`) === '0', 'undo restores it, delete line removed');

  // reminders: fixed weekdays, edit, done (rolls), due card + snooze
  await click('nav [data-val=reminders]'); await settle(200);
  await ev(`document.getElementById('rem-input').focus()`);
  await click('#rem-repeat [data-val=days]');
  for (const d of ['0', '1', '2', '3', '4', '5', '6']) {
    const on = await ev(`document.querySelector('#rem-days [data-val="${d}"]').getAttribute('aria-pressed')==='true'`);
    if (on !== (d === '1' || d === '4')) await click(`#rem-days [data-val="${d}"]`);
  }
  await ev(`(()=>{const i=document.getElementById('rem-time'); i.value='20:30'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await type('#rem-input', 'להוציא את הפח'); await click('[data-act=add-rem]'); await settle();
  ok(sql(`select repeat || '|' || array_to_string(repeat_days, ',') || '|' || (extract(dow from remind_date) in (1, 4)) from reminders where title = 'להוציא את הפח'`) === 'days|1,4|true', 'reminder: Mon+Thu, first date on a matching day');
  ok((await text('#rem-groups')).includes('כל שני וחמישי'), 'row shows כל שני וחמישי');
  await ev(`[...document.querySelectorAll('#rem-groups [data-act=edit-rem]')].find(b=>b.textContent.includes('להוציא את הפח')).click()`); await settle(200);
  await click('#edit-repeat [data-val=monthly]');
  await ev(`document.querySelector('#edit-form button[type=submit]').click()`); await settle();
  ok(sql(`select repeat || '|' || coalesce(array_to_string(repeat_days, ','), 'null') || '|' || (repeat_anchor = extract(day from remind_date)) from reminders where title = 'להוציא את הפח'`) === 'monthly|null|true', 'edited to monthly: days cleared, anchor set');
  const before = sql(`select remind_date from reminders where title = 'להוציא את הפח'`);
  await ev(`[...document.querySelectorAll('#rem-groups .row')].find(r=>r.textContent.includes('להוציא את הפח')).querySelector('[data-act=toggle-rem]').click()`); await settle();
  ok(sql(`select remind_date > '${before}' and done_at is null from reminders where title = 'להוציא את הפח'`) === 't' && (await toast()).includes('הבאה:'), 'done on a repeating reminder rolls it: ' + await toast());
  await asMaya('POST', '/reminders', { title: 'לאסוף כביסה', recipient_id: null, remind_date: sql(`select ((now() - interval '5 minutes') at time zone 'Asia/Jerusalem')::date`), remind_time: sql(`select to_char((now() - interval '5 minutes') at time zone 'Asia/Jerusalem', 'HH24:MI')`) });
  await click('nav [data-val=tasks]'); await refresh(); await settle();
  ok((await text('#alerts')).includes('לאסוף כביסה'), 'reminder maya added that is due now shows as a card for naor');
  await click('#alerts [data-act=snooze-rem]'); await settle();
  ok(sql(`select abs(extract(epoch from snooze_until - now() - interval '30 minutes')) < 10 from reminders where title = 'לאסוף כביסה'`) === 't', 'snoozed 30 minutes: ' + await toast());
  await shot('c04-reminders');

  // shopping: category memory, merge, check, clear + undo, delete + undo
  await click('nav [data-val=shopping]'); await settle(200);
  await type('#item-input', 'חלב 3%'); await ev(`document.getElementById('item-qty').value='1'`); await click('[data-act=add-item]'); await settle();
  ok(sql(`select qty from shopping_items where name = 'חלב 3%'`) === '3' && (await toast()).includes('ל-3'), 'duplicate merged into quantity 3');
  await type('#item-input', 'זעתר'); await ev(`document.getElementById('item-cat').value='יבשים'; document.getElementById('item-cat').dispatchEvent(new Event('change',{bubbles:true}))`);
  await click('[data-act=add-item]'); await settle();
  ok(sql(`select category from item_categories where name = 'זעתר'`) === 'יבשים', 'category remembered');
  await type('#item-input', 'זעתר'); await settle(100);
  ok(await ev(`document.getElementById('item-cat').value`) === 'יבשים', 'next time the category is filled in');
  await type('#item-input', '');
  for (const name of ['לחם', 'בננות']) {
    await ev(`[...document.querySelectorAll('#cat-groups .row')].find(r=>r.textContent.includes(${q(name)})).querySelector('[data-act=toggle-item]').click()`); await settle(400);
  }
  await sleep(2800);
  ok(sql(`select count(*) from shopping_items where checked_at is not null`) === '2' && (await text('#cart')).includes('לחם'), 'two items in the cart');
  await click('[data-act=clear-cart]'); await settle();
  ok(sql(`select count(*) from shopping_items where checked_at is not null`) === '0' && sql(`select subject from activity where verb = 'cart_cleared'`) === '2', 'cart cleared, one log line');
  await click('#toast-action'); await settle();
  ok(sql(`select count(*) from shopping_items where checked_at is not null`) === '2' && sql(`select count(*) from activity where verb = 'cart_cleared'`) === '0', 'undo brings the cart back');
  await ev(`[...document.querySelectorAll('#cat-groups .row')].find(r=>r.textContent.includes('זעתר')).querySelector('[data-act=remove-item]').click()`); await settle();
  ok(sql(`select count(*) from shopping_items where name = 'זעתר'`) === '0' && sql(`select verb from activity order by id desc limit 1`) === 'item_deleted', 'item delete logged');
  await click('#toast-action'); await settle();
  ok(sql(`select count(*) from shopping_items where name = 'זעתר'`) === '1', 'undo restores the item');

  // offline add is kept and sent later, without duplicates
  await cmd('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(500);
  await type('#item-input', 'ביצים'); await click('[data-act=add-item]'); await settle();
  ok((await text('#cat-groups')).includes('ממתין לשליחה') && await visible('#net'), 'offline: pending row and banner');
  await shot('c05-offline');
  await cmd('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  for (let i = 0; i < 30 && sql(`select count(*) from shopping_items where name = 'ביצים'`) !== '1'; i++) await sleep(500);
  await settle(1500);
  ok(sql(`select count(*) from shopping_items where name = 'ביצים'`) === '1' && !(await text('#cat-groups')).includes('ממתין'), 'back online: sent once, pending gone');

  // saved lists: save what's on the list, empty it, add it back (merged), undo, delete + undo
  await click('#list-bar'); await settle(300);
  await type('#list-name', 'קנייה שבועית');
  await click('[data-act=list-save]'); await settle();
  const saved = Number(sql(`select jsonb_array_length(items) from saved_lists where name = 'קנייה שבועית'`));
  ok(saved >= 4 && (await toast()).includes('נשמרה'), `list saved to Supabase with ${saved} items`);
  ok(sql(`select verb || '|' || actor_id from activity order by id desc limit 1`) === `list_saved|${NAOR}`, 'save is in the feed');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  sql(`delete from shopping_items where name <> 'חלב 3%'`);
  sql(`update shopping_items set qty = '1', checked_at = null where name = 'חלב 3%'`);
  await refresh(); await settle();
  await click('#list-bar'); await settle(300);
  await click('#lists [data-act=list-add]'); await settle(1500);
  const back = Number(sql(`select count(*) from shopping_items`));
  ok(back === saved && sql(`select qty from shopping_items where name = 'חלב 3%'`) === '4', `added back: ${back} items, milk 1 + 3 = ${sql(`select qty from shopping_items where name = 'חלב 3%'`)}`);
  ok((await toast()).startsWith('נוספו') && sql(`select verb from activity order by id desc limit 1`) === 'list_loaded', 'one feed line: ' + await toast());
  await click('#toast-action'); await settle(1500);
  ok(sql(`select count(*) from shopping_items`) === '1' && sql(`select qty from shopping_items where name = 'חלב 3%'`) === '1' && sql(`select count(*) from activity where verb = 'list_loaded'`) === '0', 'undo: rows removed, milk back to 1, feed line gone');
  await click('#list-bar'); await settle(300);
  await click('#lists [data-act=list-delete]'); await settle();
  ok(sql(`select count(*) from saved_lists`) === '0', 'list deleted');
  await click('#toast-action'); await settle();
  ok(sql(`select count(*) from saved_lists`) === '1', 'undo restores the list');
  ok(Number(sql(`select count(*) from audit_log where entity = 'saved_lists' or op = 'load_list'`)) >= 4, 'saved-list actions are in the audit trail');

  // notes on items, editing them (with a concurrent edit), and which list is shown
  await ev(`document.getElementById('item-input').focus()`);
  await type('#item-input', 'יוגורט'); await type('#item-note', 'ללא לקטוז');
  await click('[data-act=add-item]'); await settle();
  ok(sql(`select note from shopping_items where name = 'יוגורט'`) === 'ללא לקטוז', 'item saved to Supabase with its note');
  ok((await text('#cat-groups')).includes('ללא לקטוז'), 'note shown under the item');
  const yid = sql(`select id from shopping_items where name = 'יוגורט'`);
  await click(`[data-act=edit-item][data-id="${yid}"]`); await settle(300);
  await ev(`document.getElementById('ie-note').value = 'של יטבתה'`);
  await asMaya('POST', '/rpc/update_checked', { p_table: 'shopping_items', p_id: yid, p_changes: { note: 'של תנובה' }, p_base: { note: 'ללא לקטוז' } });
  await ev(`document.querySelector('#item-form button[type=submit]').click()`); await settle();
  ok((await text('#item-msg')).includes('מאיה שינתה את הפריט'), 'concurrent note edit caught, names maya: ' + await text('#item-msg'));
  await ev(`document.querySelector('#item-form button[type=submit]').click()`); await settle();
  ok(sql(`select note from shopping_items where id = '${yid}'`) === 'של יטבתה' && sql(`select verb from activity order by id desc limit 1`) === 'item_edited', 'second save wins, feed says עדכן פריט');
  await click('#list-bar'); await settle(300);
  await type('#list-name', 'עם יוגורט'); await click('[data-act=list-save]'); await settle();
  const lid = sql(`select id from saved_lists where name = 'עם יוגורט'`);
  ok(sql(`select current_list_id from households where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`) === lid, 'the saved list becomes the current one');
  ok(sql(`select items @> '[{"name":"יוגורט","note":"של יטבתה"}]' from saved_lists where id = '${lid}'`) === 't', 'saved list keeps the note');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await settle(300);
  ok((await text('#title')) === 'עם יוגורט' && (await text('#list-bar-name')) === 'עם יוגורט', 'title and list bar name the list on screen');
  await click('#list-bar'); await settle(300);
  await click('[data-act=list-new]'); await settle(1500);
  ok(sql(`select count(*) from shopping_items`) === '0' && (await text('#list-bar-name')) === 'רשימה ללא שם', 'רשימה חדשה: empty and unnamed');
  await click('#list-bar'); await settle(300);
  await click(`[data-act=list-switch][data-id="${lid}"]`); await settle(1500);
  ok(sql(`select note from shopping_items where name = 'יוגורט'`) === 'של יטבתה' && sql(`select current_list_id from households where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`) === lid, 'פתיחה brings the list back with notes and makes it current');
  ok((await toast()).startsWith('נפתחה "עם יוגורט"'), 'toast: ' + await toast());
  await click('#toast-action'); await settle(1500);
  ok(sql(`select count(*) from shopping_items`) === '0' && sql(`select current_list_id is null from households where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`) === 't', 'undo of פתיחה: back to the empty unnamed list');
  ok(Number(sql(`select count(*) from audit_log where op in ('open_list', 'new_list') or (entity = 'households' and changes ? 'current_list_id')`)) >= 3, 'open / new / current-list switches are audited');
  await shot('c08-lists');

  // account sheet + partner rename
  await click('#settings-btn'); await settle(300);
  ok(await visible('#sign-out') && (await text('#who-h')) === 'הגדרות' && (await text('#set-email')) === '', 'the ⚙ button opens settings with sign-out');
  await click('[data-act=who-rename]'); await type('#partner-name', 'מאיה כהן'); await click('[data-act=save-name]'); await settle();
  ok(sql(`select display_name from members where slot = 2 and household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`) === 'מאיה כהן', 'partner renamed');
  await click('nav [data-val=home]'); await settle(300); await shot('c06-home-after');

  // audit trail: everything above is in it, nothing was erased by undo, and the app can't alter it
  ok(Number(sql(`select count(*) from audit_log where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`)) > 25, 'audit trail holds the session: ' + sql(`select count(*) from audit_log`) + ' entries');
  ok(sql(`select count(*) from audit_log where entity = 'tasks' and action = 'delete' and entity_id = '${tid}'`) === '1' && sql(`select count(*) from audit_log where entity_id = '${tid}' and op = 'undo'`) >= '2', 'undone delete and done are both still in the audit trail');
  ok(sql(`select count(*) from audit_log where entity = 'tasks' and entity_id = '${tid}' and actor_id = '${MAYA}' and changes ? 'title'`) === '1', 'the concurrent title edit by maya is audited under her name');
  const forged = await (await fetch(`http://127.0.0.1:${REST_PORT}/audit_log`, { method: 'POST', headers: { Authorization: `Bearer ${TOKENS.maya}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ household_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'event', entity: 'x' }) })).status;
  const erased = await (await fetch(`http://127.0.0.1:${REST_PORT}/audit_log?id=gt.0`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKENS.maya}` } })).status;
  ok(forged >= 400 && erased >= 400 && Number(sql(`select count(*) from audit_log`)) > 25, `the API refuses to forge (${forged}) or erase (${erased}) audit entries`);
  await click('#settings-btn'); await settle(300);
  await click('#who-sheet [data-act=audit]'); await settle(1500);
  const auditText = await text('#audit-list');
  ok(auditText.includes('סיום קנייה') && auditText.includes('ביטול פעולה') && auditText.includes('דחייה'), 'audit screen shows clear-cart, undo and snooze');
  ok(auditText.includes('מאיה') && auditText.includes('עדכון') && auditText.includes('←'), 'audit screen shows who and before → after');
  await click('#audit-filters [data-val=reminders]'); await settle(1200);
  ok(await ev(`[...document.querySelectorAll('#audit-list .audit-what')].every(x => x.textContent.includes('תזכורת'))`), 'reminders filter works against Supabase');
  await shot('c07-audit');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);

  // the second household never leaked into this session
  const leaked = await ev(`JSON.stringify(JSON.parse(localStorage.getItem('jeel.state'))).includes('סוד של בית אחר')`);
  ok(leaked === false, 'other household never reached the browser');
} finally {
  console.log('errors:', JSON.stringify(errs.filter((e) => !/WebSocket|realtime/i.test(e))));
  console.log('screenshots:', OUT);
  ws.close(); chrome.kill(); proxy.close();
  if (!process.argv.includes('--keep')) { sh(['rm', '-f', REST, DB]); sh(['network', 'rm', NET]); }
}
console.log(fails ? `${fails} FAILED` : 'ALL E2E PASSED');
process.exit(fails ? 1 : 0);
