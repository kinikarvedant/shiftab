// Turns an audit row's detail JSON into one readable line. Plain TS (no React) so node can run it directly.
import { formatBp } from '../../../shared/money.ts';

const MONEY = new Set(['amount', 'total', 'price', 'rateCents', 'unitPrice', 'tip', 'menuPrice']);
const TIMES = new Set(['clockIn', 'clockOut', 'at', 'start']);
const KEY_NAMES: Record<string, string> = {
  number: 'order', rateCents: 'rate', breakMin: 'break (min)', taxRateBp: 'tax rate', serviceChargeBp: 'service charge',
  require2faForFinance: '2FA for finance', dayStartHour: 'day start', historyDays: 'history days', lockAfterSec: 'auto-lock',
};
const hidden = (k: string) => k === 'id' || k.endsWith('Id') || k === 'updatedAt' || k === 'updatedBy';
const human = (k: string) => KEY_NAMES[k] ?? k.replace(/([A-Z])/g, ' $1').toLowerCase();
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface Fmt { money(minor: number): string; dateTime(ts: number): string }

/** '{"number":"A12","total":1200}' -> "order: A12 · total: $12.00"; from/to pairs become "a → b" (records: only what changed). */
export function detailText(fmt: Fmt, action: string, raw: string | null): string {
  if (!raw) return '';
  let d: unknown;
  try { d = JSON.parse(raw); } catch { return raw; }
  const money = action === 'menu.price' ? new Set([...MONEY, 'from', 'to']) : MONEY;
  const val = (k: string, v: unknown): string => {
    if (v == null || v === '') return '—';
    if (typeof v === 'number' && money.has(k)) return fmt.money(v);
    if (typeof v === 'number' && TIMES.has(k)) return fmt.dateTime(v);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) return v.map((x) => val(k, x)).join(', ') || '—';
    if (isObj(v) && 'kind' in v && typeof v.value === 'number') return v.kind === 'pct' ? formatBp(v.value) : fmt.money(v.value); // discount
    if (isObj(v)) return pairs(v).join(', ');
    return String(v);
  };
  const pairs = (o: Record<string, unknown>) =>
    Object.entries(o).filter(([k, v]) => !hidden(k) && v !== '' && v != null).map(([k, v]) => `${human(k)}: ${val(k, v)}`);
  if (Array.isArray(d)) return d.map((x) => human(String(x))).join(', '); // settings.changed: changed field names
  if (!isObj(d)) return String(d);
  const { from, to, ...rest } = d;
  const out = pairs(rest);
  if ('from' in d || 'to' in d) {
    if (isObj(from) && isObj(to) && !('kind' in from)) { // two versions of a record: list what changed
      for (const k of new Set([...Object.keys(from), ...Object.keys(to)]))
        if (!hidden(k) && JSON.stringify(from[k]) !== JSON.stringify(to[k])) out.push(`${human(k)}: ${val(k, from[k])} → ${val(k, to[k])}`);
    } else out.push(`${val('from', from)} → ${val('to', to)}`);
  }
  return out.join(' · ');
}
