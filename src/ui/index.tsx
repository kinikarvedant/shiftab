// Shared UI kit. Modules should build from these + the classes in styles.css.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, CheckCircle2, Delete, Info, X, XCircle, CornerDownLeft } from 'lucide-react';
import { table } from '../lib/db.ts';
import { initials } from '../lib/format.ts';
import { dismissToast, useToasts } from './toast.ts';
import type { UserDoc } from '../../shared/schema.ts';

export { toast } from './toast.ts';

// ---------- Dialog (native <dialog>: focus trap, Esc, top layer for free) ----------
export function Dialog(props: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; label?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog ref={ref} className={`sheet${props.wide ? ' wide' : ''}`} aria-label={props.label}
      onCancel={(e) => { e.preventDefault(); props.onClose(); }}>
      {props.open && <>
        <div className="sheet-head">
          <h2>{props.title}</h2>
          <button className="btn ghost icon sm" onClick={props.onClose} aria-label="Close"><X /></button>
        </div>
        <div className="sheet-body">{props.children}</div>
        {props.footer && <div className="sheet-foot">{props.footer}</div>}
      </>}
    </dialog>
  );
}

// ---------- Avatar ----------
export function Avatar({ user, size = '', className = '' }: { user: Pick<UserDoc, 'id' | 'name' | 'color'>; size?: '' | 'sm' | 'lg' | 'xl'; className?: string }) {
  const photo = useLiveQuery(() => table('photos').get(user.id), [user.id]);
  const cls = `avatar ${size} ${className}`;
  if (photo?.dataUrl) return <img className={cls} src={photo.dataUrl} alt="" />;
  return <span className={cls} style={{ background: user.color }} aria-hidden="true">{initials(user.name)}</span>;
}

// ---------- Brand mark: the venue's logo, or the p0rtal mark ----------
export function BrandMark({ className = '' }: { className?: string }) {
  const logo = useLiveQuery(async () => (await table('settings').get('business'))?.brand?.logo ?? null, []);
  return logo ? <img className={`brand-logo ${className}`} src={logo} alt="" /> : <img className={`brand-mark ${className}`} src="/icon.svg" alt="" />;
}

// ---------- Empty state ----------
export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty">{icon}<h2>{title}</h2>{children && <div className="muted">{children}</div>}</div>;
}

// ---------- PIN pad ----------
export function PinPad({ onSubmit, busy, error, label = 'Enter your PIN' }: {
  onSubmit: (pin: string) => Promise<boolean | void> | void; busy?: boolean; error?: string; label?: string;
}) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const submit = async (p = pin) => {
    if (p.length < 4 || busy) return;
    const ok = await onSubmit(p);
    if (ok === false) { setShake(true); setPin(''); navigator.vibrate?.([30, 40, 30]); setTimeout(() => setShake(false), 400); }
  };
  const press = (d: string) => { if (!busy) setPin((p) => (p.length < 8 ? p + d : p)); navigator.vibrate?.(8); };
  const back = () => setPin((p) => p.slice(0, -1));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
      else if (e.key === 'Enter') void submit();
      else return;
      e.preventDefault(); // don't also activate whatever button has focus
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  return (
    <div className="stack" style={{ alignItems: 'center', gap: 'var(--space-4)' }}>
      <div className="muted" id="pin-label">{label}</div>
      <div className={`pin-dots${shake ? ' shake' : ''}`} role="status" aria-live="polite" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
      </div>
      {error && <div role="alert" className="danger-text small">{error}</div>}
      <div className="pinpad" role="group" aria-labelledby="pin-label">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" onClick={() => press(d)} aria-label={d}>{d}</button>)}
        <button type="button" className="ghost" onClick={back} aria-label="Delete digit"><Delete /></button>
        <button type="button" onClick={() => press('0')} aria-label="0">0</button>
        <button type="button" className="ghost" onClick={() => void submit()} aria-label="Enter" disabled={pin.length < 4 || busy}
          style={{ color: pin.length >= 4 ? 'var(--accent)' : undefined }}><CornerDownLeft /></button>
      </div>
    </div>
  );
}

// ---------- Toast host ----------
const TOAST_ICON = { info: Info, success: CheckCircle2, error: XCircle, warning: AlertTriangle };
export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = TOAST_ICON[t.kind];
        return (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
            <Icon style={{ color: `var(--${t.kind === 'error' ? 'danger' : t.kind})` }} />
            <div className="grow">{t.text}</div>
            {t.action && <button className="btn sm outline" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
            <button className="btn ghost icon sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><X /></button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- ask() / confirmBox(): promise-based prompts ----------
interface AskOpts { title: string; message?: ReactNode; label?: string; placeholder?: string; initial?: string; input?: boolean; required?: boolean; confirm?: string; danger?: boolean; inputMode?: 'text' | 'decimal' | 'numeric'; secret?: boolean }
let pending: (AskOpts & { resolve: (v: string | null) => void }) | null = null;
const askSubs = new Set<() => void>();
const emitAsk = () => askSubs.forEach((f) => f());

export function ask(o: AskOpts): Promise<string | null> {
  pending?.resolve(null);
  return new Promise((resolve) => { pending = { input: true, ...o, resolve }; emitAsk(); });
}
export const confirmBox = async (o: Omit<AskOpts, 'input'>) => (await ask({ ...o, input: false })) !== null;

export function AskHost() {
  const p = useSyncExternalStore((f) => { askSubs.add(f); return () => askSubs.delete(f); }, () => pending);
  const [value, setValue] = useState('');
  useEffect(() => { setValue(p?.initial ?? ''); }, [p]);
  const done = (v: string | null) => { p?.resolve(v); pending = null; setValue(''); emitAsk(); };
  const invalid = !!p?.input && !!p.required && !value.trim();
  return (
    <Dialog open={!!p} onClose={() => done(null)} title={p?.title ?? ''}
      footer={<>
        <button className="btn ghost" onClick={() => done(null)}>Cancel</button>
        <button className={`btn ${p?.danger ? 'danger solid' : 'primary'}`} disabled={invalid} form="ask-form" type="submit">{p?.confirm ?? 'OK'}</button>
      </>}>
      <form id="ask-form" className="stack" onSubmit={(e) => { e.preventDefault(); if (!invalid) done(p?.input ? (p.secret ? value : value.trim()) : ''); }}>
        {p?.message && <div className="muted">{p.message}</div>}
        {p?.input && (
          <label className="field">
            <span>{p.label ?? p.title}</span>
            <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={p.placeholder} inputMode={p.inputMode}
              maxLength={p.secret ? 256 : 200} type={p.secret ? 'password' : 'text'} autoComplete={p.secret ? 'current-password' : 'off'} />
          </label>
        )}
      </form>
    </Dialog>
  );
}
