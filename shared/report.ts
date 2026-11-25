// Daily ledger (revenue vs labour) + weekly payroll. Pure: same code on server, client and tests.
import { businessDay, dateRange, weekStart } from './time.ts';
import type { Totals } from './money.ts';

export interface DatasetSettings {
  timezone: string; dayStartHour: number; weekStartsOn: number;
  overtimeWeeklyHours: number; overtimeMultiplierPct: number;
}
export interface Dataset {
  settings: DatasetSettings;
  users: { id: string; name: string; groupId: string; active: boolean }[];
  rates: { id: string; userId: string; rateCents: number; effectiveFrom: string }[];
  orders: { id: string; status: string; closedAt: number | null; totals: Totals | null }[];
  payments: { id: string; orderId: string; method: string; amount: number; tip: number; at: number }[];
  shifts: { id: string; userId: string; clockIn: number; clockOut: number | null; breakMin: number }[];
  generatedAt: number;
}

export interface DayRow {
  date: string;
  orders: number; gross: number; tax: number; service: number; discounts: number;
  net: number; revenue: number; tips: number; avgTicket: number;
  byMethod: Record<string, number>;
  labourMinutes: number; labourCost: number;
  labourPctBp: number | null; // labour / revenue, basis points
  profit: number; // revenue - labour
}
export interface EmployeeRow {
  userId: string; name: string; shifts: number;
  minutes: number; regularMinutes: number; overtimeMinutes: number;
  rateCents: number; pay: number; missingRate: boolean; openShifts: number;
}
export interface Report {
  from: string; to: string;
  days: DayRow[]; totals: DayRow; employees: EmployeeRow[];
  bestDay: string | null; worstDay: string | null;
  warnings: string[];
}

const emptyDay = (date: string): DayRow => ({
  date, orders: 0, gross: 0, tax: 0, service: 0, discounts: 0, net: 0, revenue: 0, tips: 0, avgTicket: 0,
  byMethod: {}, labourMinutes: 0, labourCost: 0, labourPctBp: null, profit: 0,
});

function finish(r: DayRow) {
  r.net = r.gross - r.tax - r.service;
  r.revenue = r.net + r.service;
  r.avgTicket = r.orders ? Math.round(r.gross / r.orders) : 0;
  r.labourPctBp = r.revenue > 0 ? Math.round((r.labourCost * 10_000) / r.revenue) : null;
  r.profit = r.revenue - r.labourCost;
}

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
    const minutes = Math.max(0, Math.round((end - sh.clockIn) / 60_000) - sh.breakMin);
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

  const rows = [...days.values()];
  rows.forEach(finish);
  const totals = emptyDay(`${from}..${to}`);
  for (const r of rows) {
    for (const k of ['orders', 'gross', 'tax', 'service', 'discounts', 'tips', 'labourMinutes', 'labourCost'] as const) totals[k] += r[k];
    for (const [m, v] of Object.entries(r.byMethod)) totals.byMethod[m] = (totals.byMethod[m] ?? 0) + v;
  }
  finish(totals);

  const emp = [...employees.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of emp) if (e.missingRate) warnings.push(`${e.name} has shifts without a pay rate — their labour cost is counted as 0.`);

  const active = rows.filter((r) => r.revenue > 0 || r.labourCost > 0);
  const byProfit = [...active].sort((a, b) => b.profit - a.profit);
  return {
    from, to, days: rows, totals, employees: emp,
    bestDay: byProfit[0]?.date ?? null,
    worstDay: byProfit.length > 1 ? byProfit[byProfit.length - 1].date : null,
    warnings,
  };
}

export function reportCsv(r: Report, money: (n: number) => string): string {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const hrs = (m: number) => (m / 60).toFixed(2);
  const lines = [
    ['Date', 'Orders', 'Gross', 'Tax', 'Service', 'Discounts', 'Net sales', 'Revenue', 'Tips', 'Labour hours', 'Labour cost', 'Labour %', 'Profit after labour'],
    ...[...r.days, r.totals].map((d) => [d.date, d.orders, money(d.gross), money(d.tax), money(d.service), money(d.discounts),
      money(d.net), money(d.revenue), money(d.tips), hrs(d.labourMinutes), money(d.labourCost),
      d.labourPctBp == null ? '' : (d.labourPctBp / 100).toFixed(1) + '%', money(d.profit)]),
    [],
    ['Employee', 'Shifts', 'Total hours', 'Regular hours', 'Overtime hours', 'Rate / hour', 'Pay due'],
    ...r.employees.map((e) => [e.name, e.shifts, hrs(e.minutes), hrs(e.regularMinutes), hrs(e.overtimeMinutes),
      e.missingRate ? 'MISSING' : money(e.rateCents), money(e.pay)]),
  ];
  return lines.map((l) => l.map(esc).join(',')).join('\r\n');
}
