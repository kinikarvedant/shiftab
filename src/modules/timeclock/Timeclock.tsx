// Time clock: your own punches and hours; with timeclock.manage, who's on now and the weekly timesheet.
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, ChevronLeft, ChevronRight, Clock, Coffee, Download, Lock, LogIn, LogOut, Play, Plus, RotateCcw, Trash2, Users } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { remove, write } from '../../lib/sync.ts';
import { useApp, useCan } from '../../lib/session.ts';
import { api, ApiError, errorText } from '../../lib/api.ts';
import { elapsedText, hoursText, useFmt, useNow, uuid } from '../../lib/format.ts';
import { Avatar, Dialog, Empty, confirmBox, toast } from '../../ui/index.tsx';
import { outranks } from '../../../shared/permissions.ts';
import { addDays, businessDay, dateRange, localDate, localTime, weekStart } from '../../../shared/time.ts';
import type { ShiftDoc, UserDoc } from '../../../shared/schema.ts';
import type { ModuleProps } from '../index.ts';
import { byUserDay, endBreak, flagOf, shiftMinutes, shiftTimes, sumMinutes, toCsv } from './lib.ts';
import './timeclock.css';

type Fmt = ReturnType<typeof useFmt>;
const DAY = 86_400_000;
const FLAG = {
  stale: { cls: 'danger', label: 'No clock-out', icon: AlertTriangle },
  long: { cls: 'warning', label: 'Over 12h', icon: AlertTriangle },
  open: { cls: 'success', label: 'On shift', icon: Clock },
} as const;

/** "17:00", or "02:00 +1" when the shift ends on a later calendar day. */
const outText = (fmt: Fmt, s: ShiftDoc) =>
  s.clockOut == null ? '—' : fmt.time(s.clockOut) + (localDate(s.clockOut, fmt.tz) !== localDate(s.clockIn, fmt.tz) ? ' +1' : '');

function FlagPill({ s, now }: { s: ShiftDoc; now: number }) {
  const f = flagOf(s, now);
  if (!f) return null;
  const F = FLAG[f];
  return <span className={`pill ${F.cls}`}><F.icon aria-hidden="true" />{F.label}</span>;
}

export default function Timeclock(_: ModuleProps) {
  const can = useCan();
  const manage = can('timeclock.manage');
  const [tab, setTab] = useState<'me' | 'team'>('me');
  const team = manage && tab === 'team';
  return (
    <div className="page timeclock">
      <div className="page-head">
        <div><h1>Time</h1><p>{team ? "Who's on now and the weekly timesheet." : 'Your shifts and hours.'}</p></div>
        {manage && (
          <div className="seg" role="group" aria-label="View">
            <button aria-pressed={!team} onClick={() => setTab('me')}>My time</button>
            <button aria-pressed={team} onClick={() => setTab('team')}>Team</button>
          </div>
        )}
      </div>
      {team ? <Team /> : <MyTime canPunch={can('timeclock.self')} />}
    </div>
  );
}

// ---------- My time ----------
function MyTime({ canPunch }: { canPunch: boolean }) {
  const fmt = useFmt();
  const now = useNow(15_000);
  const me = useApp().session!.user;
  const mine = useLiveQuery(() => table('shifts').where('userId').equals(me.id).toArray(), [me.id]);
  const [busy, setBusy] = useState(false);
  if (!mine) return <div className="skeleton" style={{ height: '12rem' }} />;

  const day = (t: number) => businessDay(t, fmt.tz, fmt.settings?.dayStartHour ?? 4);
  const week = weekStart(fmt.today(), fmt.settings?.weekStartsOn ?? 1);
  const open = mine.find((s) => s.clockOut == null);
  const recent = mine.filter((s) => s.clockOut == null || s.clockIn >= now - 14 * DAY).sort((a, b) => b.clockIn - a.clockIn);
  const weekMin = sumMinutes(mine.filter((s) => day(s.clockIn) >= week), now);

  async function punch() {
    setBusy(true);
    try {
      if (open) {
        const t = Date.now();
        await write('shifts', { ...endBreak(open, t), clockOut: t });
        toast(`Clocked out · ${elapsedText(Date.now() - open.clockIn)} on shift`, 'success');
      } else {
        await write('shifts', { id: uuid(), userId: me.id, clockIn: Date.now(), clockOut: null, breakMin: 0, note: '' });
        toast(`Clocked in at ${fmt.time(Date.now())}`, 'success');
      }
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  }

  async function toggleBreak() {
    if (!open) return;
    setBusy(true);
    try {
      const t = Date.now();
      if (open.breakStart) { await write('shifts', endBreak(open, t)); toast(`Back from a ${elapsedText(t - open.breakStart)} break`, 'success'); }
      else { await write('shifts', { ...open, breakStart: t }); toast("On a break. Breaks aren't paid time.", 'success'); }
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  }

  return (
    <div className="stack lg">
      <section className={`card pad-lg tc-status${open ? (open.breakStart ? ' break' : ' on') : ''}`} aria-label="Clock status">
        <div className="stack sm">
          <span className="row nowrap strong">
            {open ? (open.breakStart
              ? <><Coffee aria-hidden="true" /> On a break since {fmt.time(open.breakStart)}</>
              : <><Clock aria-hidden="true" /> On shift since {fmt.time(open.clockIn)}{day(open.clockIn) !== fmt.today() ? `, ${fmt.date(open.clockIn)}` : ''}</>) : "You're not clocked in"}
          </span>
          {open && <span className="tc-elapsed">{elapsedText(now - (open.breakStart ?? open.clockIn))}</span>}
          {open && open.breakMin > 0 && <span className="small muted">Breaks so far: {open.breakMin} min (not paid)</span>}
          {!canPunch && <span className="small muted">Your group doesn't use the time clock.</span>}
        </div>
        {canPunch && open && (open.breakStart
          ? <button className="btn xl success" disabled={busy} onClick={toggleBreak}><Play /> End break</button>
          : <button className="btn xl outline" disabled={busy} onClick={toggleBreak}><Coffee /> Start break</button>)}
        {canPunch && (open
          ? <button className="btn xl danger solid" disabled={busy} onClick={punch}><LogOut /> Clock out</button>
          : <button className="btn xl success" disabled={busy} onClick={punch}><LogIn /> Clock in</button>)}
      </section>
      {open && flagOf(open, now) === 'stale' && (
        <div className="banner warning"><AlertTriangle /> <span className="grow">Forgot to clock out? Clock out now and ask a manager to correct the time.</span></div>
      )}

      <div className="grid-auto">
        <div className="card kpi"><div className="label">This week · from {fmt.day(week)}</div><div className="value">{hoursText(weekMin)}</div></div>
        <div className="card kpi"><div className="label">Last 14 days · {recent.length} shift{recent.length === 1 ? '' : 's'}</div><div className="value">{hoursText(sumMinutes(recent, now))}</div></div>
      </div>

      <section className="stack">
        <h2>My shifts · last 14 days</h2>
        {recent.length === 0 ? (
          <Empty icon={<Clock />} title="No shifts yet">When you clock in, your shifts and hours show up here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Day</th><th>In</th><th>Out</th><th className="num">Break</th><th className="num">Hours</th><th>Notes</th></tr></thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={s.id}>
                    <td>{fmt.day(day(s.clockIn))}</td>
                    <td>{fmt.time(s.clockIn)}</td>
                    <td>{outText(fmt, s)}</td>
                    <td className="num">{s.breakStart ? `${s.breakMin ? `${s.breakMin}m + ` : ''}on break` : s.breakMin ? `${s.breakMin}m` : '—'}</td>
                    <td className="num">{hoursText(shiftMinutes(s, now))}</td>
                    <td><span className="row nowrap"><FlagPill s={s} now={now} />{s.note && <span className="small muted">{s.note}</span>}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- Team ----------
interface Draft { shift?: ShiftDoc; userId: string; date: string }

function Team() {
  const fmt = useFmt();
  const now = useNow(30_000);
  const session = useApp().session!;
  const me = session.user;
  const level = session.level;
  const today = fmt.today();
  const [back, setBack] = useState(0); // weeks before this one
  const week = addDays(weekStart(today, fmt.settings?.weekStartsOn ?? 1), -7 * back);
  const days = dateRange(week, addDays(week, 6));
  const local = week >= addDays(today, -13); // terminals keep 14 days of shifts
  const [remote, setRemote] = useState<{ week: string; shifts?: ShiftDoc[]; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [edit, setEdit] = useState<Draft | null>(null);
  const data = useLiveQuery(async () => {
    const [users, groups, shifts] = await Promise.all([table('users').toArray(), table('groups').toArray(), table('shifts').toArray()]);
    return { users: users.sort((a, b) => a.name.localeCompare(b.name)), groups, shifts };
  }, []);

  useEffect(() => {
    if (local) return;
    if (level !== 'password') {
      setRemote({ week, error: 'Weeks older than 14 days are kept on the server. Sign in with your password to see them.' });
      return;
    }
    let live = true;
    setRemote(null);
    api<{ shifts: ShiftDoc[] }>('GET', `/api/attendance?from=${week}&to=${addDays(week, 6)}`).then(
      (r) => { if (live) setRemote({ week, shifts: r.shifts }); },
      (e) => { if (live) setRemote({ week, error: e instanceof ApiError && e.status === 0 ? "You're offline — weeks older than 14 days need a connection." : errorText(e) }); },
    );
    return () => { live = false; };
  }, [week, local, level, retry]);

  if (!data) return <div className="skeleton" style={{ height: '12rem' }} />;

  const mine = data.groups.find((g) => g.id === me.groupId);
  const groupOf = (u: UserDoc) => data.groups.find((g) => g.id === u.groupId);
  const userOf = (id: string) => data.users.find((u) => u.id === id);
  /** null = editable, else the reason it's read-only (server: timeclock.manage + strictly higher rank). */
  const why = (u: UserDoc): string | null => {
    const g = groupOf(u);
    if (level === 'vault') return 'Offline sign-in is read-only. Reconnect to make changes.';
    if (u.id === me.id) return 'This is your own timesheet. Ask someone senior to correct it.';
    return mine && g && outranks(mine, g) ? null : `${u.name} is ranked at or above you, so their timesheet is read-only.`;
  };

  const shifts = local ? data.shifts : remote?.week === week ? remote.shifts : undefined;
  const error = !local && remote?.week === week ? remote.error : undefined;
  const grid = shifts && byUserDay(shifts, days, fmt.tz, fmt.settings?.dayStartHour ?? 4);
  const rows = grid ? data.users
    .filter((u) => grid.has(u.id) || (u.active && !!groupOf(u)?.permissions.includes('timeclock.self')))
    .map((u) => {
      const cells = grid.get(u.id);
      const mins = days.map((d) => sumMinutes(cells?.get(d) ?? [], now));
      return { u, cells, mins, total: mins.reduce((a, m) => a + m, 0) };
    }) : [];
  const dayTotals = days.map((_, i) => rows.reduce((a, r) => a + r.mins[i], 0));
  const weekTotal = dayTotals.reduce((a, m) => a + m, 0);
  const flagged = rows.flatMap((r) => [...(r.cells?.values() ?? [])].flat()).filter((s) => ['stale', 'long'].includes(flagOf(s, now) ?? '')).length;
  const onNow = data.shifts.filter((s) => s.clockOut == null).sort((a, b) => a.clockIn - b.clockIn);
  const canAdd = !!shifts && data.users.some((u) => u.active && !why(u));

  const saved = (doc: ShiftDoc | null, id: string) => {
    if (!local) setRemote((r) => (r?.shifts ? { ...r, shifts: [...r.shifts.filter((s) => s.id !== id), ...(doc ? [doc] : [])] } : r));
  };

  function exportCsv() {
    const hrs = (m: number) => (m / 60).toFixed(2);
    const text = toCsv([
      ['Employee', 'Group', ...days, 'Total hours'],
      ...rows.map((r) => [r.u.name, groupOf(r.u)?.name ?? '', ...r.mins.map(hrs), hrs(r.total)]),
      ['Total', '', ...dayTotals.map(hrs), hrs(weekTotal)],
    ]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `timesheet-${week}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1_000);
  }

  const shiftButton = (s: ShiftDoc, u: UserDoc) => {
    const f = flagOf(s, now);
    const F = f ? FLAG[f] : null;
    const range = `${fmt.time(s.clockIn)}–${s.clockOut == null ? '…' : outText(fmt, s)}`;
    return (
      <button key={s.id} className={`tc-shift ${f ?? ''}`} onClick={() => setEdit({ shift: s, userId: u.id, date: localDate(s.clockIn, fmt.tz) })}
        aria-label={`${u.name}, ${range}, ${hoursText(shiftMinutes(s, now))}${F ? `, ${F.label}` : ''}`}>
        <span className="strong num">{hoursText(shiftMinutes(s, now))}</span>
        <span className="t num">{range}</span>
        {F && <span className={`t ${F.cls}-text`}><F.icon aria-hidden="true" /> {F.label}</span>}
      </button>
    );
  };

  return (
    <div className="stack lg">
      <section className="stack" aria-labelledby="tc-now">
        <h2 id="tc-now">On now <span className="muted">· {onNow.length}</span></h2>
        {onNow.length === 0 ? <p className="muted">Nobody is clocked in.</p> : (
          <ul className="tc-now">
            {onNow.map((s) => {
              const u = userOf(s.userId);
              return u && (
                <li key={s.id}>
                  <button className="tc-who" onClick={() => setEdit({ shift: s, userId: u.id, date: localDate(s.clockIn, fmt.tz) })}>
                    <Avatar user={u} size="sm" />
                    <span className="strong ellipsis">{u.name}</span>
                    <span className="muted num">{elapsedText(now - s.clockIn)}</span>
                    {flagOf(s, now) === 'stale' && <span className="pill danger"><AlertTriangle aria-hidden="true" />12h+</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="stack" aria-labelledby="tc-week">
        <div className="row between">
          <div className="row nowrap">
            <button className="btn outline icon" aria-label="Previous week" onClick={() => setBack((b) => b + 1)}><ChevronLeft /></button>
            <div>
              <h2 id="tc-week">{fmt.day(week)} – {fmt.day(addDays(week, 6))}</h2>
              <span className="small muted">{back === 0 ? 'This week' : back === 1 ? 'Last week' : `${back} weeks ago`}{local ? '' : ' · from the server'}</span>
            </div>
            <button className="btn outline icon" aria-label="Next week" disabled={back === 0} onClick={() => setBack((b) => b - 1)}><ChevronRight /></button>
          </div>
          <div className="row">
            <button className="btn outline" disabled={!grid || rows.length === 0} onClick={exportCsv}><Download /> Export CSV</button>
            <button className="btn primary" disabled={!canAdd} onClick={() => setEdit({ userId: '', date: days.includes(today) ? today : week })}><Plus /> Add shift</button>
          </div>
        </div>

        {error && (
          <div className="banner warning"><AlertTriangle /> <span className="grow">{error}</span>
            {level === 'password' && <button className="btn outline" onClick={() => setRetry((n) => n + 1)}><RotateCcw /> Retry</button>}
          </div>
        )}
        {flagged > 0 && (
          <div className="banner warning"><AlertTriangle /> <span className="grow">{flagged} shift{flagged === 1 ? '' : 's'} this week need{flagged === 1 ? 's' : ''} a look: no clock-out, or over 12 hours.</span></div>
        )}

        {!grid ? (!error && <div className="skeleton" style={{ height: '10rem' }} />) : rows.length === 0 ? (
          <Empty icon={<Users />} title="No shifts this week">Nobody clocked in this week.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data tc-grid">
              <thead>
                <tr><th scope="col">Employee</th>{days.map((d) => <th key={d} scope="col">{fmt.day(d)}</th>)}<th scope="col" className="num">Week</th></tr>
              </thead>
              <tbody>
                {rows.map(({ u, cells, mins, total }) => {
                  const ro = !!why(u);
                  return (
                    <tr key={u.id}>
                      <th scope="row">
                        <span className="row nowrap">
                          <Avatar user={u} size="sm" /><span className="ellipsis">{u.name}</span>
                          {ro && <Lock className="tc-ro" role="img" aria-label="Read-only" />}
                        </span>
                      </th>
                      {days.map((d, i) => {
                        const list = cells?.get(d) ?? [];
                        return (
                          <td key={d}>
                            {list.map((s) => shiftButton(s, u))}
                            {list.length > 1 && <div className="xs muted num">= {hoursText(mins[i])}</div>}
                            {list.length === 0 && !ro && (
                              <button className="tc-add" aria-label={`Add shift for ${u.name} on ${fmt.day(d)}`} onClick={() => setEdit({ userId: u.id, date: d })}><Plus aria-hidden="true" /></button>
                            )}
                          </td>
                        );
                      })}
                      <td className="num strong">{hoursText(total)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr><td>Total</td>{dayTotals.map((m, i) => <td key={days[i]} className="num">{hoursText(m)}</td>)}<td className="num">{hoursText(weekTotal)}</td></tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="small muted row nowrap"><Lock className="tc-ro" aria-hidden="true" /> You can correct timesheets for people ranked below you. Rows with a lock are read-only.</p>
      </section>

      {edit && <ShiftDialog draft={edit} users={data.users} why={why} fmt={fmt} onSaved={saved} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ShiftDialog({ draft, users, why, fmt, onSaved, onClose }: {
  draft: Draft; users: UserDoc[]; why: (u: UserDoc) => string | null; fmt: Fmt;
  onSaved: (doc: ShiftDoc | null, id: string) => void; onClose: () => void;
}) {
  const x = draft.shift;
  const [userId, setUserId] = useState(draft.userId);
  const [date, setDate] = useState(x ? localDate(x.clockIn, fmt.tz) : draft.date);
  const [inT, setIn] = useState(x ? localTime(x.clockIn, fmt.tz) : '09:00');
  const [outT, setOut] = useState(x ? (x.clockOut == null ? '' : localTime(x.clockOut, fmt.tz)) : '17:00');
  const [breakMin, setBreak] = useState(String(x?.breakMin ?? 0));
  const [note, setNote] = useState(x?.note ?? '');
  const [busy, setBusy] = useState(false);
  const user = users.find((u) => u.id === userId);
  const reason = user ? why(user) : null;
  const ok = !reason;
  const t = date && inT ? shiftTimes(date, inT, outT, fmt.tz) : null;
  const paid = t?.clockOut != null ? shiftMinutes({ ...t, userId, breakMin: Number(breakMin) || 0 }, 0) : null;

  async function save() {
    if (!user || !t) return;
    const min = Number(breakMin);
    if (outT === inT) return toast('Clock-out must be after clock-in.', 'error');
    if (t.clockIn > Date.now() + 60_000 || (t.clockOut ?? 0) > Date.now() + 60_000) return toast("Times can't be in the future.", 'error');
    if (t.clockOut != null && min >= (t.clockOut - t.clockIn) / 60_000) return toast("The break can't be as long as the shift.", 'error');
    const doc = { id: x?.id ?? uuid(), userId: user.id, clockIn: t.clockIn, clockOut: t.clockOut, breakMin: min, breakStart: x?.breakStart ?? null, note: note.trim(), review: false };
    setBusy(true);
    try {
      await write('shifts', doc);
      toast(x ? 'Shift updated' : 'Shift added', 'success');
      onSaved({ ...doc, updatedAt: Date.now(), updatedBy: '' }, doc.id);
      onClose();
    } catch (e) { toast(errorText(e), 'error'); } finally { setBusy(false); }
  }

  async function del() {
    if (!x || !(await confirmBox({
      title: 'Delete this shift?', danger: true, confirm: 'Delete shift',
      message: `${user?.name ?? 'Shift'}: ${fmt.dateTime(x.clockIn)}. It's removed from the timesheet (the audit log keeps a record).`,
    }))) return;
    try {
      await remove('shifts', x.id);
      toast('Shift deleted', 'success');
      onSaved(null, x.id);
      onClose();
    } catch (e) { toast(errorText(e), 'error'); }
  }

  return (
    <Dialog open onClose={onClose} title={x ? 'Shift' : 'Add shift'} footer={<>
      {x && ok && <button className="btn danger" disabled={busy} onClick={del}><Trash2 /> Delete</button>}
      <span className="spacer" />
      <button className="btn ghost" onClick={onClose}>{ok ? 'Cancel' : 'Close'}</button>
      {ok && <button className="btn primary" type="submit" form="shift-form" disabled={busy || !user}>Save</button>}
    </>}>
      {reason && <div className="banner"><Lock /> <span className="grow">{reason}</span></div>}
      <form id="shift-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <fieldset className="plain stack" disabled={!ok || busy}>
          {draft.userId && user ? (
            <span className="row nowrap"><Avatar user={user} size="sm" /><strong>{user.name}</strong></span>
          ) : (
            <label className="field"><span>Employee</span>
              <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose…</option>
                {users.filter((u) => u.active && !why(u)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          )}
          <div className="form-grid">
            <label className="field"><span>Clock-in date</span>
              <input type="date" required value={date} max={localDate(Date.now(), fmt.tz)} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field"><span>Clock in</span><input type="time" required value={inT} onChange={(e) => setIn(e.target.value)} /></label>
            <label className="field"><span>Clock out</span>
              <input type="time" value={outT} onChange={(e) => setOut(e.target.value)} />
              <span className="hint">Empty = still on shift. Earlier than clock-in = next day.</span>
            </label>
            <label className="field"><span>Unpaid break (minutes)</span>
              <input type="number" required min={0} max={600} step={1} inputMode="numeric" value={breakMin} onChange={(e) => setBreak(e.target.value)} />
            </label>
          </div>
          <label className="field"><span>Note / reason for the change</span>
            <input maxLength={200} value={note} placeholder="e.g. Forgot to clock out" onChange={(e) => setNote(e.target.value)} />
          </label>
          {t && (
            <p className="small muted">
              {t.clockOut == null ? `Open since ${fmt.dateTime(t.clockIn)}` : `${hoursText(paid ?? 0)} paid · ${fmt.dateTime(t.clockIn)} → ${fmt.dateTime(t.clockOut)}`}
            </p>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}
