// Who is using this device right now: PIN sessions (terminals), password sessions (back office),
// and offline "vault" sessions (read-only cached finance). See PLAN §5.
import { useCallback, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getMeta, setMeta, table } from './db.ts';
import { api, ApiError } from './api.ts';
import { derivePin, openJson, randomSalt, sealJson, vaultKey } from './crypto.ts';
import { setSignerSource, startSync, syncNow, type Signer } from './sync.ts';
import { can, type Permission } from '../../shared/permissions.ts';
import type { GroupDoc, UserDoc } from '../../shared/schema.ts';

export type Level = 'pin' | 'password' | 'vault';
export interface Session { user: UserDoc; level: Level; pinKey: CryptoKey | null; vaultKey: CryptoKey | null; startedAt: number }
export interface Device { id: string; name: string; code: string }
export interface AppState {
  ready: boolean;
  needsSetup: boolean;
  device: Device | null;
  serverUserId: string | null; // valid password session on the server
  totp: boolean;
  session: Session | null;
  passwordPrompt: boolean;     // show the email + password sign-in instead of the PIN tiles
  demo: { email: string; password: string; pin: string } | null; // public demo server: its shared sign-in
}

let app: AppState = { ready: false, needsSetup: false, device: null, serverUserId: null, totp: false, session: null, passwordPrompt: false, demo: null };
const subs = new Set<() => void>();
const set = (p: Partial<AppState>) => { app = { ...app, ...p }; subs.forEach((f) => f()); };
export const useApp = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => app);
export const getApp = () => app;
export const askPassword = (v: boolean) => set({ passwordPrompt: v });

setSignerSource((): Signer | null => app.session ? { userId: app.session.user.id, level: app.session.level, key: app.session.pinKey } : null);

/** Ask the server who we are. Returns false when offline. */
export async function refreshState(): Promise<boolean> {
  try {
    await flushLogout();
    const s = await api<{ needsSetup: boolean; device: Device | null; user: { id: string } | null; totp: boolean; instance?: string; demo?: AppState['demo'] }>('GET', '/api/state', undefined, 5_000);
    // The server was reset to a fresh database (e.g. for a demo): this device's copy belongs to the old one. Start clean.
    const known = await getMeta<string>('instance');
    if (s.instance && known && known !== s.instance) { await forgetLocalData(); return true; }
    if (s.instance && known !== s.instance) await setMeta('instance', s.instance);
    await setMeta('device', s.device);
    set({ needsSetup: s.needsSetup, device: s.device, serverUserId: s.user?.id ?? null, totp: s.totp, demo: s.demo ?? null });
    if (app.session?.level === 'password' && app.session.user.id !== s.user?.id) set({ session: null }); // server session ended
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) return false;
    throw e;
  }
}

/** Wipe this device's copy of the venue (keeps its display preferences) and start over. */
async function forgetLocalData() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('p0.') && !/^p0\.(theme|scale|wallScale|fold\.)/.test(k)) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
  await db.delete();
  location.reload();
}

export async function boot() {
  set({ device: (await getMeta<Device | null>('device')) ?? null });
  const online = await refreshState().catch(() => false);
  if (online && app.serverUserId && app.device) {
    // Shared terminal: a manager's session never carries over to whoever opens the app next.
    await logoutServer();
  }
  if (app.device || app.serverUserId) startSync();
  if (online && app.serverUserId) {
    // Reload on a personal (non-enrolled) device: resume. The finance cache stays locked until the password is typed again.
    await syncNow().catch(() => {});
    const user = await table('users').get(app.serverUserId);
    if (user?.active) set({ session: { user, level: 'password', pinKey: null, vaultKey: null, startedAt: Date.now() } });
  }
  set({ ready: true });
}

// ---------- PIN ----------
const FAIL_KEY = (id: string) => `p0.pinfail.${id}`;
function failures(userId: string): { n: number; until: number } {
  try { return JSON.parse(localStorage.getItem(FAIL_KEY(userId)) ?? '') ?? { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; }
}
export const pinLockedFor = (userId: string) => Math.max(0, failures(userId).until - Date.now());

/** Verify a PIN against the check value synced from the server. Returns the signer key, or null. */
export async function checkPin(user: UserDoc, pin: string): Promise<CryptoKey | null> {
  if (!user.pinSalt || !user.pinCheck || !user.active) return null;
  if (pinLockedFor(user.id) > 0) throw new Error('Too many wrong PINs. Wait a moment and try again.');
  const { key, check } = await derivePin(pin, user.pinSalt);
  if (check !== user.pinCheck) {
    const f = failures(user.id);
    const n = f.n + 1;
    const until = n >= 5 ? Date.now() + Math.min(2 ** (n - 5), 32) * 60_000 : 0; // 1, 2, 4 … 32 min
    try { localStorage.setItem(FAIL_KEY(user.id), JSON.stringify({ n, until })); } catch { /* storage blocked */ }
    return null;
  }
  try { localStorage.removeItem(FAIL_KEY(user.id)); } catch { /* storage blocked */ }
  return key;
}

export function startPinSession(user: UserDoc, key: CryptoKey) {
  set({ session: { user, level: 'pin', pinKey: key, vaultKey: null, startedAt: Date.now() } });
}

// ---------- password + vault ----------
interface VaultHead { userId: string }

async function openVault(email: string, password: string, verifiedOnline: boolean, userId?: string) {
  const id = `u:${email}`;
  const rec = await db.vault.get(id);
  if (rec?.salt) {
    const key = await vaultKey(password, rec.salt);
    try { const head = await openJson<VaultHead>(key, rec); return { key, userId: head.userId }; } catch { /* wrong password or changed */ }
  }
  if (!verifiedOnline || !userId) return null;
  // first sign-in on this device, or the password changed: start a fresh vault
  await db.vault.filter((v) => v.key.startsWith(`d:${userId}:`)).delete();
  const salt = randomSalt();
  const key = await vaultKey(password, salt);
  await db.vault.put({ key: id, salt, ...(await sealJson(key, { userId } satisfies VaultHead)), savedAt: Date.now() });
  return { key, userId };
}

export class NeedTotp extends Error {}

export async function passwordLogin(email: string, password: string, totp?: string) {
  email = email.trim().toLowerCase();
  try {
    await flushLogout(); // end any old session first
    await api('POST', '/api/auth/login', { email, password, totp: totp || undefined });
    try { localStorage.removeItem(PENDING_LOGOUT); } catch { /* the new cookie replaced the old one */ }
  } catch (e) {
    if (e instanceof ApiError && e.data.needTotp) throw new NeedTotp(e.message);
    if (!(e instanceof ApiError) || e.status !== 0) throw e;
    // offline: unlock the encrypted cache only
    const v = await openVault(email, password, false);
    const user = v && (await table('users').get(v.userId));
    if (!v || !user?.active) throw new Error("Can't reach the server, and this device has no offline copy for that email and password.");
    set({ session: { user, level: 'vault', pinKey: null, vaultKey: v.key, startedAt: Date.now() } });
    return;
  }
  await refreshState();
  startSync();
  await syncNow().catch(() => {});
  const user = app.serverUserId ? await table('users').get(app.serverUserId) : undefined;
  if (!user) throw new Error('Signed in, but your profile has not synced yet. Try again in a moment.');
  const v = await openVault(email, password, true, user.id);
  set({ session: { user, level: 'password', pinKey: null, vaultKey: v?.key ?? null, startedAt: Date.now() } });
}

export async function lock() {
  const s = app.session;
  set({ session: null });
  if (s?.level === 'password' || app.serverUserId) await logoutServer();
  pendingUpdate?.();
}

// A new app version installs only when nobody is signed in, so a terminal never reloads mid-order.
let pendingUpdate: (() => void) | null = null;
export function updateWhenIdle(apply: () => void) { pendingUpdate = apply; if (!app.session) apply(); }

// Logging out must reach the server even if this device is offline right now: remember and retry.
const PENDING_LOGOUT = 'p0.pendingLogout';
async function logoutServer() {
  set({ serverUserId: null, totp: false });
  try { localStorage.setItem(PENDING_LOGOUT, '1'); } catch { /* storage blocked */ }
  await flushLogout();
}
async function flushLogout() {
  let pending = false;
  try { pending = localStorage.getItem(PENDING_LOGOUT) === '1'; } catch { /* storage blocked */ }
  if (!pending) return;
  try {
    await api('POST', '/api/auth/logout', {}, 5_000);
    try { localStorage.removeItem(PENDING_LOGOUT); } catch { /* storage blocked */ }
  } catch { /* offline: refreshState() retries on the next reconnect */ }
}
addEventListener('online', () => void flushLogout());

// ---------- finance vault access ----------
export async function vaultSave(name: string, value: unknown) {
  const s = app.session;
  if (!s?.vaultKey) return false;
  await db.vault.put({ key: `d:${s.user.id}:${name}`, ...(await sealJson(s.vaultKey, value)), savedAt: Date.now() });
  return true;
}
export async function vaultLoad<T>(name: string): Promise<{ value: T; savedAt: number } | null> {
  const s = app.session;
  if (!s?.vaultKey) return null;
  const rec = await db.vault.get(`d:${s.user.id}:${name}`);
  if (!rec) return null;
  try { return { value: await openJson<T>(s.vaultKey, rec), savedAt: rec.savedAt }; } catch { return null; }
}

// ---------- permissions ----------
let groupCache: GroupDoc[] = [];
export const setGroupCache = (g: GroupDoc[]) => { groupCache = g; };

export function canSession(s: Session | null, perm: Permission, groups: GroupDoc[] = groupCache) {
  if (!s) return false;
  const g = groups.find((x) => x.id === s.user.groupId);
  return can(s.user, g, perm, s.level === 'pin' ? 'pin' : 'password');
}

/** Permissions this person holds but can only use after an email + password sign-in (they're on a PIN). */
export function useNeedsPassword() {
  const { session } = useApp();
  const groups = useLiveQuery(() => table('groups').toArray(), [], groupCache);
  return useCallback((perm: Permission) => !!session && session.level === 'pin'
    && can(session.user, groups.find((g) => g.id === session.user.groupId), perm, 'password'), [session, groups]);
}

/** Reactive permission check for components. */
export function useCan() {
  const { session } = useApp();
  const groups = useLiveQuery(() => table('groups').toArray(), [], groupCache);
  return useCallback((perm: Permission) => canSession(session, perm, groups), [session, groups]);
}

/** Keep the signed-in user fresh (name/group/photo changes); lock if they were deactivated. */
export function updateSessionUser(user: UserDoc | undefined) {
  const s = app.session;
  if (!s) return;
  if (!user || !user.active) { void lock(); return; }
  if (user.updatedAt !== s.user.updatedAt) set({ session: { ...s, user } });
}
