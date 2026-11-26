// End-to-end authorisation checks against a real server on a temp database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/index.ts';
import { PIN_ITERATIONS, PWD_ITERATIONS, signingString } from '../shared/schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'p0rtal-test-'));
const { app } = buildApp({ dataDir: dir, production: false, setupCode: 'TESTCODE', logger: false });
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

type Jar = Record<string, string>;
async function call(method: string, url: string, jar: Jar = {}, payload?: unknown, origin = 'http://localhost:80') {
  const res = await app.inject({
    method: method as any, url, payload: payload as any,
    headers: { ...(origin ? { origin } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  for (const c of [res.headers['set-cookie'] ?? []].flat()) {
    const [kv] = String(c).split(';'); const i = kv.indexOf('=');
    jar[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const owner: Jar = {};
let staffKey: Buffer, ownerKey: Buffer, staffId = '', ownerId = '';
const docs = new Map<string, any>();

async function pull(jar: Jar) {
  const r = await call('GET', '/api/sync/pull?since=0&limit=1000', jar);
  assert.equal(r.status, 200);
  for (const d of r.body.docs) docs.set(`${d.c}/${d.id}`, d.data);
  return r.body.docs as any[];
}
const find = (c: string, f: (d: any) => boolean) => [...docs.entries()].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v).find(f);
const pinKey = (salt: string, pin: string) => pbkdf2Sync(pin, Buffer.from(salt, 'base64'), PIN_ITERATIONS, 32, 'sha256');
const pwdKey = (salt: string, pw: string) => pbkdf2Sync(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), PWD_ITERATIONS, 32, 'sha256');

function mutation(collection: string, id: string, data: any, actor: string, key: Buffer | null, at = Date.now(), op = 'put', kid?: 'pin' | 'pwd') {
  const m = { mid: randomUUID(), collection, id, op, data, at, actor };
  const sig = key ? createHmac('sha256', key).update(signingString(m as any, createHash('sha256').update(JSON.stringify(data)).digest('hex'))).digest('base64') : null;
  return { ...m, sig, ...(kid ? { kid } : {}) };
}
const push = (jar: Jar, ...mutations: unknown[]) => call('POST', '/api/sync/push', jar, { mutations });
const deviceOnly = () => ({ p0_dev: owner.p0_dev });

test('setup is guarded by the setup code and runs once', async () => {
  assert.equal((await call('GET', '/api/state')).body.needsSetup, true);
  const body = (code: string) => ({
    code, preset: 'restaurant',
    business: { name: 'Test Bistro', currency: 'USD', locale: 'en-US', timezone: 'UTC' },
    owner: { name: 'Olive Owner', email: 'owner@example.com', password: 'correct horse battery', pin: '1234' },
  });
  assert.equal((await call('POST', '/api/setup', {}, body('WRONG'))).status, 403);
  assert.equal((await call('POST', '/api/setup', owner, body('testcode'))).status, 200);
  assert.ok(owner.p0_sid && owner.p0_dev);
  assert.equal((await call('POST', '/api/setup', {}, body('TESTCODE'))).status, 409);
});

test('CSRF: state-changing requests need a same-origin Origin header', async () => {
  assert.equal((await call('POST', '/api/auth/logout', {}, {}, '')).status, 403);
  assert.equal((await call('POST', '/api/auth/logout', {}, {}, 'https://evil.example')).status, 403);
});

test('owner creates staff; terminals see users without emails', async () => {
  await pull(owner);
  const staffGroup = find('groups', (g) => g.name === 'Staff');
  const r = await call('POST', '/api/staff', owner, { name: 'Sam Server', groupId: staffGroup.id, color: '#fbbf24', pin: '4321' });
  assert.equal(r.status, 200);
  staffId = r.body.id;
  docs.clear();
  await pull(deviceOnly());
  const sam = docs.get(`users/${staffId}`);
  const own = find('users', (u) => u.name === 'Olive Owner');
  ownerId = own.id;
  assert.equal(own.email, null, 'device-only pulls never include emails');
  staffKey = pinKey(sam.pinSalt, '4321');
  ownerKey = pinKey(own.pinSalt, '1234');
  assert.equal(createHmac('sha256', staffKey).update('p0rtal-pin-check').digest('base64'), sam.pinCheck);
  assert.equal(sam.pinLen, 4, 'PIN length is recorded so the pad can submit on the last digit');
  assert.equal(own.pinLen, 4);
});

test('PIN-signed order flow; server computes totals and ignores forged ones', async () => {
  const item = find('items', (i) => i.name === 'Ribeye steak');
  const table = find('tables', () => true);
  const orderId = randomUUID(), lineId = randomUUID();
  const order = {
    number: 'A-1', type: 'dine_in', tableId: table.id, guests: 2, status: 'open', discount: null, note: '',
    billRequested: false, openedBy: staffId, openedAt: Date.now(), closedAt: null, voidReason: '',
    totals: { subtotal: 1, discount: 0, service: 0, tax: 0, total: 1 }, // forged
  };
  const line = { orderId, itemId: item.id, name: item.name, unitPrice: item.price, qty: 2, note: '', status: 'sent', sentAt: null, voided: false, voidReason: '', addedBy: staffId, addedAt: Date.now() };
  let r = await push(deviceOnly(), mutation('orders', orderId, order, staffId, staffKey), mutation('orderItems', lineId, line, staffId, staffKey));
  assert.deepEqual(r.body.results.map((x: any) => x.ok), [true, true]);

  // price override and discount need permissions Staff doesn't have
  r = await push(deviceOnly(), mutation('orderItems', randomUUID(), { ...line, unitPrice: 1 }, staffId, staffKey));
  assert.match(r.body.results[0].error, /Override item prices/);
  r = await push(deviceOnly(), mutation('orders', orderId, { ...order, discount: { kind: 'pct', value: 5000 } }, staffId, staffKey));
  assert.match(r.body.results[0].error, /Apply discounts/);

  // overpay refused, exact pay ok, then close
  const pay = (amount: number) => mutation('payments', randomUUID(), { orderId, method: 'Card', amount, tip: 0, tendered: null, takenBy: staffId, at: Date.now() }, staffId, staffKey);
  r = await push(deviceOnly(), pay(item.price * 2 + 1));
  assert.match(r.body.results[0].error, /more than the balance/);
  r = await push(deviceOnly(), pay(item.price * 2), mutation('orders', orderId, { ...order, status: 'paid' }, staffId, staffKey));
  assert.deepEqual(r.body.results.map((x: any) => x.ok), [true, true]);
  await pull(owner);
  assert.equal(docs.get(`orders/${orderId}`).totals.total, item.price * 2);

  // closed orders are immutable for staff
  r = await push(deviceOnly(), mutation('orders', orderId, { ...order, status: 'open' }, staffId, staffKey));
  assert.match(r.body.results[0].error, /Remove payments|reopen paid/);
});

test('signatures: forged actor rejected, replay is a no-op, unsigned needs a session', async () => {
  const s = docs.get('settings/business');
  const { id: _, updatedAt: _u, updatedBy: _b, ...settings } = s;
  // Staff key pretending to be the owner
  let r = await push(deviceOnly(), mutation('settings', 'business', { ...settings, name: 'Hacked' }, ownerId, staffKey));
  assert.match(r.body.results[0].error, /Signature/);
  // Owner's real PIN still can't use a sensitive permission
  r = await push(deviceOnly(), mutation('settings', 'business', { ...settings, name: 'Hacked' }, ownerId, ownerKey));
  assert.match(r.body.results[0].error, /Change business settings/);
  // Unsigned on a device without a session: kept for retry, not applied
  r = await push(deviceOnly(), mutation('settings', 'business', { ...settings, name: 'Hacked' }, ownerId, null));
  assert.equal(r.body.results[0].retry, true);
  // Owner password session can
  const m = mutation('settings', 'business', { ...settings, name: 'Renamed Bistro' }, ownerId, null);
  r = await push(owner, m);
  assert.equal(r.body.results[0].ok, true);
  r = await push(owner, m); // replay
  assert.equal(r.body.results[0].ok, true);
  // PIN signatures only count from an enrolled device
  r = await push({ p0_sid: owner.p0_sid }, mutation('photos', staffId, { dataUrl: 'data:image/png;base64,AAAA' }, staffId, staffKey));
  assert.equal(r.body.results[0].retry, true);
});

test('kitchen stations: a password session with staff rights, real categories and real people', async () => {
  const mains = find('categories', (c) => c.name === 'Mains');
  const station = { name: 'Grill', color: '#f87171', categoryIds: [mains.id], userIds: [staffId] };
  let r = await push(deviceOnly(), mutation('stations', randomUUID(), station, ownerId, ownerKey));
  assert.match(r.body.results[0].error, /Manage staff/, 'a PIN is not enough to assign stations');
  r = await push(owner, mutation('stations', randomUUID(), { ...station, categoryIds: [randomUUID()] }, ownerId, null));
  assert.match(r.body.results[0].error, /Unknown category/);
  r = await push(owner, mutation('stations', randomUUID(), { ...station, userIds: [randomUUID()] }, ownerId, null));
  assert.match(r.body.results[0].error, /Unknown employee/);
  r = await push(owner, mutation('stations', randomUUID(), station, ownerId, null));
  assert.equal(r.body.results[0].ok, true);
});

test('time clock: self punches must be at the current time', async () => {
  const shift = (clockIn: number) => ({ userId: staffId, clockIn, clockOut: null, breakMin: 0, note: '' });
  let r = await push(deviceOnly(), mutation('shifts', randomUUID(), shift(Date.now() - 3 * 3_600_000), staffId, staffKey));
  assert.match(r.body.results[0].error, /current time/);
  const id = randomUUID();
  r = await push(deviceOnly(), mutation('shifts', id, shift(Date.now()), staffId, staffKey));
  assert.equal(r.body.results[0].ok, true);
  r = await push(deviceOnly(), mutation('shifts', randomUUID(), shift(Date.now()), staffId, staffKey));
  assert.match(r.body.results[0].error, /already clocked in/);
});

test('breaks: staff start and end their own; the server times them, so nobody can shorten one', async () => {
  docs.clear(); await pull(owner);
  const open = find('shifts', (s) => s.userId === staffId && s.clockOut == null);
  const base = { userId: staffId, clockIn: open.clockIn, clockOut: null, note: open.note, breakMin: 0 };
  const t0 = Date.now(), MIN = 60_000;
  let r = await push(deviceOnly(), mutation('shifts', open.id, { ...base, breakStart: t0 }, staffId, staffKey, t0));
  assert.equal(r.body.results[0].ok, true, 'start a break');
  r = await push(deviceOnly(), mutation('shifts', open.id, { ...base, breakStart: null, breakMin: 0 }, staffId, staffKey, t0 + 3 * MIN));
  assert.equal(r.body.results[0].ok, true, 'end it three minutes later, claiming no break at all');
  docs.clear(); await pull(owner);
  assert.equal(docs.get(`shifts/${open.id}`).breakMin, 3, 'the server counts the real break');
  r = await push(deviceOnly(), mutation('shifts', open.id, { ...base, breakStart: null, breakMin: 0 }, staffId, staffKey));
  assert.match(r.body.results[0].error, /only clock yourself out/, 'staff cannot edit break minutes directly');
  r = await push(deviceOnly(), mutation('shifts', open.id, { ...base, breakMin: 3, breakStart: t0 + 3 * MIN }, staffId, staffKey, t0 + 3 * MIN));
  assert.equal(r.body.results[0].ok, true, 'a second break');
  r = await push(deviceOnly(), mutation('shifts', open.id, { ...base, breakMin: 3, breakStart: t0 + 3 * MIN, clockOut: t0 + 4 * MIN }, staffId, staffKey, t0 + 4 * MIN));
  assert.equal(r.body.results[0].ok, true, 'clock out mid-break');
  docs.clear(); await pull(owner);
  const closed = docs.get(`shifts/${open.id}`);
  assert.deepEqual([closed.breakMin, closed.breakStart], [4, null], 'the break ends with the shift');
});

test('finance needs a password session; pay rates round-trip encrypted', async () => {
  assert.equal((await call('GET', '/api/finance/rates', deviceOnly())).status, 401);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await call('POST', '/api/finance/rates', owner, { userId: staffId, rateCents: 1850, effectiveFrom: '2020-01-01' })).status, 200);
  const rates = (await call('GET', '/api/finance/rates', owner)).body;
  assert.equal(rates[0].rateCents, 1850);
  const ds = await call('GET', `/api/finance/dataset?from=${day}&to=${day}`, owner);
  assert.equal(ds.status, 200);
  assert.ok(ds.body.orders.some((o: any) => o.status === 'paid'));
});

test('other costs: finance managers add them (encrypted at rest); they reach the report data', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const cost = { day, spreadDays: 30, category: 'Equipment', description: 'Combi oven', amount: 300_000 };
  assert.equal((await call('POST', '/api/finance/expenses', deviceOnly(), cost)).status, 401, 'needs a password session');
  assert.equal((await call('POST', '/api/finance/expenses', owner, { ...cost, spreadDays: 12 })).status, 400, 'only the offered spreads');
  const r = await call('POST', '/api/finance/expenses', owner, cost);
  assert.equal(r.status, 200);
  const peek = new DatabaseSync(join(dir, 'p0rtal.db'), { readOnly: true });
  const raw = peek.prepare('SELECT data_enc FROM expenses WHERE id = ?').get(r.body.id) as any;
  peek.close();
  assert.ok(raw && !String(raw.data_enc).includes('Combi'), 'stored encrypted');
  const ds = (await call('GET', `/api/finance/dataset?from=${day}&to=${day}`, owner)).body;
  assert.deepEqual(ds.expenses.map((e: any) => [e.description, e.amount, e.spreadDays]), [['Combi oven', 300_000, 30]]);
  assert.equal((await call('GET', `/api/finance/dataset?from=2025-01-01&to=2026-01-02`, owner)).status, 400, 'a year at most');
  assert.equal((await call('DELETE', `/api/finance/expenses/${r.body.id}`, owner)).status, 200);
});

test('rank rules: a manager cannot touch the owner or grant owner-only permissions', async () => {
  const managerGroup = find('groups', (g) => g.name === 'Manager');
  const created = await call('POST', '/api/staff', owner, { name: 'Max Manager', groupId: managerGroup.id, color: '#60a5fa' });
  await call('POST', `/api/staff/${created.body.id}/login`, owner, { email: 'max@example.com', password: 'manager password 1' });
  const mgr: Jar = {};
  assert.equal((await call('POST', '/api/auth/login', mgr, { email: 'max@example.com', password: 'manager password 1' })).status, 200);
  assert.equal((await call('PATCH', `/api/staff/${ownerId}`, mgr, { active: false })).status, 403);
  assert.equal((await call('POST', '/api/groups', mgr, { name: 'Sneaky', rank: 70, permissions: ['settings.manage'], color: '#000000' })).status, 403);
  assert.equal((await call('POST', '/api/groups', mgr, { name: 'Peers', rank: 80, permissions: [], color: '#000000' })).status, 403);
  assert.equal((await call('PATCH', `/api/staff/${created.body.id}`, mgr, { groupId: find('groups', (g) => g.name === 'Owner').id })).status, 403);
  assert.equal((await call('GET', '/api/admin/backup', mgr)).status, 403);
  assert.equal((await call('POST', `/api/staff/${staffId}/pin`, mgr, { pin: '5555' })).status, 200);
});

test('overrides need a password key, not a PIN (offline PIN guessing cannot forge a void)', async () => {
  docs.clear();
  await pull(deviceOnly());
  const own = docs.get(`users/${ownerId}`);
  assert.ok(own.pwdSalt && own.pwdCheck, 'owner has an approval key');
  // the manager reset Sam's PIN to 5555 earlier, which revoked the old key immediately
  let r0 = await push(deviceOnly(), mutation('photos', staffId, { dataUrl: 'data:image/png;base64,AAAA' }, staffId, staffKey));
  assert.match(r0.body.results[0].error, /Signature/, 'old PIN no longer signs after a manager reset');
  staffKey = pinKey(docs.get(`users/${staffId}`).pinSalt, '5555');
  const item = find('items', (i) => i.name === 'Calamari');
  const orderId = randomUUID(), lineId = randomUUID();
  const order = { number: 'A-9', type: 'takeaway', tableId: null, guests: 0, status: 'open', discount: null, note: '', billRequested: false,
    openedBy: staffId, openedAt: Date.now(), closedAt: null, voidReason: '', totals: null };
  const line = { orderId, itemId: item.id, name: item.name, unitPrice: item.price, qty: 1, note: '', status: 'sent', sentAt: null, voided: false, voidReason: '', addedBy: staffId, addedAt: Date.now() };
  let r = await push(deviceOnly(), mutation('orders', orderId, order, staffId, staffKey), mutation('orderItems', lineId, line, staffId, staffKey));
  assert.deepEqual(r.body.results.map((x: any) => x.ok), [true, true]);
  const voided = { ...line, voided: true, voidReason: 'Sent back' };
  r = await push(deviceOnly(), mutation('orderItems', lineId, voided, ownerId, ownerKey));
  assert.match(r.body.results[0].error, /Void items/, 'owner PIN alone cannot void');
  const strong = pwdKey(own.pwdSalt, 'correct horse battery');
  r = await push(deviceOnly(), mutation('orderItems', lineId, voided, ownerId, strong, Date.now(), 'put', 'pwd'));
  assert.equal(r.body.results[0].ok, true, 'owner password key can void');
  r = await push(deviceOnly(), mutation('settings', 'business', { ...docs.get('settings/business') }, ownerId, strong, Date.now(), 'put', 'pwd'));
  assert.equal(r.body.results[0].ok, false, 'password key still cannot use sensitive permissions');
});

test('punches: no 24h+ self shifts, no overlaps; late punches are flagged', async () => {
  const at = Date.now() - 25 * 86_400_000;
  const id = randomUUID();
  const kim = (await call('POST', '/api/staff', owner, { name: 'Kim Kitchen', groupId: find('groups', (g) => g.name === 'Kitchen').id, color: '#f87171', pin: '2222' })).body.id;
  docs.clear(); await pull(deviceOnly());
  const k = pinKey(docs.get(`users/${kim}`).pinSalt, '2222');
  let r = await push(deviceOnly(), mutation('shifts', id, { userId: kim, clockIn: at, clockOut: null, breakMin: 0, note: '' }, kim, k, at));
  assert.equal(r.body.results[0].ok, true, 'an old offline clock-in is accepted…');
  docs.clear(); await pull(owner);
  assert.equal(docs.get(`shifts/${id}`).review, true, '…but flagged for review');
  r = await push(deviceOnly(), mutation('shifts', id, { userId: kim, clockIn: at, clockOut: Date.now(), breakMin: 0, note: '', review: false }, kim, k));
  assert.match(r.body.results[0].error, /over 24 hours/);
});

test('rejections leak nothing before authentication and repeat the same answer', async () => {
  const m = mutation('users', ownerId, { name: 'x' }, randomUUID(), randomBytes(32), 0);
  let r = await push(deviceOnly(), m);
  assert.equal(r.body.results[0].ok, false);
  assert.equal(r.body.results[0].current, null, 'no server copy for an unauthenticated change');
  r = await push(deviceOnly(), m);
  assert.equal(r.body.results[0].ok, false, 'a resent rejected change is still rejected');
});

test('payments are stamped with the signed action time, not a client-chosen one', async () => {
  const item = find('items', (i) => i.name === 'Fries');
  const orderId = randomUUID();
  const order = { number: 'A-10', type: 'takeaway', tableId: null, guests: 0, status: 'open', discount: null, note: '', billRequested: false,
    openedBy: staffId, openedAt: Date.now(), closedAt: null, voidReason: '', totals: null };
  const line = { orderId, itemId: item.id, name: 'Ribeye steak', unitPrice: item.price, qty: 1, note: '', status: 'new', sentAt: null, voided: false, voidReason: '', addedBy: staffId, addedAt: Date.now() };
  const payId = randomUUID(), lineId = randomUUID();
  const r = await push(deviceOnly(), mutation('orders', orderId, order, staffId, staffKey), mutation('orderItems', lineId, line, staffId, staffKey),
    mutation('payments', payId, { orderId, method: 'Cash', amount: item.price, tip: 0, tendered: null, takenBy: staffId, at: 9e12 }, staffId, staffKey));
  assert.deepEqual(r.body.results.map((x: any) => x.ok), [true, true, true]);
  docs.clear(); await pull(owner);
  assert.ok(docs.get(`payments/${payId}`).at < Date.now() + 1000);
  assert.equal(docs.get(`orderItems/${lineId}`).name, 'Fries', 'menu lines keep the menu name');
});

test('a manager cannot hand out a senior group, and 2FA setup needs the password', async () => {
  const sneaky = (await call('POST', '/api/groups', owner, { name: 'Office', rank: 70, permissions: ['settings.manage'], color: '#000000' })).body.id;
  const mgr: Jar = {};
  assert.equal((await call('POST', '/api/auth/login', mgr, { email: 'max@example.com', password: 'manager password 1' })).status, 200);
  assert.equal((await call('POST', '/api/staff', mgr, { name: 'Plant', groupId: sneaky, color: '#000000' })).status, 403);
  assert.equal((await call('POST', '/api/auth/totp/setup', mgr, {})).status, 400);
  assert.equal((await call('POST', '/api/auth/totp/setup', mgr, { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/auth/totp/setup', mgr, { password: 'manager password 1' })).status, 200);
});

test('CSRF check also covers encoded paths; session cookies do not persist', async () => {
  assert.equal((await call('POST', '/%61pi/sync/push', {}, { mutations: [] }, 'https://evil.example')).status, 403);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'http://localhost:80' }, payload: { email: 'max@example.com', password: 'manager password 1' } });
  const sid = [res.headers['set-cookie']].flat().find((c) => String(c).startsWith('p0_sid='));
  assert.ok(sid && !/Max-Age/i.test(String(sid)), 'browser-session cookie');
});

test('login lockout after repeated failures', async () => {
  const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9',
    headers: { origin: 'http://localhost:80' }, payload: { email: 'owner@example.com', password } }).then((r) => r.statusCode);
  for (let i = 0; i < 5; i++) assert.equal(await login('wrong-password'), 401);
  assert.equal(await login('correct horse battery'), 429);
});

test('dish photos: only menu editors can set them, and photos must belong to a person or a dish', async () => {
  const item = find('items', (i) => i.name === 'Calamari');
  const photo = { dataUrl: 'data:image/jpeg;base64,AAAA' };
  let r = await push(deviceOnly(), mutation('photos', item.id, photo, staffId, staffKey));
  assert.equal(r.body.results[0].ok, false, 'staff cannot change a dish photo');
  r = await push(deviceOnly(), mutation('photos', item.id, photo, ownerId, ownerKey));
  assert.equal(r.body.results[0].ok, true, 'a menu editor can, from a terminal');
  r = await push(deviceOnly(), mutation('photos', randomUUID(), photo, ownerId, ownerKey));
  assert.match(r.body.results[0].error, /Unknown employee or dish/);
});
