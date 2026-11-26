// Reports for any date range: ledger (revenue vs wages vs other costs), payroll, tender mix and other costs.
// All maths: shared/report.ts. Online: fetch the dataset and keep an encrypted copy (vault). Offline or vault
// session: show that copy, read-only.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, ChevronLeft, ChevronRight, Download, Lock, Plus, Printer, RefreshCw, Trash2, TrendingDown, TrendingUp, WifiOff, type LucideIcon } from 'lucide-react';
import { api, ApiError, errorText } from '../../lib/api.ts';
import { useApp, useCan, vaultLoad, vaultSave } from '../../lib/session.ts';
import { hoursText, useFmt } from '../../lib/format.ts';
import { confirmBox, Dialog, Empty, toast } from '../../ui/index.tsx';
import { formatBp, minorDigits, parseMoney } from '../../../shared/money.ts';
import { buildReport, COST_CATEGORIES, groupingFor, groupRows, reportCsv, SPREADS, type Dataset, type DayRow, type Report } from '../../../shared/report.ts';
import { addDays, weekStart } from '../../../shared/time.ts';
import type { ModuleProps } from '../index.ts';
import './reports.css';

type Fmt = ReturnType<typeof useFmt>;
type Grouping = 'day' | 'week' | 'month';
interface Got { key: string; ds: Dataset | null; offline: boolean; savedAt: number | null; error: string | null; totp: boolean }

const LABOUR_WARN_BP = 3500; // 35% of revenue
const MAX_DAYS = 366;
const overLabour = (bp: number | null) => bp != null && bp > LABOUR_WARN_BP;
const pct = (bp: number | null) => (bp == null ? '–' : formatBp(bp));
const OFFLINE = "You're offline — costs can be added once you're back online.";

// ---------- date ranges ----------
type Preset = 'today' | 'yesterday' | 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'days30' | 'custom';
const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'week', label: 'This week' }, { id: 'lastWeek', label: 'Last week' },
  { id: 'month', label: 'This month' }, { id: 'lastMonth', label: 'Last month' }, { id: 'days30', label: 'Last 30 days' },
];
interface Range { preset: Preset; from: string; to: string }
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => { const [y, m] = d.split('-').map(Number); return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10); };
const spanDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

function presetRange(p: Exclude<Preset, 'custom'>, today: string, weekStartsOn: number): Range {
  const at = (from: string, to: string): Range => ({ preset: p, from, to });
  const wk = weekStart(today, weekStartsOn);
  switch (p) {
    case 'today': return at(today, today);
    case 'yesterday': return at(addDays(today, -1), addDays(today, -1));
    case 'week': return at(wk, addDays(wk, 6));
    case 'lastWeek': return at(addDays(wk, -7), addDays(wk, -1));
    case 'month': return at(monthStart(today), monthEnd(today));
    case 'lastMonth': { const f = monthStart(addDays(monthStart(today), -1)); return at(f, monthEnd(f)); }
    case 'days30': return at(addDays(today, -29), today);
  }
}

/** ◀ ▶ move a whole calendar month when the range is one, otherwise by the range's own length. */
function shifted(r: Range, dir: -1 | 1): Range {
  if (r.from === monthStart(r.from) && r.to === monthEnd(r.from)) {
    const f = monthStart(dir < 0 ? addDays(r.from, -1) : addDays(r.to, 1));
    return { preset: 'custom', from: f, to: monthEnd(f) };
  }
  const n = spanDays(r.from, r.to) * dir;
  return { preset: 'custom', from: addDays(r.from, n), to: addDays(r.to, n) };
}

/** Never rejects: every outcome is a Got. */
async function fetchRange(from: string, to: string, offline: boolean): Promise<Got> {
  const key = `${from}|${to}`;
  const got: Got = { key, ds: null, offline, savedAt: null, error: null, totp: false };
  if (!offline) {
    try {
      const ds = await api<Dataset>('GET', `/api/finance/dataset?from=${from}&to=${to}`);
      await vaultSave(`range:${key}`, ds).catch(() => false); // false = no vault key on this device; the live copy still shows
      return { ...got, ds };
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 0)) return { ...got, error: errorText(e), totp: e instanceof ApiError && !!e.data.needTotp };
    }
  }
  const c = await vaultLoad<Dataset>(`range:${key}`).catch(() => null);
  return { ...got, offline: true, ds: c?.value ?? null, savedAt: c?.savedAt ?? null };
}

function downloadCsv(r: Report, fmt: Fmt) {
  // BOM so Excel reads UTF-8 currency symbols
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + reportCsv(r, fmt.money)], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: `shiftab-${r.from}-to-${r.to}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Reports(_: ModuleProps) {
  const fmt = useFmt();
  const can = useCan();
  const { session } = useApp();
  const vault = session?.level === 'vault';
  const [picked, setPicked] = useState<Range | null>(null);
  const [tick, setTick] = useState(0);
  const [got, setGot] = useState<Got | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);

  const s = fmt.settings;
  const ready = !!s;
  const today = fmt.today();
  const ws = s?.weekStartsOn ?? 1;
  const range = picked ?? presetRange('week', today, ws);
  const { from, to } = range;
  const problem = from > to ? 'The start date is after the end date.' : spanDays(from, to) > MAX_DAYS ? `Pick a range of at most ${MAX_DAYS} days.` : '';

  useEffect(() => {
    if (!ready || problem) return;
    let live = true;
    setBusy(true);
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 300); // skeleton only for slow loads
    void fetchRange(from, to, vault).then((g) => {
      if (!live) return;
      clearTimeout(t);
      setGot(g); setBusy(false); setSlow(false);
    });
    return () => { live = false; clearTimeout(t); };
  }, [from, to, vault, tick, ready, problem]);

  const view = got?.key === `${from}|${to}` ? got : null;
  const r = useMemo(() => (view?.ds ? buildReport(view.ds, from, to) : null), [view, from, to]);
  const label = range.preset === 'custom' ? 'Custom range' : PRESETS.find((p) => p.id === range.preset)!.label;

  let body;
  if (problem) body = <div className="banner warning" role="alert"><AlertTriangle aria-hidden="true" /><div className="grow">{problem}</div></div>;
  else if (!view) body = slow || !ready ? <Skeleton /> : null;
  else if (view.error) {
    body = view.totp
      ? <Empty icon={<Lock />} title="Two-factor sign-in required">{view.error}</Empty>
      : <div className="banner danger" role="alert"><AlertTriangle aria-hidden="true" /><div className="grow">{view.error}</div>
          <button className="btn sm outline" onClick={() => setTick((n) => n + 1)}>Try again</button></div>;
  } else if (!view.ds || !r) {
    body = (
      <Empty icon={<WifiOff />} title="No saved copy of this period">
        {session?.vaultKey
          ? 'You are offline. Open a period once while connected and an encrypted copy is kept on this device.'
          : 'You are offline, and saved reports are locked. Sign in with your password to open them.'}
      </Empty>
    );
  } else {
    body = <ReportView r={r} fmt={fmt} today={today} savedAt={view.offline ? view.savedAt : null} busy={busy}
      canEditCosts={can('finance.manage') && !vault && !view.offline} onChanged={() => setTick((n) => n + 1)} />;
  }

  return (
    <div className="page reports">
      <div className="page-head">
        <div><h1>Reports</h1><p>{s?.name ? `${s.name} · ` : ''}{label}</p></div>
        <div className="row no-print">
          <button className="btn outline" onClick={() => setTick((n) => n + 1)} disabled={busy}><RefreshCw className={busy ? 'spin' : ''} aria-hidden="true" /> Refresh</button>
          <button className="btn outline" onClick={() => r && downloadCsv(r, fmt)} disabled={!r}><Download aria-hidden="true" /> Export CSV</button>
          <button className="btn outline" onClick={() => window.print()} disabled={!r}><Printer aria-hidden="true" /> Print</button>
        </div>
      </div>

      <div className="stack rp-range">
        <div className="row no-print" role="group" aria-label="Report period">
          {PRESETS.map((p) => (
            <button key={p.id} className="chip" aria-pressed={range.preset === p.id} onClick={() => setPicked(presetRange(p.id, today, ws))}>{p.label}</button>
          ))}
        </div>
        <div className="row">
          <button className="btn outline icon no-print" aria-label="Previous period" onClick={() => setPicked(shifted(range, -1))}><ChevronLeft aria-hidden="true" /></button>
          <h2 aria-live="polite">{rangeText(fmt, from, to)}</h2>
          <button className="btn outline icon no-print" aria-label="Next period" onClick={() => setPicked(shifted(range, 1))} disabled={to >= today}><ChevronRight aria-hidden="true" /></button>
          <label className="rp-date no-print"><span className="sr-only">From</span>
            <input type="date" className="input" value={from} max={today} onChange={(e) => e.target.value && setPicked({ preset: 'custom', from: e.target.value, to })} /></label>
          <span className="muted no-print" aria-hidden="true">to</span>
          <label className="rp-date no-print"><span className="sr-only">To</span>
            <input type="date" className="input" value={to} min={from} onChange={(e) => e.target.value && setPicked({ preset: 'custom', from, to: e.target.value })} /></label>
          {view?.ds && !view.offline && <span className="muted small">Updated {fmt.time(view.ds.generatedAt)}</span>}
        </div>
      </div>

      {body}
    </div>
  );
}

function rangeText(fmt: Fmt, from: string, to: string) {
  const year = from.slice(0, 4) !== to.slice(0, 4) || from.slice(0, 4) !== fmt.today().slice(0, 4);
  const f = new Intl.DateTimeFormat(fmt.locale, { weekday: spanDays(from, to) <= 7 ? 'short' : undefined, day: 'numeric', month: 'short', year: year ? 'numeric' : undefined, timeZone: 'UTC' });
  const d = (x: string) => f.format(Date.parse(`${x}T12:00:00Z`));
  return from === to ? d(from) : `${d(from)} – ${d(to)}`;
}

function Skeleton() {
  return (
    <div className="stack lg" aria-busy="true">
      <span className="sr-only" role="status">Loading report…</span>
      <div className="rp-kpis">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton rp-sk kpi-h" />)}</div>
      <div className="skeleton rp-sk chart-h" />
      <div className="skeleton rp-sk table-h" />
    </div>
  );
}

/** Best / worst row by profit among rows with any activity (days, weeks or months). */
function extremes(rows: DayRow[]) {
  const active = rows.filter((d) => d.revenue > 0 || d.labourCost > 0 || d.costs > 0).sort((a, b) => b.profit - a.profit);
  return { best: active[0]?.date ?? null, worst: active.length > 1 ? active[active.length - 1]!.date : null };
}

function ReportView({ r, fmt, today, savedAt, busy, canEditCosts, onChanged }: {
  r: Report; fmt: Fmt; today: string; savedAt: number | null; busy: boolean; canEditCosts: boolean; onChanged: () => void;
}) {
  const by = groupingFor(r.from, r.to);
  const rows = useMemo(() => groupRows(r.days, by, fmt.settings?.weekStartsOn ?? 1), [r, by, fmt.settings?.weekStartsOn]);
  const ext = extremes(rows);
  return (
    <div className="stack lg rp-body" aria-busy={busy}>
      {savedAt != null && <div className="banner"><WifiOff aria-hidden="true" /><div className="grow">Offline — showing the copy saved {fmt.dateTime(savedAt)}. Read-only.</div></div>}
      {r.warnings.map((w, i) => <div key={i} className="banner warning"><AlertTriangle aria-hidden="true" /><div className="grow">{w}</div></div>)}
      <Kpis r={r} fmt={fmt} today={today} />
      <Chart rows={rows} by={by} ext={ext} r={r} fmt={fmt} today={today} />
      <Ledger rows={rows} by={by} ext={ext} r={r} fmt={fmt} today={today} />
      <Costs r={r} fmt={fmt} canEdit={canEditCosts} onChanged={onChanged} />
      <div className="rp-split">
        <Payroll r={r} fmt={fmt} />
        <Tenders r={r} fmt={fmt} />
      </div>
    </div>
  );
}

// ---------- KPI tiles ----------
interface Flag { tone: 'warning' | 'danger'; icon: LucideIcon; note: string }
const KPIS: { label: string; value: (d: DayRow, f: Fmt) => string; flag?: (d: DayRow) => Flag | null }[] = [
  { label: 'Revenue', value: (d, f) => f.money(d.revenue) },
  { label: 'Labour cost', value: (d, f) => f.money(d.labourCost) },
  { label: 'Labour %', value: (d) => pct(d.labourPctBp),
    flag: (d) => (overLabour(d.labourPctBp) ? { tone: 'warning', icon: AlertTriangle, note: 'Above 35% of revenue' } : null) },
  { label: 'Other costs', value: (d, f) => f.money(d.costs) },
  { label: 'Profit', value: (d, f) => f.money(d.profit),
    flag: (d) => (d.profit < 0 ? { tone: 'danger', icon: TrendingDown, note: 'Loss after wages and costs' } : null) },
  { label: 'Orders', value: (d, f) => d.orders.toLocaleString(f.locale) },
  { label: 'Avg ticket', value: (d, f) => f.money(d.avgTicket) },
  { label: 'Tips', value: (d, f) => f.money(d.tips) },
  { label: 'Labour hours', value: (d) => hoursText(d.labourMinutes) },
];

function Kpis({ r, fmt, today }: { r: Report; fmt: Fmt; today: string }) {
  const todayRow = r.days.length > 1 ? r.days.find((d) => d.date === today) : undefined;
  return (
    <section className="rp-kpis" aria-label="Totals for the period">
      {KPIS.map((k) => {
        const f = k.flag?.(r.totals);
        return (
          <div key={k.label} className="card kpi">
            <div className="label">{k.label}</div>
            <div className={`value${f ? ` ${f.tone}-text` : ''}`}>{f && <f.icon aria-hidden="true" />}{k.value(r.totals, fmt)}</div>
            {f && <div className={`xs strong ${f.tone}-text`}>{f.note}</div>}
            {todayRow && <div className="small muted rp-today">Today <strong>{k.value(todayRow, fmt)}</strong></div>}
          </div>
        );
      })}
    </section>
  );
}

function Badges({ date, ext, today }: { date: string; ext: { best: string | null; worst: string | null }; today: string }) {
  return <>
    {date === today && <span className="pill accent">Today</span>}
    {date === ext.best && <span className="pill success"><TrendingUp aria-hidden="true" />Best</span>}
    {date === ext.worst && <span className="pill danger"><TrendingDown aria-hidden="true" />Worst</span>}
  </>;
}

/** Row label: the day, the week's dates, or the month. */
function rowLabel(d: DayRow, by: Grouping, fmt: Fmt) {
  if (by === 'day') return fmt.day(d.date);
  if (by === 'week') return `${fmt.day(d.date)} – ${fmt.day(d.until ?? d.date)}`;
  return new Intl.DateTimeFormat(fmt.locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${d.date}T12:00:00Z`));
}

// ---------- chart: revenue column beside a spending column (wages + other costs), one money axis ----------
function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

function Chart({ rows, by, ext, r, fmt, today }: { rows: DayRow[]; by: Grouping; ext: { best: string | null; worst: string | null }; r: Report; fmt: Fmt; today: string }) {
  const peak = Math.max(0, ...rows.flatMap((d) => [d.revenue, d.labourCost + d.costs]));
  const t = r.totals;
  const step = peak > 0 ? niceStep(peak / 4) : 1;
  const top = step * 4;
  const h = (v: number) => `${v > 0 ? Math.max(0.5, (v / top) * 100) : 0}%`;
  const scale = 10 ** minorDigits(fmt.currency);
  const tick = new Intl.NumberFormat(fmt.locale, { style: 'currency', currency: fmt.currency, notation: 'compact', maximumFractionDigits: 1 });
  const weekday = new Intl.DateTimeFormat(fmt.locale, { weekday: 'short', timeZone: 'UTC' });
  const dm = new Intl.DateTimeFormat(fmt.locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const mon = new Intl.DateTimeFormat(fmt.locale, { month: 'short', timeZone: 'UTC' });
  const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
  const short = (d: string) => (by === 'day' ? `${weekday.format(at(d))} ${Number(d.slice(8))}` : by === 'week' ? dm.format(at(d)) : `${mon.format(at(d))} ${d.slice(2, 4)}`);
  const unit = by === 'day' ? 'day' : by;
  const summary = `Revenue, wages and other costs per ${unit}, ${fmt.day(r.from)} to ${fmt.day(r.to)}. `
    + `Revenue ${fmt.money(t.revenue)}, wages ${fmt.money(t.labourCost)}${t.labourPctBp != null ? ` (${formatBp(t.labourPctBp)} of revenue)` : ''}, other costs ${fmt.money(t.costs)}, profit ${fmt.money(t.profit)}. `
    + 'Every figure is in the ledger table.';

  return (
    <section className="card rp-chart no-print" aria-labelledby="rp-chart-h">
      <div className="card-head">
        <h2 id="rp-chart-h">Revenue vs spending</h2>
        <ul className="rp-legend">
          <li><i className="rev" />Revenue</li>
          <li><i className="lab" />Wages</li>
          <li><i className="cost" />Other costs</li>
          <li className="muted">% under each {unit} = wages ÷ revenue · Best / Worst = by profit</li>
        </ul>
      </div>
      {peak === 0 ? <Empty icon={<BarChart3 />} title="No sales, shifts or costs in this period" /> : (
        <div className="rp-scroll">
          <div className="rp-plot" role="img" aria-label={summary}>
            <div className="rp-yaxis">{[0, 1, 2, 3, 4].map((i) => <span key={i}>{tick.format((i * step) / scale)}</span>)}</div>
            <div className="rp-grid" style={{ gridColumn: `2 / span ${rows.length}` }}>{[0, 1, 2, 3, 4].map((i) => <i key={i} />)}</div>
            {rows.map((d, i) => {
              const col = String(i + 2);
              const edge = i < 2 ? ' start' : i >= rows.length - 2 ? ' end' : '';
              const spend = d.labourCost + d.costs;
              const isToday = by === 'day' && d.date === today;
              return [
                <div key={d.date} className={`rp-bars${isToday ? ' today' : ''}${edge}`} style={{ gridColumn: col }}>
                  <i className="rev" style={{ height: h(d.revenue) }} />
                  <span className="spend" style={{ height: h(spend) }}>
                    <i className="lab" style={{ height: spend ? `${(d.labourCost / spend) * 100}%` : 0 }} />
                    <i className="cost" style={{ height: spend ? `${(d.costs / spend) * 100}%` : 0 }} />
                  </span>
                  <div className="rp-tip">
                    <strong>{rowLabel(d, by, fmt)}</strong>
                    <span><i className="rev" /><b>{fmt.money(d.revenue)}</b><span className="muted">Revenue</span></span>
                    <span><i className="lab" /><b>{fmt.money(d.labourCost)}</b><span className="muted">Wages</span></span>
                    <span><i className="cost" /><b>{fmt.money(d.costs)}</b><span className="muted">Other costs</span></span>
                    <span><i /><b>{fmt.money(d.profit)}</b><span className="muted">Profit</span></span>
                    <span><i /><b>{pct(d.labourPctBp)}</b><span className="muted">Labour %</span></span>
                  </div>
                </div>,
                <div key={`${d.date}x`} className="rp-x" style={{ gridColumn: col }}>
                  <span className={isToday ? 'strong' : ''}>{short(d.date)}</span>
                  <span className="muted">{overLabour(d.labourPctBp) && <AlertTriangle className="warning-text" aria-hidden="true" />}{pct(d.labourPctBp)}</span>
                  <Badges date={d.date} ext={ext} today={by === 'day' ? today : ''} />
                </div>,
              ];
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- tables ----------
function RowCells({ d, fmt }: { d: DayRow; fmt: Fmt }) {
  const warn = overLabour(d.labourPctBp);
  return <>
    <td className="num">{d.orders}</td>
    <td className="num">{fmt.money(d.gross)}</td>
    <td className="num">{fmt.money(d.tax)}</td>
    <td className="num">{fmt.money(d.service)}</td>
    <td className="num">{fmt.money(d.discounts)}</td>
    <td className="num">{fmt.money(d.net)}</td>
    <td className="num">{fmt.money(d.revenue)}</td>
    <td className="num">{fmt.money(d.tips)}</td>
    <td className="num">{hoursText(d.labourMinutes)}</td>
    <td className="num">{fmt.money(d.labourCost)}</td>
    <td className={`num${warn ? ' warning-text' : ''}`}>{warn && <><AlertTriangle aria-hidden="true" /><span className="sr-only">Above 35%: </span></>}{pct(d.labourPctBp)}</td>
    <td className="num">{fmt.money(d.costs)}</td>
    <td className={`num${d.profit < 0 ? ' danger-text' : ''}`}>{fmt.money(d.profit)}</td>
  </>;
}

function Ledger({ rows, by, ext, r, fmt, today }: { rows: DayRow[]; by: Grouping; ext: { best: string | null; worst: string | null }; r: Report; fmt: Fmt; today: string }) {
  const title = by === 'day' ? 'Daily ledger' : by === 'week' ? 'Weekly ledger' : 'Monthly ledger';
  return (
    <section className="card" aria-labelledby="rp-ledger-h">
      <div className="card-head"><h2 id="rp-ledger-h">{title}</h2></div>
      <div className="table-wrap">
        <table className="data" aria-labelledby="rp-ledger-h">
          <thead><tr>
            <th>{by === 'day' ? 'Date' : by === 'week' ? 'Week' : 'Month'}</th><th className="num">Orders</th><th className="num">Gross</th><th className="num">Tax</th><th className="num">Service</th>
            <th className="num">Discounts</th><th className="num">Net sales</th><th className="num">Revenue</th><th className="num">Tips</th>
            <th className="num">Labour hours</th><th className="num">Labour cost</th><th className="num">Labour %</th><th className="num">Other costs</th><th className="num">Profit</th>
          </tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.date}>
              <td><span className="rp-cell">{rowLabel(d, by, fmt)}<Badges date={d.date} ext={ext} today={by === 'day' ? today : ''} /></span></td>
              <RowCells d={d} fmt={fmt} />
            </tr>
          ))}</tbody>
          <tfoot><tr><td>Total</td><RowCells d={r.totals} fmt={fmt} /></tr></tfoot>
        </table>
      </div>
    </section>
  );
}

// ---------- other costs ----------
function Costs({ r, fmt, canEdit, onChanged }: { r: Report; fmt: Fmt; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const spreadLabel = (n: number) => SPREADS.find((s) => s.days === n)?.label ?? `${n} days`;
  async function del(id: string, what: string) {
    if (!(await confirmBox({ title: `Remove ${what}?`, message: 'It comes out of every report it was part of.', confirm: 'Remove', danger: true }))) return;
    try { await api('DELETE', `/api/finance/expenses/${id}`); toast('Cost removed', 'success'); onChanged(); }
    catch (e) { toast(e instanceof ApiError && e.status === 0 ? OFFLINE : errorText(e), 'error'); }
  }
  return (
    <section className="card" aria-labelledby="rp-costs-h">
      <div className="card-head">
        <h2 id="rp-costs-h">Other costs</h2>
        {canEdit && <button className="btn outline sm no-print" onClick={() => setAdding(true)}><Plus aria-hidden="true" /> Add cost</button>}
      </div>
      {r.costs.length === 0 ? (
        <p className="muted">No costs in this period.{canEdit ? ' Add equipment, stock, rent or bills to see your real profit.' : ''}</p>
      ) : (
        <div className="table-wrap">
          <table className="data" aria-labelledby="rp-costs-h">
            <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Spread</th><th className="num">Amount</th><th className="num">In this period</th>{canEdit && <th className="no-print"><span className="sr-only">Remove</span></th>}</tr></thead>
            <tbody>{r.costs.map((e) => (
              <tr key={e.id}>
                <td>{fmt.day(e.day)}</td>
                <td>{e.category}</td>
                <td className="ellipsis" style={{ maxWidth: '18rem' }}>{e.description || '—'}</td>
                <td className="muted">{spreadLabel(e.spreadDays)}</td>
                <td className="num">{fmt.money(e.amount)}</td>
                <td className="num">{fmt.money(e.inRange)}</td>
                {canEdit && <td className="num no-print"><button className="btn ghost icon sm" aria-label={`Remove ${e.description || e.category}`} onClick={() => void del(e.id, e.description || e.category)}><Trash2 /></button></td>}
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={5}>Total in this period</td><td className="num">{fmt.money(r.totals.costs)}</td>{canEdit && <td className="no-print" />}</tr></tfoot>
          </table>
        </div>
      )}
      {adding && <CostDialog fmt={fmt} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} />}
    </section>
  );
}

function CostDialog({ fmt, onClose, onSaved }: { fmt: Fmt; onClose: () => void; onSaved: () => void }) {
  const [day, setDay] = useState(fmt.today());
  const [category, setCategory] = useState<string>(COST_CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [spreadDays, setSpread] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const minor = parseMoney(amount, fmt.currency);
  const bad = minor == null || minor <= 0;

  async function save() {
    if (bad) return;
    setBusy(true);
    try {
      await api('POST', '/api/finance/expenses', { day, category, description: description.trim(), amount: minor, spreadDays });
      toast(`${fmt.money(minor)} ${category.toLowerCase()} added`, 'success');
      onSaved();
    } catch (e) { toast(e instanceof ApiError && e.status === 0 ? OFFLINE : errorText(e), 'error'); } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={onClose} title="Add a cost" footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" type="submit" form="cost-form" disabled={busy || bad}>Add cost</button>
    </>}>
      <form id="cost-form" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="form-grid">
          <label className="field"><span>Date</span><input type="date" required value={day} onChange={(e) => setDay(e.target.value)} /></label>
          <label className="field"><span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>{COST_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          </label>
        </div>
        <label className="field"><span>Description</span><input maxLength={120} placeholder="e.g. Combi oven, weekly veg order, electricity bill" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="form-grid">
          <label className="field"><span>Amount ({fmt.currency})</span>
            <input inputMode="decimal" className="money" required autoFocus value={amount} aria-invalid={amount !== '' && bad} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field"><span>Count it</span>
            <select value={spreadDays} onChange={(e) => setSpread(Number(e.target.value))}>{SPREADS.map((s) => <option key={s.days} value={s.days}>{s.label}</option>)}</select>
          </label>
        </div>
        <p className="small muted">Spreading a big purchase shares its cost evenly across the days it serves, so one day's profit isn't wiped out.
          {spreadDays > 1 && !bad && ` That's about ${fmt.money(Math.round(minor / spreadDays))} a day.`}</p>
      </form>
    </Dialog>
  );
}

function Payroll({ r, fmt }: { r: Report; fmt: Fmt }) {
  const sum = (k: 'shifts' | 'regularMinutes' | 'overtimeMinutes') => r.employees.reduce((a, e) => a + e[k], 0);
  return (
    <section className="card" aria-labelledby="rp-pay-h">
      <div className="card-head"><h2 id="rp-pay-h">Payroll</h2></div>
      {r.employees.length === 0 ? <p className="muted">No shifts in this period.</p> : (
        <div className="table-wrap">
          <table className="data" aria-labelledby="rp-pay-h">
            <thead><tr>
              <th>Employee</th><th className="num">Shifts</th><th className="num">Total hours</th><th className="num">Regular</th>
              <th className="num">Overtime</th><th className="num">Rate / hr</th><th className="num">Pay due</th>
            </tr></thead>
            <tbody>{r.employees.map((e) => (
              <tr key={e.userId}>
                <td><span className="rp-cell">{e.name}{e.openShifts > 0 && <span className="pill info">Clocked in</span>}</span></td>
                <td className="num">{e.shifts}</td>
                <td className="num">{hoursText(e.minutes)}</td>
                <td className="num">{hoursText(e.regularMinutes)}</td>
                <td className="num">{hoursText(e.overtimeMinutes)}</td>
                <td className="num">{e.missingRate ? <span className="pill warning"><AlertTriangle aria-hidden="true" />Missing</span> : fmt.money(e.rateCents)}</td>
                <td className="num">{fmt.money(e.pay)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr>
              <td>Total payroll</td><td className="num">{sum('shifts')}</td><td className="num">{hoursText(r.totals.labourMinutes)}</td>
              <td className="num">{hoursText(sum('regularMinutes'))}</td><td className="num">{hoursText(sum('overtimeMinutes'))}</td>
              <td /><td className="num">{fmt.money(r.totals.labourCost)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function Tenders({ r, fmt }: { r: Report; fmt: Fmt }) {
  const rows = Object.entries(r.totals.byMethod).sort((a, b) => b[1] - a[1]);
  const paid = rows.reduce((a, [, v]) => a + v, 0);
  return (
    <section className="card" aria-labelledby="rp-tender-h">
      <div className="card-head"><h2 id="rp-tender-h">Tender mix</h2></div>
      {rows.length === 0 ? <p className="muted">No payments in this period.</p> : (
        <div className="table-wrap">
          <table className="data" aria-labelledby="rp-tender-h">
            <thead><tr><th>Method</th><th className="num">Amount</th><th className="num">Share</th></tr></thead>
            <tbody>{rows.map(([m, v]) => (
              <tr key={m}><td>{m}</td><td className="num">{fmt.money(v)}</td><td className="num">{formatBp(Math.round((v * 10_000) / paid))}</td></tr>
            ))}</tbody>
            <tfoot><tr><td>Total taken</td><td className="num">{fmt.money(paid)}</td><td /></tr></tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
