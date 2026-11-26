// Order helpers shared by Floor, Order and Kitchen.
import { useLiveQuery } from 'dexie-react-hooks';
import { getMeta, setMeta, table } from '../../lib/db.ts';
import { getApp } from '../../lib/session.ts';
import { write, type Signer } from '../../lib/sync.ts';
import { uuid } from '../../lib/format.ts';
import { orderTotals, paidSum } from '../../../shared/money.ts';
import { businessDay } from '../../../shared/time.ts';
import { DEFAULT_SETTINGS, type OrderDoc, type OrderItemDoc, type PaymentDoc, type SettingsDoc } from '../../../shared/schema.ts';

/** Short ticket number: device code + daily counter, e.g. "A-014". Unique per device per day. */
async function nextNumber() {
  const s = await table('settings').get('business');
  const day = businessDay(Date.now(), s?.timezone ?? DEFAULT_SETTINGS.timezone!, s?.dayStartHour ?? 4);
  const key = `ordno:${day}`;
  const n = ((await getMeta<number>(key)) ?? 0) + 1;
  await setMeta(key, n);
  return `${getApp().device?.code ?? 'W'}-${String(n).padStart(3, '0')}`;
}

export async function openOrder(o: { tableId: string | null; type: 'dine_in' | 'takeaway'; guests: number }) {
  const s = getApp().session!;
  const id = uuid();
  await write('orders', {
    id, number: await nextNumber(), type: o.type, tableId: o.tableId, guests: o.guests, status: 'open', discount: null, note: '',
    billRequested: false, openedBy: s.user.id, openedAt: Date.now(), closedAt: null, voidReason: '', totals: null,
  });
  return id;
}

export const pricing = (s?: SettingsDoc) => ({ taxRateBp: s?.taxRateBp ?? 0, taxInclusive: s?.taxInclusive ?? false, serviceChargeBp: s?.serviceChargeBp ?? 0 });

export function summarise(order: OrderDoc | undefined, lines: OrderItemDoc[], payments: PaymentDoc[], s?: SettingsDoc) {
  const totals = order?.totals ?? orderTotals(lines, order?.discount ?? null, pricing(s));
  const paid = paidSum(payments);
  const live = lines.filter((l) => !l.voided);
  return { totals, paid, balance: Math.max(0, totals.total - paid), count: live.reduce((a, l) => a + l.qty, 0), unsent: live.filter((l) => l.status === 'new') };
}

export function useOrder(orderId: string) {
  return useLiveQuery(async () => {
    const [order, lines, payments, settings] = await Promise.all([
      table('orders').get(orderId),
      table('orderItems').where('orderId').equals(orderId).toArray(),
      table('payments').where('orderId').equals(orderId).toArray(),
      table('settings').get('business'),
    ]);
    lines.sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id));
    payments.sort((a, b) => a.at - b.at);
    return { order, lines, payments, settings, ...summarise(order, lines, payments, settings) };
  }, [orderId]);
}

/** Kitchen food on this order that hasn't come off the pass yet (the same lines the kitchen display shows as to-do). */
export async function foodStillComing(lines: OrderItemDoc[]) {
  const items = new Map((await table('items').toArray()).map((i) => [i.id, i]));
  return lines.some((l) => !l.voided && l.status !== 'ready' && !(l.itemId && items.get(l.itemId)?.sendToKitchen === false));
}

/** Close a fully paid order. The server re-checks that it's paid in full. */
export const closeOrder = (order: OrderDoc) => write('orders', { ...order, status: 'paid', billRequested: false, closedAt: Date.now() });

/** Send every unsent line to the kitchen. */
export async function sendLines(lines: OrderItemDoc[], signer?: Signer) {
  for (const l of lines) if (l.status === 'new' && !l.voided) await write('orderItems', { ...l, status: 'sent', sentAt: Date.now() }, signer);
}
