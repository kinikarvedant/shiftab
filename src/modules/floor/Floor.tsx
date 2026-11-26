// Floor: every table's live state and running total, open tickets, quick takeaway.
import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarClock, CheckCircle2, Plus, Receipt, ShoppingBag, Users, Utensils, Armchair } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { write } from '../../lib/sync.ts';
import { go } from '../../lib/router.ts';
import { errorText } from '../../lib/api.ts';
import { elapsedText, useFmt, useNow } from '../../lib/format.ts';
import { Dialog, Empty, toast } from '../../ui/index.tsx';
import { openOrder, summarise } from '../order/lib.ts';
import type { ModuleProps } from '../index.ts';
import type { OrderDoc, ReservationDoc, TableDoc } from '../../../shared/schema.ts';
import './floor.css';

type State = 'free' | 'reserved' | 'seated' | 'ordered' | 'bill' | 'paid';
const STATE: Record<State, { label: string; icon: typeof Users }> = {
  free: { label: 'Free', icon: Armchair },
  reserved: { label: 'Reserved', icon: CalendarClock },
  seated: { label: 'Seated', icon: Users },
  ordered: { label: 'Ordered', icon: Utensils },
  bill: { label: 'Bill', icon: Receipt },
  paid: { label: 'Paid', icon: CheckCircle2 }, // prepaid, waiting for food; staff close it once served
};

export default function Floor(_: ModuleProps) {
  const fmt = useFmt();
  const now = useNow(30_000);
  const [area, setArea] = useState<string>('all');
  const [picked, setPicked] = useState<TableDoc | null>(null);
  const data = useLiveQuery(async () => {
    const [areas, tables, orders, reservations] = await Promise.all([
      table('areas').toArray(), table('tables').toArray(),
      table('orders').where('status').equals('open').toArray(), table('reservations').toArray(),
    ]);
    const ids = orders.map((o) => o.id);
    const [lines, payments] = await Promise.all([
      table('orderItems').where('orderId').anyOf(ids).toArray(), table('payments').where('orderId').anyOf(ids).toArray(),
    ]);
    areas.sort((a, b) => a.sort - b.sort);
    const areaRank = new Map(areas.map((a, i) => [a.id, i]));
    tables.sort((a, b) => (areaRank.get(a.areaId) ?? 99) - (areaRank.get(b.areaId) ?? 99) || a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { areas, tables, orders, reservations, lines, payments };
  }, []);

  const view = useMemo(() => {
    if (!data) return null;
    const byTable = new Map<string, OrderDoc[]>();
    for (const o of data.orders) if (o.tableId) byTable.set(o.tableId, [...(byTable.get(o.tableId) ?? []), o]);
    const sum = (o: OrderDoc) => summarise(o, data.lines.filter((l) => l.orderId === o.id), data.payments.filter((p) => p.orderId === o.id), fmt.settings);
    // a booking shows from 60 min before until its end
    const resFor = (t: TableDoc) => data.reservations.find((r) => r.tableId === t.id && r.status === 'booked'
      && r.start - 60 * 60_000 <= now && now <= r.start + r.durationMin * 60_000);
    const cards = data.tables.map((t) => {
      const orders = (byTable.get(t.id) ?? []).sort((a, b) => a.openedAt - b.openedAt);
      const res = resFor(t);
      const sums = orders.map(sum);
      const total = sums.reduce((a, s) => a + s.totals.total, 0);
      const sent = orders.some((o) => data.lines.some((l) => l.orderId === o.id && l.status !== 'new' && !l.voided));
      const paidUp = sums.length > 0 && sums.every((s) => s.count > 0 && s.paid > 0 && s.balance === 0);
      const state: State = paidUp ? 'paid' : orders.some((o) => o.billRequested) ? 'bill' : orders.length ? (sent ? 'ordered' : 'seated') : res ? 'reserved' : 'free';
      return { t, orders, res, total, state, guests: orders.reduce((a, o) => a + o.guests, 0), since: orders[0]?.openedAt };
    });
    const takeaways = data.orders.filter((o) => !o.tableId).sort((a, b) => a.openedAt - b.openedAt).map((o) => ({ o, s: sum(o) }));
    return { cards, takeaways };
  }, [data, now, fmt.settings]);

  if (!data || !view) return <div className="page"><div className="skeleton" style={{ height: '12rem' }} /></div>;
  const cards = view.cards.filter((c) => area === 'all' || c.t.areaId === area);
  const counts = view.cards.reduce((a, c) => ({ ...a, [c.state]: (a[c.state] ?? 0) + 1 }), {} as Record<State, number>);

  async function takeaway() {
    try { go(`order/${await openOrder({ tableId: null, type: 'takeaway', guests: 0 })}`); } catch (e) { toast(errorText(e), 'error'); }
  }

  return (
    <div className="page floor">
      <div className="page-head">
        <div>
          <h1>Floor</h1>
          <p className="small">{counts.free ?? 0} free · {(counts.seated ?? 0) + (counts.ordered ?? 0) + (counts.bill ?? 0) + (counts.paid ?? 0)} occupied · {counts.reserved ?? 0} reserved</p>
        </div>
        <button className="btn primary lg" onClick={takeaway}><ShoppingBag /> New takeaway</button>
      </div>

      {data.areas.length > 1 && (
        <div className="row chips" role="tablist" aria-label="Areas">
          <button className="chip" role="tab" aria-selected={area === 'all'} onClick={() => setArea('all')}>All areas</button>
          {data.areas.map((a) => <button key={a.id} className="chip" role="tab" aria-selected={area === a.id} onClick={() => setArea(a.id)}>{a.name}</button>)}
        </div>
      )}

      {data.tables.length === 0 ? (
        <Empty icon={<Armchair />} title="No tables yet">Add areas and tables in Settings → Floor plan.</Empty>
      ) : (
        <div className="tables-grid">
          {cards.map(({ t, state, total, guests, since, res, orders }) => {
            const S = STATE[state];
            return (
              <button key={t.id} className={`table-card ${state}`} onClick={() => (orders.length === 1 ? go(`order/${orders[0].id}`) : setPicked(t))}
                aria-label={`Table ${t.name}, ${S.label}${total ? `, ${fmt.money(total)}` : ''}`}>
                <div className="row between nowrap">
                  <span className="t-name">{t.name}</span>
                  <span className="t-state"><S.icon aria-hidden="true" />{S.label}</span>
                </div>
                {state === 'free' && <span className="muted small">{t.seats} seats</span>}
                {state === 'reserved' && res && <span className="small">{fmt.time(res.start)} · {res.name} · {res.partySize}</span>}
                {orders.length > 0 && (
                  <div className="row between nowrap t-meta">
                    <span className="small"><Users aria-hidden="true" /> {guests || '–'} · {since ? elapsedText(now - since) : ''}</span>
                    <span className="t-total money">{fmt.money(total)}</span>
                  </div>
                )}
                {orders.length > 1 && <span className="pill">{orders.length} tickets</span>}
              </button>
            );
          })}
        </div>
      )}

      {view.takeaways.length > 0 && (
        <section className="stack" style={{ marginTop: 'var(--space-6)' }}>
          <h2>Takeaway & counter</h2>
          <div className="tables-grid">
            {view.takeaways.map(({ o, s }) => (
              <button key={o.id} className={`table-card ${o.billRequested ? 'bill' : s.count ? 'ordered' : 'seated'}`} onClick={() => go(`order/${o.id}`)}>
                <div className="row between nowrap"><span className="t-name code">{o.number}</span><span className="t-state"><ShoppingBag aria-hidden="true" />Takeaway</span></div>
                <div className="row between nowrap t-meta">
                  <span className="small">{s.count} items · {elapsedText(now - o.openedAt)}</span>
                  <span className="t-total money">{fmt.money(s.totals.total)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <OpenTable table={picked} reservation={picked ? view.cards.find((c) => c.t.id === picked.id)?.res : undefined}
        orders={picked ? view.cards.find((c) => c.t.id === picked.id)?.orders ?? [] : []} onClose={() => setPicked(null)} />
    </div>
  );
}

function OpenTable({ table: t, reservation, orders, onClose }: { table: TableDoc | null; reservation?: ReservationDoc; orders: OrderDoc[]; onClose: () => void }) {
  const fmt = useFmt();
  const [guests, setGuests] = useState(2);
  const [busy, setBusy] = useState(false);
  const start = async (seatRes: boolean) => {
    if (!t) return;
    setBusy(true);
    try {
      const n = seatRes && reservation ? reservation.partySize : guests;
      const id = await openOrder({ tableId: t.id, type: 'dine_in', guests: n });
      if (seatRes && reservation) await write('reservations', { ...reservation, status: 'seated' });
      onClose();
      go(`order/${id}`);
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!t} onClose={onClose} title={t ? `Table ${t.name}` : ''}
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary lg" disabled={busy} onClick={() => start(false)}><Plus /> {orders.length ? 'New ticket' : 'Open table'}</button></>}>
      {orders.length > 0 && (
        <div className="stack sm">
          <span className="muted small">Open tickets</span>
          {orders.map((o) => <button key={o.id} className="btn outline block" onClick={() => { onClose(); go(`order/${o.id}`); }}><span className="code">{o.number}</span> · {fmt.time(o.openedAt)}</button>)}
        </div>
      )}
      {reservation && (
        <div className="banner"><CalendarClock /> <div className="grow">Booked for <strong>{reservation.name}</strong>, {reservation.partySize} at {fmt.time(reservation.start)}{reservation.notes ? ` — ${reservation.notes}` : ''}</div>
          <button className="btn primary sm" disabled={busy} onClick={() => start(true)}>Seat them</button></div>
      )}
      <div className="stack sm">
        <span className="muted small">Guests</span>
        <div className="row">{[1, 2, 3, 4, 5, 6, 8, 10].map((n) => <button key={n} className="chip" aria-pressed={guests === n} onClick={() => setGuests(n)} style={{ minWidth: '3rem', justifyContent: 'center' }}>{n}</button>)}</div>
        <span className="hint muted xs">{t?.seats} seats at this table</span>
      </div>
    </Dialog>
  );
}
