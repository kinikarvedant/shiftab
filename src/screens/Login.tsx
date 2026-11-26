// Password (+2FA) sign-in for managers and owners. Works offline as a read-only unlock of cached reports.
import { useState } from 'react';
import { KeyRound, Loader2, ArrowLeft, ShieldCheck } from 'lucide-react';
import { NeedTotp, passwordLogin, useApp } from '../lib/session.ts';
import { errorText } from '../lib/api.ts';
import { useSyncState } from '../lib/sync.ts';
import { BrandMark } from '../ui/index.tsx';

export function Login({ onBack }: { onBack?: () => void }) {
  const { demo } = useApp();
  const [email, setEmail] = useState(demo?.email ?? '');
  const [password, setPassword] = useState(demo?.password ?? '');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { online } = useSyncState();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await passwordLogin(email, password, needTotp ? totp : undefined); }
    catch (err) {
      if (err instanceof NeedTotp) { setNeedTotp(true); setError(''); }
      else setError(errorText(err));
    } finally { setBusy(false); }
  }

  return (
    <main className="center-page">
      <form className="card pad-lg auth-card stack lg" onSubmit={submit}>
        <div className="hero-mark"><BrandMark /><div><h1>Sign in</h1><p className="muted">Managers and owners: reports, payroll, staff and settings.</p></div></div>
        {demo && <div className="banner"><span>Demo venue with made-up sample data, so the sign-in is filled in for you. It starts fresh about once an hour.
          To try the staff PIN screen, tap <strong>Enrol device</strong> in the top bar after signing in. Every PIN is {demo.pin}.</span></div>}
        {!online && <div className="banner warning">Offline — you can still open reports saved on this device.</div>}
        <label className="field"><span>Email</span><input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
        <label className="field"><span>Password</span><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {needTotp && (
          <label className="field"><span className="row nowrap"><ShieldCheck size={16} /> 6-digit code from your authenticator app</span>
            <input className="code" required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus />
          </label>
        )}
        {error && <div className="banner danger" role="alert">{error}</div>}
        <button className="btn primary lg block" disabled={busy}>{busy ? <><Loader2 className="spin" /> Checking…</> : <><KeyRound /> Sign in</>}</button>
        {onBack && <button type="button" className="btn ghost block" onClick={onBack}><ArrowLeft /> Back to staff sign-in</button>}
        {!onBack && <p className="small muted">Staff sign in with their PIN on an enrolled terminal. A manager enrols a terminal from Settings → Devices.</p>}
      </form>
    </main>
  );
}
