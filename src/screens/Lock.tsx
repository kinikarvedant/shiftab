// Shared terminal sign-in: tap your face, enter your PIN, clock in/out or open the till.
import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Camera, LogIn, LogOut, KeyRound, ArrowRight, UserRoundX } from 'lucide-react';
import { table } from '../lib/db.ts';
import { checkPin, pinLockedFor, startPinSession } from '../lib/session.ts';
import { write, type Signer } from '../lib/sync.ts';
import { elapsedText, useFmt, useNow, uuid } from '../lib/format.ts';
import { photoFromFile } from '../lib/photo.ts';
import { errorText } from '../lib/api.ts';
import { Avatar, BrandMark, Dialog, Empty, PinPad, toast } from '../ui/index.tsx';
import { SyncPill } from '../ui/sync-pill.tsx';
import { can, type Permission } from '../../shared/permissions.ts';
import type { UserDoc } from '../../shared/schema.ts';
import './screens.css';

const WORK_PERMS: Permission[] = ['pos.use', 'kitchen.view', 'reservations.manage', 'menu.manage', 'floor.manage', 'timeclock.manage'];

export function Lock({ onPassword }: { onPassword: () => void }) {
  const fmt = useFmt();
  const now = useNow(1_000);
  const users = useLiveQuery(() => table('users').filter((u) => u.active && !!u.pinCheck).toArray(), [], []);
  const groups = useLiveQuery(() => table('groups').toArray(), [], []);
  const openShifts = useLiveQuery(() => table('shifts').filter((s) => s.clockOut == null).toArray(), [], []);
  const [who, setWho] = useState<UserDoc | null>(null);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const shiftOf = (id: string) => openShifts.find((s) => s.userId === id);
  const sorted = [...users].sort((a, b) => (shiftOf(b.id) ? 1 : 0) - (shiftOf(a.id) ? 1 : 0) || a.name.localeCompare(b.name));
  const close = () => { setWho(null); setKey(null); setError(''); };
  const allowed = (p: Permission) => !!who && can(who, groups.find((g) => g.id === who.groupId), p, 'pin');
  const signer = (): Signer => ({ userId: who!.id, level: 'pin', key });
  const shift = who ? shiftOf(who.id) : undefined;

  async function enter(pin: string) {
    if (!who) return false;
    setBusy(true); setError('');
    try {
      const k = await checkPin(who, pin);
      if (!k) {
        const wait = pinLockedFor(who.id);
        setError(wait ? `Too many tries. Locked for ${Math.ceil(wait / 60_000)} min.` : 'Wrong PIN — try again.');
        return false;
      }
      setKey(k);
    } catch (e) { setError(errorText(e)); return false; } finally { setBusy(false); }
  }

  async function punch() {
    if (!who) return;
    try {
      if (shift) {
        await write('shifts', { ...shift, clockOut: Date.now() }, signer());
        toast(`${who.name} clocked out · ${elapsedText(Date.now() - shift.clockIn)} on shift`, 'success');
      } else {
        await write('shifts', { id: uuid(), userId: who.id, clockIn: Date.now(), clockOut: null, breakMin: 0, note: '' }, signer());
        toast(`${who.name} clocked in at ${fmt.time(Date.now())}`, 'success');
      }
      close();
    } catch (e) { toast(errorText(e), 'error'); }
  }

  async function setPhoto(file?: File) {
    if (!file || !who) return;
    try {
      await write('photos', { id: who.id, dataUrl: await photoFromFile(file) }, signer());
      toast('Photo updated', 'success');
    } catch (e) { toast(errorText(e), 'error'); }
  }

  return (
    <main className="lock">
      <header className="lock-head">
        <div>
          <div className="brand lock-brand"><BrandMark /><span>{fmt.settings?.name ?? 'Shiftab'}</span></div>
          <div className="lock-clock" aria-label="Current time">{fmt.time(now)}</div>
          <div className="muted">{fmt.date(now)}</div>
        </div>
        <SyncPill />
      </header>

      <section aria-label="Staff">
        {sorted.length === 0 ? (
          <Empty icon={<UserRoundX />} title="No staff with a PIN yet">A manager can add staff and PINs after signing in with their password.</Empty>
        ) : (
          <div className="faces">
            {sorted.map((u) => {
              const s = shiftOf(u.id);
              return (
                <button key={u.id} className={`face${s ? ' on-shift' : ''}`} onClick={() => setWho(u)} aria-label={`${u.name}${s ? ', on shift' : ''}`}>
                  <Avatar user={u} size="lg" />
                  <span className="name ellipsis">{u.name}</span>
                  {s ? <span className="pill success">On shift · {elapsedText(now - s.clockIn)}</span> : <span className="pill">Off</span>}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <footer className="lock-foot">
        <span className="small muted">Tap your name, then enter your PIN.</span>
        <button className="btn outline" onClick={onPassword}><KeyRound /> Manager sign-in</button>
      </footer>

      <Dialog open={!!who} onClose={close} title={who ? <span className="row nowrap"><Avatar user={who} size="sm" /> {who.name}</span> : ''}>
        {who && !key && <PinPad busy={busy} error={error} length={who.pinLen} onSubmit={enter} />}
        {who && key && (
          <div className="stack lg">
            <p className="muted">{shift ? `On shift since ${fmt.time(shift.clockIn)} (${elapsedText(Date.now() - shift.clockIn)}).` : 'You are not clocked in.'}</p>
            <div className="action-grid">
              {allowed('timeclock.self') && (shift
                ? <button className="btn lg danger" onClick={punch}><LogOut /> Clock out</button>
                : <button className="btn lg success" onClick={punch}><LogIn /> Clock in</button>)}
              {WORK_PERMS.some(allowed) && <button className="btn lg primary" onClick={() => startPinSession(who, key)}>Open Shiftab <ArrowRight /></button>}
              <button className="btn lg outline" onClick={() => fileRef.current?.click()}><Camera /> {`Photo`}</button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" capture="user" hidden onChange={(e) => { void setPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn ghost" onClick={close}>Done</button>
          </div>
        )}
      </Dialog>
    </main>
  );
}
