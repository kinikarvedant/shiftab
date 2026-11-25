// Menu (categories + items) and floor plan (areas + tables). All local-first writes.
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Armchair, LayoutGrid, Pencil, Plus, UtensilsCrossed } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { remove, write } from '../../lib/sync.ts';
import { useFmt, uuid } from '../../lib/format.ts';
import { ask, confirmBox, Empty, toast } from '../../ui/index.tsx';
import { minorDigits, parseMoney } from '../../../shared/money.ts';
import { Area, Category, Item, Table } from '../../../shared/schema.ts';
import { bySort, Editor, Field, fieldErrors, move, MoveButtons, nextSort, useBusy } from './lib.tsx';

const skeleton = <div className="skeleton" style={{ height: '16rem' }} />;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- Menu ----------
interface CatDraft { id: string; isNew: boolean; name: string; color: string; sort: number }
interface ItemDraft { id: string; isNew: boolean; name: string; price: string; categoryId: string; fromCat: string; active: boolean; sendToKitchen: boolean; sort: number }

export function Menu() {
  const fmt = useFmt();
  const data = useLiveQuery(async () => {
    const [cats, items] = await Promise.all([table('categories').toArray(), table('items').toArray()]);
    return { cats: cats.sort(bySort), items: items.sort(bySort) };
  }, []);
  const [sel, setSel] = useState('');
  const [cat, setCat] = useState<CatDraft | null>(null);
  const [item, setItem] = useState<ItemDraft | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, run] = useBusy();
  if (!data) return skeleton;

  const current = data.cats.find((c) => c.id === sel) ?? data.cats[0];
  const inCat = (id: string) => data.items.filter((i) => i.categoryId === id);
  const items = current ? inCat(current.id) : [];
  const digits = minorDigits(fmt.currency);
  const close = () => { setCat(null); setItem(null); setErr({}); };

  const saveCat = (d: CatDraft) => {
    const r = Category.safeParse({ name: d.name, color: d.color, sort: d.sort });
    setErr(fieldErrors(r, { name: 'Enter a name (up to 40 characters).', color: 'Pick a colour.' }));
    if (r.success) void run(async () => { await write('categories', { id: d.id, ...r.data }); if (d.isNew) setSel(d.id); close(); });
  };
  const saveItem = (d: ItemDraft) => {
    const sort = d.isNew || d.categoryId !== d.fromCat ? nextSort(inCat(d.categoryId)) : d.sort;
    const r = Item.safeParse({ name: d.name, categoryId: d.categoryId, price: parseMoney(d.price, fmt.currency) ?? NaN, active: d.active, sort, sendToKitchen: d.sendToKitchen });
    setErr(fieldErrors(r, { name: 'Enter a name (up to 80 characters).', price: `Enter a price like ${(450 / 10 ** digits).toFixed(digits)}.`, categoryId: 'Pick a category.' }));
    if (r.success) void run(async () => { await write('items', { id: d.id, ...r.data }); close(); });
  };
  const deleteCat = async (d: CatDraft) => {
    if (await confirmBox({ title: `Delete ${d.name}?`, message: 'The category is empty, so nothing else changes.', confirm: 'Delete', danger: true }))
      void run(async () => { await remove('categories', d.id); close(); });
  };
  const deleteItem = async (d: ItemDraft) => {
    if (await confirmBox({ title: `Delete ${d.name}?`, message: 'Past orders keep their own copy of the name and price. To just hide it from the till, switch it off instead.', confirm: 'Delete', danger: true }))
      void run(async () => { await remove('items', d.id); close(); });
  };
  const newCat = () => setCat({ id: uuid(), isNew: true, name: '', color: '#8e8cff', sort: nextSort(data.cats) });
  const editItem = (i: (typeof items)[number] | null) => current && setItem(i
    ? { id: i.id, isNew: false, name: i.name, price: (i.price / 10 ** digits).toFixed(digits), categoryId: i.categoryId, fromCat: i.categoryId, active: i.active, sendToKitchen: i.sendToKitchen, sort: i.sort }
    : { id: uuid(), isNew: true, name: '', price: '', categoryId: current.id, fromCat: current.id, active: true, sendToKitchen: true, sort: 0 });

  return (
    <div className="set-split">
      <section className="card stack" aria-labelledby="cats-h">
        <div className="row between"><h2 id="cats-h">Categories</h2><button className="btn outline" onClick={newCat}><Plus aria-hidden="true" /> Add</button></div>
        {data.cats.length === 0 ? <Empty icon={<UtensilsCrossed />} title="No categories yet">Add one, then put items in it.</Empty> : (
          <ul className="set-list">
            {data.cats.map((c, i) => (
              <li key={c.id} className="set-row">
                <button className="set-main" aria-pressed={c.id === current?.id} onClick={() => setSel(c.id)}>
                  <span className="swatch" style={{ background: c.color }} aria-hidden="true" />
                  <span className="grow ellipsis strong">{c.name}</span>
                  <span className="muted small">{inCat(c.id).length}</span>
                </button>
                <button className="btn ghost icon" aria-label={`Edit ${c.name}`} onClick={() => setCat({ id: c.id, isNew: false, name: c.name, color: c.color, sort: c.sort })}><Pencil aria-hidden="true" /></button>
                <MoveButtons name={c.name} i={i} n={data.cats.length} onMove={(by) => void run(() => move('categories', data.cats, i, by))} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack" aria-labelledby="items-h">
        <div className="row between">
          <h2 id="items-h" className="ellipsis">{current ? current.name : 'Items'}</h2>
          <button className="btn primary" disabled={!current} onClick={() => editItem(null)}><Plus aria-hidden="true" /> Add item</button>
        </div>
        {!current ? <p className="muted">Add a category first.</p>
          : items.length === 0 ? <Empty icon={<UtensilsCrossed />} title="No items in this category" />
          : (
            <ul className="set-list">
              {items.map((it, i) => (
                <li key={it.id} className="set-row">
                  <button className="set-main" onClick={() => editItem(it)} aria-label={`Edit ${it.name}, ${fmt.money(it.price)}${it.active ? '' : ', off the menu'}`}>
                    <span className="grow ellipsis strong">{it.name}</span>
                    {!it.active && <span className="pill">Off</span>}
                    <span className="money">{fmt.money(it.price)}</span>
                  </button>
                  <label className="switch" title="On sale">
                    <input type="checkbox" checked={it.active} aria-label={`${it.name} on sale`}
                      onChange={(e) => void run(() => write('items', { ...it, active: e.target.checked }))} />
                  </label>
                  <MoveButtons name={it.name} i={i} n={items.length} onMove={(by) => void run(() => move('items', items, i, by))} />
                </li>
              ))}
            </ul>
          )}
      </section>

      {cat && (
        <Editor open title={cat.isNew ? 'New category' : 'Edit category'} busy={busy} onClose={close} onSave={() => saveCat(cat)}
          onDelete={cat.isNew ? undefined : () => void deleteCat(cat)}
          deleteNote={inCat(cat.id).length ? `It has ${plural(inCat(cat.id).length, 'item')}. Move or delete them before deleting the category.` : undefined}>
          <Field label="Name" error={err.name}>
            <input autoFocus maxLength={40} value={cat.name} aria-invalid={!!err.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} />
          </Field>
          <Field label="Colour" hint="Shown on the till buttons." error={err.color}>
            <input type="color" value={cat.color} onChange={(e) => setCat({ ...cat, color: e.target.value })} />
          </Field>
        </Editor>
      )}

      {item && (
        <Editor open title={item.isNew ? 'New item' : 'Edit item'} busy={busy} onClose={close} onSave={() => saveItem(item)}
          onDelete={item.isNew ? undefined : () => void deleteItem(item)}>
          <Field label="Name" error={err.name}>
            <input autoFocus maxLength={80} value={item.name} aria-invalid={!!err.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
          </Field>
          <Field label={`Price (${fmt.currency})`} error={err.price}>
            <input inputMode="decimal" className="money" value={item.price} aria-invalid={!!err.price} onChange={(e) => setItem({ ...item, price: e.target.value })} />
          </Field>
          <Field label="Category" error={err.categoryId}>
            <select value={item.categoryId} onChange={(e) => setItem({ ...item, categoryId: e.target.value })}>
              {data.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <label className="switch"><input type="checkbox" checked={item.active} onChange={(e) => setItem({ ...item, active: e.target.checked })} /> On sale (shown on the till)</label>
          <label className="switch"><input type="checkbox" checked={item.sendToKitchen} onChange={(e) => setItem({ ...item, sendToKitchen: e.target.checked })} /> Send to kitchen display</label>
        </Editor>
      )}
    </div>
  );
}

// ---------- Floor plan ----------
interface AreaDraft { id: string; isNew: boolean; name: string; sort: number }
interface TableDraft { id: string; isNew: boolean; name: string; seats: string; areaId: string; sort: number }

export function FloorPlan() {
  const data = useLiveQuery(async () => {
    const [areas, tables] = await Promise.all([table('areas').toArray(), table('tables').toArray()]);
    return { areas: areas.sort(bySort), tables: tables.sort(bySort) };
  }, []);
  const [sel, setSel] = useState('');
  const [area, setArea] = useState<AreaDraft | null>(null);
  const [tbl, setTbl] = useState<TableDraft | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const [busy, run] = useBusy();
  if (!data) return skeleton;

  const current = data.areas.find((a) => a.id === sel) ?? data.areas[0];
  const inArea = (id: string) => data.tables.filter((t) => t.areaId === id);
  const tables = current ? inArea(current.id) : [];
  const close = () => { setArea(null); setTbl(null); setErr({}); };

  const saveArea = (d: AreaDraft) => {
    const r = Area.safeParse({ name: d.name, sort: d.sort });
    setErr(fieldErrors(r, { name: 'Enter a name (up to 40 characters).' }));
    if (r.success) void run(async () => { await write('areas', { id: d.id, ...r.data }); if (d.isNew) setSel(d.id); close(); });
  };
  const saveTable = (d: TableDraft) => {
    const r = Table.safeParse({ name: d.name, areaId: d.areaId, seats: Number(d.seats), sort: d.sort });
    setErr(fieldErrors(r, { name: 'Enter a name of up to 12 characters.', seats: 'Enter 1–50 seats.' }));
    if (r.success) void run(async () => { await write('tables', { id: d.id, ...r.data }); close(); });
  };
  const deleteArea = async (d: AreaDraft) => {
    if (await confirmBox({ title: `Delete ${d.name}?`, message: 'The area is empty, so nothing else changes.', confirm: 'Delete', danger: true }))
      void run(async () => { await remove('areas', d.id); close(); });
  };
  const deleteTable = (d: TableDraft) => run(async () => {
    // open orders and bookings point at the table; deleting it would leave them unsaveable
    const [open, booked] = await Promise.all([
      table('orders').where('tableId').equals(d.id).filter((o) => o.status === 'open').count(),
      table('reservations').where('tableId').equals(d.id).filter((x) => x.status === 'booked').count(),
    ]);
    if (open) throw new Error(`Table ${d.name} has an open order. Close or move it first.`);
    if (booked) throw new Error(`Table ${d.name} has ${plural(booked, 'upcoming booking')}. Move them to another table first.`);
    if (!(await confirmBox({ title: `Delete table ${d.name}?`, message: 'Past orders are kept.', confirm: 'Delete', danger: true }))) return;
    await remove('tables', d.id);
    close();
  });
  const addFive = async () => {
    if (!current) return;
    const prefix = await ask({ title: 'Add 5 tables', label: 'Name prefix (optional)', placeholder: 'T',
      message: `Adds 5 tables of 4 seats to ${current.name}, numbered after the last table with that prefix.`, confirm: 'Add 5 tables' });
    if (prefix === null) return;
    const last = data.tables.reduce((m, t) => {
      const rest = t.name.slice(prefix.length);
      return t.name.startsWith(prefix) && /^\d+$/.test(rest) ? Math.max(m, Number(rest)) : m;
    }, 0);
    const sort = nextSort(tables);
    const docs = [1, 2, 3, 4, 5].map((n) => ({ name: `${prefix}${last + n}`, areaId: current.id, seats: 4, sort: sort + n - 1 }));
    if (!docs.every((d) => Table.safeParse(d).success)) return toast('That prefix is too long: table names have up to 12 characters.', 'error');
    void run(async () => {
      for (const d of docs) await write('tables', { id: uuid(), ...d });
      toast(`Added ${docs[0]!.name}–${docs[4]!.name}`, 'success');
    });
  };

  return (
    <div className="set-split">
      <section className="card stack" aria-labelledby="areas-h">
        <div className="row between"><h2 id="areas-h">Areas</h2>
          <button className="btn outline" onClick={() => setArea({ id: uuid(), isNew: true, name: '', sort: nextSort(data.areas) })}><Plus aria-hidden="true" /> Add</button></div>
        {data.areas.length === 0 ? <Empty icon={<LayoutGrid />} title="No areas yet">Add one (e.g. Inside, Terrace, Bar), then its tables.</Empty> : (
          <ul className="set-list">
            {data.areas.map((a, i) => (
              <li key={a.id} className="set-row">
                <button className="set-main" aria-pressed={a.id === current?.id} onClick={() => setSel(a.id)}>
                  <span className="grow ellipsis strong">{a.name}</span><span className="muted small">{inArea(a.id).length}</span>
                </button>
                <button className="btn ghost icon" aria-label={`Rename ${a.name}`} onClick={() => setArea({ id: a.id, isNew: false, name: a.name, sort: a.sort })}><Pencil aria-hidden="true" /></button>
                <MoveButtons name={a.name} i={i} n={data.areas.length} onMove={(by) => void run(() => move('areas', data.areas, i, by))} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack" aria-labelledby="tables-h">
        <div className="row between">
          <h2 id="tables-h" className="ellipsis">{current ? `Tables in ${current.name}` : 'Tables'}</h2>
          <div className="row">
            <button className="btn outline" disabled={!current || busy} onClick={() => void addFive()}><Plus aria-hidden="true" /> Add 5</button>
            <button className="btn primary" disabled={!current}
              onClick={() => current && setTbl({ id: uuid(), isNew: true, name: '', seats: '4', areaId: current.id, sort: nextSort(tables) })}><Plus aria-hidden="true" /> Add table</button>
          </div>
        </div>
        {!current ? <p className="muted">Add an area first.</p>
          : tables.length === 0 ? <Empty icon={<Armchair />} title="No tables in this area" />
          : (
            <ul className="set-list">
              {tables.map((t, i) => (
                <li key={t.id} className="set-row">
                  <button className="set-main" onClick={() => setTbl({ id: t.id, isNew: false, name: t.name, seats: String(t.seats), areaId: t.areaId, sort: t.sort })} aria-label={`Edit table ${t.name}, ${plural(t.seats, 'seat')}`}>
                    <span className="grow ellipsis strong">{t.name}</span><span className="muted small">{plural(t.seats, 'seat')}</span>
                  </button>
                  <MoveButtons name={`table ${t.name}`} i={i} n={tables.length} onMove={(by) => void run(() => move('tables', tables, i, by))} />
                </li>
              ))}
            </ul>
          )}
      </section>

      {area && (
        <Editor open title={area.isNew ? 'New area' : 'Rename area'} busy={busy} onClose={close} onSave={() => saveArea(area)}
          onDelete={area.isNew ? undefined : () => void deleteArea(area)}
          deleteNote={inArea(area.id).length ? `It has ${plural(inArea(area.id).length, 'table')}. Delete them before deleting the area.` : undefined}>
          <Field label="Name" error={err.name}>
            <input autoFocus maxLength={40} value={area.name} aria-invalid={!!err.name} onChange={(e) => setArea({ ...area, name: e.target.value })} />
          </Field>
        </Editor>
      )}

      {tbl && (
        <Editor open title={tbl.isNew ? 'New table' : `Table ${tbl.name}`} busy={busy} onClose={close} onSave={() => saveTable(tbl)}
          onDelete={tbl.isNew ? undefined : () => void deleteTable(tbl)}>
          <Field label="Name" hint="Up to 12 characters, e.g. 12 or T4." error={err.name}>
            <input autoFocus maxLength={12} value={tbl.name} aria-invalid={!!err.name} onChange={(e) => setTbl({ ...tbl, name: e.target.value })} />
          </Field>
          <Field label="Seats" error={err.seats}>
            <input type="number" inputMode="numeric" min={1} max={50} value={tbl.seats} aria-invalid={!!err.seats} onChange={(e) => setTbl({ ...tbl, seats: e.target.value })} />
          </Field>
        </Editor>
      )}
    </div>
  );
}
