// Local IndexedDB (Dexie). Tables are generated from shared/schema.ts COLLECTIONS.
import Dexie, { type Table } from 'dexie';
import { COLLECTIONS, COLLECTION_NAMES, LOCAL_DB_VERSION, type CollectionName, type Doc, type Mutation } from '../../shared/schema.ts';

export type OutboxEntry = Mutation & { seq?: number };
export interface MetaEntry { key: string; value: unknown }
export interface VaultEntry { key: string; iv: string; ct: string; salt?: string; savedAt: number }

class LocalDb extends Dexie {
  outbox!: Table<OutboxEntry, number>;
  meta!: Table<MetaEntry, string>;
  vault!: Table<VaultEntry, string>;
  constructor() {
    super('p0rtal'); // first project name, kept: renaming would strand each device's offline data
    const stores: Record<string, string> = { outbox: '++seq, [collection+id]', meta: 'key', vault: 'key' };
    for (const c of COLLECTION_NAMES) stores[c] = ['id', COLLECTIONS[c].indexes].filter(Boolean).join(', ');
    this.version(LOCAL_DB_VERSION).stores(stores);
  }
}

export const db = new LocalDb();
export const table = <C extends CollectionName>(c: C) => db.table<Doc<C>, string>(c);

export const getMeta = async <T>(key: string): Promise<T | undefined> => (await db.meta.get(key))?.value as T | undefined;
export const setMeta = (key: string, value: unknown) => db.meta.put({ key, value });
