// Offline-first sync engine: local write + outbox, push/pull, SSE real-time, pruning. See PLAN §4.
import { useSyncExternalStore } from 'react';
import { db, getMeta, setMeta, table, type OutboxEntry } from './db.ts';
import { api, ApiError } from './api.ts';
import { hmac, sha256hex } from './crypto.ts';
import { toast } from '../ui/toast.ts';
import { COLLECTIONS, COLLECTION_NAMES, signingString, type CollectionName, type DataIn, type DataOf, type Doc } from '../../shared/schema.ts';
import type { AuthLevel } from '../../shared/permissions.ts';

/** Who a change is made by: the signed-in person, or a manager approving an override. */
export interface Signer { userId: string; level: AuthLevel | 'vault'; key: CryptoKey | null }
const kidOf = (s: Signer) => (s.level === 'strong' ? 'pwd' as const : 'pin' as const);

let getSigner: () => Signer | null = () => null;
export const setSignerSource = (fn: () => Signer | null) => { getSigner = fn; };

// ---------- status store ----------
export interface SyncState { online: boolean; syncing: boolean; blocked: string | null; lastSync: number }
let state: SyncState = { online: navigator.onLine, syncing: false, blocked: null, lastSync: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<SyncState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export const useSyncState = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
export const getSyncState = () => state;

// ---------- writes ----------
type Writable<C extends CollectionName> = (DataIn<C> | DataOf<C>) & { id: string; updatedAt?: number; updatedBy?: string };

/** Save locally (instant) and queue for the server. */
export async function write<C extends CollectionName>(c: C, doc: Writable<C>, signer = getSigner()) {
  return mutate(c, doc.id, 'put', doc, signer);
}
export async function remove(c: CollectionName, id: string, signer = getSigner()) {
  return mutate(c, id, 'del', null, signer);
}

async function mutate(c: CollectionName, id: string, op: 'put' | 'del', doc: any, signer: Signer | null) {
  if (!signer) throw new Error('Sign in first.');
  if (signer.level === 'vault') throw new Error('Offline manager sign-in is read-only. Reconnect to make changes.');
  if (COLLECTIONS[c].apiOnly) throw new Error(`${c} can only be changed online.`);
  let data: Record<string, unknown> | null = null;
  if (doc) { const { id: _i, updatedAt: _u, updatedBy: _b, ...rest } = doc; data = rest; }
  const m = { mid: crypto.randomUUID(), collection: c, id, op, data, at: Date.now(), actor: signer.userId };
  const signed = (signer.level === 'pin' || signer.level === 'strong') && signer.key;
  const sig = signed ? await hmac(signer.key!, signingString(m, await sha256hex(JSON.stringify(data)))) : null;
  await db.transaction('rw', [db.table(c), db.outbox], async () => {
    if (op === 'put') await db.table(c).put({ ...data, id, updatedAt: m.at, updatedBy: signer.userId });
    else await db.table(c).delete(id);
    await db.outbox.add({ ...m, sig, ...(signed ? { kid: kidOf(signer) } : {}) });
  });
  schedule();
}

// ---------- push / pull ----------
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
let again = false;
let backoff = 2_000;

function schedule(ms = 250) { clearTimeout(timer); timer = setTimeout(() => void syncNow(), ms); }

export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    set({ syncing: true });
    try {
      do { again = false; await push(); await pull(); } while (again);
      set({ online: true, lastSync: Date.now() });
      backoff = 2_000;
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) { set({ online: false }); schedule(backoff); backoff = Math.min(backoff * 2, 60_000); }
      else if (e instanceof ApiError && e.status === 401) set({ online: true, blocked: 'Not signed in to the server. Enrol this device or sign in.' });
      else { console.error(e); schedule(backoff); }
    } finally {
      set({ syncing: false });
      running = null;
    }
  })();
  return running;
}

async function push() {
  for (;;) {
    const batch = await db.outbox.orderBy('seq').limit(100).toArray();
    if (!batch.length) { if (state.blocked) set({ blocked: null }); return; }
    const res = await api<{ results: { mid: string; ok: boolean; retry?: boolean; error?: string; current?: any }[] }>(
      'POST', '/api/sync/push', { mutations: batch.map(({ seq: _s, ...m }) => m) },
    );
    for (const [i, r] of res.results.entries()) {
      const entry = batch[i];
      if (r.ok) { await db.outbox.delete(entry.seq!); continue; }
      if (r.retry) { set({ blocked: r.error ?? 'Waiting to sync.' }); return; }
      await db.transaction('rw', [db.outbox, db.table(entry.collection)], async () => {
        await db.outbox.delete(entry.seq!);
        const pending = await db.outbox.where('[collection+id]').equals([entry.collection, entry.id]).count();
        if (!pending) { if (r.current) await db.table(entry.collection).put(r.current); else await db.table(entry.collection).delete(entry.id); }
      });
      toast(`Change not saved: ${r.error}`, 'error');
    }
    if (res.results.length < batch.length) return;
    if (state.blocked) set({ blocked: null });
  }
}

async function pull() {
  let cursor = (await getMeta<number>('cursor')) ?? 0;
  for (;;) {
    const res = await api<{ docs: { c: CollectionName; id: string; seq: number; deleted?: boolean; data?: any }[]; cursor: number; more: boolean }>(
      'GET', `/api/sync/pull?since=${cursor}&limit=500`,
    );
    await db.transaction('rw', [db.outbox, db.meta, ...COLLECTION_NAMES.map((c) => db.table(c))], async () => {
      const pending = new Set((await db.outbox.toArray()).map((e) => `${e.collection}/${e.id}`)); // our newer local changes win until pushed
      const puts = new Map<CollectionName, unknown[]>(), dels = new Map<CollectionName, string[]>();
      for (const d of res.docs) {
        if (!COLLECTIONS[d.c] || pending.has(`${d.c}/${d.id}`)) continue;
        if (d.deleted) dels.set(d.c, [...(dels.get(d.c) ?? []), d.id]);
        else puts.set(d.c, [...(puts.get(d.c) ?? []), d.data]);
      }
      for (const [c, ids] of dels) await db.table(c).bulkDelete(ids);
      for (const [c, docs] of puts) await db.table(c).bulkPut(docs);
      await setMeta('cursor', res.cursor);
    });
    cursor = res.cursor;
    if (!res.more) return;
  }
}

/** Forget old closed records on this device (the server keeps everything). */
export async function prune() {
  const s = await table('settings').get('business');
  const cutoff = Date.now() - (s?.historyDays ?? 2) * 86_400_000;
  const pending = new Set((await db.outbox.toArray()).map((m) => `${m.collection}/${m.id}`));
  const open = new Set((await table('orders').where('status').equals('open').primaryKeys()));
  const old = <C extends CollectionName>(c: C, keep: (d: Doc<C>) => boolean) =>
    table(c).filter((d) => d.updatedAt < cutoff && !keep(d) && !pending.has(`${c}/${d.id}`)).delete();
  await old('orders', (d) => d.status === 'open');
  await old('orderItems', (d) => open.has(d.orderId));
  await old('payments', (d) => open.has(d.orderId));
  await old('shifts', (d) => d.clockOut == null || d.clockIn >= Date.now() - 14 * 86_400_000); // matches server SHIFT_WINDOW_DAYS
  await old('reservations', (d) => d.start >= cutoff);
}

// ---------- lifecycle ----------
let started = false;
let events: EventSource | null = null;

export function startSync() {
  if (started) { void syncNow(); return; }
  started = true;
  const connect = () => {
    events?.close();
    events = new EventSource('/api/events');
    events.onmessage = (e) => { if (Number(e.data) > 0) schedule(50); set({ online: true }); };
    events.onerror = () => { if (events?.readyState === EventSource.CLOSED) setTimeout(connect, 5_000); };
  };
  connect();
  addEventListener('online', () => { set({ online: true }); schedule(0); connect(); });
  addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); });
  setInterval(() => schedule(0), 30_000);
  void prune();
  setInterval(() => void prune(), 3_600_000);
  void syncNow();
}

export const pendingCount = () => db.outbox.count();
export const discardStuck = async (): Promise<OutboxEntry | undefined> => {
  const head = await db.outbox.orderBy('seq').first();
  if (head) await db.outbox.delete(head.seq!);
  set({ blocked: null });
  schedule(0);
  return head;
};
