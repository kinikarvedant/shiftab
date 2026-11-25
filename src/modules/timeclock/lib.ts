// Pure timesheet maths (no DOM / Dexie), checked by `node --test src/modules/timeclock/lib.test.ts`.
import { addDays, businessDay, zonedTime } from '../../../shared/time.ts';

export interface ShiftLike { userId: string; clockIn: number; clockOut: number | null; breakMin: number }
const HOUR = 3_600_000;

/** Paid minutes: open shifts count up to `now`, minus the unpaid break. */
export const shiftMinutes = (s: ShiftLike, now: number) => Math.max(0, Math.round(((s.clockOut ?? now) - s.clockIn) / 60_000) - s.breakMin);
export const sumMinutes = (list: ShiftLike[], now: number) => list.reduce((a, s) => a + shiftMinutes(s, now), 0);

/** 'stale' = open 12h+ (missed clock-out?), 'open' = on shift now, 'long' = closed but over 12h. */
export const flagOf = (s: ShiftLike, now: number) =>
  s.clockOut == null ? (now - s.clockIn > 12 * HOUR ? 'stale' : 'open') : s.clockOut - s.clockIn > 12 * HOUR ? 'long' : null;

/** userId -> business day -> shifts in clock-in order, keeping only `days`. */
export function byUserDay<S extends ShiftLike>(shifts: S[], days: string[], tz: string, dayStartHour: number) {
  const out = new Map<string, Map<string, S[]>>();
  for (const s of [...shifts].sort((a, b) => a.clockIn - b.clockIn)) {
    const d = businessDay(s.clockIn, tz, dayStartHour);
    if (!days.includes(d)) continue;
    const u = out.get(s.userId) ?? new Map<string, S[]>();
    out.set(s.userId, u.set(d, [...(u.get(d) ?? []), s]));
  }
  return out;
}

/** Wall-clock inputs in the venue timezone -> epoch ms. A clock-out at or before the clock-in is the next day. */
export function shiftTimes(date: string, inTime: string, outTime: string, tz: string) {
  const clockIn = zonedTime(date, inTime, tz);
  if (!outTime) return { clockIn, clockOut: null };
  const out = zonedTime(date, outTime, tz);
  return { clockIn, clockOut: out > clockIn ? out : zonedTime(addDays(date, 1), outTime, tz) };
}

/** Every field quoted; leading = + - @ defused so names can't run as spreadsheet formulas. */
export const toCsv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => `"${String(v).replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`).join(',')).join('\r\n');
