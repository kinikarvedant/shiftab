// Bookings: a day's reservations as a list or a table timeline; create/edit with clash warning; seat → open order.
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarClock, CalendarX, ChartGantt, ChevronLeft, ChevronRight, CircleCheck, CircleX, List, Plus, RotateCcw, Search, TriangleAlert, UserX, Users } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { write } from '../../lib/sync.ts';
import { go } from '../../lib/router.ts';
import { errorText } from '../../lib/api.ts';
import { useCan } from '../../lib/session.ts';
import { useFmt, useNow, uuid } from '../../lib/format.ts';
import { Dialog, Empty, confirmBox, toast } from '../../ui/index.tsx';
import { openOrder } from '../order/lib.ts';
import { addDays, localDate, localTime, zonedTime } from '../../../shared/time.ts';
import { Reservation, type ReservationDoc, type TableDoc } from '../../../shared/schema.ts';
import type { ModuleProps } from '../index.ts';
import './reservations.css';

type Res = Omit<ReservationDoc, 'updatedAt' | 'updatedBy'>;
type Status = Res['status'];
interface Group { name: string; tables: TableDoc[] }

const STATUS: Record<Status, { label: string; tone: string; icon: typeof Users }> = {
  booked: { label: 'Booked', tone: 'info', icon: CalendarClock },
  seated: { label: 'Seated', tone: 'accent', icon: Users },
  completed: { label: 'Completed', tone: 'success', icon: CircleCheck },
  no_show: { label: 'No-show', tone: 'warning', icon: UserX },
  cancelled: { label: 'Cancelled', tone: 'danger', icon: CircleX },
};
/** Where each status can go next; the first is the quick action in the list. */
const NEXT: Record<Status, Status[]> = { booked: ['seated', 'no_show', 'cancelled'], seated: ['completed', 'booked'], completed: ['booked'], no_show: ['booked'], cancelled: ['booked'] };
const ACTION: Record<Status, { label: string; cls: string; icon: typeof Users }> = {
  seated: { label: 'Seat', cls: 'primary', icon: Users },
  completed: { label: 'Complete', cls: 'success', icon: CircleCheck },
  no_show: { label: 'No-show', cls: 'outline', icon: UserX },
  cancelled: { label: 'Cancel', cls: 'danger', icon: CircleX },
  booked: { label: 'Reopen', cls: 'outline', icon: RotateCcw },
};
const DURATIONS = [30, 60, 90, 120, 150, 180, 210, 240];
const ALLERGY = /(\b(?:allerg\w*|anaphyla\w*|epi-?pen|gluten|coeliac|celiac|(?:pea|tree ?)?nuts?|dairy|lactose|shellfish|sesame|soy|eggs?)\b)/i;
const gone = (s: Status) => s === 'cancelled' || s === 'no_show';
const holdsTable = (s: Status) => s === 'booked' || s === 'seated';
const covers = (rs: Res[]) => rs.reduce((a, r) => a + (gone(r.status) ? 0 : r.partySize), 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const wallMin = (ts: number, tz: string) => { const [h, m] = localTime(ts, tz).split(':').map(Number); return h * 60 + m; };
const vars = (v: Record<string, number>) => v as CSSProperties;

/** Validates against the shared schema and writes exactly its fields. */
const save = ({ id, name, phone, partySize, start, durationMin, tableId, status, notes }: Res) =>
  write('reservations', { id, ...Reservation.parse({ name, phone, partySize, start, durationMin, tableId, status, notes }) });

let busy = false; // one status change at a time: a double-tap on Seat must not open two orders
function useSetStatus() {
  const fmt = useFmt();
  const can = useCan();
  return async (r: Res, to: Status) => {
    if (busy) return false;
    busy = true;
    try {
      if (to === 'cancelled' && !(await confirmBox({ title: 'Cancel this booking?', message: `${r.name}, ${r.partySize} at ${fmt.time(r.start)} on ${fmt.date(r.start)}. You can reopen it later.`, confirm: 'Cancel booking', danger: true }))) return false;
      await save({ ...r, status: to });
      if (to === 'seated' && r.tableId && can('pos.use')) go(`order/${await openOrder({ tableId: r.tableId, type: 'dine_in', guests: r.partySize })}`);
      else toast(`${r.name}: ${STATUS[to].label}`, 'success', { label: 'Undo', run: () => save(r).catch((e) => toast(errorText(e), 'error')) });
      return true;
    } catch (e) { toast(errorText(e), 'error'); return false; } finally { busy = false; }
  };
}

export default function Reservations(_: ModuleProps) {
  const fmt = useFmt();
  const now = useNow(60_000);
  const today = localDate(now, fmt.tz);
  const [picked, setPicked] = useState<string>();
  const date = picked ?? today;
  const [view, setView] = useState(() => (matchMedia('(min-width: 48em)').matches ? 'timeline' : 'list'));
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Res | 'new' | null>(null);
  const setStatus = useSetStatus();

  const floor = useLiveQuery(async () => {
    const [areas, tables] = await Promise.all([table('areas').toArray(), table('tables').toArray()]);
    areas.sort((a, b) => a.sort - b.sort);
    tables.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true }));
    const known = new Set(areas.map((a) => a.id));
    const groups: Group[] = [...areas.map((a) => ({ name: a.name, tables: tables.filter((t) => t.areaId === a.id) })),
      { name: 'Other', tables: tables.filter((t) => !known.has(t.areaId)) }].filter((g) => g.tables.length);
    return { groups, tables: groups.flatMap((g) => g.tables) };
  }, []);
  const from = zonedTime(date, '00:00', fmt.tz), to = zonedTime(addDays(date, 1), '00:00', fmt.tz);
  const day = useLiveQuery(() => table('reservations').where('start').between(from, to, true, false).sortBy('start'), [from, to]);

  const needle = q.trim().toLowerCase(), digits = needle.replace(/\D/g, '');
  const shown = (day ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle) || (!!digits && r.phone.replace(/\D/g, '').includes(digits)));
  const live = (day ?? []).filter((r) => !gone(r.status)).length;
  const close = (d?: string) => { setEditing(null); if (d) setPicked(d); };
  const add = <button className="btn primary lg" onClick={() => setEditing('new')}><Plus aria-hidden="true" /> New booking</button>;

  return (
    <div className="page res">
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <p className="small">{fmt.day(date)}{date === today && ' (today)'} · <strong>{plural(live, 'booking')}</strong> · <strong>{plural(covers(day ?? []), 'cover')}</strong></p>
        </div>
        {add}
      </div>

      <div className="row res-bar">
        <div className="row res-day">
          <button className="btn icon" onClick={() => setPicked(addDays(date, -1))} aria-label="Previous day"><ChevronLeft /></button>
          <button className="btn" onClick={() => setPicked(undefined)}>Today</button>
          <button className="btn icon" onClick={() => setPicked(addDays(date, 1))} aria-label="Next day"><ChevronRight /></button>
          <input className="input res-date" type="date" value={date} onChange={(e) => e.target.value && setPicked(e.target.value)} aria-label="Date" />
        </div>
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}><List aria-hidden="true" /> List</button>
          <button aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}><ChartGantt aria-hidden="true" /> Timeline</button>
        </div>
        <input className="input res-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" aria-label="Search bookings by name or phone" />
      </div>

      {!day || !floor ? <div className="skeleton" style={{ height: '12rem' }} />
        : !day.length ? <Empty icon={<CalendarX />} title={`No bookings for ${fmt.day(date)}`}>{add}</Empty>
        : !shown.length ? <Empty icon={<Search />} title="No matches">Nothing on this day matches “{q.trim()}”.</Empty>
        : view === 'list' ? <DayList items={shown} date={date} tables={floor.tables} onEdit={setEditing} onStatus={(r, s) => void setStatus(r, s)} />
        : <Timeline key={date} items={shown} date={date} groups={floor.groups} now={now} onEdit={setEditing} />}

      {editing && floor && <Edit r={editing === 'new' ? null : editing} date={date} groups={floor.groups} tables={floor.tables} onClose={close} />}
    </div>
  );
}

function Pill({ s }: { s: Status }) {
  const S = STATUS[s];
  return <span className={`pill ${S.tone}`}><S.icon aria-hidden="true" />{S.label}</span>;
}

function ActionButton({ to, onPick }: { to: Status; onPick: (to: Status) => void }) {
  const A = ACTION[to];
  return <button type="button" className={`btn ${A.cls}`} onClick={() => onPick(to)}><A.icon aria-hidden="true" />{A.label}</button>;
}

function Notes({ text }: { text: string }) {
  const parts = text.split(ALLERGY); // odd indices are the allergy words
  return (
    <span className="res-notes">
      {parts.length > 1 && <><TriangleAlert className="warning-text" aria-hidden="true" /><span className="sr-only">Allergy: </span></>}
      {parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}
    </span>
  );
}

function DayList({ items, date, tables, onEdit, onStatus }: { items: Res[]; date: string; tables: TableDoc[]; onEdit: (r: Res) => void; onStatus: (r: Res, s: Status) => void }) {
  const fmt = useFmt();
  const byId = new Map(tables.map((t) => [t.id, t]));
  const slots = new Map<string, Res[]>(); // half-hour slots; items arrive sorted by start
  for (const r of items) {
    const t = localTime(r.start, fmt.tz), k = `${t.slice(0, 2)}:${+t.slice(3) < 30 ? '00' : '30'}`;
    slots.set(k, [...(slots.get(k) ?? []), r]);
  }
  return (
    <div className="res-list">
      {[...slots].map(([k, rs]) => (
        <section key={k} aria-labelledby={`slot-${k}`}>
          <h2 className="res-slot" id={`slot-${k}`}>{fmt.time(zonedTime(date, k, fmt.tz))} <span className="muted small">{plural(rs.length, 'booking')} · {plural(covers(rs), 'cover')}</span></h2>
          <ul>
            {rs.map((r) => {
              const t = r.tableId ? byId.get(r.tableId) : undefined;
              return (
                <li key={r.id} className={`res-item ${r.status}`}>
                  <time className="res-time">{fmt.time(r.start)}</time>
                  <span className="res-party"><Users aria-hidden="true" />{r.partySize}<span className="sr-only"> guests</span></span>
                  <button className="res-who" onClick={() => onEdit(r)}>
                    <span className="sr-only">Edit booking: </span><span className="strong">{r.name}</span>
                    {r.phone && <span className="muted small">{r.phone}</span>}
                  </button>
                  <span className="res-table">
                    {t ? <>{t.name} <span className="muted xs">· {t.seats}</span></> : <span className="muted">No table</span>}
                    {t && r.partySize > t.seats && <><TriangleAlert className="warning-text" aria-hidden="true" /><span className="sr-only">Party larger than table</span></>}
                  </span>
                  {r.notes && <Notes text={r.notes} />}
                  <Pill s={r.status} />
                  <span className="res-act"><ActionButton to={NEXT[r.status][0]} onPick={(s) => onStatus(r, s)} /></span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function lanes(rs: Res[]) { // stack overlapping bookings in one row
  const ends: number[] = [];
  const placed = rs.map((r) => {
    let lane = ends.findIndex((e) => e <= r.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = r.start + r.durationMin * 60_000;
    return { r, lane };
  });
  return { placed, n: Math.max(1, ends.length) };
}

function Timeline({ items, date, groups, now, onEdit }: { items: Res[]; date: string; groups: Group[]; now: number; onEdit: (r: Res) => void }) {
  const fmt = useFmt();
  const ref = useRef<HTMLDivElement>(null);
  const shown = items.filter((r) => !gone(r.status));
  const from = Math.min(600, ...shown.map((r) => Math.floor(wallMin(r.start, fmt.tz) / 60) * 60)); // 10:00 or earlier
  const to = Math.min(1800, Math.max(1440, ...shown.map((r) => Math.ceil((wallMin(r.start, fmt.tz) + r.durationMin) / 60) * 60)));
  const nowMin = date === localDate(now, fmt.tz) ? wallMin(now, fmt.tz) : -1;
  const nowAt = nowMin >= from && nowMin <= to ? (nowMin - from) / 30 : null;
  const known = new Set(groups.flatMap((g) => g.tables.map((t) => t.id)));
  const hours: number[] = [];
  for (let m = from; m < to; m += 60) hours.push(m);

  useEffect(() => { // bring "now" (or the first booking) into view
    const el = ref.current, t = el?.querySelector('.tl-now, .tl-bar');
    if (el && t) el.scrollLeft += t.getBoundingClientRect().left - el.getBoundingClientRect().left - el.clientWidth / 3;
  }, []);

  const row = (key: string, label: ReactNode, rs: Res[]) => {
    const { placed, n } = lanes(rs);
    return (
      <div className="tl-row" key={key}>
        <div className="tl-label">{label}</div>
        <div className="tl-track" style={vars({ '--lanes': n })}>
          {placed.map(({ r, lane }) => {
            const S = STATUS[r.status], start = wallMin(r.start, fmt.tz);
            return (
              <button key={r.id} className={`tl-bar ${r.status}`} onClick={() => onEdit(r)}
                style={vars({ '--l': (start - from) / 30, '--w': Math.min(r.durationMin, to - start) / 30, '--lane': lane })}
                aria-label={`${r.name}, ${r.partySize} guests, ${fmt.time(r.start)} to ${fmt.time(r.start + r.durationMin * 60_000)}, ${S.label}. Edit`}>
                <span className="ellipsis strong">{r.name} · {r.partySize}</span>
                <span className="ellipsis xs"><S.icon aria-hidden="true" /> {S.label} · {fmt.time(r.start)}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="tl-wrap" ref={ref} tabIndex={0} role="region" aria-label={`Timeline for ${fmt.day(date)}`}>
      <div className={`tl${nowAt === null ? '' : ' has-now'}`} style={vars({ '--slots': (to - from) / 30, '--now': nowAt ?? 0 })}>
        <div className="tl-row tl-head" aria-hidden="true">
          <div className="tl-label muted small">Table</div>
          <div className="tl-track">
            {hours.map((m) => <span key={m} className="tl-hour" style={vars({ '--l': (m - from) / 30 })}>{fmt.time(zonedTime(date, `${m / 60}:00`, fmt.tz))}</span>)}
            {nowAt !== null && <span className="tl-now" style={vars({ '--l': nowAt })}>Now</span>}
          </div>
        </div>
        {groups.map((g) => (
          <div key={g.name} role="group" aria-label={g.name}>
            {groups.length > 1 && <div className="tl-area"><span>{g.name}</span></div>}
            {g.tables.map((t) => row(t.id, <><span className="strong">{t.name}</span><span className="muted xs">{t.seats} seats</span></>, shown.filter((r) => r.tableId === t.id)))}
          </div>
        ))}
        {row('none', <span className="muted small">Unassigned</span>, shown.filter((r) => !r.tableId || !known.has(r.tableId)))}
      </div>
    </div>
  );
}

function Edit({ r, date, groups, tables, onClose }: { r: Res | null; date: string; groups: Group[]; tables: TableDoc[]; onClose: (date?: string) => void }) {
  const fmt = useFmt();
  const setStatus = useSetStatus();
  const [f, setF] = useState(() => ({
    name: r?.name ?? '', phone: r?.phone ?? '', party: String(r?.partySize ?? 2),
    date: r ? localDate(r.start, fmt.tz) : date, time: r ? localTime(r.start, fmt.tz) : '19:00',
    duration: String(r?.durationMin ?? 90), notes: r?.notes ?? '',
    tableId: tables.find((t) => t.id === r?.tableId)?.id ?? '', // a deleted table reads as "no table"
  }));
  const [tried, setTried] = useState(false);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const party = Number(f.party), dur = Number(f.duration), status = r?.status ?? 'booked';
  const start = f.date && f.time ? zonedTime(f.date, f.time, fmt.tz) : NaN;
  const end = start + dur * 60_000;
  const tbl = tables.find((t) => t.id === f.tableId);
  const others = useLiveQuery(() => table('reservations').where('tableId').equals(f.tableId).toArray(), [f.tableId]);
  const clash = holdsTable(status) && Number.isFinite(start)
    ? others?.find((o) => o.id !== r?.id && holdsTable(o.status) && o.start < end && start < o.start + o.durationMin * 60_000) : undefined;
  const errors = {
    name: f.name.trim() ? '' : 'Enter the guest’s name.',
    party: Number.isInteger(party) && party >= 1 && party <= 200 ? '' : 'Party size must be 1–200.',
    when: Number.isFinite(start) ? '' : 'Pick a date and time.',
  };
  const err = (k: keyof typeof errors) => (tried && errors[k] ? errors[k] : '');
  const durations = [...new Set([...DURATIONS, dur])].sort((a, b) => a - b);

  async function submit(to?: Status) {
    setTried(true);
    if (Object.values(errors).some(Boolean)) return;
    const doc: Res = { id: r?.id ?? uuid(), name: f.name.trim(), phone: f.phone.trim(), partySize: party, start, durationMin: dur, tableId: f.tableId || null, status, notes: f.notes.trim() };
    if (to) { if (await setStatus(doc, to)) onClose(); return; }
    try {
      await save(doc);
      toast(`${r ? 'Booking updated' : 'Booking added'} for ${fmt.dateTime(start)}`, 'success');
      onClose(f.date);
    } catch (e) { toast(errorText(e), 'error'); }
  }

  return (
    <Dialog open onClose={onClose} wide title={r ? 'Edit booking' : 'New booking'}
      footer={<>
        <button className="btn ghost" onClick={() => onClose()}>Close</button>
        <button className="btn primary" type="submit" form="res-form">{r ? 'Save changes' : 'Add booking'}</button>
      </>}>
      {r && (
        <div className="row">
          <Pill s={r.status} />
          <span className="spacer" />
          {NEXT[r.status].map((to) => <ActionButton key={to} to={to} onPick={(s) => void submit(s)} />)}
        </div>
      )}
      <form id="res-form" className="form-grid res-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field">
          <span>Name</span>
          <input value={f.name} onChange={set('name')} maxLength={80} required autoFocus={!r} autoComplete="off" aria-invalid={!!err('name')} aria-describedby="res-name-err" />
          {err('name') && <small className="error" id="res-name-err">{err('name')}</small>}
        </label>
        <label className="field">
          <span>Phone</span>
          <input type="tel" value={f.phone} onChange={set('phone')} maxLength={32} autoComplete="off" />
        </label>
        <label className="field">
          <span>Party size</span>
          <input type="number" inputMode="numeric" min={1} max={200} value={f.party} onChange={set('party')} required aria-invalid={!!err('party')} aria-describedby="res-party-err" />
          {err('party') && <small className="error" id="res-party-err">{err('party')}</small>}
        </label>
        <label className="field">
          <span>Date</span>
          <input type="date" value={f.date} onChange={set('date')} required aria-invalid={!!err('when')} aria-describedby="res-when-err" />
        </label>
        <label className="field">
          <span>Time</span>
          <input type="time" step={900} value={f.time} onChange={set('time')} required aria-invalid={!!err('when')} aria-describedby="res-when-err" />
          {err('when') && <small className="error" id="res-when-err">{err('when')}</small>}
        </label>
        <label className="field">
          <span>Duration</span>
          <select value={f.duration} onChange={set('duration')}>{durations.map((m) => <option key={m} value={m}>{m} min</option>)}</select>
        </label>
        <label className="field">
          <span>Table</span>
          <select value={f.tableId} onChange={set('tableId')} aria-describedby="res-seats">
            <option value="">No table yet</option>
            {groups.map((g) => <optgroup key={g.name} label={g.name}>{g.tables.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.seats} seats</option>)}</optgroup>)}
          </select>
          {tbl && party > tbl.seats && <small className="warning-text" id="res-seats"><TriangleAlert aria-hidden="true" /> Party of {party} is more than the {tbl.seats} seats at {tbl.name}.</small>}
        </label>
        {clash && (
          <div className="banner warning res-full" role="alert">
            <TriangleAlert aria-hidden="true" />
            <div>Clashes with <strong>{clash.name}</strong> ({clash.partySize}) on table {tbl?.name}, {fmt.time(clash.start)}–{fmt.time(clash.start + clash.durationMin * 60_000)}. You can still save.</div>
          </div>
        )}
        <label className="field res-full">
          <span>Notes</span>
          <textarea value={f.notes} onChange={set('notes')} maxLength={500} placeholder="Allergies, occasion, high chair…" />
        </label>
      </form>
    </Dialog>
  );
}
