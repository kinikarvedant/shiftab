// Online-only sections: enrolled devices, password, two-factor, backup.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Download, Info, KeyRound, MonitorSmartphone, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { lock, refreshState, useApp, useCan } from '../../lib/session.ts';
import { syncNow, useSyncState } from '../../lib/sync.ts';
import { useFmt, useSettings } from '../../lib/format.ts';
import { ask, confirmBox, Empty, toast } from '../../ui/index.tsx';
import { failText, Field, OFFLINE, useBusy } from './lib.tsx';

interface DeviceRow { id: string; name: string; code: string; createdBy: string; createdAt: number; lastSeen: number }

function ago(ts: number, locale: string) {
  const s = (ts - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const a = Math.abs(s);
  return a < 60 ? rtf.format(0, 'minute') : a < 3600 ? rtf.format(Math.round(s / 60), 'minute')
    : a < 86_400 ? rtf.format(Math.round(s / 3600), 'hour') : rtf.format(Math.round(s / 86_400), 'day');
}

export function Devices() {
  const { device } = useApp();
  const fmt = useFmt();
  const [list, setList] = useState<DeviceRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const load = useCallback(async () => {
    setError('');
    try { setList(await api<DeviceRow[]>('GET', '/api/devices')); } catch (e) { setError(failText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const enrol = async () => {
    const name = await ask({ title: 'Enrol this device', message: 'Staff will be able to sign in here with their PIN. You can revoke it any time.', label: 'Device name', placeholder: 'Bar tablet', required: true, confirm: 'Enrol' });
    if (name) await run(async () => { await api('POST', '/api/devices/enrol', { name }); await refreshState(); toast(`Enrolled as “${name}”`, 'success'); await load(); });
  };
  const revoke = async (d: DeviceRow) => {
    const self = d.id === device?.id;
    const ok = await confirmBox({
      title: `Revoke ${d.name}?`, confirm: 'Revoke', danger: true,
      message: `${self ? 'This is the device you are using. ' : ''}It stops syncing at once and staff can no longer sign in there with a PIN. Changes it has not sent yet stay on it until it is enrolled again.`,
    });
    if (ok) await run(async () => { await api('DELETE', `/api/devices/${d.id}`); if (self) await refreshState(); toast(`${d.name} revoked`, 'success'); await load(); });
  };

  return (
    <section className="card stack" aria-labelledby="dev-h">
      <div className="row between">
        <h2 id="dev-h">Enrolled devices</h2>
        <div className="row">
          <button className="btn ghost icon" aria-label="Reload devices" disabled={busy} onClick={() => void load()}><RefreshCw aria-hidden="true" /></button>
          {!device && <button className="btn primary" disabled={busy || !!error} onClick={() => void enrol()}><MonitorSmartphone aria-hidden="true" /> Enrol this device</button>}
        </div>
      </div>
      <p className="muted small">Only enrolled devices can sync and offer PIN sign-in. The letter code marks order numbers made on each device.</p>
      {error ? <div className="banner warning" role="alert"><WifiOff aria-hidden="true" /><div className="grow">{error}</div><button className="btn sm outline" onClick={() => void load()}>Retry</button></div>
        : !list ? <div className="skeleton" style={{ height: '8rem' }} />
        : list.length === 0 ? <Empty icon={<MonitorSmartphone />} title="No devices enrolled" />
        : (
          <ul className="set-list">
            {list.map((d) => (
              <li key={d.id} className="set-row">
                <div className="grow stack sm" style={{ gap: 0 }}>
                  <div className="row"><span className="strong ellipsis">{d.name}</span><span className="pill code" title="Device code">{d.code}</span>
                    {d.id === device?.id && <span className="pill accent">This device</span>}</div>
                  <span className="muted small">Last seen {ago(d.lastSeen, fmt.locale)} · enrolled {fmt.date(d.createdAt)}</span>
                </div>
                <button className="btn danger" disabled={busy} onClick={() => void revoke(d)} aria-label={`Revoke ${d.name}`}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

export function Security() {
  const { session } = useApp();
  const can = useCan();
  if (session?.level === 'pin') return <div className="banner"><Info aria-hidden="true" /><div>Sign in with your password to change security settings.</div></div>;
  if (session?.level !== 'password') return <div className="banner warning"><WifiOff aria-hidden="true" /><div>{OFFLINE}</div></div>;
  return <div className="stack lg"><Password /><TwoFactor />{can('settings.manage') && <Backup />}</div>;
}

function Password() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, run] = useBusy();
  const short = f.next.length > 0 && f.next.length < 10;
  const mismatch = f.again.length > 0 && f.again !== f.next;
  const ready = f.current && f.next.length >= 10 && f.again === f.next;
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) void run(async () => {
      await api('POST', '/api/auth/password', { current: f.current, next: f.next });
      setF({ current: '', next: '', again: '' });
      toast('Password changed. Your other sessions were signed out.', 'success');
    });
  };
  return (
    <form className="card stack" onSubmit={submit} aria-labelledby="pw-h">
      <h2 id="pw-h" className="row nowrap"><KeyRound aria-hidden="true" /> Change password</h2>
      <div className="form-grid">
        <Field label="Current password"><input type="password" autoComplete="current-password" value={f.current} onChange={up('current')} /></Field>
        <Field label="New password" hint="At least 10 characters." error={short ? 'Too short: use at least 10 characters.' : undefined}>
          <input type="password" autoComplete="new-password" value={f.next} aria-invalid={short} onChange={up('next')} /></Field>
        <Field label="Repeat new password" error={mismatch ? 'The passwords do not match.' : undefined}>
          <input type="password" autoComplete="new-password" value={f.again} aria-invalid={mismatch} onChange={up('again')} /></Field>
      </div>
      <div className="row end"><button className="btn primary" disabled={busy || !ready}>Change password</button></div>
    </form>
  );
}

function TwoFactor() {
  const { session } = useApp();
  const settings = useSettings();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, run] = useBusy();
  const on = session!.user.hasTotp;
  const synced = async () => { await refreshState(); await syncNow().catch(() => {}); }; // pulls the new hasTotp flag

  const enable = (e: FormEvent) => {
    e.preventDefault();
    if (/^\d{6}$/.test(code)) void run(async () => {
      await api('POST', '/api/auth/totp/enable', { code });
      toast('Two-factor sign-in is on. Sign in again with your password and a code.', 'success');
      await lock(); // the server ended every session for this account
      await refreshState();
    });
  };
  const disable = async () => {
    const c = await ask({
      title: 'Turn off two-factor?', label: '6-digit code from your authenticator app', inputMode: 'numeric', required: true, confirm: 'Turn off', danger: true,
      message: settings?.require2faForFinance ? 'This venue requires 2FA for reports and payroll, so you will lose access to them.' : 'Your password alone will be enough to sign in.',
    });
    if (c) await run(async () => { await api('POST', '/api/auth/totp/disable', { code: c }); await synced(); toast('Two-factor sign-in is off.', 'success'); });
  };

  return (
    <section className="card stack" aria-labelledby="tfa-h">
      <div className="row between">
        <h2 id="tfa-h" className="row nowrap"><ShieldCheck aria-hidden="true" /> Two-factor sign-in</h2>
        <span className={`pill ${on ? 'success' : 'warning'}`}>{on ? 'On' : 'Off'}</span>
      </div>
      {on ? <>
        <p className="muted">Signing in with your password also asks for a code from your authenticator app.</p>
        <div className="row end"><button className="btn danger" disabled={busy} onClick={() => void disable()}>Turn off</button></div>
      </> : !setup ? <>
        <p className="muted">Protect your account with a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …).</p>
        <div className="row end"><button className="btn primary" disabled={busy} onClick={async () => {
          const password = await ask({ title: 'Confirm it’s you', message: 'Enter your password to set up two-factor sign-in.', label: 'Password', required: true, confirm: 'Continue', input: true, secret: true });
          if (password) void run(async () => setSetup(await api('POST', '/api/auth/totp/setup', { password })));
        }}>Set up two-factor</button></div>
      </> : (
        <form className="stack" onSubmit={enable}>
          <p>1. Open the link on this phone, or add this key to your authenticator app by hand:</p>
          <p className="code totp-secret" aria-label="Secret key">{setup.secret.match(/.{1,4}/g)?.join(' ')}</p>
          <div><a className="btn outline" href={setup.uri}><ShieldCheck aria-hidden="true" /> Open in authenticator app</a></div>
          <p>2. Enter the 6-digit code it shows.</p>
          <Field label="Code">
            <input className="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: '10rem' }} />
          </Field>
          <div className="row end">
            <button type="button" className="btn ghost" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button>
            <button className="btn primary" disabled={busy || code.length !== 6}>Verify and turn on</button>
          </div>
        </form>
      )}
    </section>
  );
}

function Backup() {
  const { online } = useSyncState();
  return (
    <section className="card stack" aria-labelledby="bk-h">
      <h2 id="bk-h" className="row nowrap"><Download aria-hidden="true" /> Backup</h2>
      <p className="muted">Download a full snapshot of the venue database. The server also keeps 14 daily snapshots.</p>
      <div className="banner warning"><AlertTriangle aria-hidden="true" />
        <div>PIN keys, 2FA secrets and pay rates in the backup are encrypted with the server secret. Back up <span className="code strong">APP_SECRET</span> (or the <span className="code strong">data/.secret</span> file) separately and keep it safe: without it they cannot be restored.</div></div>
      <div className="row end">
        {online ? <a className="btn primary" href="/api/admin/backup" download><Download aria-hidden="true" /> Download backup</a>
          : <span className="muted small"><WifiOff aria-hidden="true" className="inline-icon" /> {OFFLINE}</span>}
      </div>
    </section>
  );
}
