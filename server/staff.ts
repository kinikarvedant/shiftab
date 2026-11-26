// Users, groups and credentials. Every write enforces the rank + permission-subset rules.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Email, fail, killSessions, parse, Password, requireSession, setStrongKey, userAndGroup, type Ctx } from './auth.ts';
import { hashPassword, makePin } from './security.ts';
import { canGrant, outranks } from '../shared/permissions.ts';
import { Group, PIN_RE, User, type GroupDoc } from '../shared/schema.ts';

export function staffRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const id = (req: FastifyRequest) => parse(z.uuid(), (req.params as any).id);

  /** Load a target user and check the actor may manage them (strictly lower rank, or themselves). */
  function target(me: ReturnType<typeof requireSession>, userId: string, allowSelf: boolean) {
    const t = userAndGroup(db, userId) ?? fail(404, 'Employee not found.');
    const self = userId === me.user.id;
    if (self && allowSelf) return { ...t, self };
    if (!self && outranks(me.group, t.group) && me.group.permissions.includes('staff.manage')) return { ...t, self };
    return fail(403, self ? 'Ask someone senior to change that for you.' : 'You can only manage people below your rank.');
  }

  function groupFor(me: ReturnType<typeof requireSession>, groupId: string) {
    const g = db.live('groups', groupId) as GroupDoc | null;
    if (!g) fail(400, 'Unknown group.');
    if (!outranks(me.group, { ...g!, id: groupId })) fail(403, 'You can only assign groups below your own rank.');
    // A group made by someone more senior may hold permissions you don't: assigning it would hand them out.
    if (!canGrant(me.group, g!.permissions)) fail(403, "That group has permissions you don't hold, so you can't assign it.");
    return g!;
  }

  // ---------- users ----------
  app.post('/api/staff', async (req) => {
    const me = requireSession(ctx, req, 'staff.manage');
    const body = parse(z.strictObject({
      name: User.shape.name, groupId: z.uuid(), color: User.shape.color,
      pin: z.string().regex(PIN_RE, 'PIN must be 4-8 digits').optional(),
    }), req.body);
    groupFor(me, body.groupId);
    const pin = body.pin ? makePin(body.pin) : null;
    const userId = randomUUID();
    db.tx(() => {
      db.put('users', userId, {
        name: body.name, groupId: body.groupId, active: true, color: body.color,
        email: null, pinSalt: pin?.salt ?? null, pinCheck: pin?.check ?? null, pinLen: pin?.len ?? null, pwdSalt: null, pwdCheck: null, hasPassword: false, hasTotp: false,
      }, me.user.id);
      db.raw.prepare('INSERT INTO credentials (user_id, pin_key_enc, pin_changed_at) VALUES (?, ?, ?)').run(userId, pin?.keyEnc ?? null, Date.now());
      db.audit(me.user.id, me.device?.id ?? null, 'staff.created', userId, { name: body.name, groupId: body.groupId });
    });
    ctx.broadcast();
    return { id: userId };
  });

  app.patch('/api/staff/:id', async (req) => {
    const me = requireSession(ctx, req);
    const userId = id(req);
    const body = parse(z.strictObject({
      name: User.shape.name.optional(), groupId: z.uuid().optional(), color: User.shape.color.optional(), active: z.boolean().optional(),
    }), req.body);
    const t = target(me, userId, true);
    if (t.self && (body.groupId !== undefined && body.groupId !== t.user.groupId || body.active === false)) {
      fail(403, "You can't change your own group or deactivate yourself.");
    }
    if (body.groupId && body.groupId !== t.user.groupId) groupFor(me, body.groupId);
    const next = { ...t.user, ...body };
    const { id: _, updatedAt: _u, updatedBy: _b, ...data } = next as any;
    db.tx(() => {
      db.put('users', userId, User.parse(data), me.user.id);
      db.audit(me.user.id, me.device?.id ?? null, 'staff.updated', userId, body);
    });
    if (body.active === false || (body.groupId && body.groupId !== t.user.groupId)) killSessions(db, userId);
    ctx.broadcast();
    return { ok: true };
  });

  app.post('/api/staff/:id/pin', async (req) => {
    const me = requireSession(ctx, req);
    const userId = id(req);
    const { pin } = parse(z.strictObject({ pin: z.string().regex(PIN_RE, 'PIN must be 4-8 digits') }), req.body);
    const t = target(me, userId, true);
    const p = makePin(pin);
    db.tx(() => {
      db.raw.prepare(`INSERT INTO credentials (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`).run(userId);
      // Changing your own PIN keeps the old key briefly so changes signed offline before the switch still sync.
      // A reset by a manager (e.g. the PIN leaked) revokes the old one immediately.
      db.raw.prepare(`UPDATE credentials SET pin_prev_enc = ${t.self ? 'pin_key_enc' : 'NULL'}, pin_key_enc = ?, pin_changed_at = ? WHERE user_id = ?`)
        .run(p.keyEnc, Date.now(), userId);
      db.put('users', userId, stripMeta({ ...t.user, pinSalt: p.salt, pinCheck: p.check, pinLen: p.len }), me.user.id);
      db.audit(me.user.id, me.device?.id ?? null, 'staff.pin_set', userId);
    });
    ctx.broadcast();
    return { ok: true };
  });

  app.post('/api/staff/:id/login', async (req) => {
    const me = requireSession(ctx, req, 'staff.manage');
    const userId = id(req);
    const body = parse(z.strictObject({ email: Email, password: Password }), req.body);
    const t = target(me, userId, false);
    if (body.password.toLowerCase().includes(body.email.split('@')[0])) fail(400, 'Password must not contain the email name.');
    const hash = await hashPassword(body.password);
    const taken = db.raw.prepare('SELECT user_id FROM credentials WHERE email = ? AND user_id != ?').get(body.email, userId);
    if (taken) fail(409, 'That email is already used by someone else.');
    db.tx(() => {
      db.raw.prepare(`INSERT INTO credentials (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`).run(userId);
      db.raw.prepare('UPDATE credentials SET email = ?, password_hash = ?, failed = 0, locked_until = 0 WHERE user_id = ?').run(body.email, hash, userId);
      db.put('users', userId, stripMeta({ ...t.user, email: body.email, hasPassword: true }), me.user.id);
      db.audit(me.user.id, me.device?.id ?? null, 'staff.login_set', userId, { email: body.email });
    });
    await setStrongKey(db, userId, body.password, me.user.id);
    killSessions(db, userId);
    ctx.broadcast();
    return { ok: true };
  });

  app.delete('/api/staff/:id/login', async (req) => {
    const me = requireSession(ctx, req, 'staff.manage');
    const userId = id(req);
    const t = target(me, userId, false);
    db.tx(() => {
      db.raw.prepare('UPDATE credentials SET email = NULL, password_hash = NULL, pwd_key_enc = NULL, totp_enc = NULL, totp_pending_enc = NULL WHERE user_id = ?').run(userId);
      db.put('users', userId, stripMeta({ ...t.user, email: null, hasPassword: false, hasTotp: false, pwdSalt: null, pwdCheck: null }), me.user.id);
      db.audit(me.user.id, me.device?.id ?? null, 'staff.login_removed', userId);
    });
    killSessions(db, userId);
    ctx.broadcast();
    return { ok: true };
  });

  // ---------- groups ----------
  app.post('/api/groups', async (req) => {
    const me = requireSession(ctx, req, 'staff.manage');
    const g = parse(Group, req.body);
    if (g.rank >= me.group.rank) fail(403, 'New groups must rank below your own.');
    if (!canGrant(me.group, g.permissions)) fail(403, "You can't grant permissions you don't have.");
    const gid = randomUUID();
    db.tx(() => { db.put('groups', gid, g, me.user.id); db.audit(me.user.id, me.device?.id ?? null, 'group.created', gid, g); });
    ctx.broadcast();
    return { id: gid };
  });

  app.patch('/api/groups/:id', async (req) => {
    const me = requireSession(ctx, req, 'staff.manage');
    const gid = id(req);
    const prev = db.live('groups', gid) as GroupDoc | null ?? fail(404, 'Group not found.');
    const g = parse(Group, req.body);
    if (prev.rank >= me.group.rank || g.rank >= me.group.rank) fail(403, 'You can only edit groups below your own rank.');
    const added = g.permissions.filter((p) => !prev.permissions.includes(p));
    if (!canGrant(me.group, added)) fail(403, "You can't grant permissions you don't have.");
    db.tx(() => { db.put('groups', gid, g, me.user.id); db.audit(me.user.id, me.device?.id ?? null, 'group.updated', gid, { from: stripMeta(prev), to: g }); });
    ctx.broadcast();
    return { ok: true };
  });

  app.delete('/api/groups/:id', async (req) => {
    const me = requireSession(ctx, req, 'staff.manage');
    const gid = id(req);
    const prev = db.live('groups', gid) as GroupDoc | null ?? fail(404, 'Group not found.');
    if (prev.rank >= me.group.rank) fail(403, 'You can only delete groups below your own rank.');
    if (db.list('users').some((u) => u.groupId === gid)) fail(409, 'Move everyone out of this group first.');
    db.tx(() => { db.put('groups', gid, stripMeta(prev), me.user.id, true); db.audit(me.user.id, me.device?.id ?? null, 'group.deleted', gid, { name: prev.name }); });
    ctx.broadcast();
    return { ok: true };
  });
}

function stripMeta<T extends object>(d: T) {
  const { id: _i, updatedAt: _u, updatedBy: _b, ...rest } = d as any;
  return rest;
}
