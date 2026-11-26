// Settings: per-device display, brand appearance, business profile, menu, floor plan, devices, security.
// Every section is gated by its permission; the tab is in the route (#/settings/menu).
import { useMemo, useReducer, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Armchair, Lock, MonitorCog, MonitorSmartphone, Palette, Plus, ShieldCheck, Store, UtensilsCrossed, X } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { useCan, useNeedsPassword } from '../../lib/session.ts';
import { go } from '../../lib/router.ts';
import { write } from '../../lib/sync.ts';
import { useFmt } from '../../lib/format.ts';
import { prefs, SCALES, setPref, WALL_SCALES, type Theme } from '../../lib/display.ts';
import { FoldToggle, openWithPassword, toast, useFold } from '../../ui/index.tsx';
import { startTour } from '../../ui/tour.tsx';
import { DEFAULT_SETTINGS, Settings as SettingsSchema, type DataOf } from '../../../shared/schema.ts';
import type { Permission } from '../../../shared/permissions.ts';
import type { ModuleProps } from '../index.ts';
import { Field, fieldErrors, useBusy } from './lib.tsx';
import { FloorPlan, Menu } from './catalog.tsx';
import { Devices, Security } from './account.tsx';
import Appearance from './Appearance.tsx';
import './settings.css';

const TABS: { id: string; label: string; hint: string; icon: typeof Store; perm?: Permission; C: () => ReactNode }[] = [
  { id: 'display', label: 'Display', hint: 'Theme and size for this device.', icon: MonitorCog, C: Display },
  { id: 'appearance', label: 'Appearance', hint: 'Brand look for every device in the venue.', icon: Palette, perm: 'settings.manage', C: Appearance },
  { id: 'business', label: 'Business', hint: 'Venue profile, tax, payments and rules.', icon: Store, perm: 'settings.manage', C: Business },
  { id: 'menu', label: 'Menu', hint: 'Categories, items and prices.', icon: UtensilsCrossed, perm: 'menu.manage', C: Menu },
  { id: 'floor', label: 'Floor plan', hint: 'Areas and tables.', icon: Armchair, perm: 'floor.manage', C: FloorPlan },
  { id: 'devices', label: 'Devices', hint: 'Terminals that can sync and take PIN sign-ins.', icon: MonitorSmartphone, perm: 'devices.manage', C: Devices },
  { id: 'security', label: 'Security', hint: 'Your password, two-factor sign-in and backups.', icon: ShieldCheck, C: Security },
];

export default function Settings({ params: [tab] }: ModuleProps) {
  const can = useCan();
  const needsPassword = useNeedsPassword();
  const tabs = TABS.filter((t) => !t.perm || can(t.perm));
  const locked = TABS.filter((t) => t.perm && !can(t.perm) && needsPassword(t.perm)); // e.g. Appearance for an owner on a PIN
  const cur = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  const [folded, fold] = useFold('settings');
  return (
    <div className="page settings">
      <div className="page-head"><div><h1>Settings</h1><p>{cur.hint}</p></div></div>
      <div className={`settings-body${folded ? ' folded' : ''}`}>
        <nav className="seg settings-tabs" aria-label="Settings sections">
          <FoldToggle folded={folded} onToggle={() => fold(!folded)} what="sections" className="" label />
          {tabs.map((t) => (
            <button key={t.id} type="button" data-tour={t.id} aria-pressed={t === cur} title={t.label} onClick={() => { go(`settings/${t.id}`); fold(true); }}>
              <t.icon aria-hidden="true" /> <span className="tab-label">{t.label}</span>
            </button>
          ))}
          {locked.map((t) => (
            <button key={t.id} type="button" className="locked" title={`${t.label} (needs your password)`} onClick={() => void openWithPassword(t.label, `settings/${t.id}`)} aria-label={`${t.label}, needs your password`}>
              <t.icon aria-hidden="true" /> <span className="tab-label">{t.label}</span> <Lock className="lock-inline" aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className="settings-pane"><cur.C /></div>
      </div>
    </div>
  );
}

// ---------- Display (per device) ----------
function Seg<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; name?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => <button key={o.value} type="button" aria-pressed={o.value === value} aria-label={o.name} onClick={() => onChange(o.value)}>{o.label}</button>)}
      </div>
    </div>
  );
}

const SIZE_NAMES: Record<string, string> = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large' };
const sizes = (list: typeof SCALES) => list.map((s) => ({ value: s.value, label: s.label, name: SIZE_NAMES[s.label] }));

function Display() {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const set = (k: 'theme' | 'scale' | 'wallScale', v: string | number) => { setPref(k, v); rerender(); };
  return (
    <section className="card stack lg" aria-label="Display">
      <p className="muted">These apply to this device only and change at once.</p>
      <Seg<Theme> label="Theme" value={prefs.theme()} onChange={(v) => set('theme', v)}
        options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Daylight' }, { value: 'system', label: 'System' }]} />
      <Seg label="Text and button size" value={prefs.scale()} options={sizes(SCALES)} onChange={(v) => set('scale', v)} />
      <Seg label="Kitchen display / TV size" value={prefs.wallScale()} options={sizes(WALL_SCALES)} onChange={(v) => set('wallScale', v)} />
    </section>
  );
}

// ---------- Business ----------
type S = DataOf<'settings'>;
/** Numeric fields are edited as text; value shown = stored / divisor (basis points -> %). */
const NUM = { taxRateBp: 100, serviceChargeBp: 100, overtimeWeeklyHours: 1, overtimeMultiplierPct: 1, lockAfterSec: 1, historyDays: 1 } as const;
type NumKey = keyof typeof NUM;
type Draft = Omit<S, NumKey> & Record<NumKey, string>;
const KEYS = Object.keys(SettingsSchema.shape) as (keyof S)[];

function toDraft(s: Partial<S> | undefined): Draft {
  const base = { ...DEFAULT_SETTINGS, ...s } as S;
  const d: Record<string, unknown> = Object.fromEntries(KEYS.map((k) => [k, base[k]]));
  for (const [k, div] of Object.entries(NUM)) d[k] = String(base[k as NumKey] / div);
  return d as Draft;
}
function fromDraft(d: Draft): unknown {
  const out: Record<string, unknown> = { ...d };
  for (const [k, div] of Object.entries(NUM)) {
    const t = d[k as NumKey].trim().replace(',', '.');
    const n = t === '' ? NaN : Number(t);
    out[k] = div === 1 ? n : Math.round(n * div);
  }
  return out;
}

const NICE: Record<string, string> = {
  name: 'Enter a name (up to 80 characters).',
  currency: 'Use a 3-letter currency code such as USD or EUR.',
  locale: 'Use a language tag such as en-US or fr-FR.',
  timezone: 'Pick a timezone.',
  taxRateBp: 'Enter 0–50%.', serviceChargeBp: 'Enter 0–50%.',
  overtimeWeeklyHours: 'Enter 0–168 hours.', overtimeMultiplierPct: 'Enter a whole number from 100 to 300.',
  lockAfterSec: 'Enter 15–3600 seconds.', historyDays: 'Enter 1–14 days.',
  paymentMethods: 'Keep 1–10 methods of up to 24 characters each.',
  receiptFooter: 'Up to 200 characters.',
};
const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'NZD', 'SGD', 'AED', 'JPY', 'CHF', 'ZAR', 'MXN', 'BRL'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function Business() {
  const saved = useLiveQuery(async () => (await table('settings').get('business')) ?? null, []);
  // undefined = still loading. Remount on every stored change so the draft always starts from the latest settings.
  return saved === undefined ? <div className="skeleton" style={{ height: '24rem' }} />
    : <BusinessForm key={saved?.updatedAt ?? 0} saved={saved ?? undefined} />;
}

function BusinessForm({ saved }: { saved: Partial<S> | undefined }) {
  const fmt = useFmt();
  const [d, setD] = useState(() => toDraft(saved));
  const [err, setErr] = useState<Record<string, string>>({});
  const [method, setMethod] = useState('');
  const [busy, run] = useBusy();
  const zones = useMemo(() => { const z = Intl.supportedValuesOf?.('timeZone') ?? []; return z.includes(d.timezone) ? z : [d.timezone, ...z]; }, [d.timezone]);
  const days = useMemo(() => {
    const f = new Intl.DateTimeFormat(fmt.locale, { weekday: 'long', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => f.format(Date.UTC(2023, 0, 1 + i))); // 1 Jan 2023 was a Sunday
  }, [fmt.locale]);
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(saved));

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const text = (k: { [K in keyof Draft]: Draft[K] extends string ? K : never }[keyof Draft]) => ({
    value: d[k], 'aria-invalid': !!err[k], onChange: (e: { target: { value: string } }) => set(k, e.target.value),
  });

  const addMethod = () => {
    const m = method.trim();
    if (!m) return;
    if (d.paymentMethods.some((x) => x.toLowerCase() === m.toLowerCase())) return toast(`${m} is already in the list.`, 'warning');
    set('paymentMethods', [...d.paymentMethods, m]);
    setMethod('');
  };
  const onMethodKey = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addMethod(); } };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const r = SettingsSchema.safeParse(fromDraft(d));
    const errors = fieldErrors(r, NICE);
    setErr(errors);
    if (!r.success) {
      toast('Check the highlighted fields.', 'error');
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.settings [aria-invalid="true"]')?.focus());
      return;
    }
    void run(async () => { await write('settings', { id: 'business', ...r.data }); toast('Settings saved', 'success'); });
  };

  return (
    <form className="stack lg" onSubmit={save} noValidate>
      <div className="banner">
        <span className="grow small">New here? The setup tour walks you through your brand, business details, menu, tables, team and devices.</span>
        <button type="button" className="btn outline sm" onClick={startTour}>Start setup tour</button>
      </div>
      <section className="card stack" aria-labelledby="b-venue">
        <h2 id="b-venue">Venue</h2>
        <div className="form-grid">
          <Field label="Business name" error={err.name}><input maxLength={80} {...text('name')} /></Field>
          <Field label="Currency" hint="Changing it does not convert existing prices." error={err.currency}>
            <input list="set-currencies" maxLength={3} autoCapitalize="characters" spellCheck={false} {...text('currency')}
              onChange={(e) => set('currency', e.target.value.toUpperCase())} />
            <datalist id="set-currencies">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Language / number format" hint="e.g. en-US, en-GB, fr-FR." error={err.locale}><input spellCheck={false} {...text('locale')} /></Field>
          <Field label="Timezone" error={err.timezone}>
            <select value={d.timezone} onChange={(e) => set('timezone', e.target.value)}>{zones.map((z) => <option key={z}>{z}</option>)}</select>
          </Field>
        </div>
      </section>

      <section className="card stack" aria-labelledby="b-tax">
        <h2 id="b-tax">Tax and service</h2>
        <div className="form-grid">
          <Field label="Tax rate (%)" error={err.taxRateBp}><input inputMode="decimal" className="num" {...text('taxRateBp')} /></Field>
          <Field label="Service charge (%)" hint="Added to the bill after discounts; 0 = none." error={err.serviceChargeBp}><input inputMode="decimal" className="num" {...text('serviceChargeBp')} /></Field>
        </div>
        <label className="switch"><input type="checkbox" checked={d.taxInclusive} onChange={(e) => set('taxInclusive', e.target.checked)} /> Menu prices already include tax</label>
      </section>

      <section className="card stack" aria-labelledby="b-day">
        <h2 id="b-day">Business day and week</h2>
        <div className="form-grid">
          <Field label="Business day starts at" hint="Sales and shifts before this hour count to the previous day.">
            <select value={d.dayStartHour} onChange={(e) => set('dayStartHour', Number(e.target.value))}>
              {HOURS.map((h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
            </select>
          </Field>
          <Field label="Week starts on" hint="Used for weekly reports and overtime.">
            <select value={d.weekStartsOn} onChange={(e) => set('weekStartsOn', Number(e.target.value))}>
              {days.map((name, i) => <option key={i} value={i}>{name}</option>)}
            </select>
          </Field>
          <Field label="Overtime after (hours per week)" hint="0 = no overtime." error={err.overtimeWeeklyHours}><input inputMode="decimal" className="num" {...text('overtimeWeeklyHours')} /></Field>
          <Field label="Overtime pay (%)" hint="150 = time and a half." error={err.overtimeMultiplierPct}><input inputMode="numeric" className="num" {...text('overtimeMultiplierPct')} /></Field>
        </div>
      </section>

      <section className="card stack" aria-labelledby="b-pay">
        <h2 id="b-pay">Payments and receipts</h2>
        <div className="field">
          <span id="b-methods">Payment methods</span>
          <div className="row" role="group" aria-labelledby="b-methods">
            {d.paymentMethods.map((m) => (
              <button key={m} type="button" className="chip" disabled={d.paymentMethods.length <= 1} aria-label={`Remove ${m}`}
                onClick={() => set('paymentMethods', d.paymentMethods.filter((x) => x !== m))}>{m} <X aria-hidden="true" className="inline-icon" /></button>
            ))}
          </div>
          {err.paymentMethods && <span className="error">{err.paymentMethods}</span>}
        </div>
        <div className="row nowrap" style={{ maxWidth: '28rem' }}>
          <input className="input" maxLength={24} placeholder="Add a method, e.g. Voucher" aria-label="New payment method" value={method}
            onChange={(e) => setMethod(e.target.value)} onKeyDown={onMethodKey} />
          <button type="button" className="btn outline" disabled={!method.trim() || d.paymentMethods.length >= 10} onClick={addMethod}><Plus aria-hidden="true" /> Add</button>
        </div>
        <Field label="Receipt footer" error={err.receiptFooter}>
          <textarea maxLength={200} value={d.receiptFooter} aria-invalid={!!err.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} />
        </Field>
      </section>

      <section className="card stack" aria-labelledby="b-sec">
        <h2 id="b-sec">Terminals and security</h2>
        <div className="form-grid">
          <Field label="Lock terminals after (seconds idle)" hint="PIN sessions only; 15–3600." error={err.lockAfterSec}><input inputMode="numeric" className="num" {...text('lockAfterSec')} /></Field>
          <Field label="Days of orders kept on terminals" hint="Older history stays on the server; 1–14." error={err.historyDays}><input inputMode="numeric" className="num" {...text('historyDays')} /></Field>
        </div>
        <label className="switch"><input type="checkbox" checked={d.require2faForFinance} onChange={(e) => set('require2faForFinance', e.target.checked)} /> Require two-factor sign-in for reports and payroll</label>
      </section>

      <div className="save-bar">
        <span className="muted small grow" aria-live="polite">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        <button type="button" className="btn ghost" disabled={!dirty || busy} onClick={() => { setD(toDraft(saved)); setErr({}); }}>Undo</button>
        <button className="btn primary" disabled={!dirty || busy}>Save</button>
      </div>
    </form>
  );
}
