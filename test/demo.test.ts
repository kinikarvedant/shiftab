// The public demo: seeds a believable venue, keeps its shared sign-in usable, and resets to a fresh copy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DEMO = '1'; // read when server/demo.ts loads, hence the dynamic imports below
const { buildApp } = await import('../server/index.ts');
const { DEMO_LOGIN, resetDemo, startDemo } = await import('../server/demo.ts');
const { buildReport } = await import('../shared/report.ts');
const { addDays, businessDay } = await import('../shared/time.ts');

const dir = mkdtempSync(join(tmpdir(), 'shiftab-demo-'));
const { app, ctx } = buildApp({ dataDir: dir, production: false, logger: false });
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

type Jar = Record<string, string>;
async function call(method: string, url: string, jar: Jar = {}, payload?: unknown) {
  const res = await app.inject({
    method: method as any, url, payload: payload as any,
    headers: { origin: 'http://localhost:80', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  for (const c of [res.headers['set-cookie'] ?? []].flat()) {
    const [kv] = String(c).split(';'); const i = kv.indexOf('=');
    jar[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

const jar: Jar = {};
let instance = '';

test('the demo starts set up, with its sign-in published and no stray sessions', async () => {
  await startDemo(app, ctx);
  const s = (await call('GET', '/api/state')).body;
  assert.equal(s.needsSetup, false);
  assert.deepEqual(s.demo, DEMO_LOGIN);
  instance = s.instance;
  assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
  assert.equal(ctx.db.list('users').length, 9);
});

test('nobody can lock the shared sign-in, change it or turn on 2FA', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', {}, { email: DEMO_LOGIN.email, password: 'wrong password' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', jar, { email: DEMO_LOGIN.email, password: DEMO_LOGIN.password })).status, 200);
  assert.equal((await call('POST', '/api/auth/password', jar, { current: DEMO_LOGIN.password, next: 'a new password!' })).status, 403);
  assert.equal((await call('POST', '/api/auth/totp/setup', jar, { password: DEMO_LOGIN.password })).status, 403);
});

test('uploads are refused', async () => {
  const me = (await call('GET', '/api/state', jar)).body.user.id;
  const r = await call('POST', '/api/sync/push', jar, { mutations: [{
    mid: randomUUID(), collection: 'photos', id: me, op: 'put', data: { dataUrl: 'data:image/png;base64,AAAA' }, at: Date.now(), actor: me, sig: null,
  }] });
  assert.equal(r.body.results[0].ok, false);
  assert.match(r.body.results[0].error, /turned off in the demo/);
});

test('four weeks of trade give a believable report', async () => {
  const to = addDays(businessDay(Date.now(), 'Australia/Melbourne', 4), -1), from = addDays(to, -27);
  const ds = await call('GET', `/api/finance/dataset?from=${from}&to=${to}`, jar);
  assert.equal(ds.status, 200);
  const rep = buildReport(ds.body, from, to);
  assert.equal(rep.days.filter((d) => d.orders > 0).length, 28, 'trade every day');
  assert.ok(rep.totals.orders > 1500 && rep.totals.orders < 3000, `${rep.totals.orders} orders`);
  const pct = rep.totals.labourPctBp! / 100;
  assert.ok(pct > 15 && pct < 45, `labour ${pct}%`);
  assert.ok(rep.totals.costs > 0 && rep.totals.profit > 0);
  assert.ok(rep.employees.some((e) => e.overtimeMinutes > 0), 'some overtime past 38 h');
  assert.ok(rep.employees.every((e) => !e.missingRate || e.shifts === 0));
  const open = ctx.db.list('orders').filter((o) => o.status === 'open');
  assert.equal(open.length, 4);
  assert.equal(new Set(open.map((o) => o.tableId)).size, 4, 'open orders on different tables');
});

test('a new device skips the old history in a few requests, and still gets everything live', async () => {
  let since = 0, requests = 0, more = true;
  const got = new Map<string, number>();
  while (more) {
    const r = await call('GET', `/api/sync/pull?since=${since}&limit=500`, jar);
    assert.equal(r.status, 200);
    for (const d of r.body.docs) got.set(d.c, (got.get(d.c) ?? 0) + 1);
    ({ cursor: since, more } = r.body);
    requests++;
  }
  assert.ok(requests <= 5, `${requests} requests`);
  assert.equal(since, ctx.db.seq());
  assert.ok((got.get('orders') ?? 0) < ctx.db.list('orders').length / 4, 'old orders stay on the server');
  assert.equal(got.get('reservations'), 4);
  assert.equal(got.get('tables'), 20);
});

test('a reset starts a fresh copy: new instance, sessions gone, history back', async () => {
  await resetDemo(app, ctx);
  const s = (await call('GET', '/api/state', jar)).body;
  assert.notEqual(s.instance, instance);
  assert.equal(s.user, null);
  assert.ok(ctx.db.list('payments').length > 1500);
  assert.equal((await call('POST', '/api/auth/login', {}, { email: DEMO_LOGIN.email, password: DEMO_LOGIN.password })).status, 200);
});
