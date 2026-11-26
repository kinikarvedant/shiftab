// Payment: split across methods, tips, cash change. Paying the balance closes the order, except a table whose
// food is still being made (prepay): that stays open until staff close it once the food is served.
import { useEffect, useState } from 'react';
import { Banknote, CreditCard, CheckCircle2, Trash2, ArrowLeft } from 'lucide-react';
import { write, remove } from '../../lib/sync.ts';
import { getApp } from '../../lib/session.ts';
import { go } from '../../lib/router.ts';
import { errorText } from '../../lib/api.ts';
import { useFmt, uuid } from '../../lib/format.ts';
import { confirmBox, Dialog, toast } from '../../ui/index.tsx';
import { withApproval } from '../../ui/approve.tsx';
import { minorDigits, parseMoney } from '../../../shared/money.ts';
import { closeOrder, foodStillComing, sendLines, type useOrder } from './lib.ts';

type O = NonNullable<ReturnType<typeof useOrder>>;
const isCash = (m: string) => /cash/i.test(m);

export function PayDialog({ open, onClose, o }: { open: boolean; onClose: () => void; o: O }) {
  const fmt = useFmt();
  const methods = fmt.settings?.paymentMethods ?? ['Cash', 'Card'];
  const digits = minorDigits(fmt.currency);
  const toText = (minor: number) => (minor / 10 ** digits).toFixed(digits);
  const [method, setMethod] = useState(methods[0]);
  const [amount, setAmount] = useState('');
  const [tip, setTip] = useState('');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ change: number; keptOpen: boolean } | null>(null);

  useEffect(() => { if (open) { setAmount(toText(o.balance)); setTip(''); setTendered(''); setDone(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const amt = parseMoney(amount, fmt.currency);
  const tipC = tip.trim() ? parseMoney(tip, fmt.currency) : 0;
  const tend = tendered.trim() ? parseMoney(tendered, fmt.currency) : null;
  const cash = isCash(method);
  const problem = amt == null || amt <= 0 ? 'Enter an amount.' : amt > o.balance ? 'More than the balance due.'
    : tipC == null ? 'Tip is not a valid amount.' : cash && tend != null && tend < amt + tipC ? 'Cash given is less than the amount.' : '';
  const change = cash && tend != null && amt != null ? Math.max(0, tend - amt - (tipC ?? 0)) : 0;
  const quick = cash ? [...new Set([o.balance, ...[5, 10, 20, 50, 100].map((n) => Math.ceil(o.balance / (n * 10 ** digits)) * n * 10 ** digits)])].filter((v) => v >= o.balance).slice(0, 4) : [];

  async function charge() {
    if (problem || amt == null || !o.order) return;
    setBusy(true);
    try {
      await sendLines(o.lines); // anything not yet fired goes to the kitchen now
      const me = getApp().session!.user.id;
      await write('payments', { id: uuid(), orderId: o.order.id, method, amount: amt, tip: tipC ?? 0, tendered: cash ? tend : null, takenBy: me, at: Date.now() });
      if (amt === o.balance) {
        const keptOpen = !!o.order.tableId && await foodStillComing(o.lines);
        if (keptOpen) await write('orders', { ...o.order, billRequested: false });
        else await closeOrder(o.order);
        setDone({ change, keptOpen });
        if (o.order.tableId) navigator.vibrate?.(20);
      } else {
        toast(`${fmt.money(amt)} taken by ${method}. ${fmt.money(o.balance - amt)} left to pay.`, 'success');
        setAmount(toText(o.balance - amt)); setTip(''); setTendered('');
      }
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  }

  async function removePayment(id: string, label: string) {
    const signer = await withApproval('payments.refund', 'Removing a payment');
    if (!signer || !(await confirmBox({ title: 'Remove payment?', message: `${label} will be removed from this order.`, confirm: 'Remove', danger: true }))) return;
    try { await remove('payments', id, signer); } catch (e) { toast(errorText(e), 'error'); }
  }

  if (done) {
    const closeNow = async () => { try { if (o.order) await closeOrder(o.order); onClose(); go('floor'); } catch (e) { toast(errorText(e), 'error'); } };
    return (
      <Dialog open={open} onClose={() => { onClose(); go('floor'); }} title="Paid">
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center', padding: 'var(--space-4) 0' }}>
          <CheckCircle2 size={64} className="success-text" aria-hidden="true" />
          {done.keptOpen
            ? <><h2>Paid in full</h2><p className="muted">The food is still being made, so the table stays open. Close it from the ticket once the food is served.</p></>
            : <h2>Order #{o.order?.number} is closed</h2>}
          {done.change > 0 && <div><div className="muted">Change due</div><div className="money" style={{ fontSize: 'var(--fs-3xl)', fontWeight: 750 }}>{fmt.money(done.change)}</div></div>}
          <button className="btn primary lg" onClick={() => { onClose(); go('floor'); }}><ArrowLeft /> Back to floor</button>
          {done.keptOpen && <button className="btn outline" onClick={() => void closeNow()}>Close the table now</button>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Take payment"
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary lg" disabled={!!problem || busy} onClick={() => void charge()}>Charge {amt ? fmt.money(amt + (tipC ?? 0)) : ''}</button></>}>
      <div className="row between">
        <span className="muted">Balance due</span>
        <span className="money" style={{ fontSize: 'var(--fs-2xl)', fontWeight: 750 }} aria-live="polite">{fmt.money(o.balance)}</span>
      </div>
      <div className="row" role="radiogroup" aria-label="Payment method">
        {methods.map((m) => (
          <button key={m} className="chip" role="radio" aria-checked={m === method} aria-pressed={m === method} onClick={() => setMethod(m)} style={{ minHeight: 'var(--tap)' }}>
            {isCash(m) ? <Banknote aria-hidden="true" /> : <CreditCard aria-hidden="true" />}{m}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label className="field"><span>Amount ({fmt.currency})</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" />
          <span className="hint">Less than the balance to split the bill.</span>
        </label>
        <label className="field"><span>Tip (optional)</span><input inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value)} className="money" placeholder="0" /></label>
        {cash && <label className="field"><span>Cash given</span><input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} className="money" /></label>}
      </div>
      {quick.length > 0 && (
        <div className="row">{quick.map((v) => <button key={v} className="chip money" onClick={() => setTendered(toText(v))}>{fmt.money(v)}</button>)}</div>
      )}
      {cash && change > 0 && <div className="banner"><Banknote /> Change due: <strong className="money">{fmt.money(change)}</strong></div>}
      {problem && amount && <div className="danger-text small" role="alert">{problem}</div>}
      {o.payments.length > 0 && (
        <div className="stack sm">
          <span className="muted small">Already paid</span>
          {o.payments.map((p) => (
            <div key={p.id} className="row between">
              <span>{p.method} · {fmt.time(p.at)}{p.tip ? ` · tip ${fmt.money(p.tip)}` : ''}</span>
              <span className="row nowrap"><span className="money strong">{fmt.money(p.amount)}</span>
                <button className="btn ghost icon sm" aria-label="Remove payment" onClick={() => void removePayment(p.id, `${p.method} ${fmt.money(p.amount)}`)}><Trash2 /></button></span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
