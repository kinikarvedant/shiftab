// Who is calling (session / enrolled device), setup wizard, password login, TOTP, device enrolment.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import {
  checkTotp, dummyVerify, hashPassword, limiter, makePin, makeStrongKey, newTotpSecret, open, randomToken, safeEqual, seal, sha256, verifyPassword,
} from './security.ts';
import { can, DEFAULT_GROUPS, type Permission } from '../shared/permissions.ts';
import { DEFAULT_SETTINGS, PIN_RE, Settings, type GroupDoc, type UserDoc } from '../shared/schema.ts';
import { PRESETS } from '../shared/presets.ts';

export interface Config { production: boolean; dataDir: string; setupCode: string }
export interface Ctx { db: Db; config: Config; broadcast: () => void }

const SESSION_IDLE = 30 * 60_000;
const SESSION_MAX = 12 * 3_600_000;
const DEVICE_MAX_AGE = 400 * 86_400; // seconds (browser maximum)

export const fail = (statusCode: number, message: string, extra?: object): never => {
  throw Object.assign(new Error(message), { statusCode, extra });
};

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) fail(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return (r as { data: z.output<T> }).data;
}

export const Password = z.string().min(10, 'Password must be at least 10 characters').max(256);
export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

// ---------- cookies ----------
function cookieNames(c: Config) {
  return c.production ? { sid: '__Host-p0_sid', dev: '__Host-p0_dev' } : { sid: 'p0_sid', dev: 'p0_dev' };
}
function readCookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return out;
}
/** maxAge null = browser-session cookie (gone when the browser closes). */
function setCookie(reply: FastifyReply, c: Config, name: string, value: string, maxAge: number | null) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (maxAge != null) attrs.push(`Max-Age=${maxAge}`);
  if (c.production) attrs.push('Secure');
  const prev = reply.getHeader('set-cookie');
  reply.header('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), attrs.join('; ')]);
}

// ---------- caller ----------
export interface Caller {
  session: { tokenHash: string; userId: string; totp: boolean } | null;
  device: { id: string; name: string; code: string } | null;
}
const callers = new WeakMap<FastifyRequest, Caller>();

export function getCaller(ctx: Ctx, req: FastifyRequest): Caller {
  const cached = callers.get(req);
  if (cached) return cached;
  const names = cookieNames(ctx.config);
  const cookies = readCookies(req);
  const now = Date.now();
  const caller: Caller = { session: null, device: null };
  const db = ctx.db.raw;

  if (cookies[names.sid]) {
    const h = sha256(cookies[names.sid]);
    const s = db.prepare('SELECT user_id, last_seen, expires_at, totp FROM sessions WHERE token_hash = ?').get(h) as any;
    if (s && s.expires_at > now && s.last_seen + SESSION_IDLE > now) {
      caller.session = { tokenHash: h, userId: s.user_id, totp: !!s.totp };
      // Background pulls and the event stream are not activity: they must not keep an idle session alive.
      const background = req.method === 'GET' && (req.url.startsWith('/api/sync/pull') || req.url.startsWith('/api/events'));
      if (!background && now - s.last_seen > 30_000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, h);
    } else if (s) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
  }
  if (cookies[names.dev]) {
    const d = db.prepare('SELECT id, name, code, last_seen FROM devices WHERE token_hash = ?').get(sha256(cookies[names.dev])) as any;
    if (d) {
      caller.device = { id: d.id, name: d.name, code: d.code };
      if (now - d.last_seen > 60_000) db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, d.id);
    }
  }
  callers.set(req, caller);
  return caller;
}

export function userAndGroup(db: Db, userId: string) {
  const user = db.live('users', userId) as UserDoc | null;
  const group = user ? (db.live('groups', user.groupId) as GroupDoc | null) : null;
  if (!user || !group) return null;
  return { user: { ...user, id: userId }, group: { ...group, id: user.groupId } };
}

/** A valid password session whose user is active (and holds `perm`, if given). */
export function requireSession(ctx: Ctx, req: FastifyRequest, perm?: Permission) {
  const { session, device } = getCaller(ctx, req);
  if (!session) return fail(401, 'Please sign in with your password.');
  const ug = userAndGroup(ctx.db, session.userId);
  if (!ug || !ug.user.active) return fail(401, 'Your account is not active.');
  if (perm && !can(ug.user, ug.group, perm, 'password')) fail(403, 'You do not have permission to do that.');
  return { ...ug, session, device };
}

function createSession(ctx: Ctx, reply: FastifyReply, userId: string, totp: boolean) {
  const token = randomToken();
  const now = Date.now();
  ctx.db.raw.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, totp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, now, now, now + SESSION_MAX, totp ? 1 : 0);
  setCookie(reply, ctx.config, cookieNames(ctx.config).sid, token, null);
}

/** (Re)derive the password-based approval key that lets terminals sign manager overrides offline. */
export async function setStrongKey(db: Db, userId: string, password: string, actor: string) {
  const k = await makeStrongKey(password);
  db.tx(() => {
    db.raw.prepare('UPDATE credentials SET pwd_key_enc = ? WHERE user_id = ?').run(k.keyEnc, userId);
    const u = db.live('users', userId);
    if (u) db.put('users', userId, { ...u, pwdSalt: k.salt, pwdCheck: k.check }, actor);
  });
}

export const killSessions = (db: Db, userId: string, except?: string) =>
  db.raw.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, except ?? '');

function enrolDevice(ctx: Ctx, reply: FastifyReply, name: string, by: string) {
  const used = new Set((ctx.db.raw.prepare('SELECT code FROM devices').all() as any[]).map((r) => r.code));
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const code = [...letters].find((l) => !used.has(l))
    ?? [...letters].flatMap((a) => [...letters].map((b) => a + b)).find((l) => !used.has(l))!;
  const token = randomToken();
  const id = randomUUID();
  const now = Date.now();
  ctx.db.raw.prepare('INSERT INTO devices (id, name, code, token_hash, created_by, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, code, sha256(token), by, now, now);
  setCookie(reply, ctx.config, cookieNames(ctx.config).dev, token, DEVICE_MAX_AGE);
  return { id, name, code };
}

const needsSetup = (db: Db) => !db.raw.prepare("SELECT 1 FROM docs WHERE collection = 'users' LIMIT 1").get();

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const credLimit = limiter(10, 15 * 60_000);
  const limitIp = (req: FastifyRequest) => { if (!credLimit(req.ip)) fail(429, 'Too many attempts. Try again in a few minutes.'); };

  app.get('/api/state', async (req) => {
    const { session, device } = getCaller(ctx, req);
    const ug = session ? userAndGroup(db, session.userId) : null;
    return {
      needsSetup: needsSetup(db),
      device,
      user: ug?.user.active ? { id: ug.user.id, name: ug.user.name, groupId: ug.user.groupId, email: ug.user.email } : null,
      totp: session?.totp ?? false,
      now: Date.now(),
    };
  });

  // ---------- first-run setup ----------
  app.post('/api/setup', async (req, reply) => {
    limitIp(req);
    const body = parse(z.strictObject({
      code: z.string().max(64),
      business: Settings.pick({ name: true, currency: true, locale: true, timezone: true }),
      preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]),
      owner: z.strictObject({ name: z.string().trim().min(1).max(60), email: Email, password: Password, pin: z.string().regex(PIN_RE, 'PIN must be 4-8 digits') }),
    }), req.body);
    if (!needsSetup(db)) fail(409, 'This venue is already set up.');
    if (!safeEqual(body.code.trim().toUpperCase(), ctx.config.setupCode)) fail(403, 'Wrong setup code. It is printed in the server log.');

    const hash = await hashPassword(body.owner.password);
    const pin = makePin(body.owner.pin);
    const ownerId = randomUUID();
    const device = db.tx(() => {
      if (!needsSetup(db)) fail(409, 'This venue is already set up.');
      db.put('settings', 'business', Settings.parse({ ...DEFAULT_SETTINGS, ...body.business }), ownerId);
      let ownerGroup = '';
      for (const g of DEFAULT_GROUPS) {
        const id = randomUUID();
        if (g.key === 'owner') ownerGroup = id;
        db.put('groups', id, { name: g.name, rank: g.rank, permissions: g.permissions, color: g.color }, ownerId);
      }
      db.put('users', ownerId, {
        name: body.owner.name, groupId: ownerGroup, active: true, color: '#a78bfa',
        email: body.owner.email, pinSalt: pin.salt, pinCheck: pin.check, pinLen: pin.len, pwdSalt: null, pwdCheck: null, hasPassword: true, hasTotp: false,
      }, ownerId);
      db.raw.prepare('INSERT INTO credentials (user_id, email, password_hash, pin_key_enc) VALUES (?, ?, ?, ?)')
        .run(ownerId, body.owner.email, hash, pin.keyEnc);
      const preset = PRESETS[body.preset];
      preset.menu.forEach((cat, ci) => {
        const catId = randomUUID();
        db.put('categories', catId, { name: cat.name, sort: ci, color: cat.color }, ownerId);
        cat.items.forEach(([name, price, kitchen = true], ii) =>
          db.put('items', randomUUID(), { name, categoryId: catId, price, active: true, sort: ii, sendToKitchen: kitchen }, ownerId));
      });
      preset.floor.forEach((area, ai) => {
        const areaId = randomUUID();
        db.put('areas', areaId, { name: area.name, sort: ai }, ownerId);
        area.tables.forEach(([name, seats], ti) => db.put('tables', randomUUID(), { name, areaId, seats, sort: ti }, ownerId));
      });
      db.audit(ownerId, null, 'setup', null, { preset: body.preset });
      return enrolDevice(ctx, reply, 'Main terminal', ownerId);
    });
    await setStrongKey(db, ownerId, body.owner.password, ownerId);
    createSession(ctx, reply, ownerId, false);
    ctx.broadcast();
    return { ok: true, device };
  });

  // ---------- password login ----------
  app.post('/api/auth/login', async (req, reply) => {
    limitIp(req);
    const body = parse(z.object({ email: Email, password: z.string().max(256), totp: z.string().max(10).optional() }), req.body);
    const cred = db.raw.prepare('SELECT * FROM credentials WHERE email = ?').get(body.email) as any;
    const now = Date.now();
    const deny = (msg = 'Wrong email or password.') => {
      if (cred) {
        const r = db.raw.prepare('UPDATE credentials SET failed = failed + 1 WHERE user_id = ? RETURNING failed').get(cred.user_id) as any;
        if (r.failed >= 5) db.raw.prepare('UPDATE credentials SET failed = 0, locked_until = ? WHERE user_id = ?').run(now + 15 * 60_000, cred.user_id);
      }
      db.audit(cred?.user_id ?? null, null, 'login.failed', null, { email: body.email, ip: req.ip });
      return fail(401, msg);
    };
    if (!cred?.password_hash) { await dummyVerify(body.password); return deny(); }
    if (cred.locked_until > now) fail(429, 'Too many attempts. Try again in a few minutes.');
    if (!(await verifyPassword(body.password, cred.password_hash))) return deny();
    const ug = userAndGroup(db, cred.user_id);
    if (!ug?.user.active) return deny();

    let totp = false;
    if (cred.totp_enc) {
      if (!body.totp) return fail(401, 'Enter the 6-digit code from your authenticator app.', { needTotp: true });
      const step = checkTotp(open(cred.totp_enc).toString(), body.totp.trim(), cred.totp_last, now);
      if (step == null) return deny('That code is not valid. Check your authenticator app.');
      db.raw.prepare('UPDATE credentials SET totp_last = ? WHERE user_id = ?').run(step, cred.user_id);
      totp = true;
    }
    db.raw.prepare('UPDATE credentials SET failed = 0, locked_until = 0 WHERE user_id = ?').run(cred.user_id);
    if (!cred.pwd_key_enc) { await setStrongKey(db, cred.user_id, body.password, cred.user_id); ctx.broadcast(); } // older accounts
    createSession(ctx, reply, cred.user_id, totp);
    db.audit(cred.user_id, getCaller(ctx, req).device?.id ?? null, 'login', null, { ip: req.ip, totp });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const { session } = getCaller(ctx, req);
    if (session) db.raw.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
    setCookie(reply, ctx.config, cookieNames(ctx.config).sid, '', 0);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    limitIp(req);
    const me = requireSession(ctx, req);
    const body = parse(z.strictObject({ current: z.string().max(256), next: Password }), req.body);
    const cred = db.raw.prepare('SELECT password_hash FROM credentials WHERE user_id = ?').get(me.user.id) as any;
    if (!cred?.password_hash || !(await verifyPassword(body.current, cred.password_hash))) fail(401, 'Current password is wrong.');
    db.raw.prepare('UPDATE credentials SET password_hash = ? WHERE user_id = ?').run(await hashPassword(body.next), me.user.id);
    await setStrongKey(db, me.user.id, body.next, me.user.id);
    killSessions(db, me.user.id, me.session.tokenHash);
    ctx.broadcast();
    db.audit(me.user.id, me.device?.id ?? null, 'password.changed', me.user.id);
    return { ok: true };
  });

  // ---------- TOTP 2FA (self-service) ----------
  app.post('/api/auth/totp/setup', async (req) => {
    limitIp(req);
    const me = requireSession(ctx, req);
    const { password } = parse(z.strictObject({ password: z.string().max(256) }), req.body);
    const cred = db.raw.prepare('SELECT password_hash, totp_enc FROM credentials WHERE user_id = ?').get(me.user.id) as any;
    if (!cred?.password_hash || !(await verifyPassword(password, cred.password_hash))) fail(401, 'Your password is wrong.');
    if (cred.totp_enc) fail(409, 'Two-factor is already on. Turn it off first (that needs a current code).');
    const secret = newTotpSecret();
    db.raw.prepare('UPDATE credentials SET totp_pending_enc = ? WHERE user_id = ?').run(seal(secret), me.user.id);
    const label = encodeURIComponent(`Shiftab:${me.user.email ?? me.user.name}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Shiftab&digits=6&period=30` };
  });

  const setTotpFlag = (userId: string, on: boolean, actor: string) => {
    const u = db.live('users', userId)!;
    db.put('users', userId, { ...u, hasTotp: on }, actor);
  };

  app.post('/api/auth/totp/enable', async (req) => {
    limitIp(req);
    const me = requireSession(ctx, req);
    const { code } = parse(z.strictObject({ code: z.string().max(10) }), req.body);
    const cred = db.raw.prepare('SELECT totp_pending_enc, totp_last FROM credentials WHERE user_id = ?').get(me.user.id) as any;
    if (!cred?.totp_pending_enc) fail(400, 'Start 2FA setup first.');
    const step = checkTotp(open(cred.totp_pending_enc).toString(), code.trim(), cred.totp_last);
    if (step == null) fail(400, 'That code is not valid. Check the time on your phone and try again.');
    db.tx(() => {
      db.raw.prepare('UPDATE credentials SET totp_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last = ? WHERE user_id = ?').run(step, me.user.id);
      db.raw.prepare('DELETE FROM sessions WHERE user_id = ?').run(me.user.id); // sign in again, now with the code
      setTotpFlag(me.user.id, true, me.user.id);
      db.audit(me.user.id, me.device?.id ?? null, 'totp.enabled', me.user.id);
    });
    ctx.broadcast();
    return { ok: true, signedOut: true };
  });

  app.post('/api/auth/totp/disable', async (req) => {
    limitIp(req);
    const me = requireSession(ctx, req);
    const { code } = parse(z.strictObject({ code: z.string().max(10) }), req.body);
    const cred = db.raw.prepare('SELECT totp_enc, totp_last FROM credentials WHERE user_id = ?').get(me.user.id) as any;
    if (!cred?.totp_enc) fail(400, '2FA is not enabled.');
    if (checkTotp(open(cred.totp_enc).toString(), code.trim(), cred.totp_last) == null) fail(400, 'That code is not valid.');
    db.tx(() => {
      db.raw.prepare('UPDATE credentials SET totp_enc = NULL WHERE user_id = ?').run(me.user.id);
      db.raw.prepare('UPDATE sessions SET totp = 0 WHERE user_id = ?').run(me.user.id);
      setTotpFlag(me.user.id, false, me.user.id);
      db.audit(me.user.id, me.device?.id ?? null, 'totp.disabled', me.user.id);
    });
    ctx.broadcast();
    return { ok: true };
  });

  // ---------- devices ----------
  app.post('/api/devices/enrol', async (req, reply) => {
    const me = requireSession(ctx, req, 'devices.manage');
    const { name } = parse(z.strictObject({ name: z.string().trim().min(1).max(40) }), req.body);
    if (me.device) fail(409, `This browser is already enrolled as "${me.device.name}".`);
    const device = enrolDevice(ctx, reply, name, me.user.id);
    db.audit(me.user.id, device.id, 'device.enrolled', device.id, { name });
    return { device };
  });

  app.get('/api/devices', async (req) => {
    requireSession(ctx, req, 'devices.manage');
    return db.raw.prepare('SELECT id, name, code, created_by AS createdBy, created_at AS createdAt, last_seen AS lastSeen FROM devices ORDER BY created_at').all();
  });

  app.delete('/api/devices/:id', async (req, reply) => {
    const me = requireSession(ctx, req, 'devices.manage');
    const { id } = req.params as { id: string };
    const r = db.raw.prepare('DELETE FROM devices WHERE id = ?').run(id);
    if (!r.changes) fail(404, 'Device not found.');
    db.audit(me.user.id, me.device?.id ?? null, 'device.revoked', id);
    if (me.device?.id === id) setCookie(reply, ctx.config, cookieNames(ctx.config).dev, '', 0);
    return { ok: true };
  });
}
