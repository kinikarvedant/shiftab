// Manager override. When the signed-in person can't do something, someone who can approves it on the
// same screen, and that one change is signed by (and audited as) the approver.
// Money and timesheet overrides (ELEVATED) need the approver's password — a short PIN is not enough,
// because terminals can verify PINs offline and could therefore be used to guess them. Works offline.
import { useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { table } from '../lib/db.ts';
import { derivePwd } from '../lib/crypto.ts';
import { canSession, checkPin, getApp } from '../lib/session.ts';
import type { Signer } from '../lib/sync.ts';
import { can, ELEVATED, PERMISSIONS, type Permission } from '../../shared/permissions.ts';
import type { UserDoc } from '../../shared/schema.ts';
import { Avatar, Dialog, PinPad } from './index.tsx';

let req: { perm: Permission; why: string; resolve: (s: Signer | null) => void } | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Resolve to a signer allowed to do `perm` — the current user, or an approver. */
export function withApproval(perm: Permission, why: string): Promise<Signer | null> {
  const s = getApp().session;
  if (s && canSession(s, perm)) return Promise.resolve({ userId: s.user.id, level: s.level, key: s.pinKey });
  req?.resolve(null);
  return new Promise((resolve) => { req = { perm, why, resolve }; emit(); });
}

// Same back-off as PINs: 5 wrong passwords -> 1, 2, 4 … 32 minutes.
const failKey = (id: string) => `p0.pwdfail.${id}`;
function lockedFor(id: string) {
  try { const f = JSON.parse(localStorage.getItem(failKey(id)) ?? 'null'); return f ? Math.max(0, f.until - Date.now()) : 0; } catch { return 0; }
}
function recordFailure(id: string) {
  try {
    const f = JSON.parse(localStorage.getItem(failKey(id)) ?? 'null') ?? { n: 0, until: 0 };
    const n = f.n + 1;
    localStorage.setItem(failKey(id), JSON.stringify({ n, until: n >= 5 ? Date.now() + Math.min(2 ** (n - 5), 32) * 60_000 : 0 }));
  } catch { /* storage blocked */ }
}

export function ApproveHost() {
  const r = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => req);
  const [who, setWho] = useState<UserDoc | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const strong = !!r && ELEVATED.has(r.perm);
  const approvers = useLiveQuery(async () => {
    if (!r) return [];
    const groups = await table('groups').toArray();
    const users = await table('users').filter((u) => u.active && !!(strong ? u.pwdCheck : u.pinCheck)).toArray();
    return users.filter((u) => can(u, groups.find((g) => g.id === u.groupId), r.perm, strong ? 'strong' : 'pin'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [r, strong]);
  const close = (s: Signer | null) => { r?.resolve(s); req = null; setWho(null); setError(''); setPassword(''); emit(); };

  async function approveWithPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!who?.pwdSalt || !who.pwdCheck || busy) return;
    const wait = lockedFor(who.id);
    if (wait) return setError(`Too many wrong passwords. Try again in ${Math.ceil(wait / 60_000)} min.`);
    setBusy(true); setError('');
    try {
      const { key, check } = await derivePwd(password, who.pwdSalt);
      if (check !== who.pwdCheck) { recordFailure(who.id); setError('Wrong password.'); setPassword(''); return; }
      try { localStorage.removeItem(failKey(who.id)); } catch { /* storage blocked */ }
      close({ userId: who.id, level: 'strong', key });
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!r} onClose={() => close(null)} title={<span className="row nowrap"><ShieldCheck /> Approval needed</span>}>
      {r && (
        <p className="muted">{r.why} needs <strong>{PERMISSIONS[r.perm]}</strong>.{' '}
          {strong ? 'Someone allowed to approve it enters their password.' : 'Someone allowed to approve it enters their PIN.'}</p>
      )}
      {!who ? (
        <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(8rem, 1fr))' }}>
          {approvers?.map((u) => (
            <button key={u.id} className="btn outline" style={{ flexDirection: 'column', height: 'auto', padding: 'var(--space-3)' }} onClick={() => setWho(u)}>
              <Avatar user={u} size="lg" /> <span className="ellipsis">{u.name}</span>
            </button>
          ))}
          {approvers?.length === 0 && (
            <p className="muted">{strong
              ? 'Nobody who can approve this has a back-office password on this venue yet. An owner can add one under Staff.'
              : 'Nobody with this permission has a PIN yet.'}</p>
          )}
        </div>
      ) : strong ? (
        <form className="stack" onSubmit={approveWithPassword}>
          <div className="row"><Avatar user={who} /> <strong>{who.name}</strong> <button type="button" className="btn ghost sm" onClick={() => { setWho(null); setError(''); }}>Change</button></div>
          <label className="field"><span>{who.name}'s password</span>
            <input type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <div role="alert" className="danger-text small">{error}</div>}
          <button className="btn primary lg" disabled={busy || !password}><KeyRound /> {busy ? 'Checking…' : 'Approve'}</button>
        </form>
      ) : (
        <div className="stack" style={{ alignItems: 'center' }}>
          <div className="row"><Avatar user={who} /> <strong>{who.name}</strong> <button className="btn ghost sm" onClick={() => setWho(null)}>Change</button></div>
          <PinPad busy={busy} error={error} label={`${who.name}, enter your PIN to approve`} onSubmit={async (pin) => {
            setBusy(true);
            try {
              const key = await checkPin(who, pin);
              if (!key) { setError('Wrong PIN.'); return false; }
              close({ userId: who.id, level: 'pin', key });
            } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
          }} />
        </div>
      )}
    </Dialog>
  );
}
