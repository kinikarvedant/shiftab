import { randomUUID } from 'node:crypto';
// SQLite document store + server-only tables. Synchronous (node:sqlite): never await inside tx().
import { DatabaseSync } from 'node:sqlite';
import type { CollectionName } from '../shared/schema.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection, id));
CREATE INDEX IF NOT EXISTS docs_seq ON docs(seq);
-- 'instance' = a random id for this database: devices compare it to spot a reset (a fresh database) and start clean
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS docs_order ON docs(collection, json_extract(data, '$.orderId'));
-- report queries (server/finance.ts) pick by these fields: index them so a year's report stays quick
CREATE INDEX IF NOT EXISTS docs_closed ON docs(collection, json_extract(data, '$.closedAt'));
CREATE INDEX IF NOT EXISTS docs_at ON docs(collection, json_extract(data, '$.at'));
CREATE INDEX IF NOT EXISTS docs_clockin ON docs(collection, json_extract(data, '$.clockIn'));
CREATE TABLE IF NOT EXISTS credentials (
  user_id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT,
  totp_enc TEXT, totp_pending_enc TEXT, totp_last INTEGER NOT NULL DEFAULT 0,
  pin_key_enc TEXT, pin_prev_enc TEXT, pin_changed_at INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, totp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mutations (mid TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, device TEXT,
  action TEXT NOT NULL, target TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS pay_rates (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, effective_from TEXT NOT NULL, data_enc TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
-- other costs (equipment, stock, rent…): dates in the clear for range queries, everything else encrypted
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY, day TEXT NOT NULL, end_day TEXT NOT NULL, data_enc TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS expenses_days ON expenses(day, end_day);
`;

export interface StoredDoc { data: Record<string, any>; seq: number; deleted: boolean; updatedAt: number; updatedBy: string }

export type Db = ReturnType<typeof openDb>;

export function openDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('instance', ?)").run(randomUUID());
  // additive migrations for databases created by older versions
  for (const sql of [
    'ALTER TABLE credentials ADD COLUMN pwd_key_enc TEXT',
    'ALTER TABLE mutations ADD COLUMN result TEXT',
  ]) { try { db.exec(sql); } catch { /* column already exists */ } }

  const q = {
    get: db.prepare('SELECT data, seq, deleted, updated_at, updated_by FROM docs WHERE collection = ? AND id = ?'),
    list: db.prepare('SELECT id, data, updated_at, updated_by FROM docs WHERE collection = ? AND deleted = 0'),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM docs'),
    upsert: db.prepare(`INSERT INTO docs (collection, id, data, seq, updated_at, updated_by, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, seq = excluded.seq,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted = excluded.deleted`),
    byOrder: db.prepare("SELECT data FROM docs WHERE collection = ? AND json_extract(data, '$.orderId') = ? AND deleted = 0"),
    since: db.prepare('SELECT collection, id, data, seq, updated_at, updated_by, deleted FROM docs WHERE seq > ? ORDER BY seq LIMIT ?'),
    audit: db.prepare('INSERT INTO audit (ts, actor, device, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)'),
  };

  const row2doc = (r: any): StoredDoc => ({
    data: JSON.parse(r.data), seq: r.seq, deleted: !!r.deleted, updatedAt: r.updated_at, updatedBy: r.updated_by,
  });

  const self = {
    raw: db,
    tx<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    seq: () => (q.maxSeq.get() as any).s as number,
    get(c: CollectionName, id: string): StoredDoc | null {
      const r = q.get.get(c, id);
      return r ? row2doc(r) : null;
    },
    /** Live (not deleted) doc data or null. */
    live(c: CollectionName, id: string | null | undefined) {
      if (!id) return null;
      const d = self.get(c, id);
      return d && !d.deleted ? d.data : null;
    },
    list(c: CollectionName) {
      return (q.list.all(c) as any[]).map((r) => ({ id: r.id as string, ...JSON.parse(r.data), updatedAt: r.updated_at, updatedBy: r.updated_by }));
    },
    byOrder(c: 'orderItems' | 'payments', orderId: string): any[] {
      return (q.byOrder.all(c, orderId) as any[]).map((r) => JSON.parse(r.data));
    },
    put(c: CollectionName, id: string, data: object, actor: string, deleted = false): number {
      const seq = self.seq() + 1;
      q.upsert.run(c, id, JSON.stringify(data), seq, Date.now(), actor, deleted ? 1 : 0);
      return seq;
    },
    since(seq: number, limit: number) {
      return (q.since.all(seq, limit) as any[]).map((r) => ({ collection: r.collection as CollectionName, id: r.id as string, ...row2doc(r) }));
    },
    audit(actor: string | null, device: string | null, action: string, target: string | null, detail?: unknown) {
      q.audit.run(Date.now(), actor, device, action, target, detail === undefined ? null : JSON.stringify(detail));
    },
  };
  return self;
}
