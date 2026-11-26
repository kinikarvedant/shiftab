// Kitchen display (KDS): tickets oldest-first, readable from across the room on a TV.
// Tap an item to mark it ready; "Bump" readies the ticket. Ages: 8 min warning, 12 min late.
// Who sees what: someone on a kitchen station (Staff → Roles → Kitchen stations, e.g. Tandoor) sees that
// station's dishes wherever they sign in, and can switch to "Whole order" for context (other dishes dimmed).
// Anyone else picks course tabs, kept per device.
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChefHat, Clock, RotateCcw, Check, ShoppingBag } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { write } from '../../lib/sync.ts';
import { errorText } from '../../lib/api.ts';
import { prefs, setPref, WALL_SCALES } from '../../lib/display.ts';
import { useNow } from '../../lib/format.ts';
import { Empty, toast } from '../../ui/index.tsx';
import { useApp } from '../../lib/session.ts';
import type { Doc, OrderItemDoc } from '../../../shared/schema.ts';
import type { ModuleProps } from '../index.ts';
import './kitchen.css';

const WARN = 8 * 60_000, LATE = 12 * 60_000, KEEP_DONE = 15 * 60_000;
const STATION_KEY = 'p0.kds.categories';
const loadStation = (): string[] => { try { return JSON.parse(localStorage.getItem(STATION_KEY) ?? '[]'); } catch { return []; } };
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function Kitchen(_: ModuleProps) {
  const now = useNow(1_000);
  const me = useApp().session?.user.id;
  const [station, setStation] = useState(loadStation);
  const [whole, setWhole] = useState(false);
  useEffect(() => { try { localStorage.setItem(STATION_KEY, JSON.stringify(station)); } catch { /* storage blocked */ } }, [station]);
  const data = useLiveQuery(async () => {
    const [lines, items, tables, categories, stations] = await Promise.all([
      table('orderItems').where('status').anyOf('sent', 'ready').toArray(), table('items').toArray(), table('tables').toArray(),
      table('categories').orderBy('sort').toArray(), table('stations').toArray(),
    ]);
    const orders = await table('orders').bulkGet([...new Set(lines.map((l) => l.orderId))]);
    return { lines, items, tables, categories, stations, orders: orders.filter(Boolean) as NonNullable<(typeof orders)[number]>[] };
  }, []);

  const tickets = useMemo(() => {
    const none = { active: [], done: [], courses: [], sel: [] as string[], catOf: (_: OrderItemDoc): Doc<'categories'> | undefined => undefined,
      isMine: (_: OrderItemDoc) => true, mine: '' };
    if (!data) return none;
    const itemById = new Map(data.items.map((i) => [i.id, i]));
    const catById = new Map(data.categories.map((c) => [c.id, c]));
    const catOf = (l: OrderItemDoc) => catById.get(itemById.get(l.itemId ?? '')?.categoryId ?? '');
    const kitchenLines = data.lines.filter((l) => !l.voided && !(l.itemId && itemById.get(l.itemId)?.sendToKitchen === false));
    // course tabs: categories that have kitchen items, each with how many are still to make
    const courses = data.categories.filter((c) => data.items.some((i) => i.categoryId === c.id && i.sendToKitchen !== false))
      .map((c) => ({ c, open: kitchenLines.filter((l) => l.status === 'sent' && catOf(l)?.id === c.id).length }));
    // the signed-in person's stations win over this screen's course tabs
    const myStations = data.stations.filter((s) => !!me && s.userIds.includes(me));
    const sel = (myStations.length ? [...new Set(myStations.flatMap((s) => s.categoryIds))] : station).filter((id) => catById.has(id));
    // lines with no menu category (open items) show on every station so nothing is missed
    const isMine = (l: OrderItemDoc) => { const c = catOf(l); return !sel.length || !c || sel.includes(c.id); };
    const shown = whole ? kitchenLines : kitchenLines.filter(isMine);
    const byOrder = new Map<string, OrderItemDoc[]>();
    for (const l of shown) byOrder.set(l.orderId, [...(byOrder.get(l.orderId) ?? []), l]);
    const course = (l: OrderItemDoc) => catOf(l)?.sort ?? Number.MAX_SAFE_INTEGER;
    const all = data.orders.filter((o) => o.status !== 'void' && byOrder.has(o.id)).map((o) => {
      const lines = byOrder.get(o.id)!.sort((a, b) => course(a) - course(b) || a.addedAt - b.addedAt); // courses in menu order
      const my = lines.filter(isMine); // timers, Bump and recall only ever touch this screen's own dishes
      const firstSent = Math.min(...my.map((l) => l.sentAt ?? l.updatedAt));
      const pending = my.filter((l) => l.status === 'sent');
      const lastReady = Math.max(...my.map((l) => l.updatedAt));
      return { o, lines, my, firstSent, pending, lastReady, where: o.tableId ? data.tables.find((t) => t.id === o.tableId)?.name ?? '?' : null };
    }).filter((t) => t.my.length > 0);
    return {
      active: all.filter((t) => t.pending.length > 0).sort((a, b) => a.firstSent - b.firstSent),
      done: all.filter((t) => t.pending.length === 0 && now - t.lastReady < KEEP_DONE).sort((a, b) => b.lastReady - a.lastReady).slice(0, 8),
      courses, sel, catOf, isMine, mine: myStations.map((s) => s.name).join(' + '),
    };
  }, [data, now, station, whole, me]);
  const toggle = (id: string) => setStation((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const stationName = tickets.mine || tickets.courses.filter((x) => tickets.sel.includes(x.c.id)).map((x) => x.c.name).join(' + ');

  const set = (l: OrderItemDoc, status: 'sent' | 'ready') => write('orderItems', { ...l, status }).catch((e) => toast(errorText(e), 'error'));

  return (
    <div className="kds">
      <div className="kds-head">
        <h1 className="row nowrap"><ChefHat aria-hidden="true" /> {stationName || 'Kitchen'} <span className="pill accent">{tickets.active.length} open</span></h1>
        <div className="seg" role="group" aria-label="Screen size">
          {WALL_SCALES.map((s) => <button key={s.label} aria-pressed={prefs.wallScale() === s.value} onClick={() => setPref('wallScale', s.value)}>{s.label}</button>)}
        </div>
      </div>
      {tickets.mine ? (
        <div className="seg kds-scope" role="group" aria-label="What to show">
          <button aria-pressed={!whole} onClick={() => setWhole(false)}>My station</button>
          <button aria-pressed={whole} onClick={() => setWhole(true)}>Whole order</button>
        </div>
      ) : tickets.courses.length > 1 && (
        <div className="kds-courses" role="group" aria-label="Courses shown on this screen">
          <button className="chip" aria-pressed={tickets.sel.length === 0} onClick={() => setStation([])}>All</button>
          {tickets.courses.map(({ c, open }) => (
            <button key={c.id} className="chip" style={{ ['--cat' as string]: c.color }} aria-pressed={tickets.sel.includes(c.id)} onClick={() => toggle(c.id)}>
              {c.name}<span className="kds-count" aria-label={`${open} to make`}>{open}</span>
            </button>
          ))}
        </div>
      )}
      {tickets.active.length === 0 ? (
        <Empty icon={<ChefHat />} title="All caught up">{stationName ? `New ${stationName} tickets` : 'New tickets'} appear here the moment they are sent.</Empty>
      ) : (
        <div className="kds-grid">
          {tickets.active.map((t) => {
            const age = now - t.firstSent;
            const level = age >= LATE ? 'late' : age >= WARN ? 'warn' : '';
            return (
              <article key={t.o.id} className={`kds-ticket ${level}`} aria-label={`${t.where ? `Table ${t.where}` : 'Takeaway'}, ${mmss(age)}`}>
                <header>
                  <span className="kds-where">{t.where ?? <><ShoppingBag aria-hidden="true" /> {t.o.number}</>}</span>
                  <span className="kds-age"><Clock aria-hidden="true" />{mmss(age)}{level === 'late' && <strong> LATE</strong>}</span>
                </header>
                <ul>
                  {t.lines.map((l) => {
                    const other = !tickets.isMine(l); // whole-order view: another station's dish, shown for context only
                    return (
                    <li key={l.id}>
                      <button className={`kds-line${l.status === 'ready' ? ' ready' : ''}${other ? ' other' : ''}`} style={{ ['--cat' as string]: tickets.catOf(l)?.color }}
                        disabled={other} onClick={() => void set(l, l.status === 'ready' ? 'sent' : 'ready')}
                        aria-pressed={l.status === 'ready'} aria-label={`${l.qty} ${l.name}${l.status === 'ready' ? ', ready' : ''}${other ? ', another station' : ''}`}>
                        <span className="kds-qty">{l.qty}×</span>
                        <span className="kds-name">{l.name}{l.note && <span className={`kds-note${/allerg/i.test(l.note) ? ' allergy' : ''}`}>{l.note}</span>}</span>
                        {l.status === 'ready' && <Check aria-hidden="true" />}
                      </button>
                    </li>
                    );
                  })}
                </ul>
                <footer>
                  <span className="muted">{t.o.number}{t.o.guests ? ` · ${t.o.guests} guests` : ''}</span>
                  <button className="btn success" onClick={() => t.pending.forEach((l) => void set(l, 'ready'))}><Check /> Bump</button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {tickets.done.length > 0 && (
        <section className="kds-done" aria-label="Recently completed">
          <span className="muted">Done:</span>
          {tickets.done.map((t) => (
            <button key={t.o.id} className="chip" onClick={() => t.my.forEach((l) => void set(l, 'sent'))} aria-label={`Recall ${t.where ?? t.o.number}`}>
              <RotateCcw aria-hidden="true" /> {t.where ?? t.o.number}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
