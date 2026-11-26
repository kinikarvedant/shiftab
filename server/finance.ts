// Finance: pay rates (encrypted at rest), report datasets, audit log, backups.
// Only password sessions with finance permissions (and TOTP when required) get here.
import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fail, parse, requireSession, userAndGroup, type Ctx } from './auth.ts';
import { open, seal } from './security.ts';
import { outranks, type Permission } from '../shared/permissions.ts';
import { addDays, weekStart } from '../shared/time.ts';
import type { Dataset } from '../shared/report.ts';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Invalid date');
const DAY = 86_400_000;

export function financeRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const settings = () => db.live('settings', 'business')!;

  function requireFinance(req: FastifyRequest, perm: Permission) {
    const me = requireSession(ctx, req, perm);
    if (settings().require2faForFinance && !me.session.totp) {
      fail(403, 'Finance needs two-factor sign-in. Turn on 2FA under Settings → Security, then sign in again.', { needTotp: true });
    }
    return me;
  }

  const rates = () => (db.raw.prepare('SELECT id, user_id, effective_from, data_enc FROM pay_rates ORDER BY effective_from').all() as any[])
    .map((r) => ({ id: r.id as string, userId: r.user_id as string, effectiveFrom: r.effective_from as string, ...JSON.parse(open(r.data_enc).toString()) as { rateCents: number } }));

  app.get('/api/finance/rates', async (req) => { requireFinance(req, 'finance.view'); return rates(); });

  app.post('/api/finance/rates', async (req) => {
    const me = requireFinance(req, 'finance.manage');
    const body = parse(z.strictObject({ userId: z.uuid(), rateCents: z.int().min(0).max(1_000_000), effectiveFrom: DateStr }), req.body);
    const t = userAndGroup(db, body.userId) ?? fail(404, 'Employee not found.');
    const self = body.userId === me.user.id;
    if (!(outranks(me.group, t.group) || (self && me.group.rank >= 100))) fail(403, 'You can only set pay for people below your rank.');
    const id = randomUUID();
    db.tx(() => {
      db.raw.prepare('DELETE FROM pay_rates WHERE user_id = ? AND effective_from = ?').run(body.userId, body.effectiveFrom);
      db.raw.prepare('INSERT INTO pay_rates (id, user_id, effective_from, data_enc, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, body.userId, body.effectiveFrom, seal(JSON.stringify({ rateCents: body.rateCents })), me.user.id, Date.now());
      db.audit(me.user.id, me.device?.id ?? null, 'payrate.set', body.userId, { name: t.user.name, rateCents: body.rateCents, effectiveFrom: body.effectiveFrom });
    });
    return { id };
  });

  app.delete('/api/finance/rates/:id', async (req) => {
    const me = requireFinance(req, 'finance.manage');
    const rid = parse(z.uuid(), (req.params as any).id);
    const row = db.raw.prepare('SELECT user_id FROM pay_rates WHERE id = ?').get(rid) as any ?? fail(404, 'Rate not found.');
    const t = userAndGroup(db, row.user_id);
    if (t && !outranks(me.group, t.group) && !(row.user_id === me.user.id && me.group.rank >= 100)) fail(403, 'You can only change pay for people below your rank.');
    db.raw.prepare('DELETE FROM pay_rates WHERE id = ?').run(rid);
    db.audit(me.user.id, me.device?.id ?? null, 'payrate.deleted', row.user_id, { id: rid });
    return { ok: true };
  });

  /** Raw data for shared/report.ts buildReport(). Shifts cover whole weeks so overtime is right. */
  app.get('/api/finance/dataset', async (req): Promise<Dataset> => {
    const me = requireFinance(req, 'finance.view');
    const q = req.query as Record<string, string>;
    const from = parse(DateStr, q.from), to = parse(DateStr, q.to);
    if (to < from || Date.parse(to) - Date.parse(from) > 62 * DAY) fail(400, 'Pick a range of at most 62 days.');
    const s = settings();
    // generous UTC windows; buildReport assigns exact business days
    const lo = Date.parse(`${from}T00:00:00Z`) - 2 * DAY, hi = Date.parse(`${to}T00:00:00Z`) + 3 * DAY;
    const shiftLo = Date.parse(`${addDays(weekStart(from, s.weekStartsOn), -1)}T00:00:00Z`) - DAY;
    const pick = (c: string, field: string, a: number, b: number) =>
      (db.raw.prepare(`SELECT id, data FROM docs WHERE collection = ? AND deleted = 0 AND json_extract(data, '$.${field}') BETWEEN ? AND ?`)
        .all(c, a, b) as any[]).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
    db.audit(me.user.id, me.device?.id ?? null, 'finance.viewed', null, { from, to });
    return {
      settings: { timezone: s.timezone, dayStartHour: s.dayStartHour, weekStartsOn: s.weekStartsOn, overtimeWeeklyHours: s.overtimeWeeklyHours, overtimeMultiplierPct: s.overtimeMultiplierPct },
      users: db.list('users').map((u) => ({ id: u.id, name: u.name, groupId: u.groupId, active: u.active })),
      rates: rates(),
      orders: pick('orders', 'closedAt', lo, hi).map((o) => ({ id: o.id, status: o.status, closedAt: o.closedAt, totals: o.totals })),
      payments: pick('payments', 'at', lo - 7 * DAY, hi).map((p) => ({ id: p.id, orderId: p.orderId, method: p.method, amount: p.amount, tip: p.tip, at: p.at })),
      shifts: pick('shifts', 'clockIn', shiftLo, hi).map((x) => ({ id: x.id, userId: x.userId, clockIn: x.clockIn, clockOut: x.clockOut, breakMin: x.breakMin })),
      generatedAt: Date.now(),
    };
  });

  /** Attendance history beyond what terminals keep. Managers see everyone; others see themselves. */
  app.get('/api/attendance', async (req) => {
    const me = requireSession(ctx, req);
    const q = req.query as Record<string, string>;
    const from = parse(DateStr, q.from), to = parse(DateStr, q.to);
    if (to < from || Date.parse(to) - Date.parse(from) > 92 * DAY) fail(400, 'Pick a range of at most 92 days.');
    const manage = me.group.permissions.includes('timeclock.manage');
    const visible = (userId: string) => {
      if (userId === me.user.id) return true;
      const t = manage ? userAndGroup(db, userId) : null;
      return !!t && outranks(me.group, t.group); // managers see their own and lower ranks only
    };
    const lo = Date.parse(`${from}T00:00:00Z`) - DAY, hi = Date.parse(`${to}T00:00:00Z`) + 2 * DAY;
    const rows = (db.raw.prepare(`SELECT id, data, updated_at, updated_by FROM docs WHERE collection = 'shifts' AND deleted = 0
      AND json_extract(data, '$.clockIn') BETWEEN ? AND ?`).all(lo, hi) as any[])
      .map((r) => ({ id: r.id, ...JSON.parse(r.data), updatedAt: r.updated_at, updatedBy: r.updated_by }))
      .filter((s) => visible(s.userId));
    return { shifts: rows };
  });

  app.get('/api/audit', async (req) => {
    requireSession(ctx, req, 'audit.view');
    const q = req.query as Record<string, string>;
    const before = Number.parseInt(q.before ?? '', 10) || Number.MAX_SAFE_INTEGER;
    return db.raw.prepare('SELECT id, ts, actor, device, action, target, detail FROM audit WHERE id < ? ORDER BY id DESC LIMIT 100').all(before);
  });

  // ---------- backups ----------
  const dir = join(ctx.config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const snapshot = (file: string) => { rmSync(file, { force: true }); db.raw.prepare('VACUUM INTO ?').run(file); };

  function daily() {
    const file = join(dir, `p0rtal-${new Date().toISOString().slice(0, 10)}.db`);
    try { statSync(file); return; } catch { /* not yet today */ }
    snapshot(file);
    db.raw.prepare('DELETE FROM mutations WHERE at < ?').run(Date.now() - 60 * DAY);
    for (const old of readdirSync(dir).filter((f) => /^p0rtal-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14)) rmSync(join(dir, old));
  }
  daily();
  setInterval(daily, 3_600_000).unref();

  app.get('/api/admin/backup', async (req, reply) => {
    const me = requireFinance(req, 'settings.manage'); // a backup contains all sales history: same 2FA rule as finance
    const file = join(dir, `download-${randomUUID()}.db`);
    snapshot(file);
    db.audit(me.user.id, me.device?.id ?? null, 'backup.downloaded', null);
    const stream = createReadStream(file);
    stream.on('close', () => rmSync(file, { force: true }));
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="shiftab-backup-${new Date().toISOString().slice(0, 10)}.db"`)
      .send(stream);
  });
}
