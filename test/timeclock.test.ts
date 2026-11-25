import test from 'node:test';
import assert from 'node:assert/strict';
import { byUserDay, flagOf, shiftMinutes, shiftTimes, toCsv } from '../src/modules/timeclock/lib.ts';

const H = 3_600_000;

test('timesheet maths', () => {
  const t0 = Date.UTC(2026, 10, 24, 9);
  assert.equal(shiftMinutes({ userId: 'a', clockIn: t0, clockOut: t0 + 8 * H, breakMin: 30 }, 0), 450);
  assert.equal(shiftMinutes({ userId: 'a', clockIn: t0, clockOut: null, breakMin: 0 }, t0 + 90 * 60_000), 90);
  assert.equal(flagOf({ userId: 'a', clockIn: t0, clockOut: null, breakMin: 0 }, t0 + 13 * H), 'stale');
  assert.equal(flagOf({ userId: 'a', clockIn: t0, clockOut: t0 + 13 * H, breakMin: 0 }, 0), 'long');

  // overnight 22:00 -> 02:00 in Berlin (UTC+1 in November)
  const { clockIn, clockOut } = shiftTimes('2026-11-24', '22:00', '02:00', 'Europe/Berlin');
  assert.equal(clockIn, Date.UTC(2026, 10, 24, 21));
  assert.equal(clockOut! - clockIn, 4 * H);

  // 02:00 local belongs to the previous business day when the day starts at 04:00
  const grid = byUserDay([{ userId: 'a', clockIn: Date.UTC(2026, 10, 25, 1), clockOut: null, breakMin: 0 }], ['2026-11-24', '2026-11-25'], 'Europe/Berlin', 4);
  assert.deepEqual([...grid.get('a')!.keys()], ['2026-11-24']);

  assert.equal(toCsv([['=SUM(A1)', 'say "hi"', 7.5]]), `"'=SUM(A1)","say ""hi""","7.5"`);
});
