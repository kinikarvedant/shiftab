// Ledger for any date range (revenue vs wages vs other costs) + payroll. Pure: same code on server, client and tests.
import { addDays, businessDay, dateRange, weekStart } from './time.ts';
import type { Totals } from './money.ts';

export interface DatasetSettings {
  timezone: string; dayStartHour: number; weekStartsOn: number;
  overtimeWeeklyHours: number; overtimeMultiplierPct: number;
}
/** Other business costs (equipment, stock, rent…), entered by owners and managers. */
export const COST_CATEGORIES = ['Equipment', 'Ingredients & stock', 'Supplies & materials', 'Rent', 'Utilities', 'Repairs & maintenance', 'Marketing', 'Other'] as const;
/** A big purchase can be spread evenly over the days it serves, so one day's profit isn't wiped out. */
export const SPREADS = [
  { days: 1, label: 'Just that day' }, { days: 7, label: 'Over a week' }, { days: 30, label: 'Over a month' },
  { days: 91, label: 'Over 3 months' }, { days: 365, label: 'Over a year' },
] as const;
export interface Expense { id: string; day: string; spreadDays: number; category: string; description: string; amount: number }

export interface Dataset {
  settings: DatasetSettings;
  users: { id: string; name: string; groupId: string; active: boolean }[];
  rates: { id: string; userId: string; rateCents: number; effectiveFrom: string }[];
  orders: { id: string; status: string; closedAt: number | null; totals: Totals | null }[];
  payments: { id: string; orderId: string; method: string; amount: number; tip: number; at: number }[];
  shifts: { id: string; userId: string; clockIn: number; clockOut: number | null; breakMin: number; breakStart?: number | null }[];
  expenses?: Expense[]; // copies saved before costs existed don't have them
  generatedAt: number;
}

export interface DayRow {
  date: string;
  orders: number; gross: number; tax: number; service: number; discounts: number;
  net: number; revenue: number; tips: number; avgTicket: number;
  byMethod: Record<string, number>;
  labourMinutes: number; labourCost: number;
  labourPctBp: number | null; // labour / revenue, basis points
  costs: number;  // other costs (their share for this day when spread)
  profit: number; // revenue - labour - costs
  until?: string; // grouped rows (week / month): last day covered
}
export interface EmployeeRow {
  userId: string; name: string; shifts: number;
  minutes: number; regularMinutes: number; overtimeMinutes: number;
  rateCents: number; pay: number; missingRate: boolean; openShifts: number;
}
export interface Report {
  from: string; to: string;
  days: DayRow[]; totals: DayRow; employees: EmployeeRow[];
  costs: (Expense & { inRange: number })[]; // costs touching the range, with the part that falls inside it
  bestDay: string | null; worstDay: string | null;
  warnings: string[];
}

const emptyDay = (date: string): DayRow => ({
  date, orders: 0, gross: 0, tax: 0, service: 0, discounts: 0, net: 0, revenue: 0, tips: 0, avgTicket: 0,
  byMethod: {}, labourMinutes: 0, labourCost: 0, labourPctBp: null, costs: 0, profit: 0,
});
const SUMMED = ['orders', 'gross', 'tax', 'service', 'discounts', 'tips', 'labourMinutes', 'labourCost', 'costs'] as const;

function finish(r: DayRow) {
  r.net = r.gross - r.tax - r.service;
  r.revenue = r.net + r.service;
  r.avgTicket = r.orders ? Math.round(r.gross / r.orders) : 0;
  r.labourPctBp = r.revenue > 0 ? Math.round((r.labourCost * 10_000) / r.revenue) : null;
  r.profit = r.revenue - r.labourCost - r.costs;
}

const dayNo = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
/** Share of `e` on its k-th day: an even split, the odd cents going to the first days. */
const share = (e: Expense, k: number) => Math.floor(e.amount / e.spreadDays) + (k < e.amount % e.spreadDays ? 1 : 0);

/** Rate in effect on `day` = latest rate with effectiveFrom <= day. */
function rateOn(rates: Dataset['rates'], userId: string, day: string): number | null {
  let best: { effectiveFrom: string; rateCents: number } | null = null;
  for (const r of rates) {
    if (r.userId === userId && r.effectiveFrom <= day && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  }
  return best ? best.rateCents : null;
}

/** Report for business days from..to inclusive. `now` closes open shifts for live numbers. */
export function buildReport(ds: Dataset, from: string, to: string, now = Date.now()): Report {
  const s = ds.settings;
  const day = (t: number) => businessDay(t, s.timezone, s.dayStartHour);
  const days = new Map(dateRange(from, to).map((d) => [d, emptyDay(d)]));
  const warnings: string[] = [];

  // Revenue: paid orders by business day of closing; tender mix from their payments.
  const paidDay = new Map<string, string>();
  for (const o of ds.orders) {
    if (o.status !== 'paid' || !o.totals || o.closedAt == null) continue;
    const row = days.get(day(o.closedAt));
    if (!row) continue;
    paidDay.set(o.id, row.date);
    row.orders++;
    row.gross += o.totals.total;
    row.tax += o.totals.tax;
    row.service += o.totals.service;
    row.discounts += o.totals.discount;
  }
  for (const p of ds.payments) {
    const d = paidDay.get(p.orderId);
    if (!d) continue;
    const row = days.get(d)!;
    row.tips += p.tip;
    row.byMethod[p.method] = (row.byMethod[p.method] ?? 0) + p.amount;
  }

  // Labour: per employee, chronological within each week so overtime lands on the right shifts.
  const otThreshold = Math.round(s.overtimeWeeklyHours * 60); // 0 = off
  const names = new Map(ds.users.map((u) => [u.id, u.name]));
  const employees = new Map<string, EmployeeRow>();
  const weekMinutes = new Map<string, number>(); // `${userId}|${weekStart}`
  const shifts = [...ds.shifts].sort((a, b) => a.clockIn - b.clockIn);

  for (const sh of shifts) {
    const d = day(sh.clockIn);
    const end = sh.clockOut ?? now;
    const onBreak = sh.breakStart != null ? Math.round((end - sh.breakStart) / 60_000) : 0; // a break still going isn't paid either
    const minutes = Math.max(0, Math.round((end - sh.clockIn) / 60_000) - sh.breakMin - onBreak);
    const key = `${sh.userId}|${weekStart(d, s.weekStartsOn)}`;
    const before = weekMinutes.get(key) ?? 0;
    weekMinutes.set(key, before + minutes);

    const row = days.get(d);
    if (!row) continue; // earlier days of the week: counted towards overtime only

    const ot = otThreshold > 0 ? Math.max(0, before + minutes - Math.max(before, otThreshold)) : 0;
    const reg = minutes - ot;
    const rate = rateOn(ds.rates, sh.userId, d);
    // integer maths: (reg*rate*100 + ot*rate*pct) / (60*100)
    const cost = rate == null ? 0 : Math.round((reg * rate * 100 + ot * rate * s.overtimeMultiplierPct) / 6000);

    row.labourMinutes += minutes;
    row.labourCost += cost;

    let e = employees.get(sh.userId);
    if (!e) {
      e = { userId: sh.userId, name: names.get(sh.userId) ?? 'Unknown', shifts: 0, minutes: 0, regularMinutes: 0,
        overtimeMinutes: 0, rateCents: 0, pay: 0, missingRate: false, openShifts: 0 };
      employees.set(sh.userId, e);
    }
    e.shifts++;
    e.minutes += minutes;
    e.regularMinutes += reg;
    e.overtimeMinutes += ot;
    e.pay += cost;
    if (rate == null) e.missingRate = true; else e.rateCents = rate;
    if (sh.clockOut == null) {
      e.openShifts++;
      if (end - sh.clockIn > 12 * 3_600_000) warnings.push(`${e.name} has been clocked in for over 12 hours.`);
    }
  }

  // Other costs: each day gets its share (only the days inside the range are walked)
  const costs: Report['costs'] = [];
  for (const e of ds.expenses ?? []) {
    let inRange = 0;
    const start = dayNo(e.day);
    for (let k = Math.max(0, dayNo(from) - start); k < Math.min(e.spreadDays, dayNo(to) - start + 1); k++) {
      const row = days.get(addDays(e.day, k));
      if (row) { row.costs += share(e, k); inRange += share(e, k); }
    }
    if (inRange > 0) costs.push({ ...e, inRange });
  }

  const rows = [...days.values()];
  rows.forEach(finish);
  const totals = sumRows(rows, `${from}..${to}`);

  const emp = [...employees.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of emp) if (e.missingRate) warnings.push(`${e.name} has shifts without a pay rate — their labour cost is counted as 0.`);

  const active = rows.filter((r) => r.revenue > 0 || r.labourCost > 0 || r.costs > 0);
  const byProfit = [...active].sort((a, b) => b.profit - a.profit);
  return {
    from, to, days: rows, totals, employees: emp, costs: costs.sort((a, b) => a.day.localeCompare(b.day)),
    bestDay: byProfit[0]?.date ?? null,
    worstDay: byProfit.length > 1 ? byProfit[byProfit.length - 1].date : null,
    warnings,
  };
}

function sumRows(rows: DayRow[], date: string): DayRow {
  const t = emptyDay(date);
  for (const r of rows) {
    for (const k of SUMMED) t[k] += r[k];
    for (const [m, v] of Object.entries(r.byMethod)) t.byMethod[m] = (t.byMethod[m] ?? 0) + v;
  }
  finish(t);
  return t;
}

/** Long ranges read better grouped: one row per week (starting on the venue's week start) or per month. */
export function groupRows(days: DayRow[], by: 'day' | 'week' | 'month', weekStartsOn: number): DayRow[] {
  if (by === 'day') return days;
  const groups = new Map<string, DayRow[]>();
  for (const d of days) {
    const key = by === 'week' ? weekStart(d.date, weekStartsOn) : d.date.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()].map((g) => ({ ...sumRows(g, g[0]!.date), until: g[g.length - 1]!.date }));
}

/** Day rows up to a month, then weeks up to ~6 months, then months. */
export const groupingFor = (from: string, to: string): 'day' | 'week' | 'month' => {
  const n = dayNo(to) - dayNo(from) + 1;
  return n <= 31 ? 'day' : n <= 186 ? 'week' : 'month';
};

export function reportCsv(r: Report, money: (n: number) => string): string {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const hrs = (m: number) => (m / 60).toFixed(2);
  const lines = [
    ['Date', 'Orders', 'Gross', 'Tax', 'Service', 'Discounts', 'Net sales', 'Revenue', 'Tips', 'Labour hours', 'Labour cost', 'Labour %', 'Other costs', 'Profit'],
    ...[...r.days, r.totals].map((d) => [d.date, d.orders, money(d.gross), money(d.tax), money(d.service), money(d.discounts),
      money(d.net), money(d.revenue), money(d.tips), hrs(d.labourMinutes), money(d.labourCost),
      d.labourPctBp == null ? '' : (d.labourPctBp / 100).toFixed(1) + '%', money(d.costs), money(d.profit)]),
    [],
    ['Employee', 'Shifts', 'Total hours', 'Regular hours', 'Overtime hours', 'Rate / hour', 'Pay due'],
    ...r.employees.map((e) => [e.name, e.shifts, hrs(e.minutes), hrs(e.regularMinutes), hrs(e.overtimeMinutes),
      e.missingRate ? 'MISSING' : money(e.rateCents), money(e.pay)]),
    [],
    ['Cost date', 'Category', 'Description', 'Spread over (days)', 'Amount', 'In this report'],
    ...r.costs.map((e) => [e.day, e.category, e.description, e.spreadDays, money(e.amount), money(e.inRange)]),
  ];
  return lines.map((l) => l.map(esc).join(',')).join('\r\n');
}
