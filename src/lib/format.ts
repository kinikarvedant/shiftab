// Formatting in the venue's currency, locale and timezone + small shared hooks.
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { table } from './db.ts';
import { formatMoney } from '../../shared/money.ts';
import { businessDay } from '../../shared/time.ts';

export const useSettings = () => useLiveQuery(() => table('settings').get('business'), []);

export function useFmt() {
  const s = useSettings();
  return useMemo(() => {
    const currency = s?.currency ?? 'USD';
    const locale = s?.locale ?? navigator.language;
    const tz = s?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz });
    const date = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz });
    const dateTime = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz });
    const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return {
      settings: s, currency, locale, tz,
      money: (minor: number) => formatMoney(minor, currency, locale),
      time: (ts: number) => time.format(ts),
      date: (ts: number) => date.format(ts),
      dateTime: (ts: number) => dateTime.format(ts),
      /** 'YYYY-MM-DD' -> "Wed, 25 Nov" */
      day: (d: string) => day.format(Date.parse(`${d}T12:00:00Z`)),
      today: () => businessDay(Date.now(), tz, s?.dayStartHour ?? 4),
    };
  }, [s]);
}

export const hoursText = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
export const elapsedText = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
export const uuid = () => crypto.randomUUID();

/** Re-render every `ms` (live timers). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
