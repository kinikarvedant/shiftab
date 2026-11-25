// Kitchen display (KDS): tickets oldest-first, readable from across the room on a TV.
// Tap an item to mark it ready; "Bump" readies the whole ticket. Ages: 8 min warning, 12 min late.
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChefHat, Clock, RotateCcw, Check, ShoppingBag } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { write } from '../../lib/sync.ts';
import { errorText } from '../../lib/api.ts';
import { prefs, setPref, WALL_SCALES } from '../../lib/display.ts';
import { useNow } from '../../lib/format.ts';
import { Empty, toast } from '../../ui/index.tsx';
import type { OrderItemDoc } from '../../../shared/schema.ts';
import type { ModuleProps } from '../index.ts';
import './kitchen.css';

const WARN = 8 * 60_000, LATE = 12 * 60_000, KEEP_DONE = 15 * 60_000;
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function Kitchen(_: ModuleProps) {
  const now = useNow(1_000);
  const data = useLiveQuery(async () => {
    const [lines, items, tables] = await Promise.all([
      table('orderItems').where('status').anyOf('sent', 'ready').toArray(), table('items').toArray(), table('tables').toArray(),
    ]);
    const orders = await table('orders').bulkGet([...new Set(lines.map((l) => l.orderId))]);
    return { lines, items, tables, orders: orders.filter(Boolean) as NonNullable<(typeof orders)[number]>[] };
  }, []);

  const tickets = useMemo(() => {
    if (!data) return { active: [], done: [] };
    const kitchenItem = new Map(data.items.map((i) => [i.id, i.sendToKitchen]));
    const byOrder = new Map<string, OrderItemDoc[]>();
    for (const l of data.lines) {
      if (l.voided || (l.itemId && kitchenItem.get(l.itemId) === false)) continue;
      byOrder.set(l.orderId, [...(byOrder.get(l.orderId) ?? []), l]);
    }
    const all = data.orders.filter((o) => o.status !== 'void' && byOrder.has(o.id)).map((o) => {
      const lines = byOrder.get(o.id)!.sort((a, b) => a.addedAt - b.addedAt);
      const firstSent = Math.min(...lines.map((l) => l.sentAt ?? l.updatedAt));
      const pending = lines.filter((l) => l.status === 'sent');
      const lastReady = Math.max(...lines.map((l) => l.updatedAt));
      return { o, lines, firstSent, pending, lastReady, where: o.tableId ? data.tables.find((t) => t.id === o.tableId)?.name ?? '?' : null };
    });
    return {
      active: all.filter((t) => t.pending.length > 0).sort((a, b) => a.firstSent - b.firstSent),
      done: all.filter((t) => t.pending.length === 0 && now - t.lastReady < KEEP_DONE).sort((a, b) => b.lastReady - a.lastReady).slice(0, 8),
    };
  }, [data, now]);

  const set = (l: OrderItemDoc, status: 'sent' | 'ready') => write('orderItems', { ...l, status }).catch((e) => toast(errorText(e), 'error'));

  return (
    <div className="kds">
      <div className="kds-head">
        <h1 className="row nowrap"><ChefHat aria-hidden="true" /> Kitchen <span className="pill accent">{tickets.active.length} open</span></h1>
        <div className="seg" role="group" aria-label="Screen size">
          {WALL_SCALES.map((s) => <button key={s.label} aria-pressed={prefs.wallScale() === s.value} onClick={() => setPref('wallScale', s.value)}>{s.label}</button>)}
        </div>
      </div>
      {tickets.active.length === 0 ? (
        <Empty icon={<ChefHat />} title="All caught up">New tickets appear here the moment they are sent.</Empty>
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
                  {t.lines.map((l) => (
                    <li key={l.id}>
                      <button className={`kds-line${l.status === 'ready' ? ' ready' : ''}`} onClick={() => void set(l, l.status === 'ready' ? 'sent' : 'ready')}
                        aria-pressed={l.status === 'ready'} aria-label={`${l.qty} ${l.name}${l.status === 'ready' ? ', ready' : ''}`}>
                        <span className="kds-qty">{l.qty}×</span>
                        <span className="kds-name">{l.name}{l.note && <span className={`kds-note${/allerg/i.test(l.note) ? ' allergy' : ''}`}>{l.note}</span>}</span>
                        {l.status === 'ready' && <Check aria-hidden="true" />}
                      </button>
                    </li>
                  ))}
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
            <button key={t.o.id} className="chip" onClick={() => t.lines.forEach((l) => void set(l, 'sent'))} aria-label={`Recall ${t.where ?? t.o.number}`}>
              <RotateCcw aria-hidden="true" /> {t.where ?? t.o.number}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
