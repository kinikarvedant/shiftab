// Offline sync: push (authenticate → validate → authorise → apply) and pull, plus SSE fan-out.
// To add a collection: give it a rule in RULES below (and a schema in shared/schema.ts).
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail, getCaller, userAndGroup, type Caller, type Ctx } from './auth.ts';
import { sha256, verifySig } from './security.ts';
import type { Db } from './db.ts';
import { can, outranks, PERMISSIONS, type AuthLevel, type Permission } from '../shared/permissions.ts';
import { COLLECTIONS, Mutation, signingString, type CollectionName, type GroupDoc, type UserDoc } from '../shared/schema.ts';
import { orderTotals, paidSum } from '../shared/money.ts';

interface Actor { id: string; user: UserDoc; group: GroupDoc & { id: string }; level: AuthLevel; device: string | null; can(p: Permission): boolean }
interface RuleCtx {
  m: Mutation; prev: any | null; next: any | null; actor: Actor; db: Db; settings: any;
  audit(action: string, detail?: unknown): void;
}
/** Return a string to reject (shown to the user). May adjust server-managed fields on `next`. */
type Rule = (x: RuleCtx) => string | null | void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** Terminals keep two pay weeks of shifts so staff can check their hours offline. */
export const SHIFT_WINDOW_DAYS = 14;
/** Sales/payments recorded more than this long before they reached the server are audited as late. */
const LATE = 6 * HOUR;
const denied = (p: Permission) => `You need the "${PERMISSIONS[p]}" permission.`;
const need = (p: Permission): Rule => ({ actor }) => (actor.can(p) ? null : denied(p));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function totalsFor(db: Db, orderId: string, discount: any, settings: any) {
  return orderTotals(db.byOrder('orderItems', orderId), discount, settings);
}

function refExists(db: Db, c: CollectionName, id: string | null | undefined, label: string): string | null {
  return id == null || db.live(c, id) ? null : `Unknown ${label}.`;
}

const RULES: Record<CollectionName, Rule> = {
  settings: (x) => {
    if (x.m.id !== 'business' || x.m.op !== 'put') return 'Invalid settings change.';
    const r = need('settings.manage')(x);
    if (!r) x.audit('settings.changed', Object.keys(x.next).filter((k) => !same(x.next[k], x.prev?.[k])));
    return r;
  },
  groups: () => 'Groups are changed from the Staff screen (needs a connection).',
  users: () => 'Staff are changed from the Staff screen (needs a connection).',
  photos: (x) => {
    if (x.db.live('items', x.m.id)) return need('menu.manage')(x); // a dish photo
    if (!x.db.live('users', x.m.id)) return 'Unknown employee or dish.';
    return x.m.id === x.actor.id || x.actor.can('staff.manage') ? null : 'You can only change your own photo.';
  },
  categories: need('menu.manage'),
  stations: (x) => {
    const r = need('staff.manage')(x);
    if (r || !x.next) return r;
    for (const id of x.next.categoryIds) { const bad = refExists(x.db, 'categories', id, 'category'); if (bad) return bad; }
    for (const id of x.next.userIds) { const bad = refExists(x.db, 'users', id, 'employee'); if (bad) return bad; }
    return null;
  },
  items: (x) => {
    const r = need('menu.manage')(x) ?? (x.next && refExists(x.db, 'categories', x.next.categoryId, 'category'));
    if (!r && x.prev && x.next && x.prev.price !== x.next.price) x.audit('menu.price', { name: x.next.name, from: x.prev.price, to: x.next.price });
    return r;
  },
  areas: need('floor.manage'),
  tables: (x) => need('floor.manage')(x) ?? (x.next && refExists(x.db, 'areas', x.next.areaId, 'area')),
  reservations: (x) => need('reservations.manage')(x) ?? (x.next && x.next.tableId !== x.prev?.tableId ? refExists(x.db, 'tables', x.next.tableId, 'table') : null),

  orders: (x) => {
    const { m, prev, next, actor, db } = x;
    if (m.op === 'del') return 'Orders are never deleted — void them instead.';
    const bad = next.tableId !== prev?.tableId ? refExists(db, 'tables', next.tableId, 'table') : null; // a deleted table must not strand its open order
    if (bad) return bad;
    if (next.discount?.kind === 'pct' && next.discount.value > 10_000) return 'A discount cannot exceed 100%.';
    if (!prev) {
      if (!actor.can('pos.use')) return denied('pos.use');
      if (next.status !== 'open') return 'New orders must start open.';
      if (next.discount) {
        if (!actor.can('orders.discount')) return denied('orders.discount');
        x.audit('order.discount', { to: next.discount });
      }
      Object.assign(next, { openedBy: actor.id, totals: null, closedAt: null });
      return;
    }
    Object.assign(next, { openedBy: prev.openedBy, openedAt: prev.openedAt, number: prev.number });
    if (prev.status === 'void') return 'This order was voided and can no longer change.';
    if (prev.status === 'paid') {
      if (next.status !== 'open') return 'This order is closed. Reopen it first.';
      if (!actor.can('payments.refund')) return denied('payments.refund');
      if (!same(next.discount, prev.discount)) {
        if (!actor.can('orders.discount')) return denied('orders.discount');
        x.audit('order.discount', { number: prev.number, from: prev.discount, to: next.discount });
      }
      Object.assign(next, { totals: null, closedAt: null });
      x.audit('order.reopened', { number: prev.number });
      return;
    }
    if (!same(next.discount, prev.discount)) {
      if (!actor.can('orders.discount')) return denied('orders.discount');
      x.audit('order.discount', { number: prev.number, from: prev.discount, to: next.discount });
    }
    const totals = totalsFor(db, m.id, next.discount, x.settings);
    const paid = paidSum(db.byOrder('payments', m.id));
    if (next.status === 'void') {
      if (!actor.can('orders.void')) return denied('orders.void');
      if (!next.voidReason) return 'Give a reason for voiding the order.';
      if (paid > 0) return 'Remove the payments before voiding this order.';
      Object.assign(next, { totals, closedAt: m.at });
      x.audit('order.voided', { number: prev.number, reason: next.voidReason, total: totals.total });
    } else if (next.status === 'paid') {
      if (!actor.can('payments.take')) return denied('payments.take');
      if (db.byOrder('orderItems', m.id).every((i) => i.voided)) return 'This order has no items.';
      if (paid < totals.total) return 'This order still has a balance to pay.';
      Object.assign(next, { totals, closedAt: m.at });
      if (Date.now() - m.at > LATE) x.audit('order.closed_late', { number: prev.number, closedAt: m.at, total: totals.total });
    } else {
      if (!actor.can('pos.use')) return denied('pos.use');
      Object.assign(next, { totals: null, closedAt: null });
    }
  },

  orderItems: (x) => {
    const { m, prev, next, actor, db } = x;
    const order = db.live('orders', (next ?? prev)?.orderId);
    if (!order) return m.op === 'del' && !prev ? null : 'Order not found.';
    if (m.op === 'del') {
      if (!prev) return null;
      if (prev.status !== 'new') return 'Items already sent to the kitchen must be voided, not removed.';
      if (order.status !== 'open') return 'This order is closed.';
      return need('pos.use')(x);
    }
    const priceOk = (price: number, itemId: string | null) => {
      const menu = itemId ? db.live('items', itemId) : null;
      if (menu && menu.price === price) return null;
      if (!actor.can('orders.price')) return denied('orders.price');
      x.audit('item.price_override', { order: order.number, name: next.name, price, menuPrice: menu?.price ?? null });
      return null;
    };
    if (!prev) {
      if (order.status !== 'open') return 'This order is closed.';
      if (!actor.can('pos.use')) return denied('pos.use');
      if (next.voided || next.status === 'ready') return 'Invalid new item.';
      const menuItem = next.itemId ? db.live('items', next.itemId) : null;
      if (next.itemId && !menuItem) return 'Unknown menu item.';
      if (menuItem) next.name = menuItem.name; // a menu line always shows the menu name (no "Ribeye" at a side's price)
      Object.assign(next, { addedBy: actor.id, sentAt: next.status === 'sent' ? m.at : null });
      return priceOk(next.unitPrice, next.itemId);
    }
    if (next.orderId !== prev.orderId || next.itemId !== prev.itemId) return 'Items cannot move between orders.';
    if (prev.voided) return 'This item was voided.';
    next.addedBy = prev.addedBy;
    next.addedAt = prev.addedAt;
    if (prev.itemId) next.name = prev.name;
    const contentChanged = ['name', 'unitPrice', 'qty', 'note', 'voided', 'voidReason'].some((k) => !same(next[k], prev[k]));

    if (!contentChanged) { // kitchen flow: allowed even after the order is paid (pay-first counters)
      next.sentAt = prev.sentAt;
      if (next.status === prev.status) return null;
      if (prev.status === 'new' && next.status === 'sent') {
        if (order.status !== 'open') return 'This order is closed.';
        next.sentAt = m.at;
        return need('pos.use')(x);
      }
      if (prev.status !== 'new' && next.status !== 'new') return actor.can('kitchen.view') || actor.can('pos.use') ? null : denied('kitchen.view');
      return 'Invalid status change.';
    }
    if (order.status !== 'open') return 'This order is closed.';
    if (next.voided) {
      if (!actor.can('orders.void')) return denied('orders.void');
      if (!next.voidReason) return 'Give a reason for the void.';
      Object.assign(next, { ...prev, voided: true, voidReason: next.voidReason });
      x.audit('item.voided', { order: order.number, name: prev.name, qty: prev.qty, unitPrice: prev.unitPrice, reason: next.voidReason });
      return;
    }
    if (prev.status !== 'new') return 'Items already sent to the kitchen can only be voided.';
    if (!actor.can('pos.use')) return denied('pos.use');
    if (next.status !== 'new' && next.status !== 'sent') return 'Invalid status change.';
    next.sentAt = next.status === 'sent' ? m.at : null;
    return next.unitPrice !== prev.unitPrice ? priceOk(next.unitPrice, prev.itemId) : null;
  },

  payments: (x) => {
    const { m, prev, next, actor, db } = x;
    if (m.op === 'del') {
      if (!prev) return null;
      const order = db.live('orders', prev.orderId);
      if (order?.status !== 'open') return 'Reopen the order before removing a payment.';
      if (!actor.can('payments.refund')) return denied('payments.refund');
      x.audit('payment.removed', { order: order.number, method: prev.method, amount: prev.amount, tip: prev.tip });
      return;
    }
    if (prev) return 'Payments cannot be edited — remove it and add a new one.';
    const order = db.live('orders', next.orderId);
    if (!order) return 'Order not found.';
    if (order.status !== 'open') return 'This order is closed.';
    if (!actor.can('payments.take')) return denied('payments.take');
    if (!x.settings.paymentMethods.includes(next.method)) return 'Unknown payment method.';
    const balance = totalsFor(db, next.orderId, order.discount, x.settings).total - paidSum(db.byOrder('payments', next.orderId));
    if (next.amount > balance) return 'That payment is more than the balance due.';
    if (next.tendered != null && next.tendered < next.amount) return 'Cash tendered is less than the payment.';
    next.takenBy = actor.id;
    next.at = m.at;
    if (Date.now() - m.at > LATE) x.audit('payment.late', { order: order.number, at: m.at, amount: next.amount });
    x.audit('payment', { order: order.number, method: next.method, amount: next.amount, tip: next.tip });
  },

  shifts: (x) => {
    const { m, prev, next, actor, db } = x;
    const userId = (next ?? prev)?.userId;
    const t = userId ? userAndGroup(db, userId) : null;
    if (!t) return m.op === 'del' && !prev ? null : 'Unknown employee.';
    const manage = actor.can('timeclock.manage') && outranks(actor.group, t.group);
    const now = (ts: number) => Math.abs(ts - m.at) <= 2 * MIN;
    const self = userId === actor.id && actor.can('timeclock.self');

    if (m.op === 'del') {
      if (!prev) return null;
      if (!manage) return denied('timeclock.manage');
      x.audit('shift.deleted', { user: t.user.name, ...prev });
      return;
    }
    if (next.clockOut != null && next.clockOut <= next.clockIn) return 'Clock-out must be after clock-in.';
    if (next.clockOut != null && next.clockOut - next.clockIn > DAY) {
      return manage ? 'A shift cannot be longer than 24 hours.' : 'That shift is over 24 hours — ask a manager to correct it.';
    }
    // Note: scans all shifts; index by userId if a venue ever keeps hundreds of thousands
    const clash = db.list('shifts').some((s) => s.id !== m.id && s.userId === userId
      && s.clockIn < (next.clockOut ?? Infinity) && (s.clockOut ?? Infinity) > next.clockIn);
    const late = Date.now() - m.at > 10 * MIN; // punched offline and synced later: still counted, but flagged

    if (!prev) {
      if (self && next.clockOut == null && next.breakMin === 0 && now(next.clockIn)) {
        if (clash) return 'You are already clocked in, or this overlaps another shift.';
        next.review = late;
        return null;
      }
      if (!manage) return 'You can only clock yourself in, at the current time.';
      if (clash) return 'That overlaps another shift for this person.';
      next.review = false;
      x.audit('shift.added', { user: t.user.name, ...next });
      return;
    }
    if (next.userId !== prev.userId) return 'A shift cannot move to another employee.';
    if (self && prev.clockOut == null && next.clockOut != null && now(next.clockOut)
      && next.clockIn === prev.clockIn && next.breakMin === prev.breakMin && next.note === prev.note) {
      if (clash) return 'This overlaps another shift — ask a manager to correct it.';
      next.review = !!prev.review || late || next.clockOut - next.clockIn > 16 * HOUR;
      return null;
    }
    if (!manage) return 'You can only clock yourself out, at the current time.';
    if (clash) return 'That overlaps another shift for this person.';
    next.review = false; // a manager has looked at it
    x.audit('shift.edited', { user: t.user.name, from: prev, to: next });
  },
};

/** Terminals only hold open + recent operational data (PLAN §3 "windowed"). */
function isVisible(c: CollectionName, d: any, updatedAt: number, cutoff: number, openOrder: (id: string) => boolean) {
  if (updatedAt >= cutoff) return true;
  switch (c) {
    case 'orders': return d.status === 'open';
    case 'orderItems': case 'payments': return openOrder(d.orderId);
    case 'shifts': return d.clockOut == null || d.clockIn >= Date.now() - SHIFT_WINDOW_DAYS * DAY;
    case 'reservations': return d.start >= cutoff;
    default: return true;
  }
}

export function syncRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const clients = new Set<ServerResponse>();
  ctx.broadcast = () => { const msg = `data: ${db.seq()}\n\n`; for (const c of clients) c.write(msg); };
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000).unref();

  const settings = () => db.live('settings', 'business');

  type Outcome = { ok: true } | { ok: false; retry: true; error: string } | { ok: false; retry?: false; error: string };

  /** The server's copy of a doc, but only what this actor could also get from a pull. */
  function visibleCopy(c: CollectionName, id: string, actor: Actor) {
    const cur = db.get(c, id);
    if (!cur || cur.deleted) return null;
    const cutoff = Date.now() - (settings()?.historyDays ?? 2) * DAY;
    const openOrder = (oid: string) => db.live('orders', oid)?.status === 'open';
    if (COLLECTIONS[c].windowed && !isVisible(c, cur.data, cur.updatedAt, cutoff, openOrder)) return null;
    const data = c === 'users' && !(actor.level === 'password' && actor.can('staff.manage')) ? { ...cur.data, email: null } : cur.data;
    return { ...data, id, updatedAt: cur.updatedAt, updatedBy: cur.updatedBy };
  }

  function resolveActor(m: Mutation, raw: any, caller: Caller): Actor | Outcome {
    const ug = userAndGroup(db, m.actor);
    if (!ug || !ug.user.active) return { ok: false, error: 'This employee is not active.' };
    let level: AuthLevel;
    if (m.sig) {
      if (!caller.device) return { ok: false, retry: true, error: 'This device is not enrolled. Ask a manager to enrol it.' };
      const cred = db.raw.prepare('SELECT pin_key_enc, pin_prev_enc, pin_changed_at, pwd_key_enc FROM credentials WHERE user_id = ?').get(m.actor) as any;
      const msg = signingString(m, sha256(JSON.stringify(raw.data)));
      let valid = false;
      if (m.kid === 'pwd') {
        valid = !!cred?.pwd_key_enc && verifySig(cred.pwd_key_enc, msg, m.sig);
        level = 'strong';
      } else {
        // the previous PIN only covers changes made before the switch, and only for a short grace period
        const grace = !!cred && m.at < cred.pin_changed_at && Date.now() - cred.pin_changed_at < 12 * HOUR;
        valid = (!!cred?.pin_key_enc && verifySig(cred.pin_key_enc, msg, m.sig)) || (!!cred?.pin_prev_enc && grace && verifySig(cred.pin_prev_enc, msg, m.sig));
        level = 'pin';
      }
      if (!valid) return { ok: false, error: 'Signature check failed.' };
    } else {
      if (caller.session?.userId !== m.actor) return { ok: false, retry: true, error: `${ug.user.name} needs to sign in again to save changes.` };
      level = 'password';
    }
    return { id: m.actor, user: ug.user, group: ug.group, level, device: caller.device?.id ?? null, can: (p) => can(ug.user, ug.group, p, level) };
  }

  function apply(raw: unknown, caller: Caller): Outcome & { current?: unknown } {
    const parsed = Mutation.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Malformed change.' };
    const m = parsed.data;
    const seen = db.raw.prepare('SELECT result FROM mutations WHERE mid = ?').get(m.mid) as any;
    if (seen) return seen.result ? { ...JSON.parse(seen.result), current: null } : { ok: true }; // same answer as the first time
    const now = Date.now();
    let viewer: Actor | null = null;
    const reject = (error: string) => {
      db.raw.prepare('INSERT OR IGNORE INTO mutations (mid, at, result) VALUES (?, ?, ?)').run(m.mid, now, JSON.stringify({ ok: false, error }));
      return { ok: false as const, error, current: viewer ? visibleCopy(m.collection, m.id, viewer) : null };
    };
    if (m.at > now + 5 * MIN) return { ok: false, retry: true, error: "This device's clock is ahead. Fix the date and time." };

    const actor = resolveActor(m, raw, caller);
    if ('ok' in actor) return actor.ok || actor.retry ? actor : reject(actor.error);
    viewer = actor; // authenticated: rejections may now send back the server's copy (filtered like a pull)
    if (m.at < now - 30 * DAY) return reject('This change is too old to apply.');
    if (m.collection !== 'settings' && !UUID.test(m.id)) return reject('Invalid id.');

    const def = COLLECTIONS[m.collection];
    let next: any = null;
    if (m.op === 'put') {
      const v = def.schema.safeParse(m.data);
      if (!v.success) return reject(`Invalid data: ${v.error.issues[0]?.path.join('.')} ${v.error.issues[0]?.message}`);
      next = v.data;
    }
    const stored = db.get(m.collection, m.id);
    const prev = stored && !stored.deleted ? stored.data : null;
    const audits: [string, unknown][] = [];
    return db.tx(() => {
      const err = RULES[m.collection]({ m, prev, next, actor, db, settings: settings(), audit: (a, d) => audits.push([a, d]) });
      if (err) return reject(err);
      if (m.op === 'del') { if (prev) db.put(m.collection, m.id, prev, actor.id, true); }
      else db.put(m.collection, m.id, next, actor.id);
      for (const [a, d] of audits) db.audit(actor.id, actor.device, a, `${m.collection}/${m.id}`, d);
      db.raw.prepare('INSERT INTO mutations (mid, at) VALUES (?, ?)').run(m.mid, now);
      return { ok: true as const };
    });
  }

  app.post('/api/sync/push', async (req) => {
    const caller = getCaller(ctx, req);
    if (!caller.session && !caller.device) fail(401, 'Sign in or enrol this device first.');
    const body = z.object({ mutations: z.array(z.unknown()).max(200) }).safeParse(req.body);
    if (!body.success) fail(400, 'Malformed push.');
    const results: unknown[] = [];
    let changed = false;
    for (const raw of body.data!.mutations) {
      let r;
      try { r = apply(raw, caller); } catch (e) { req.log.error(e); r = { ok: false, retry: true, error: 'Server error — will retry.' }; }
      results.push({ mid: (raw as any)?.mid, ...r });
      if (r.ok) changed = true;
      if (!r.ok && r.retry) break; // keep order: nothing behind a stuck change is applied
    }
    if (changed) ctx.broadcast();
    return { results, seq: db.seq() };
  });

  app.get('/api/sync/pull', async (req) => {
    const caller = getCaller(ctx, req);
    if (!caller.session && !caller.device) fail(401, 'Sign in or enrol this device first.');
    const q = req.query as Record<string, string>;
    const since = Math.max(0, Number.parseInt(q.since ?? '0', 10) || 0);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(q.limit ?? '500', 10) || 500));
    const s = settings();
    const cutoff = Date.now() - (s?.historyDays ?? 2) * DAY;
    const viewer = caller.session ? userAndGroup(db, caller.session.userId) : null;
    const seeEmails = !!viewer && can(viewer.user, viewer.group, 'staff.manage', 'password');
    const openOrders = new Set(
      (db.raw.prepare("SELECT id FROM docs WHERE collection = 'orders' AND deleted = 0 AND json_extract(data, '$.status') = 'open'").all() as any[]).map((r) => r.id),
    );
    const keep = (c: CollectionName, d: any, updatedAt: number) => isVisible(c, d, updatedAt, cutoff, (id) => openOrders.has(id));
    const rows = db.since(since, limit + 1);
    const docs = [];
    for (const r of rows.slice(0, limit)) {
      if (r.deleted) { docs.push({ c: r.collection, id: r.id, seq: r.seq, deleted: true }); continue; }
      if (COLLECTIONS[r.collection].windowed && !keep(r.collection, r.data, r.updatedAt)) continue;
      const data = r.collection === 'users' && !seeEmails ? { ...r.data, email: null } : r.data;
      docs.push({ c: r.collection, id: r.id, seq: r.seq, data: { ...data, id: r.id, updatedAt: r.updatedAt, updatedBy: r.updatedBy } });
    }
    const cursor = rows.length ? rows[Math.min(rows.length, limit) - 1].seq : since;
    return { docs, cursor, more: rows.length > limit };
  });

  app.get('/api/events', (req, reply) => {
    const caller = getCaller(ctx, req);
    if (!caller.session && !caller.device) return reply.code(401).send({ error: 'Unauthorised' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
    });
    res.write(`retry: 3000\ndata: ${db.seq()}\n\n`);
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
  });
}
