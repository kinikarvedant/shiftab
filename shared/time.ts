// Business-day and week maths in the venue's timezone. Dates are 'YYYY-MM-DD' strings.

const fmts = new Map<string, Intl.DateTimeFormat>();
function zoneParts(ts: number, tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmts.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(new Date(ts))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return iso(Date.UTC(y, m - 1, d + n));
}

/** Local calendar date of an instant in `tz`. */
export function localDate(ts: number, tz: string): string {
  const { y, m, d } = zoneParts(ts, tz);
  return iso(Date.UTC(y, m - 1, d));
}

/** The trading day an instant belongs to: before `dayStartHour` local time counts as the previous day. DST-safe. */
export function businessDay(ts: number, tz: string, dayStartHour: number): string {
  const { y, m, d, h } = zoneParts(ts, tz);
  const date = iso(Date.UTC(y, m - 1, d));
  return h < dayStartHour ? addDays(date, -1) : date;
}

/** First day of the week containing `date` (weekStartsOn: 0 = Sunday … 6 = Saturday). */
export function weekStart(date: string, weekStartsOn: number): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow - weekStartsOn + 7) % 7));
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Wall-clock time in `tz` -> epoch ms (two-pass offset correction handles DST). */
export function zonedTime(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t: number) => {
    const p = zoneParts(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** 'HH:MM' local time of an instant in `tz`. */
export function localTime(ts: number, tz: string): string {
  const { h, mi } = zoneParts(ts, tz);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}
