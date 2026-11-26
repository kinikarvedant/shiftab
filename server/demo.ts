// Public demo (DEMO=1): a sample bistro with four weeks of trading history, rebuilt from scratch about once an hour.
// The sign-in is shown to every visitor, so changes that would lock the next visitor out are turned off, and so
// are uploads. Everything here is made-up sample data.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './auth.ts';
import { orderTotals } from '../shared/money.ts';
import { COLLECTIONS, Settings, type CollectionName } from '../shared/schema.ts';
import { addDays, businessDay, weekStart, zonedTime } from '../shared/time.ts';

export const DEMO = process.env.DEMO === '1';
export const DEMO_LOGIN = { email: 'owner@shiftab.example', password: 'shiftab-demo', pin: '1234' };
export const demoInfo = () => (DEMO ? DEMO_LOGIN : null);

const MIN = 60_000;
const TZ = 'Australia/Melbourne';
const DAYS = 28;
const OFF = [/^POST \/api\/auth\/(password|totp\/)/, /^(POST|DELETE) \/api\/staff\/[^/]+\/login/];

// name, group, hourly rate (cents), days worked (0 = Sunday), shift start-end, unpaid break (min)
const ROSTER: [string, string, number, number[], string, string, number][] = [
  ['Jordan Lee', 'Manager', 3900, [2, 3, 4, 5, 6], '10:30', '21:30', 30],
  ['Ava Martin', 'Supervisor', 3400, [0, 1, 4, 5, 6], '11:00', '21:00', 30],
  ['Leo Nguyen', 'Staff', 3050, [1, 2, 3, 5, 6], '11:00', '19:00', 30],
  ['Zara Ahmed', 'Staff', 3050, [0, 3, 4, 5, 6], '16:30', '22:00', 0],
  ['Sam Taylor', 'Staff', 3050, [0, 1, 2, 4], '11:00', '19:00', 30],
  ['Marco Rossi', 'Kitchen', 3600, [2, 3, 4, 5, 6], '10:00', '21:00', 30],
  ['Mei Chen', 'Kitchen', 3300, [0, 1, 3, 4, 5], '15:00', '22:00', 30],
  ['Tom Walsh', 'Kitchen', 3300, [0, 1], '10:00', '20:00', 30],
];
const COLORS = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#a3e635', '#c084fc', '#2dd4bf'];
const ORDERS_BY_DAY = [90, 55, 60, 70, 80, 105, 115]; // Sunday first
const GUESTS = ['Nguyen', 'Smith', 'Papadopoulos', 'Kaur', 'Williams', "O'Brien"];

/** Small seeded PRNG (mulberry32) so a given day always gets the same sample trade. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Wipe every table, mark the database as a new instance (devices then clear their copy), and seed it again. */
export async function resetDemo(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  db.tx(() => {
    for (const t of ['docs', 'credentials', 'sessions', 'devices', 'mutations', 'audit', 'pay_rates', 'expenses']) db.raw.exec(`DELETE FROM ${t}`);
    db.raw.prepare("UPDATE meta SET value = ? WHERE key = 'instance'").run(randomUUID());
  });
  await seed(app, ctx);
  ctx.broadcast();
}

/** Turn the demo on: guard the routes, seed, and reset once the demo is an hour old and idle (or 3 hours old). */
export async function startDemo(app: FastifyInstance, ctx: Ctx) {
  app.addHook('onRequest', async (req, reply) => {
    if (OFF.some((r) => r.test(`${req.method} ${req.url}`))) {
      return reply.code(403).send({ error: 'Turned off in the demo, so the next visitor can still sign in.' });
    }
  });
  let seededAt = Date.now();
  await resetDemo(app, ctx);
  const last = () => Math.max(
    (ctx.db.raw.prepare('SELECT MAX(at) AS t FROM mutations').get() as any).t ?? 0,
    (ctx.db.raw.prepare('SELECT MAX(last_seen) AS t FROM sessions').get() as any).t ?? 0,
  );
  setInterval(() => {
    const now = Date.now();
    if (now - seededAt < 60 * MIN || (now - last() < 10 * MIN && now - seededAt < 180 * MIN)) return;
    seededAt = now;
    resetDemo(app, ctx).catch((e) => app.log.error(e));
  }, MIN).unref();
}

async function seed(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const jar: Record<string, string> = {};
  const call = async (method: 'POST', url: string, payload: object) => {
    const res = await app.inject({
      method, url, payload,
      headers: { origin: 'http://localhost:80', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    if (res.statusCode !== 200) throw new Error(`demo seed: ${url} answered ${res.statusCode} ${res.body}`);
    for (const c of [res.headers['set-cookie'] ?? []].flat()) {
      const [kv] = String(c).split(';'); const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return JSON.parse(res.body);
  };

  // The venue, owner, menu and floor come from the normal setup wizard.
  await call('POST', '/api/setup', {
    code: ctx.config.setupCode, preset: 'restaurant',
    business: { name: 'Laneway Bistro (demo)', currency: 'AUD', locale: 'en-AU', timezone: TZ },
    owner: { name: 'Alex Morgan', ...DEMO_LOGIN },
  });
  const owner = db.list('users')[0];
  const settings = Settings.parse({ ...db.live('settings', 'business'), taxRateBp: 1000, taxInclusive: true, overtimeWeeklyHours: 38 });
  db.put('settings', 'business', settings, owner.id);

  const now = Date.now();
  const today = businessDay(now, TZ, settings.dayStartHour);
  const first = addDays(today, -DAYS);
  const groups = new Map(db.list('groups').map((g) => [g.name, g.id]));
  const staff: { id: string; days: number[]; start: string; end: string; brk: number; front: boolean }[] = [];
  for (const [i, [name, group, rateCents, days, start, end, brk]] of ROSTER.entries()) {
    const { id } = await call('POST', '/api/staff', { name, groupId: groups.get(group), color: COLORS[i], pin: DEMO_LOGIN.pin });
    await call('POST', '/api/finance/rates', { userId: id, rateCents, effectiveFrom: addDays(first, -30) });
    staff.push({ id, days, start, end, brk, front: group !== 'Kitchen' });
  }
  for (let m = weekStart(first, 1); m <= today; m = addDays(m, 7)) {
    await call('POST', '/api/finance/expenses', { day: m, spreadDays: 7, category: 'Ingredients & stock', description: 'Weekly produce and dry goods', amount: 1_150_000 });
  }
  for (let m = `${first.slice(0, 7)}-01`; m <= today; m = `${addDays(m, 32).slice(0, 7)}-01`) {
    await call('POST', '/api/finance/expenses', { day: m, spreadDays: 30, category: 'Rent', description: 'Rent', amount: 1_400_000 });
    await call('POST', '/api/finance/expenses', { day: m, spreadDays: 30, category: 'Utilities', description: 'Power, gas and water', amount: 160_000 });
  }

  const cats = new Map(db.list('categories').map((c) => [c.name, c.id]));
  const menu = (cat: string) => db.list('items').filter((it) => it.categoryId === cats.get(cat));
  const [starters, mains, sides, desserts, drinks] = ['Starters', 'Mains', 'Sides', 'Desserts', 'Drinks'].map(menu);
  const tables = db.list('tables');
  // History goes straight into the store: every doc is checked against its schema, and stamped with its own
  // time so terminals (which keep only recent history) don't download four weeks of it.
  let seq = db.seq();
  const ins = db.raw.prepare('INSERT INTO docs (collection, id, data, seq, updated_at, updated_by, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)');
  const put = (c: CollectionName, data: object, at: number, by: string, id = randomUUID()) => {
    ins.run(c, id, JSON.stringify(COLLECTIONS[c].schema.parse(data)), ++seq, Math.min(at, now), by);
    return id;
  };
  const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
  const [marco, mei, tom] = staff.filter((s) => !s.front).map((s) => s.id);
  put('stations', { name: 'Grill', color: '#ef4444', categoryIds: ['Starters', 'Mains', 'Sides'].map((c) => cats.get(c)), userIds: [marco, tom] }, now, owner.id);
  put('stations', { name: 'Pastry', color: '#ec4899', categoryIds: [cats.get('Desserts')], userIds: [mei] }, now, owner.id);

  function order(r: () => number, n: number, openedAt: number, by: string, open?: { table: string; bill: boolean }) {
    const dineIn = !!open || r() < 0.85;
    const guests = dineIn ? 1 + Math.floor(r() * r() * 6) + (r() < 0.6 ? 1 : 0) : 1 + Math.floor(r() * 2);
    const lines = new Map<string, { it: any; qty: number }>();
    const add = (it: any) => { const l = lines.get(it.id); if (l) l.qty++; else lines.set(it.id, { it, qty: 1 }); };
    for (let g = 0; g < guests; g++) {
      add(pick(r, mains));
      if (dineIn && r() < 0.8) add(pick(r, drinks));
      if (r() < 0.35) add(pick(r, starters));
      if (r() < 0.3) add(pick(r, sides));
      if (dineIn && r() < 0.25) add(pick(r, desserts));
    }
    const discount = !open && r() < 0.04 ? { kind: 'pct' as const, value: 1000 } : null;
    const closedAt = open ? null : openedAt + (dineIn ? 40 + Math.floor(r() * 50) : 8 + Math.floor(r() * 10)) * MIN;
    const totals = orderTotals([...lines.values()].map((l) => ({ unitPrice: l.it.price, qty: l.qty, voided: false })), discount, settings);
    const id = randomUUID();
    for (const { it, qty } of lines.values()) {
      const sentAt = openedAt + 2 * MIN;
      put('orderItems', {
        orderId: id, itemId: it.id, name: it.name, unitPrice: it.price, qty, note: '', voided: false, voidReason: '',
        status: open && !open.bill && it.sendToKitchen ? 'sent' : 'ready', sentAt, addedBy: by, addedAt: openedAt + MIN,
      }, open ? now : closedAt!, by);
    }
    put('orders', {
      number: `A-${String(n).padStart(3, '0')}`, type: dineIn ? 'dine_in' : 'takeaway', tableId: open ? open.table : dineIn ? pick(r, tables).id : null,
      guests: dineIn ? guests : 0, status: open ? 'open' : 'paid', discount, note: '', billRequested: !!open?.bill,
      openedBy: by, openedAt, closedAt, voidReason: '', totals: open ? null : totals,
    }, open ? now : closedAt!, by, id);
    if (open) return;
    const cash = r() < 0.15;
    const tip = !cash && r() < 0.3 ? Math.round((totals.total * (0.05 + r() * 0.05)) / 50) * 50 : 0;
    put('payments', {
      orderId: id, method: cash ? 'Cash' : 'Card', amount: totals.total, tip,
      tendered: cash ? Math.ceil(totals.total / 1000) * 1000 : null, takenBy: by, at: closedAt!,
    }, closedAt!, by);
  }

  let number = 0; // today's last ticket number
  db.tx(() => {
    for (let day = first; day <= today; day = addDays(day, 1)) {
      const r = rng(Date.parse(day) / 86_400_000);
      const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
      const on = staff.filter((s) => s.days.includes(dow));
      for (const s of on) {
        const clockIn = zonedTime(day, s.start, TZ), end = zonedTime(day, s.end, TZ);
        if (clockIn > now) continue;
        const done = end <= now;
        put('shifts', {
          userId: s.id, clockIn, clockOut: done ? end : null, breakMin: done || now - clockIn > 4 * 60 * MIN ? s.brk : 0,
          breakStart: null, note: '', review: false,
        }, done ? end : now, s.id);
      }
      const front = on.filter((s) => s.front).map((s) => s.id);
      const count = Math.round(ORDERS_BY_DAY[dow] * (0.9 + r() * 0.2));
      const times = Array.from({ length: count }, (_, n) => n < count * 0.4
        ? zonedTime(day, '11:45', TZ) + Math.floor(r() * 150) * MIN
        : zonedTime(day, '17:30', TZ) + Math.floor(r() * 240) * MIN).sort((a, b) => a - b);
      // today: only what has been paid by now
      for (const [n, openedAt] of times.filter((t) => t + 90 * MIN <= now).entries()) {
        number = n + 1;
        order(r, number, openedAt, pick(r, front));
      }
    }
    // Service in progress: tickets on the kitchen screen at different ages, one table waiting for its bill.
    const r = rng(now);
    const fronts = staff.filter((s) => s.front);
    ([[34, true], [14, false], [10, false], [5, false]] as const).forEach(([age, bill], i) =>
      order(r, number + i + 1, now - age * MIN, pick(r, fronts).id, { table: tables[i * 3].id, bill }));
    for (const [i, hours] of [1, 1.5, 2.5, 26].entries()) {
      const start = Math.ceil((now + hours * 60 * MIN) / (30 * MIN)) * 30 * MIN;
      put('reservations', {
        name: GUESTS[i], phone: '', partySize: 2 + ((i * 3) % 5), start, durationMin: 90, tableId: null, status: 'booked', notes: i === 1 ? 'Birthday' : '',
      }, now, owner.id);
    }
  });
  // The seeding session and its terminal were only needed to call the API.
  db.raw.exec('DELETE FROM sessions; DELETE FROM devices;');
}
