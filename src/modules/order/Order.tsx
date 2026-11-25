// Order screen: category rail + item grid + live ticket. Every edit is local-first and syncs in real time.
import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft, Ban, ChefHat, Minus, MoreHorizontal, NotebookPen, Percent, Plus, Receipt, Search, Send, ShoppingBag,
  Tag, Trash2, Users, ArrowRightLeft, CircleDollarSign, RotateCcw, Check,
} from 'lucide-react';
import { table } from '../../lib/db.ts';
import { remove, write, type Signer } from '../../lib/sync.ts';
import { getApp } from '../../lib/session.ts';
import { go } from '../../lib/router.ts';
import { errorText } from '../../lib/api.ts';
import { elapsedText, useFmt, useNow, uuid } from '../../lib/format.ts';
import { ask, Dialog, Empty, toast } from '../../ui/index.tsx';
import { withApproval } from '../../ui/approve.tsx';
import { formatBp, minorDigits, parseMoney } from '../../../shared/money.ts';
import type { ItemDoc, OrderDoc, OrderItemDoc } from '../../../shared/schema.ts';
import type { ModuleProps } from '../index.ts';
import { sendLines, useOrder } from './lib.ts';
import { PayDialog } from './Pay.tsx';
import './order.css';

const NOTE_CHIPS = ['No onion', 'No gluten', 'Allergy', 'Extra hot', 'Well done', 'On the side', 'To go'];

const run = (p: Promise<unknown>) => p.catch((e) => toast(errorText(e), 'error'));
let queue: Promise<unknown> = Promise.resolve();
/** Ticket edits run one at a time, in tap order. */
const serial = (fn: () => Promise<unknown>) => { queue = queue.then(fn).catch((e) => toast(errorText(e), 'error')); };

export default function Order({ params: [orderId] }: ModuleProps) {
  const fmt = useFmt();
  const now = useNow(30_000);
  const o = useOrder(orderId ?? '');
  const menu = useLiveQuery(async () => {
    const [cats, items] = await Promise.all([table('categories').toArray(), table('items').filter((i) => i.active).toArray()]);
    return { cats: cats.sort((a, b) => a.sort - b.sort), items: items.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)) };
  }, []);
  const tables = useLiveQuery(() => table('tables').toArray(), [], []);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [ticketOpen, setTicketOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [edit, setEdit] = useState<OrderItemDoc | null>(null);
  const [more, setMore] = useState(false);

  const catId = cat || menu?.cats[0]?.id || '';
  const shown = useMemo(() => {
    if (!menu) return [];
    const term = q.trim().toLowerCase();
    return term ? menu.items.filter((i) => i.name.toLowerCase().includes(term)) : menu.items.filter((i) => i.categoryId === catId);
  }, [menu, catId, q]);

  if (!orderId || o === undefined || !menu) return <div className="page"><div className="skeleton" style={{ height: '60vh' }} /></div>;
  if (!o.order) return <div className="page"><Empty icon={<Receipt />} title="Order not found">It may have been closed and archived on this device.<br /><button className="btn primary" style={{ marginTop: 'var(--space-4)' }} onClick={() => go('floor')}>Back to floor</button></Empty></div>;

  const order = o.order;
  const open = order.status === 'open';
  const tableName = tables.find((t) => t.id === order.tableId)?.name;
  const me = getApp().session!.user.id;
  const catColor = new Map(menu.cats.map((c) => [c.id, c.color]));
  const qtyOf = (itemId: string) => o.lines.filter((l) => l.itemId === itemId && !l.voided).reduce((a, l) => a + l.qty, 0);

  function add(item: ItemDoc) {
    if (!open) return;
    navigator.vibrate?.(10);
    serial(async () => {
      const lines = await table('orderItems').where('orderId').equals(order.id).toArray();
      const same = lines.find((l) => l.itemId === item.id && l.status === 'new' && !l.voided && !l.note && l.unitPrice === item.price);
      await (same
        ? write('orderItems', { ...same, qty: same.qty + 1 })
        : write('orderItems', { id: uuid(), orderId: order.id, itemId: item.id, name: item.name, unitPrice: item.price, qty: 1, note: '', status: 'new', sentAt: null, voided: false, voidReason: '', addedBy: me, addedAt: Date.now() }));
    });
  }
  /** +1 / -1 on a line, read fresh from the DB so rapid taps never lose a count. */
  const bump = (id: string, delta: 1 | -1) => serial(async () => {
    const l = await table('orderItems').get(id);
    if (!l || l.status !== 'new' || l.voided) return;
    if (l.qty + delta < 1) return removeLine(l);
    await write('orderItems', { ...l, qty: l.qty + delta });
  });

  async function customItem() {
    const signer = await withApproval('orders.price', 'Adding an open-priced item');
    if (!signer) return;
    const name = await ask({ title: 'Open item', label: 'Name', placeholder: 'e.g. Birthday cake', required: true, confirm: 'Next' });
    if (!name) return;
    const price = await ask({ title: `Price for “${name}”`, label: `Price (${fmt.currency})`, inputMode: 'decimal', required: true, confirm: 'Add' });
    const cents = price == null ? null : parseMoney(price, fmt.currency);
    if (cents == null) { if (price != null) toast('That price is not valid.', 'error'); return; }
    await run(write('orderItems', { id: uuid(), orderId: order.id, itemId: null, name, unitPrice: cents, qty: 1, note: '', status: 'new', sentAt: null, voided: false, voidReason: '', addedBy: signer.userId, addedAt: Date.now() }, signer));
  }

  async function removeLine(l: OrderItemDoc) {
    await run(remove('orderItems', l.id));
    toast(`Removed ${l.name}`, 'info', { label: 'Undo', run: () => void run(write('orderItems', l)) });
  }
  async function voidLine(l: OrderItemDoc) {
    const signer = await withApproval('orders.void', `Voiding ${l.name}`);
    if (!signer) return;
    const reason = await ask({ title: `Void ${l.qty}× ${l.name}?`, label: 'Reason', placeholder: 'e.g. Customer changed mind', required: true, confirm: 'Void item', danger: true });
    if (reason) await run(write('orderItems', { ...l, voided: true, voidReason: reason }, signer));
  }
  async function send() {
    const n = o!.unsent.length;
    await run(sendLines(o!.lines));
    if (n) toast(`Sent ${n} item${n === 1 ? '' : 's'} to the kitchen`, 'success');
  }

  const ticket = (
    <Ticket order={order} o={o} now={now} onEdit={setEdit} onInc={(l) => bump(l.id, 1)} onDec={(l) => bump(l.id, -1)}
      onSend={() => void send()} onPay={() => { setTicketOpen(false); setPayOpen(true); }} />
  );

  return (
    <div className="order">
      <header className="order-head">
        <button className="btn ghost icon" onClick={() => go('floor')} aria-label="Back to floor"><ArrowLeft /></button>
        <div className="grow">
          <h1 className="row nowrap" style={{ gap: 'var(--space-2)' }}>
            {order.type === 'takeaway' ? <><ShoppingBag aria-hidden="true" /> Takeaway</> : <>Table {tableName ?? '?'}</>}
          </h1>
          <div className="small muted ellipsis"><span className="code">#{order.number}</span> · {fmt.time(order.openedAt)} · {elapsedText(now - order.openedAt)}{order.note ? ` · ${order.note}` : ''}</div>
        </div>
        {open && order.type === 'dine_in' && (
          <div className="row nowrap guests" aria-label="Guests">
            <button className="btn ghost icon sm" aria-label="Fewer guests" onClick={() => void run(write('orders', { ...order, guests: Math.max(0, order.guests - 1) }))}><Minus /></button>
            <span className="row nowrap strong num"><Users aria-hidden="true" size={18} /> {order.guests}</span>
            <button className="btn ghost icon sm" aria-label="More guests" onClick={() => void run(write('orders', { ...order, guests: order.guests + 1 }))}><Plus /></button>
          </div>
        )}
        <button className="btn outline icon" onClick={() => setMore(true)} aria-label="Order options"><MoreHorizontal /></button>
      </header>

      {open ? (
        <div className="order-body">
          <nav className="cats" aria-label="Menu categories">
            {menu.cats.map((c) => (
              <button key={c.id} className="cat" style={{ ['--cat' as string]: c.color }} aria-pressed={!q && c.id === catId} onClick={() => { setCat(c.id); setQ(''); }}>{c.name}</button>
            ))}
          </nav>
          <section className="menu" aria-label="Menu items">
            <div className="row nowrap menu-tools">
              <label className="search grow"><Search aria-hidden="true" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search menu" aria-label="Search menu" /></label>
              <button className="btn outline" onClick={() => void customItem()}><Tag /> Open item</button>
            </div>
            <div className="items">
              {shown.map((i) => {
                const n = qtyOf(i.id);
                return (
                  <button key={i.id} className="item" style={{ ['--cat' as string]: catColor.get(i.categoryId) }} onClick={() => add(i)} aria-label={`${i.name}, ${fmt.money(i.price)}${n ? `, ${n} on ticket` : ''}`}>
                    <span className="item-name">{i.name}</span>
                    <span className="item-price money">{fmt.money(i.price)}</span>
                    {n > 0 && <span key={n} className="item-count" aria-hidden="true">{n}</span>}
                  </button>
                );
              })}
              {shown.length === 0 && <p className="muted">{q ? 'No items match.' : 'No items in this category.'}</p>}
            </div>
          </section>
          <aside className="ticket-pane" aria-label="Ticket">{ticket}</aside>
          <button className="ticket-bar" onClick={() => setTicketOpen(true)} aria-label="Open ticket">
            <span className="strong">{o.count} item{o.count === 1 ? '' : 's'}</span>
            <span className="money strong">{fmt.money(o.totals.total)}</span>
            <span className="btn primary sm">View & pay</span>
          </button>
          <Dialog open={ticketOpen} onClose={() => setTicketOpen(false)} title={`Ticket #${order.number}`}>{ticket}</Dialog>
        </div>
      ) : (
        <Closed order={order} o={o} />
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">{o.count} items, total {fmt.money(o.totals.total)}</div>

      <LineDialog line={edit} onClose={() => setEdit(null)} onVoid={voidLine} onRemove={removeLine} />
      <PayDialog open={payOpen} onClose={() => setPayOpen(false)} o={o} />
      <MoreDialog open={more} onClose={() => setMore(false)} order={order} o={o} />
    </div>
  );
}

type O = NonNullable<ReturnType<typeof useOrder>>;

function Ticket({ order, o, now, onEdit, onInc, onDec, onSend, onPay }: {
  order: OrderDoc; o: O; now: number; onEdit: (l: OrderItemDoc) => void; onInc: (l: OrderItemDoc) => void; onDec: (l: OrderItemDoc) => void; onSend: () => void; onPay: () => void;
}) {
  const fmt = useFmt();
  const t = o.totals;
  return (
    <div className="ticket">
      <ul className="lines" aria-label="Items on this ticket">
        {o.lines.length === 0 && <li className="empty-line muted">Tap items to add them.</li>}
        {o.lines.map((l) => (
          <li key={l.id} className={`line${l.voided ? ' voided' : ''}`}>
            {l.status === 'new' && !l.voided ? (
              <div className="stepper">
                <button className="btn ghost icon sm" onClick={() => onDec(l)} aria-label={`One less ${l.name}`}>{l.qty === 1 ? <Trash2 /> : <Minus />}</button>
                <span className="num strong">{l.qty}</span>
                <button className="btn ghost icon sm" onClick={() => onInc(l)} aria-label={`One more ${l.name}`}><Plus /></button>
              </div>
            ) : <span className="qty num strong">{l.qty}×</span>}
            <button className="line-main" onClick={() => onEdit(l)} disabled={l.voided}>
              <span className="line-name">{l.name}</span>
              {l.note && <span className="line-note">{l.note}</span>}
              {l.voided && <span className="line-note danger-text">Void: {l.voidReason}</span>}
              {!l.voided && l.status !== 'new' && (
                <span className={`pill ${l.status === 'ready' ? 'success' : 'info'}`}><ChefHat aria-hidden="true" />{l.status === 'ready' ? 'Ready' : `Sent ${l.sentAt ? elapsedText(now - l.sentAt) : ''}`}</span>
              )}
            </button>
            <span className="money line-price">{fmt.money(l.unitPrice * l.qty)}</span>
          </li>
        ))}
      </ul>
      <div className="ticket-foot">
        <dl className="totals">
          <div><dt>Subtotal</dt><dd className="money">{fmt.money(t.subtotal)}</dd></div>
          {t.discount > 0 && <div className="success-text"><dt>Discount{order.discount?.kind === 'pct' ? ` (${formatBp(order.discount.value)})` : ''}</dt><dd className="money">−{fmt.money(t.discount)}</dd></div>}
          {t.service > 0 && <div><dt>Service</dt><dd className="money">{fmt.money(t.service)}</dd></div>}
          {t.tax > 0 && <div><dt>Tax{fmt.settings?.taxInclusive ? ' (incl.)' : ''}</dt><dd className="money">{fmt.money(t.tax)}</dd></div>}
          {o.paid > 0 && <div><dt>Paid</dt><dd className="money">−{fmt.money(o.paid)}</dd></div>}
          <div className="grand"><dt>{o.paid > 0 ? 'Balance' : 'Total'}</dt><dd className="money">{fmt.money(o.paid > 0 ? o.balance : t.total)}</dd></div>
        </dl>
        <div className="ticket-actions">
          <button className="btn lg outline" onClick={onSend} disabled={o.unsent.length === 0}><Send /> Send{o.unsent.length ? ` (${o.unsent.length})` : ''}</button>
          <button className="btn lg primary" onClick={onPay} disabled={o.count === 0}><CircleDollarSign /> Pay {fmt.money(o.balance)}</button>
        </div>
      </div>
    </div>
  );
}

function LineDialog({ line, onClose, onVoid, onRemove }: { line: OrderItemDoc | null; onClose: () => void; onVoid: (l: OrderItemDoc) => Promise<void>; onRemove: (l: OrderItemDoc) => Promise<void> }) {
  const fmt = useFmt();
  const [note, setNote] = useState('');
  const [key, setKey] = useState('');
  if (line && key !== line.id) { setKey(line.id); setNote(line.note); }
  if (!line) return <Dialog open={false} onClose={onClose} title="">{null}</Dialog>;
  const unsent = line.status === 'new';
  const save = (signer?: Signer, patch: Partial<OrderItemDoc> = {}) => run(write('orderItems', { ...line, note: note.trim().slice(0, 200), ...patch }, signer)).then(onClose);
  async function price() {
    const signer = await withApproval('orders.price', `Changing the price of ${line!.name}`);
    if (!signer) return;
    const v = await ask({ title: `New price for ${line!.name}`, label: `Unit price (${fmt.currency})`, initial: (line!.unitPrice / 10 ** minorDigits(fmt.currency)).toFixed(minorDigits(fmt.currency)), inputMode: 'decimal', required: true, confirm: 'Set price' });
    const cents = v == null ? null : parseMoney(v, fmt.currency);
    if (cents == null) { if (v != null) toast('That price is not valid.', 'error'); return; }
    await save(signer, { unitPrice: cents });
  }
  return (
    <Dialog open onClose={onClose} title={`${line.qty}× ${line.name}`}
      footer={unsent ? <><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => void save()}><Check /> Save</button></> : <button className="btn ghost" onClick={onClose}>Close</button>}>
      {unsent ? (
        <>
          <label className="field"><span>Note for the kitchen</span><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
          <div className="row">{NOTE_CHIPS.map((c) => <button key={c} className="chip" onClick={() => setNote((n) => (n ? `${n}, ${c}` : c))}>{c}</button>)}</div>
        </>
      ) : <p className="muted">Sent to the kitchen{line.sentAt ? ` at ${fmt.time(line.sentAt)}` : ''}. Sent items can only be voided.</p>}
      <div className="row">
        {unsent && <button className="btn outline" onClick={() => void price()}><Tag /> Change price</button>}
        {unsent
          ? <button className="btn danger" onClick={() => { onClose(); void onRemove(line); }}><Trash2 /> Remove</button>
          : <button className="btn danger" onClick={() => { onClose(); void onVoid(line); }}><Ban /> Void item</button>}
      </div>
    </Dialog>
  );
}

function MoreDialog({ open, onClose, order, o }: { open: boolean; onClose: () => void; order: OrderDoc; o: O }) {
  const fmt = useFmt();
  const tables = useLiveQuery(() => table('tables').toArray(), [], []);
  const [moving, setMoving] = useState(false);
  const isOpen = order.status === 'open';

  async function discount() {
    onClose();
    const signer = await withApproval('orders.discount', 'A discount');
    if (!signer) return;
    const v = await ask({ title: 'Discount', message: 'Type a percentage like “10%” or an amount like “5.00”. Leave empty to remove the discount.', label: 'Discount', initial: order.discount ? (order.discount.kind === 'pct' ? `${order.discount.value / 100}%` : String(order.discount.value / 100)) : '', confirm: 'Apply' });
    if (v == null) return;
    let d: OrderDoc['discount'] = null;
    if (v.trim()) {
      if (v.trim().endsWith('%')) {
        const pct = Number(v.trim().slice(0, -1));
        if (!(pct > 0 && pct <= 100)) return void toast('Enter a percentage between 0 and 100.', 'error');
        d = { kind: 'pct', value: Math.round(pct * 100) };
      } else {
        const cents = parseMoney(v, fmt.currency);
        if (!cents) return void toast('That amount is not valid.', 'error');
        d = { kind: 'amt', value: cents };
      }
    }
    await run(write('orders', { ...order, discount: d }, signer));
  }
  async function voidOrder() {
    onClose();
    if (o.paid > 0) return void toast('Remove the payments before voiding this order.', 'error');
    const signer = await withApproval('orders.void', 'Voiding the whole order');
    if (!signer) return;
    const reason = await ask({ title: `Void order #${order.number}?`, label: 'Reason', required: true, confirm: 'Void order', danger: true });
    if (!reason) return;
    await run(write('orders', { ...order, status: 'void', voidReason: reason, closedAt: Date.now() }, signer));
    go('floor');
  }
  async function note() {
    onClose();
    const v = await ask({ title: 'Order note', label: 'Note', initial: order.note, confirm: 'Save' });
    if (v != null) await run(write('orders', { ...order, note: v.slice(0, 500) }));
  }

  return (
    <Dialog open={open} onClose={() => { setMoving(false); onClose(); }} title={moving ? 'Move to table' : 'Order options'}>
      {moving ? (
        <div className="tables-pick">
          {tables.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((t) => (
            <button key={t.id} className="btn outline" disabled={t.id === order.tableId}
              onClick={() => { setMoving(false); onClose(); void run(write('orders', { ...order, tableId: t.id, type: 'dine_in' })); }}>{t.name}</button>
          ))}
        </div>
      ) : isOpen ? (
        <div className="action-grid">
          <button className="btn lg outline" onClick={() => { onClose(); void run(write('orders', { ...order, billRequested: !order.billRequested })); }}><Receipt /> {order.billRequested ? 'Cancel bill request' : 'Bill requested'}</button>
          <button className="btn lg outline" onClick={() => void discount()}><Percent /> Discount</button>
          <button className="btn lg outline" onClick={() => setMoving(true)}><ArrowRightLeft /> Move table</button>
          <button className="btn lg outline" onClick={() => void note()}><NotebookPen /> Order note</button>
          <button className="btn lg danger" onClick={() => void voidOrder()}><Ban /> Void order</button>
        </div>
      ) : <p className="muted">This order is {order.status}.</p>}
    </Dialog>
  );
}

function Closed({ order, o }: { order: OrderDoc; o: O }) {
  const fmt = useFmt();
  async function reopen() {
    const signer = await withApproval('payments.refund', 'Reopening a paid order');
    if (!signer) return;
    await run(write('orders', { ...order, status: 'open', closedAt: null, totals: null }, signer));
  }
  return (
    <div className="page" style={{ maxWidth: '40rem' }}>
      <div className="card pad-lg stack">
        <div className="row between">
          <h2>{order.status === 'paid' ? 'Paid' : 'Voided'}</h2>
          <span className={`pill ${order.status === 'paid' ? 'success' : 'danger'}`}>{order.closedAt ? fmt.dateTime(order.closedAt) : ''}</span>
        </div>
        {order.status === 'void' && <p className="muted">Reason: {order.voidReason}</p>}
        <ul className="lines">
          {o.lines.filter((l) => !l.voided).map((l) => <li key={l.id} className="row between"><span>{l.qty}× {l.name}</span><span className="money">{fmt.money(l.qty * l.unitPrice)}</span></li>)}
        </ul>
        <hr className="divider" />
        <div className="row between strong"><span>Total</span><span className="money">{fmt.money(o.totals.total)}</span></div>
        {o.payments.map((p) => <div key={p.id} className="row between small muted"><span>{p.method}{p.tip ? ` + tip ${fmt.money(p.tip)}` : ''}</span><span className="money">{fmt.money(p.amount)}</span></div>)}
        <div className="row end">
          <button className="btn ghost" onClick={() => go('floor')}><ArrowLeft /> Floor</button>
          {order.status === 'paid' && <button className="btn outline" onClick={() => void reopen()}><RotateCcw /> Reopen</button>}
        </div>
      </div>
    </div>
  );
}

