// First-run setup tour: floating tips that walk a new owner through brand, business, menu, tables, team and
// devices, opening each screen and ringing the place to look. Offered once per device (with Skip); restart it
// from Settings → Business.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { go } from '../lib/router.ts';

const KEY = 'p0.tour';
type State = 'offer' | 'off' | number; // number = 1-based step

const STEPS = [
  { route: 'settings/appearance', target: '[data-tour="appearance"]', title: 'Make it yours',
    body: 'Upload your logo and Shiftab picks your colours from it, or choose a preset. Every device in the venue updates.' },
  { route: 'settings/business', target: '[data-tour="business"]', title: 'Your business details',
    body: 'Check the venue name, currency, GST, payment methods, and when your business day starts so late-night sales land on the right day.' },
  { route: 'settings/menu', target: '[data-tour="menu"]', title: 'Build your menu',
    body: 'Add categories like Starters and Mains, then dishes with prices and photos. Switch off “Send to kitchen” for drinks.' },
  { route: 'settings/floor', target: '[data-tour="floor"]', title: 'Lay out your tables',
    body: 'Add areas such as Inside or Terrace, then their tables. Staff open an order by tapping a table.' },
  { route: 'staff', target: '[data-tour="nav-staff"]', title: 'Add your team',
    body: 'Give each person a role and a PIN, set pay rates for the wage reports, and set up kitchen stations under Roles.' },
  { route: 'settings/devices', target: '[data-tour="devices"]', title: 'Connect your devices',
    body: 'On each iPad, phone or kitchen TV: open Shiftab, install it, sign in with your password and tap Enrol device. Staff then sign in there with their PIN.' },
  { route: 'floor', target: '[data-tour="nav-floor"]', title: "You're ready to trade",
    body: "Take orders from Floor. Reports compares every day's sales with wages. You can restart this tour from Settings → Business." },
];

const stored = () => { try { return localStorage.getItem(KEY); } catch { return 'off'; } };
let state: State = stored() ? 'off' : 'offer';
const subs = new Set<() => void>();
const setState = (s: State) => { state = s; subs.forEach((f) => f()); };
const useTour = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => state);
const finish = (how: 'done' | 'skipped') => { try { localStorage.setItem(KEY, how); } catch { /* storage blocked */ } setState('off'); };

/** Restart the tour (Settings → Business). */
export const startTour = () => setState(1);

export function Tour({ venue }: { venue?: string }) {
  const s = useTour();
  if (s === 'off') return null;
  if (s === 'offer') {
    return (
      <section className="tour-tip tour-offer" role="dialog" aria-labelledby="tour-title">
        <span className="tour-step">Welcome{venue ? ` to Shiftab, ${venue}` : ' to Shiftab'}</span>
        <h2 id="tour-title">Set up in 7 quick steps?</h2>
        <p className="muted small">A short tour of your brand, business details, menu, tables, team and devices. About two minutes.</p>
        <div className="row end">
          <button className="btn ghost" onClick={() => finish('skipped')}>Skip</button>
          <button className="btn primary" onClick={() => setState(1)}>Start the tour</button>
        </div>
      </section>
    );
  }
  return <Step i={s} />;
}

const sameRect = (a: DOMRect | null, b: DOMRect | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

function Step({ i }: { i: number }) {
  const step = STEPS[i - 1]!;
  const last = i === STEPS.length;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [size, setSize] = useState({ w: 352, h: 200 });
  const tip = useRef<HTMLElement>(null);
  // measure the tip once it's drawn (text wraps differently per step and screen), then place it with real numbers
  useLayoutEffect(() => {
    const el = tip.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });

  useEffect(() => { go(step.route); }, [step.route]);
  // follow the target as the page loads, scrolls, folds or resizes
  useEffect(() => {
    let raf = 0, scrolled = false;
    const tick = () => {
      const el = document.querySelector(step.target);
      if (el && !scrolled) { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); scrolled = true; }
      const r = el?.getBoundingClientRect() ?? null;
      setRect((prev) => (sameRect(prev, r) ? prev : r));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step.target]);

  // place the tip beside a sidebar item, else below the target, else above; always on screen
  const { w, h } = size, gap = 14, pad = 12;
  const clamp = (v: number, max: number) => Math.max(pad, Math.min(v, max - pad));
  let pos = { top: innerHeight - h - 24, left: (innerWidth - w) / 2 };
  if (rect) {
    if (rect.left < innerWidth * 0.3 && rect.right + gap + w <= innerWidth - pad) pos = { left: rect.right + gap, top: clamp(rect.top + rect.height / 2 - h / 2, innerHeight - h) };
    else if (rect.bottom + gap + h <= innerHeight - pad) pos = { top: rect.bottom + gap, left: clamp(rect.left + rect.width / 2 - w / 2, innerWidth - w) };
    else pos = { top: Math.max(pad, rect.top - gap - h), left: clamp(rect.left + rect.width / 2 - w / 2, innerWidth - w) };
  }

  return (
    <>
      {rect && <div className="tour-ring" aria-hidden="true" style={{ top: rect.top - 5, left: rect.left - 5, width: rect.width + 10, height: rect.height + 10 }} />}
      <section ref={tip} key={i} className="tour-tip" role="dialog" aria-labelledby="tour-title" aria-live="polite" style={pos}>
        <div className="row between nowrap">
          <span className="tour-step">Step {i} of {STEPS.length}</span>
          <button className="btn ghost icon sm" onClick={() => finish('skipped')} aria-label="Skip the tour" title="Skip the tour"><X /></button>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p className="muted small">{step.body}</p>
        <div className="row end">
          {i > 1 && <button className="btn ghost" onClick={() => setState(i - 1)}>Back</button>}
          <button className="btn primary" autoFocus onClick={() => (last ? finish('done') : setState(i + 1))}>{last ? 'Finish' : 'Next'}</button>
        </div>
      </section>
    </>
  );
}
