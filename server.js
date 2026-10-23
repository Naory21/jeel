// Jeel — local server. Zero dependencies.
// Run: node server.js        (add --open to open the browser, --empty to start with no demo data)
// Serves web/, keeps all data in db.json next to this file, and pushes
// every change to all open devices (Server-Sent Events).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8787;
const DB_FILE = path.join(__dirname, 'db.json');
const WEB_DIR = path.join(__dirname, 'web');
const TZ = 'Asia/Jerusalem';
const CATS = ['פירות וירקות', 'מוצרי חלב', 'מאפים', 'יבשים', 'ניקיון ובית', 'אחר'];
const WHO = ['naor', 'partner', 'both'];
const MEMBERS = ['naor', 'partner'];
const BUCKETS = ['today', 'tomorrow', 'week'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'days'];

// ---------- dates (Asia/Jerusalem, as YYYY-MM-DD / HH:MM strings) ----------
const ymd = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date);
const hhmm = (date) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(date);
const today = () => ymd(new Date());
const addDays = (d, n) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay(); // 0=Sun..6=Sat
// "this week" = the coming Saturday; on Friday/Saturday that would be today/tomorrow, so it means next week's Saturday
const weekEnd = (t) => { const d = 6 - dow(t); return addDays(t, d <= 1 ? d + 7 : d); };
const bucketDate = (b) => {
  const t = today();
  if (b === 'tomorrow') return addDays(t, 1);
  if (b === 'week') return weekEnd(t);
  return t;
};

// next date of a repeating reminder after r.date
function nextOccurrence(r) {
  if (r.repeat === 'daily') return addDays(r.date, 1);
  if (r.repeat === 'weekly') return addDays(r.date, 7);
  if (r.repeat === 'days') {
    let d = addDays(r.date, 1);
    while (!r.repeat_days.includes(dow(d))) d = addDays(d, 1);
    return d;
  }
  if (r.repeat === 'monthly') {
    // same day of month as when it was created, clamped to short months (31st -> 30th/28th)
    const [y, m] = r.date.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const day = Math.min(r.repeat_anchor || Number(r.date.slice(8)), last);
    return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return r.date;
}

// ---------- storage ----------
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

function seed(empty) {
  const db = {
    members: {
      naor: { name: 'נאור', gender: 'm' },
      partner: { name: 'בת הזוג', gender: 'f' }
    },
    tasks: [], reminders: [], items: [], activity: [], known: {}, audit: [], lists: [], currentListId: null
  };
  if (empty) return db;
  const T = (title, who, b, done, by) => ({ id: id(), title, who, due_date: bucketDate(b), due_time: null, done_at: done ? ago(180) : null, created_by: by, created_at: ago(600) });
  db.tasks = [
    T('להזמין טכנאי למזגן', 'both', 'today', false, 'naor'),
    T('לשלם את חשבון החשמל', 'naor', 'today', false, 'naor'),
    T('להחזיר את החבילה לדואר', 'partner', 'tomorrow', false, 'partner'),
    T('להזמין מקום לארוחת שישי', 'naor', 'week', false, 'naor'),
    T('לסדר את המרפסת לקראת החורף', 'both', 'week', false, 'partner'),
    T('לקבוע תור לרופא שיניים', 'partner', 'today', true, 'partner')
  ];
  const R = (title, who, b, time, repeat, done) => ({ id: id(), title, who, date: bucketDate(b), time, repeat, repeat_days: null, repeat_anchor: null, snooze: null, done_at: done ? ago(60) : null, created_by: 'naor', created_at: ago(600) });
  db.reminders = [
    { ...R('להוציא את הפח לפינוי', 'naor', 'today', '20:30', 'days', false), repeat_days: [1, 4] },
    R('לאסוף כביסה מהמכבסה', 'both', 'today', '18:30', 'none', false),
    R('להתקשר לסבתא – יום הולדת', 'partner', 'tomorrow', '10:00', 'none', false),
    R('חידוש ביטוח הרכב', 'naor', 'week', '09:00', 'none', false),
    R('להשקות את העציצים', 'partner', 'today', '08:00', 'none', true)
  ];
  const I = (name, qty, cat, by, checked) => ({ id: id(), name, qty, cat, by, checked_at: checked ? ago(30) : null, created_at: ago(300) });
  db.items = [
    I('חלב 3%', '2', 'מוצרי חלב', 'partner'),
    I('קוטג׳', '1', 'מוצרי חלב', 'naor'),
    I('עגבניות', '1 ק״ג', 'פירות וירקות', 'naor'),
    I('מלפפונים', '6', 'פירות וירקות', 'partner'),
    I('בננות', 'אשכול', 'פירות וירקות', 'partner'),
    I('לחם מחמצת', '1', 'מאפים', 'partner'),
    I('נייר טואלט', 'חבילה', 'ניקיון ובית', 'naor'),
    I('אורז בסמטי', '1', 'יבשים', 'naor'),
    I('נוזל כלים', '1', 'ניקיון ובית', 'partner', true),
    I('פולי קפה', '500 גר׳', 'יבשים', 'naor', true)
  ];
  for (const it of db.items) db.known[norm(it.name)] = it.cat;
  db.activity = [
    { id: id(), actor: 'partner', verb: 'item_added', subject: 'חלב 3%', at: ago(12) },
    { id: id(), actor: 'naor', verb: 'task_done', subject: 'לשלם ארנונה', at: ago(60) },
    { id: id(), actor: 'partner', verb: 'task_done', subject: 'לקבוע תור לרופא שיניים', at: ago(180) },
    { id: id(), actor: 'naor', verb: 'rem_added', subject: 'חידוש ביטוח הרכב', at: ago(1500) }
  ];
  return db;
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    const fresh = seed(process.argv.includes('--empty'));
    save(fresh);
    return fresh;
  }
  const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  d.known ??= {}; // files from older versions
  d.audit ??= [];
  d.lists ??= [];
  d.currentListId ??= null;
  return d;
}
function save(d) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DB_FILE); // atomic replace, so a crash never leaves a half-written db
}

// ---------- validation ----------
class Bad extends Error {}
class Conflict extends Error { constructor(current) { super('conflict'); this.current = current; } }
const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
const text = (v, max, field) => {
  const s = norm(v ?? '');
  if (!s || s.length > max) throw new Bad(`${field}: 1–${max} תווים`);
  return s;
};
const oneOf = (v, list, field) => { if (!list.includes(v)) throw new Bad(`${field} לא תקין`); return v; };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const optTime = (v) => { if (v == null || v === '') return null; if (!TIME_RE.test(v)) throw new Bad('שעה לא תקינה'); return v; };
const reqTime = (v) => { if (!TIME_RE.test(v ?? '')) throw new Bad('שעה לא תקינה'); return v; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const reqDate = (v) => { if (!isDate(v)) throw new Bad('תאריך לא תקין'); return v; };
// a specific "YYYY-MM-DD" wins; otherwise fall back to a bucket name
const dateArg = (date, bucket) => (date != null && date !== '') ? reqDate(date) : bucketDate(oneOf(bucket, BUCKETS, 'מועד'));
const daysArg = (v) => {
  const days = [...new Set(Array.isArray(v) ? v : [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) throw new Bad('בחרו לפחות יום אחד');
  return days;
};
// ids come from the client so a retried add is recognised instead of duplicated
const clientId = (v) => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : id());
const optNote = (v) => { const s = norm(v ?? ''); if (s.length > 200) throw new Bad('הערה: עד 200 תווים'); return s || null; };
const find = (list, itemId) => { const x = list.find((y) => y.id === itemId); if (!x) throw new Bad('לא נמצא'); return x; };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------- per-request context: activity written, records touched (for undo), notes ----------
let ctx = null;
const log = (actor, verb, subject) => {
  const row = { id: id(), actor, verb, subject: String(subject), at: now() };
  db.activity.unshift(row);
  db.activity = db.activity.slice(0, 300);
  ctx.logged.push(row.id);
};
// remember a record's state before an undoable change
const track = (list, rec) => {
  if (!ctx.snaps.some((s) => s.id === rec.id)) ctx.snaps.push({ list, id: rec.id, before: structuredClone(rec), index: db[list].indexOf(rec) });
};

// partial update with conflict detection: only the changed fields are sent, each with the value
// the editor started from; if the other phone changed that same field meanwhile, refuse
function patch(rec, changes, base, fields) {
  const keys = Object.keys(changes || {}).filter((k) => fields.includes(k));
  if (keys.some((k) => !same(rec[k], base?.[k]))) throw new Conflict(rec);
  return keys;
}

// ---------- audit trail: append-only, mirrors supabase/migrations/*_audit_trail.sql ----------
// every change as { at, actor, via, action, entity, entity_id, label, changes, op }; updates carry {field: [old, new]}
const AUDIT_MAX = 5000;
const AUDIT_NOISE = new Set(['updated_at', 'updated_by']);
const AUDIT_OP = { updateTask: 'edit', updateRem: 'edit', updateItem: 'edit', snoozeRem: 'snooze', clearCollected: 'clear_cart', loadList: 'load_list', openList: 'open_list', newList: 'new_list', undo: 'undo' };
const AUDIT_EVENTS = ['identity_selected', 'signed_in', 'signed_out'];
function auditChanges(prev, next, actor, op) {
  const out = [];
  const at = now();
  const push = (action, entity, entityId, label, changes) => out.push({ at, actor, via: 'app', action, entity, entity_id: entityId, label, changes, op: op || null });
  for (const [key, entity] of [['tasks', 'tasks'], ['reminders', 'reminders'], ['items', 'shopping_items'], ['lists', 'saved_lists']]) {
    const a = new Map(prev[key].map((x) => [x.id, x]));
    const b = new Map(next[key].map((x) => [x.id, x]));
    for (const [rid, n] of b) {
      const o = a.get(rid);
      if (!o) { push('insert', entity, rid, n.title ?? n.name, n); continue; }
      const changes = {};
      for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
        if (!AUDIT_NOISE.has(k) && !same(o[k], n[k])) changes[k] = [o[k] ?? null, n[k] ?? null];
      }
      if (Object.keys(changes).length) push('update', entity, rid, n.title ?? n.name, changes);
    }
    for (const [rid, o] of a) if (!b.has(rid)) push('delete', entity, rid, o.title ?? o.name, o);
  }
  for (const k of MEMBERS) {
    const o = prev.members[k], n = next.members[k], changes = {};
    for (const field of ['name', 'gender']) if (o[field] !== n[field]) changes[field] = [o[field], n[field]];
    if (Object.keys(changes).length) push('update', 'members', k, n.name, changes);
  }
  if ((prev.currentListId ?? null) !== (next.currentListId ?? null)) {
    push('update', 'households', 'household', null, { current_list_id: [prev.currentListId ?? null, next.currentListId ?? null] });
  }
  const ka = prev.known || {}, kb = next.known || {};
  for (const name of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
    if (ka[name] === kb[name]) continue;
    if (ka[name] === undefined) push('insert', 'item_categories', name, name, { category: kb[name] });
    else push('update', 'item_categories', name, name, { category: [ka[name], kb[name] ?? null] });
  }
  return out;
}
function appendAudit(entries) {
  let seq = db.audit[0]?.id ?? 0;
  for (const e of entries) e.id = ++seq;
  db.audit = entries.reverse().concat(db.audit).slice(0, AUDIT_MAX); // newest first
}
// the app's state without the audit trail (that one is fetched page by page)
const publicState = () => { const { audit, ...rest } = db; return rest; };

const undoBox = new Map(); // token -> { at, snaps, logged }
const UNDOABLE = new Set(['toggleTask', 'removeTask', 'toggleRem', 'removeRem', 'snoozeRem', 'removeItem', 'clearCollected', 'updateTask', 'updateRem', 'updateItem', 'loadList', 'openList', 'newList', 'deleteList']);

const ops = {
  addTask(a, actor) {
    const tid = clientId(a.id);
    if (db.tasks.some((x) => x.id === tid)) return; // retry of an add that already landed
    const title = text(a.title, 200, 'כותרת');
    db.tasks.unshift({ id: tid, title, who: oneOf(a.who, WHO, 'אחראי'), due_date: dateArg(a.due_date, a.due), due_time: optTime(a.due_time), done_at: null, created_by: actor, created_at: now() });
    log(actor, 'task_added', title);
  },
  toggleTask(a, actor) {
    const t = find(db.tasks, a.id);
    track('tasks', t);
    t.done_at = t.done_at ? null : now();
    log(actor, t.done_at ? 'task_done' : 'task_reopened', t.title);
  },
  updateTask(a, actor) {
    const t = find(db.tasks, a.id);
    const keys = patch(t, a.changes, a.base, ['title', 'who', 'due_date', 'due_time']);
    const c = a.changes;
    const next = {};
    if (keys.includes('title')) next.title = text(c.title, 200, 'כותרת');
    if (keys.includes('who')) next.who = oneOf(c.who, WHO, 'אחראי');
    if (keys.includes('due_date')) next.due_date = reqDate(c.due_date);
    if (keys.includes('due_time')) next.due_time = optTime(c.due_time);
    if (Object.keys(next).every((k) => same(t[k], next[k]))) return;
    track('tasks', t);
    Object.assign(t, next, { updated_by: actor, updated_at: now() });
    log(actor, 'task_edited', t.title);
  },
  removeTask(a, actor) {
    const t = find(db.tasks, a.id);
    track('tasks', t);
    db.tasks = db.tasks.filter((x) => x !== t);
    log(actor, 'task_deleted', t.title);
  },

  addRem(a, actor) {
    const rid = clientId(a.id);
    if (db.reminders.some((x) => x.id === rid)) return;
    const title = text(a.title, 200, 'כותרת');
    const repeat = oneOf(a.repeat ?? 'none', REPEATS, 'חזרה');
    let date = dateArg(a.date, a.when);
    const days = repeat === 'days' ? daysArg(a.repeat_days) : null;
    if (days) while (!days.includes(dow(date))) date = addDays(date, 1); // start on the first matching day
    db.reminders.push({
      id: rid, title, who: oneOf(a.who, WHO, 'נמען'), date, time: TIME_RE.test(a.time) ? a.time : '09:00', repeat,
      repeat_days: days, repeat_anchor: repeat === 'monthly' ? Number(date.slice(8)) : null, snooze: null,
      done_at: null, created_by: actor, created_at: now()
    });
    log(actor, 'rem_added', title);
  },
  toggleRem(a, actor) {
    const r = find(db.reminders, a.id);
    track('reminders', r);
    r.snooze = null;
    if (!r.done_at) ctx.auditOp = 'complete';
    if (!r.done_at && r.repeat !== 'none') {
      // a repeating reminder never closes: it rolls forward to its next occurrence after today
      do r.date = nextOccurrence(r); while (r.date <= today());
      log(actor, 'rem_done', r.title);
      return;
    }
    r.done_at = r.done_at ? null : now();
    log(actor, r.done_at ? 'rem_done' : 'rem_reopened', r.title);
  },
  snoozeRem(a, actor) {
    const r = find(db.reminders, a.id);
    track('reminders', r);
    const at = new Date(Date.now() + (Number(a.minutes) || 30) * 60000);
    r.snooze = { date: ymd(at), time: hhmm(at) }; // overrides this occurrence only
    log(actor, 'rem_snoozed', r.title);
  },
  updateRem(a, actor) {
    const r = find(db.reminders, a.id);
    const keys = patch(r, a.changes, a.base, ['title', 'who', 'date', 'time', 'repeat', 'repeat_days']);
    const c = a.changes;
    const next = {};
    if (keys.includes('title')) next.title = text(c.title, 200, 'כותרת');
    if (keys.includes('who')) next.who = oneOf(c.who, WHO, 'נמען');
    if (keys.includes('date')) next.date = reqDate(c.date);
    if (keys.includes('time')) next.time = reqTime(c.time);
    if (keys.includes('repeat')) next.repeat = oneOf(c.repeat, REPEATS, 'חזרה');
    const repeat = next.repeat ?? r.repeat;
    if (repeat === 'days') {
      next.repeat_days = daysArg(keys.includes('repeat_days') ? c.repeat_days : r.repeat_days);
      let d = next.date ?? r.date;
      while (!next.repeat_days.includes(dow(d))) d = addDays(d, 1);
      if (d !== r.date) next.date = d;
    } else if (keys.includes('repeat')) next.repeat_days = null;
    if (Object.keys(next).every((k) => same(r[k], next[k]))) return;
    track('reminders', r);
    Object.assign(r, next, { updated_by: actor, updated_at: now() });
    if (repeat === 'monthly' && (keys.includes('date') || keys.includes('repeat'))) r.repeat_anchor = Number(r.date.slice(8));
    if (keys.includes('date') || keys.includes('time')) r.snooze = null;
    log(actor, 'rem_edited', r.title);
  },
  removeRem(a, actor) {
    const r = find(db.reminders, a.id);
    track('reminders', r);
    db.reminders = db.reminders.filter((x) => x !== r);
    log(actor, 'rem_deleted', r.title);
  },

  addItem(a, actor) {
    const iid = clientId(a.id);
    if (db.items.some((x) => x.id === iid)) return;
    const name = text(a.name, 120, 'שם');
    const qty = norm(a.qty ?? '').slice(0, 30) || '1';
    const cat = oneOf(a.cat, CATS, 'קטגוריה');
    const note = optNote(a.note);
    db.known[name] = cat;
    // already on the list: add the quantities when both are plain numbers, otherwise leave it
    const dup = db.items.find((x) => !x.checked_at && norm(x.name) === name);
    if (dup) {
      const sum = Number(dup.qty) + Number(qty);
      if (/^\d+$/.test(dup.qty) && /^\d+$/.test(qty)) {
        track('items', dup);
        dup.qty = String(sum);
        if (note && !dup.note) dup.note = note;
        ctx.note = { kind: 'merged', name, qty: dup.qty };
        log(actor, 'item_added', name);
      } else ctx.note = { kind: 'exists', name };
      return;
    }
    db.items.unshift({ id: iid, name, qty, cat, note, by: actor, checked_at: null, created_at: now() });
    log(actor, 'item_added', name);
  },
  updateItem(a, actor) {
    const it = find(db.items, a.id);
    const keys = patch(it, a.changes, a.base, ['name', 'qty', 'cat', 'note']);
    const c = a.changes, next = {};
    if (keys.includes('name')) next.name = text(c.name, 120, 'שם');
    if (keys.includes('qty')) next.qty = norm(c.qty ?? '').slice(0, 30) || '1';
    if (keys.includes('cat')) next.cat = oneOf(c.cat, CATS, 'קטגוריה');
    if (keys.includes('note')) next.note = optNote(c.note);
    if (Object.keys(next).every((k) => same(it[k], next[k]))) return;
    track('items', it);
    Object.assign(it, next, { updated_by: actor, updated_at: now() });
    if (next.cat) db.known[it.name] = next.cat;
    log(actor, 'item_edited', it.name);
  },
  toggleItem(a, actor) {
    const it = find(db.items, a.id);
    track('items', it);
    it.checked_at = it.checked_at ? null : now();
    if (it.checked_at) log(actor, 'item_checked', it.name);
  },
  removeItem(a, actor) {
    const it = db.items.find((x) => x.id === a.id);
    if (!it) return;
    track('items', it);
    db.items = db.items.filter((x) => x !== it);
    log(actor, 'item_deleted', it.name);
  },
  clearCollected(a, actor) {
    const done = db.items.filter((x) => x.checked_at);
    if (!done.length) return;
    for (const it of done) track('items', it);
    db.items = db.items.filter((x) => !x.checked_at);
    log(actor, 'cart_cleared', done.length);
  },

  // things the server can't see by itself, reported by the app for its own user
  logEvent(a, actor) {
    const kind = oneOf(a.kind, AUDIT_EVENTS, 'אירוע');
    ctx.events.push({ at: now(), actor, via: 'app', action: 'event', entity: 'session', entity_id: actor, label: null, changes: null, op: kind });
  },

  // saved shopping lists: everything currently on the list (open and in the cart), under a name.
  // Saving under an existing name replaces that list's items.
  saveList(a, actor) {
    const name = text(a.name, 60, 'שם');
    const seen = new Set();
    const items = db.items.filter((i) => !seen.has(norm(i.name)) && seen.add(norm(i.name)))
      .map((i) => ({ name: i.name, qty: i.qty, category: i.cat, note: i.note || null }));
    if (!items.length) throw new Bad('הרשימה ריקה — אין מה לשמור');
    const existing = db.lists.find((l) => norm(l.name) === name);
    if (existing) {
      track('lists', existing);
      Object.assign(existing, { items, updated_at: now() });
    } else {
      db.lists.unshift({ id: clientId(a.id), name, items, created_by: actor, created_at: now(), updated_at: now() });
    }
    db.currentListId = (existing || db.lists[0]).id;   // what you just saved is the list you're looking at
    log(actor, 'list_saved', name);
    ctx.note = { kind: existing ? 'list_updated' : 'list_saved', count: items.length };
  },
  // add a saved list to the shopping list; open items with the same name get numeric quantities added
  loadList(a, actor) {
    const l = find(db.lists, a.id);
    let added = 0;
    for (const it of l.items) {
      const name = norm(it.name ?? '');
      if (!name) continue;
      const qty = norm(it.qty ?? '').slice(0, 30) || '1';
      const note = norm(it.note ?? '').slice(0, 200) || null;
      const dup = db.items.find((x) => !x.checked_at && norm(x.name) === name);
      if (dup) {
        if (/^\d+$/.test(dup.qty) && /^\d+$/.test(qty)) { track('items', dup); dup.qty = String(Number(dup.qty) + Number(qty)); if (!dup.note && note) dup.note = note; }
        else if (!dup.note && note) { track('items', dup); dup.note = note; }
      } else {
        const item = { id: id(), name, qty, cat: CATS.includes(it.category) ? it.category : 'אחר', note, by: actor, checked_at: null, created_at: now() };
        db.items.unshift(item);
        ctx.created.push(['items', item.id]);
        added++;
      }
    }
    log(actor, 'list_loaded', l.name);
    ctx.note = { kind: 'list_loaded', name: l.name, added };
  },
  // open a saved list: what's on the list is replaced by it, and it becomes the current list
  openList(a, actor) {
    const l = find(db.lists, a.id);
    for (const it of db.items) track('items', it);
    ctx.prevList = db.currentListId;
    db.items = [];
    ops.loadList(a, actor);
    db.activity = db.activity.filter((x) => !(ctx.logged.includes(x.id) && x.verb === 'list_loaded'));
    log(actor, 'list_opened', l.name);
    db.currentListId = l.id;
    ctx.note = { kind: 'list_opened', name: l.name, count: db.items.length };
  },
  // start an empty list that isn't a saved one yet
  newList(a, actor) {
    for (const it of db.items) track('items', it);
    ctx.prevList = db.currentListId;
    db.items = [];
    db.currentListId = null;
    log(actor, 'list_new', '');
  },
  deleteList(a, actor) {
    const l = find(db.lists, a.id);
    track('lists', l);
    db.lists = db.lists.filter((x) => x !== l);
    if (db.currentListId === l.id) { ctx.prevList = l.id; db.currentListId = null; }
    log(actor, 'list_deleted', l.name);
  },

  setName(a) {
    const who = oneOf(a.who, MEMBERS, 'משתמש');
    db.members[who].name = text(a.name, 30, 'שם');
  },

  // put back every record an earlier operation changed, and drop the activity lines it wrote
  undo(a) {
    const u = undoBox.get(a.token);
    if (!u) throw new Bad('אי אפשר לבטל יותר');
    undoBox.delete(a.token);
    for (const [list, rid] of u.created || []) db[list] = db[list].filter((x) => x.id !== rid);
    if (u.prevList !== undefined) db.currentListId = u.prevList;
    for (const s of u.snaps) {
      const list = db[s.list];
      const i = list.findIndex((x) => x.id === s.id);
      if (i >= 0) list[i] = s.before;
      else list.splice(Math.min(s.index, list.length), 0, s.before);
    }
    db.activity = db.activity.filter((x) => !u.logged.includes(x.id));
  }
};

// ---------- live updates ----------
const clients = new Set();
const broadcast = () => {
  const msg = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(msg);
};
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- http ----------
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const TYPES = { html: 'text/html; charset=utf-8', png: 'image/png', svg: 'image/svg+xml', webmanifest: 'application/manifest+json', js: 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // deployment settings; without web/config.js the page runs against this server
  if (req.method === 'GET' && url === '/config.js') {
    const file = path.join(WEB_DIR, 'config.js');
    res.writeHead(200, { 'Content-Type': TYPES.js, 'Cache-Control': 'no-cache' });
    return res.end(fs.existsSync(file) && !process.env.JEEL_IGNORE_CONFIG ? fs.readFileSync(file) : 'window.JEEL_CONFIG = {};\n');
  }
  // static files from web/ (fixed allow-list, no path traversal)
  const asset = url === '/' ? 'index.html' : /^\/(index\.html|sw\.js|manifest\.webmanifest|icons\/[\w-]+\.(?:png|svg))$/.exec(url)?.[1];
  if (req.method === 'GET' && asset) {
    const file = path.join(WEB_DIR, asset);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[asset.split('.').pop()], 'Cache-Control': 'no-cache' });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'GET' && url === '/api/state') return send(res, 200, publicState());

  // audit trail, newest first: ?before=<id>&limit=<n>&group=tasks|reminders|shopping|other
  if (req.method === 'GET' && url === '/api/audit') {
    const q = new URL(req.url, 'http://local').searchParams;
    const before = Number(q.get('before')) || Infinity;
    const limit = Math.min(Number(q.get('limit')) || 100, 500);
    const groups = { tasks: ['tasks'], reminders: ['reminders'], shopping: ['shopping_items', 'item_categories', 'saved_lists', 'households'], other: ['members', 'session'] };
    const only = groups[q.get('group')];
    return send(res, 200, db.audit.filter((e) => e.id < before && (!only || only.includes(e.entity))).slice(0, limit));
  }

  if (req.method === 'GET' && url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url === '/api/op') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      const before = JSON.stringify(db);
      try {
        const { op, args = {}, actor } = JSON.parse(body || '{}');
        if (!Object.hasOwn(ops, op)) throw new Bad('פעולה לא מוכרת');
        oneOf(actor, MEMBERS, 'משתמש');
        ctx = { snaps: [], logged: [], note: null, events: [], created: [] };
        const prev = JSON.parse(before);
        ops[op](args, actor);
        appendAudit([...auditChanges(prev, db, actor, ctx.auditOp ?? AUDIT_OP[op]), ...ctx.events]);
        let undo = null;
        if (UNDOABLE.has(op) && (ctx.snaps.length || ctx.created.length)) {
          undo = id();
          undoBox.set(undo, { at: Date.now(), snaps: ctx.snaps, logged: ctx.logged, created: ctx.created, prevList: ctx.prevList });
          for (const [k, v] of undoBox) if (Date.now() - v.at > 10 * 60000 || undoBox.size > 50) undoBox.delete(k);
        }
        save(db);
        broadcast();
        send(res, 200, { state: publicState(), undo, note: ctx.note });
      } catch (e) {
        db = JSON.parse(before); // an operation that failed half-way changes nothing
        if (e instanceof Conflict) return send(res, 409, { error: 'conflict', current: e.current });
        if (!(e instanceof Bad) && !(e instanceof SyntaxError)) console.error(e);
        send(res, 400, { error: e instanceof Bad ? e.message : 'בקשה לא תקינה' });
      } finally { ctx = null; }
    });
    return;
  }

  send(res, 404, { error: 'not found' });
});

const localUrl = `http://localhost:${PORT}`;
const openBrowser = () => {
  if (!process.argv.includes('--open')) return;
  const cmd = process.platform === 'win32' ? `start "" "${localUrl}"` : process.platform === 'darwin' ? `open ${localUrl}` : `xdg-open ${localUrl}`;
  exec(cmd);
};

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} is busy — the app is probably already running at ${localUrl}`);
    openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else throw e;
});

let db = load();
server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => `http://${n.address}:${PORT}`);
  console.log('\n  Jeel is running\n');
  console.log(`  On this computer:  ${localUrl}`);
  for (const u of lan) console.log(`  On your phone:     ${u}   (same Wi-Fi network)`);
  console.log(`\n  Data file: ${DB_FILE}`);
  console.log('  Stop: close this window or press Ctrl+C\n');
  openBrowser();
});
