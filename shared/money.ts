// All money is integer minor units (cents). Rates are basis points (1000 = 10%).

export interface Pricing { taxRateBp: number; taxInclusive: boolean; serviceChargeBp: number }
export interface Line { unitPrice: number; qty: number; voided: boolean }
export interface Discount { kind: 'pct' | 'amt'; value: number }
export interface Totals { subtotal: number; discount: number; service: number; tax: number; total: number }

/**
 * Order maths. Service charge applies to the discounted subtotal and is not taxed.
 * Inclusive tax: prices already contain tax, we only report the tax portion.
 */
export function orderTotals(lines: Line[], d: Discount | null, p: Pricing): Totals {
  const subtotal = lines.reduce((a, l) => (l.voided ? a : a + l.unitPrice * l.qty), 0);
  const discount = !d ? 0
    : d.kind === 'pct' ? Math.round((subtotal * Math.min(d.value, 10_000)) / 10_000)
    : Math.min(d.value, subtotal);
  const net = subtotal - discount;
  const service = Math.round((net * p.serviceChargeBp) / 10_000);
  const tax = p.taxInclusive
    ? Math.round((net * p.taxRateBp) / (10_000 + p.taxRateBp))
    : Math.round((net * p.taxRateBp) / 10_000);
  return { subtotal, discount, service, tax, total: net + service + (p.taxInclusive ? 0 : tax) };
}

export const paidSum = (payments: { amount: number }[]) => payments.reduce((a, p) => a + p.amount, 0);

/** Decimal places used by a currency (USD 2, JPY 0, BHD 3). */
export function minorDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function formatMoney(minor: number, currency: string, locale: string): string {
  const digits = minorDigits(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** digits);
}

/** "12.5" -> 1250 (USD). Returns null for anything that isn't a plain non-negative amount. */
export function parseMoney(input: string, currency: string): number | null {
  const digits = minorDigits(currency);
  const s = input.trim().replace(',', '.');
  const re = digits === 0 ? /^\d{1,10}$/ : new RegExp(`^\\d{1,10}(\\.\\d{0,${digits}})?$`);
  if (!re.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 10 ** digits + Number(frac.padEnd(digits, '0') || 0);
}

/** 1250 bp -> "12.5%" */
export const formatBp = (bp: number) => `${(bp / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
