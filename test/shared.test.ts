import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderTotals, parseMoney, formatMoney } from '../shared/money.ts';
import { businessDay, weekStart, zonedTime, addDays } from '../shared/time.ts';
import { buildReport, groupRows, groupingFor, type Dataset } from '../shared/report.ts';
import { can, canGrant, DEFAULT_GROUPS, outranks } from '../shared/permissions.ts';

test('order totals: exclusive tax, service, discount caps, voids', () => {
  const lines = [{ unitPrice: 1000, qty: 2, voided: false }, { unitPrice: 550, qty: 1, voided: false }, { unitPrice: 9999, qty: 1, voided: true }];
  const p = { taxRateBp: 1000, taxInclusive: false, serviceChargeBp: 1250 };
  assert.deepEqual(orderTotals(lines, null, p), { subtotal: 2550, discount: 0, service: 319, tax: 255, total: 3124 });
  assert.deepEqual(orderTotals(lines, { kind: 'pct', value: 1000 }, p), { subtotal: 2550, discount: 255, service: 287, tax: 230, total: 2812 });
  assert.equal(orderTotals(lines, { kind: 'amt', value: 99_999 }, p).total, 0); // amount discount capped at subtotal
  assert.equal(orderTotals(lines, { kind: 'pct', value: 50_000 }, p).discount, 2550); // pct capped at 100%
});

test('order totals: inclusive tax only reports the tax portion', () => {
  const t = orderTotals([{ unitPrice: 1100, qty: 1, voided: false }], null, { taxRateBp: 1000, taxInclusive: true, serviceChargeBp: 0 });
  assert.deepEqual(t, { subtotal: 1100, discount: 0, service: 0, tax: 100, total: 1100 });
});

test('money parsing and formatting by currency', () => {
  assert.equal(parseMoney('12.5', 'USD'), 1250);
  assert.equal(parseMoney('12,05', 'EUR'), 1205);
  assert.equal(parseMoney('1200', 'JPY'), 1200);
  assert.equal(parseMoney('12.345', 'USD'), null);
  assert.equal(parseMoney('-3', 'USD'), null);
  assert.equal(parseMoney('abc', 'USD'), null);
  assert.equal(formatMoney(123456, 'USD', 'en-US'), '$1,234.56');
});

test('business day: before/after cutoff', () => {
  const tz = 'Asia/Kolkata';
  assert.equal(businessDay(Date.parse('2026-11-25T20:00:00Z'), tz, 0), '2026-11-26');
  assert.equal(businessDay(Date.parse('2026-11-25T20:00:00Z'), tz, 4), '2026-11-25');
  assert.equal(businessDay(Date.parse('2026-11-25T23:00:00Z'), tz, 4), '2026-11-26'); // 04:30 local
});

test('business day is DST-safe (US spring forward)', () => {
  const tz = 'America/New_York';
  // 2026-03-08 DST starts 02:00 -> 03:00. 04:30 local EDT = 08:30Z belongs to the 8th.
  assert.equal(businessDay(Date.parse('2026-03-08T08:30:00Z'), tz, 4), '2026-03-08');
  // 03:30 local EDT = 07:30Z is before 4am -> 7th.
  assert.equal(businessDay(Date.parse('2026-03-08T07:30:00Z'), tz, 4), '2026-03-07');
  assert.equal(zonedTime('2026-03-08', '04:30', tz), Date.parse('2026-03-08T08:30:00Z'));
  assert.equal(zonedTime('2026-11-25', '19:00', 'Asia/Kolkata'), Date.parse('2026-11-25T13:30:00Z'));
});

test('week start', () => {
  assert.equal(weekStart('2026-11-25', 1), '2026-11-23'); // Wed -> Monday
  assert.equal(weekStart('2026-11-23', 1), '2026-11-23');
  assert.equal(weekStart('2026-11-25', 0), '2026-11-22'); // Sunday start
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

const H = 3_600_000;
function dataset(overrides: Partial<Dataset['settings']> = {}): Dataset {
  const at = (d: string, h: number) => Date.parse(`${d}T00:00:00Z`) + h * H; // timezone UTC
  return {
    settings: { timezone: 'UTC', dayStartHour: 4, weekStartsOn: 1, overtimeWeeklyHours: 0, overtimeMultiplierPct: 150, ...overrides },
    users: [{ id: 'a', name: 'Ana', groupId: 'g', active: true }, { id: 'b', name: 'Ben', groupId: 'g', active: true }],
    rates: [
      { id: 'r1', userId: 'a', rateCents: 2000, effectiveFrom: '2026-01-01' },
      { id: 'r2', userId: 'a', rateCents: 2500, effectiveFrom: '2026-11-25' }, // raise mid-week
    ],
    orders: [
      { id: 'o1', status: 'paid', closedAt: at('2026-11-23', 13), totals: { subtotal: 10000, discount: 0, service: 0, tax: 1000, total: 11000 } },
      { id: 'o2', status: 'paid', closedAt: at('2026-11-24', 2), totals: { subtotal: 5000, discount: 500, service: 450, tax: 450, total: 5400 } }, // 02:00 -> 23rd
      { id: 'o3', status: 'void', closedAt: at('2026-11-24', 14), totals: { subtotal: 900, discount: 0, service: 0, tax: 0, total: 900 } },
    ],
    payments: [
      { id: 'p1', orderId: 'o1', method: 'Card', amount: 11000, tip: 500, at: at('2026-11-23', 13) },
      { id: 'p2', orderId: 'o2', method: 'Cash', amount: 5400, tip: 0, at: at('2026-11-24', 2) },
    ],
    shifts: [
      { id: 's1', userId: 'a', clockIn: at('2026-11-23', 9), clockOut: at('2026-11-23', 17), breakMin: 30 }, // 7.5h @20
      { id: 's2', userId: 'a', clockIn: at('2026-11-25', 9), clockOut: at('2026-11-25', 13), breakMin: 0 }, // 4h @25
      { id: 's3', userId: 'b', clockIn: at('2026-11-23', 18), clockOut: at('2026-11-24', 2), breakMin: 0 }, // 8h, no rate
    ],
    generatedAt: 0,
  };
}

test('report: revenue, labour, rate history, business day, missing rates', () => {
  const r = buildReport(dataset(), '2026-11-23', '2026-11-29');
  const mon = r.days[0];
  assert.equal(mon.date, '2026-11-23');
  assert.equal(mon.orders, 2); // o2 closed 02:00 on the 24th belongs to the 23rd
  assert.equal(mon.gross, 16400);
  assert.equal(mon.tax, 1450);
  assert.equal(mon.service, 450);
  assert.equal(mon.net, 16400 - 1450 - 450);
  assert.equal(mon.revenue, 16400 - 1450);
  assert.equal(mon.tips, 500);
  assert.deepEqual(mon.byMethod, { Card: 11000, Cash: 5400 });
  assert.equal(mon.labourMinutes, 450 + 480);
  assert.equal(mon.labourCost, 15000); // 7.5h * 20.00; Ben has no rate
  assert.equal(mon.profit, mon.revenue - 15000);
  assert.equal(mon.labourPctBp, Math.round((15000 * 10000) / mon.revenue));
  assert.equal(r.days[2].labourCost, 10000); // 4h at the new 25.00 rate
  assert.equal(r.days[1].orders, 0); // void order ignored
  const ana = r.employees.find((e) => e.userId === 'a')!;
  assert.deepEqual([ana.shifts, ana.minutes, ana.pay, ana.rateCents], [2, 690, 25000, 2500]);
  assert.ok(r.employees.find((e) => e.userId === 'b')!.missingRate);
  assert.equal(r.totals.labourCost, 25000);
  assert.equal(r.bestDay, '2026-11-23');
  assert.ok(r.warnings.some((w) => w.includes('Ben')));
});

test('report: weekly overtime lands on the shifts past the threshold', () => {
  const ds = dataset({ overtimeWeeklyHours: 10, overtimeMultiplierPct: 150 });
  const r = buildReport(ds, '2026-11-23', '2026-11-29');
  const ana = r.employees.find((e) => e.userId === 'a')!;
  // 7.5h regular on Mon; Wed 4h = 2.5h regular + 1.5h OT at 25.00*1.5
  assert.equal(ana.regularMinutes, 600);
  assert.equal(ana.overtimeMinutes, 90);
  assert.equal(r.days[2].labourCost, Math.round((150 * 2500 * 100 + 90 * 2500 * 150) / 6000));
});

test('report: overtime counts earlier days of the week outside the range', () => {
  const ds = dataset({ overtimeWeeklyHours: 10 });
  const r = buildReport(ds, '2026-11-25', '2026-11-25');
  assert.equal(r.employees.find((e) => e.userId === 'a')!.overtimeMinutes, 90);
});

test('permissions: sensitive needs password, rank and grant rules', () => {
  const [owner, manager, , staff] = DEFAULT_GROUPS.map((g, i) => ({ ...g, id: `g${i}` }));
  const u = (g: { id: string }) => ({ id: 'u', groupId: g.id, active: true });
  assert.equal(can(u(manager), manager, 'finance.view', 'password'), true);
  assert.equal(can(u(manager), manager, 'finance.view', 'pin'), false);
  assert.equal(can(u(manager), manager, 'orders.void', 'pin'), false); // overrides need a password key
  assert.equal(can(u(manager), manager, 'orders.void', 'strong'), true);
  assert.equal(can(u(manager), manager, 'finance.view', 'strong'), false);
  assert.equal(can(u(staff), staff, 'pos.use', 'pin'), true);
  assert.equal(can(u(staff), staff, 'orders.void', 'password'), false);
  assert.equal(can({ ...u(owner), active: false }, owner, 'pos.use', 'password'), false);
  assert.equal(can(u(staff), manager, 'pos.use', 'password'), false); // group mismatch
  assert.ok(outranks(manager, staff) && !outranks(staff, manager) && !outranks(manager, manager));
  assert.ok(!canGrant(manager, ['settings.manage']) && canGrant(owner, ['settings.manage']));
});

test('report: other costs, spread evenly over their days, come off profit', () => {
  const ds = dataset();
  ds.expenses = [
    { id: 'e1', day: '2026-11-23', spreadDays: 1, category: 'Ingredients & stock', description: 'Veg order', amount: 4_000 },
    { id: 'e2', day: '2026-11-20', spreadDays: 7, category: 'Equipment', description: 'Blender', amount: 701 }, // 101,100,100,…
  ];
  const after = Date.parse('2026-12-01T12:00:00Z');
  const r = buildReport(ds, '2026-11-23', '2026-11-29', after);
  const d23 = r.days.find((d) => d.date === '2026-11-23')!;
  // e2 started on the 20th: its 4th day (k=3, 100) lands on the 23rd; days 24–26 get 100 each
  assert.equal(d23.costs, 4_000 + 100);
  assert.equal(d23.profit, d23.revenue - d23.labourCost - d23.costs);
  assert.equal(r.totals.costs, 4_000 + 4 * 100);
  assert.deepEqual(r.costs.map((c) => [c.id, c.inRange]), [['e2', 400], ['e1', 4_000]]);
  const whole = buildReport(ds, '2026-11-20', '2026-11-26', after);
  assert.equal(whole.totals.costs, 4_000 + 701, 'over the whole spread the cent split adds back up exactly');
  const midWeek = buildReport(ds, '2026-11-23', '2026-11-29', Date.parse('2026-11-24T12:00:00Z'));
  assert.equal(midWeek.totals.costs, 4_000 + 2 * 100, "days that haven't happened yet carry no cost");
});

test('report: long ranges group by week or month', () => {
  assert.equal(groupingFor('2026-11-01', '2026-11-30'), 'day');
  assert.equal(groupingFor('2026-09-01', '2026-11-30'), 'week');
  assert.equal(groupingFor('2026-01-01', '2026-12-31'), 'month');
  const r = buildReport(dataset(), '2026-11-16', '2026-11-29');
  const weeks = groupRows(r.days, 'week', 1);
  assert.deepEqual(weeks.map((w) => [w.date, w.until]), [['2026-11-16', '2026-11-22'], ['2026-11-23', '2026-11-29']]);
  assert.equal(weeks[1]!.revenue, r.totals.revenue);
  assert.equal(weeks.reduce((a, w) => a + w.profit, 0), r.totals.profit);
});
