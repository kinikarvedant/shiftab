// Reports: weekly ledger (revenue vs labour), payroll and tender mix. All maths: shared/report.ts.
// Online: fetch the dataset and keep an encrypted copy (vault). Offline or vault session: show that copy, read-only.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, ChevronLeft, ChevronRight, Download, Lock, Printer, RefreshCw, TrendingDown, TrendingUp, WifiOff, type LucideIcon } from 'lucide-react';
import { api, ApiError, errorText } from '../../lib/api.ts';
import { useApp, vaultLoad, vaultSave } from '../../lib/session.ts';
import { hoursText, useFmt } from '../../lib/format.ts';
import { Empty } from '../../ui/index.tsx';
import { formatBp, minorDigits } from '../../../shared/money.ts';
import { buildReport, reportCsv, type Dataset, type DayRow, type Report } from '../../../shared/report.ts';
import { addDays, weekStart } from '../../../shared/time.ts';
import type { ModuleProps } from '../index.ts';
import './reports.css';

type Fmt = ReturnType<typeof useFmt>;
interface Got { from: string; ds: Dataset | null; offline: boolean; savedAt: number | null; error: string | null; totp: boolean }

const LABOUR_WARN_BP = 3500; // 35% of revenue
const overLabour = (bp: number | null) => bp != null && bp > LABOUR_WARN_BP;
const pct = (bp: number | null) => (bp == null ? '–' : formatBp(bp));

/** Never rejects: every outcome is a Got. */
async function fetchWeek(from: string, to: string, offline: boolean): Promise<Got> {
  const got: Got = { from, ds: null, offline, savedAt: null, error: null, totp: false };
  if (!offline) {
    try {
      const ds = await api<Dataset>('GET', `/api/finance/dataset?from=${from}&to=${to}`);
      await vaultSave(`week:${from}`, ds).catch(() => false); // false = no vault key on this device; the live copy still shows
      return { ...got, ds };
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 0)) return { ...got, error: errorText(e), totp: e instanceof ApiError && !!e.data.needTotp };
    }
  }
  const c = await vaultLoad<Dataset>(`week:${from}`).catch(() => null);
  return { ...got, offline: true, ds: c?.value ?? null, savedAt: c?.savedAt ?? null };
}

function downloadCsv(r: Report, fmt: Fmt) {
  // BOM so Excel reads UTF-8 currency symbols
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + reportCsv(r, fmt.money)], { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: `shiftab-week-${r.from}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Reports(_: ModuleProps) {
  const fmt = useFmt();
  const { session } = useApp();
  const vault = session?.level === 'vault';
  const [offset, setOffset] = useState(0); // weeks from this week
  const [tick, setTick] = useState(0);
  const [got, setGot] = useState<Got | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);

  const s = fmt.settings;
  const ready = !!s;
  const today = fmt.today();
  const from = addDays(weekStart(today, s?.weekStartsOn ?? 1), offset * 7);
  const to = addDays(from, 6);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    setBusy(true);
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 300); // skeleton only for slow loads
    void fetchWeek(from, to, vault).then((g) => {
      if (!live) return;
      clearTimeout(t);
      setGot(g); setBusy(false); setSlow(false);
    });
    return () => { live = false; clearTimeout(t); };
  }, [from, to, vault, tick, ready]);

  const view = got?.from === from ? got : null;
  const r = useMemo(() => (view?.ds ? buildReport(view.ds, view.from, addDays(view.from, 6)) : null), [view]);

  let body;
  if (!view) body = slow || !ready ? <Skeleton /> : null;
  else if (view.error) {
    body = view.totp
      ? <Empty icon={<Lock />} title="Two-factor sign-in required">{view.error}</Empty>
      : <div className="banner danger" role="alert"><AlertTriangle aria-hidden="true" /><div className="grow">{view.error}</div>
          <button className="btn sm outline" onClick={() => setTick((n) => n + 1)}>Try again</button></div>;
  } else if (!view.ds || !r) {
    body = (
      <Empty icon={<WifiOff />} title="No saved copy of this week">
        {session?.vaultKey
          ? 'You are offline. Open a week once while connected and an encrypted copy is kept on this device.'
          : 'You are offline, and saved reports are locked. Sign in with your password to open them.'}
      </Empty>
    );
  } else {
    body = <ReportView r={r} fmt={fmt} today={today} savedAt={view.offline ? view.savedAt : null} busy={busy} />;
  }

  return (
    <div className="page reports">
      <div className="page-head">
        <div><h1>Reports</h1><p>{s?.name ? `${s.name} · ` : ''}Weekly report</p></div>
        <div className="row no-print">
          <button className="btn outline" onClick={() => setTick((n) => n + 1)} disabled={busy}><RefreshCw className={busy ? 'spin' : ''} aria-hidden="true" /> Refresh</button>
          <button className="btn outline" onClick={() => r && downloadCsv(r, fmt)} disabled={!r}><Download aria-hidden="true" /> Export CSV</button>
          <button className="btn outline" onClick={() => window.print()} disabled={!r}><Printer aria-hidden="true" /> Print</button>
        </div>
      </div>

      <div className="row rp-week">
        <button className="btn outline icon no-print" aria-label="Previous week" onClick={() => setOffset((o) => o - 1)}><ChevronLeft aria-hidden="true" /></button>
        <h2 aria-live="polite">{fmt.day(from)} – {fmt.day(to)}</h2>
        <button className="btn outline icon no-print" aria-label="Next week" onClick={() => setOffset((o) => o + 1)} disabled={offset >= 0}><ChevronRight aria-hidden="true" /></button>
        <button className="btn ghost no-print" onClick={() => setOffset(0)} disabled={offset === 0}>This week</button>
        {view?.ds && !view.offline && <span className="muted small">Updated {fmt.time(view.ds.generatedAt)}</span>}
      </div>

      {body}
    </div>
  );
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

function ReportView({ r, fmt, today, savedAt, busy }: { r: Report; fmt: Fmt; today: string; savedAt: number | null; busy: boolean }) {
  return (
    <div className="stack lg rp-body" aria-busy={busy}>
      {savedAt != null && <div className="banner"><WifiOff aria-hidden="true" /><div className="grow">Offline — showing the copy saved {fmt.dateTime(savedAt)}. Read-only.</div></div>}
      {r.warnings.map((w, i) => <div key={i} className="banner warning"><AlertTriangle aria-hidden="true" /><div className="grow">{w}</div></div>)}
      <Kpis r={r} fmt={fmt} today={today} />
      <WeekChart r={r} fmt={fmt} today={today} />
      <Ledger r={r} fmt={fmt} today={today} />
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
  { label: 'Profit after labour', value: (d, f) => f.money(d.profit),
    flag: (d) => (d.profit < 0 ? { tone: 'danger', icon: TrendingDown, note: 'Loss after wages' } : null) },
  { label: 'Orders', value: (d, f) => d.orders.toLocaleString(f.locale) },
  { label: 'Avg ticket', value: (d, f) => f.money(d.avgTicket) },
  { label: 'Tips', value: (d, f) => f.money(d.tips) },
  { label: 'Labour hours', value: (d) => hoursText(d.labourMinutes) },
];

function Kpis({ r, fmt, today }: { r: Report; fmt: Fmt; today: string }) {
  const todayRow = r.days.find((d) => d.date === today);
  return (
    <section className="rp-kpis" aria-label="Week totals">
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

function DayBadges({ date, r, today }: { date: string; r: Report; today: string }) {
  return <>
    {date === today && <span className="pill accent">Today</span>}
    {date === r.bestDay && <span className="pill success"><TrendingUp aria-hidden="true" />Best</span>}
    {date === r.worstDay && <span className="pill danger"><TrendingDown aria-hidden="true" />Worst</span>}
  </>;
}

// ---------- chart: paired columns per day, one axis (money) ----------
function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

function WeekChart({ r, fmt, today }: { r: Report; fmt: Fmt; today: string }) {
  const peak = Math.max(0, ...r.days.flatMap((d) => [d.revenue, d.labourCost]));
  const t = r.totals;
  const best = r.days.find((d) => d.date === r.bestDay);
  const worst = r.days.find((d) => d.date === r.worstDay);
  const step = peak > 0 ? niceStep(peak / 4) : 1;
  const top = step * 4;
  const h = (v: number) => `${v > 0 ? Math.max(0.5, (v / top) * 100) : 0}%`;
  const scale = 10 ** minorDigits(fmt.currency);
  const tick = new Intl.NumberFormat(fmt.locale, { style: 'currency', currency: fmt.currency, notation: 'compact', maximumFractionDigits: 1 });
  const weekday = new Intl.DateTimeFormat(fmt.locale, { weekday: 'short', timeZone: 'UTC' });
  const short = (d: string) => `${weekday.format(Date.parse(`${d}T12:00:00Z`))} ${Number(d.slice(8))}`;
  const summary = `Revenue and labour cost per day, ${fmt.day(r.from)} to ${fmt.day(r.to)}. `
    + `Week revenue ${fmt.money(t.revenue)}, labour cost ${fmt.money(t.labourCost)}${t.labourPctBp != null ? ` (${formatBp(t.labourPctBp)} of revenue)` : ''}. `
    + (best ? `Best day ${fmt.day(best.date)}, profit ${fmt.money(best.profit)}. ` : '')
    + (worst ? `Worst day ${fmt.day(worst.date)}, profit ${fmt.money(worst.profit)}. ` : '')
    + 'Every figure is in the daily ledger table.';

  return (
    <section className="card rp-chart no-print" aria-labelledby="rp-chart-h">
      <div className="card-head">
        <h2 id="rp-chart-h">Revenue vs labour cost</h2>
        <ul className="rp-legend">
          <li><i className="rev" />Revenue</li>
          <li><i className="lab" />Labour cost</li>
          <li className="muted">% under each day = labour ÷ revenue · Best / Worst = by profit after labour</li>
        </ul>
      </div>
      {peak === 0 ? <Empty icon={<BarChart3 />} title="No sales or shifts this week" /> : (
        <div className="rp-scroll">
          <div className="rp-plot" role="img" aria-label={summary}>
            <div className="rp-yaxis">{[0, 1, 2, 3, 4].map((i) => <span key={i}>{tick.format((i * step) / scale)}</span>)}</div>
            <div className="rp-grid" style={{ gridColumn: `2 / span ${r.days.length}` }}>{[0, 1, 2, 3, 4].map((i) => <i key={i} />)}</div>
            {r.days.map((d, i) => {
              const col = String(i + 2);
              const edge = i < 2 ? ' start' : i >= r.days.length - 2 ? ' end' : '';
              return [
                <div key={d.date} className={`rp-bars${d.date === today ? ' today' : ''}${edge}`} style={{ gridColumn: col }}>
                  <i className="rev" style={{ height: h(d.revenue) }} />
                  <i className="lab" style={{ height: h(d.labourCost) }} />
                  <div className="rp-tip">
                    <strong>{fmt.day(d.date)}</strong>
                    <span><i className="rev" /><b>{fmt.money(d.revenue)}</b><span className="muted">Revenue</span></span>
                    <span><i className="lab" /><b>{fmt.money(d.labourCost)}</b><span className="muted">Labour cost</span></span>
                    <span><i /><b>{fmt.money(d.profit)}</b><span className="muted">Profit after labour</span></span>
                    <span><i /><b>{pct(d.labourPctBp)}</b><span className="muted">Labour %</span></span>
                  </div>
                </div>,
                <div key={`${d.date}x`} className="rp-x" style={{ gridColumn: col }}>
                  <span className={d.date === today ? 'strong' : ''}>{short(d.date)}</span>
                  <span className="muted">{overLabour(d.labourPctBp) && <AlertTriangle className="warning-text" aria-hidden="true" />}{pct(d.labourPctBp)}</span>
                  <DayBadges date={d.date} r={r} today={today} />
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
function DayCells({ d, fmt }: { d: DayRow; fmt: Fmt }) {
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
    <td className={`num${d.profit < 0 ? ' danger-text' : ''}`}>{fmt.money(d.profit)}</td>
  </>;
}

function Ledger({ r, fmt, today }: { r: Report; fmt: Fmt; today: string }) {
  return (
    <section className="card" aria-labelledby="rp-ledger-h">
      <div className="card-head"><h2 id="rp-ledger-h">Daily ledger</h2></div>
      <div className="table-wrap">
        <table className="data" aria-labelledby="rp-ledger-h">
          <thead><tr>
            <th>Date</th><th className="num">Orders</th><th className="num">Gross</th><th className="num">Tax</th><th className="num">Service</th>
            <th className="num">Discounts</th><th className="num">Net sales</th><th className="num">Revenue</th><th className="num">Tips</th>
            <th className="num">Labour hours</th><th className="num">Labour cost</th><th className="num">Labour %</th><th className="num">Profit</th>
          </tr></thead>
          <tbody>{r.days.map((d) => (
            <tr key={d.date}>
              <td><span className="rp-cell">{fmt.day(d.date)}<DayBadges date={d.date} r={r} today={today} /></span></td>
              <DayCells d={d} fmt={fmt} />
            </tr>
          ))}</tbody>
          <tfoot><tr><td>Week total</td><DayCells d={r.totals} fmt={fmt} /></tr></tfoot>
        </table>
      </div>
    </section>
  );
}

function Payroll({ r, fmt }: { r: Report; fmt: Fmt }) {
  const sum = (k: 'shifts' | 'regularMinutes' | 'overtimeMinutes') => r.employees.reduce((a, e) => a + e[k], 0);
  return (
    <section className="card" aria-labelledby="rp-pay-h">
      <div className="card-head"><h2 id="rp-pay-h">Payroll</h2></div>
      {r.employees.length === 0 ? <p className="muted">No shifts this week.</p> : (
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
      {rows.length === 0 ? <p className="muted">No payments this week.</p> : (
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
