// First run: claim the venue with the setup code from the server log, create the owner.
import { useMemo, useState } from 'react';
import { Store, KeyRound, UserRound, Loader2 } from 'lucide-react';
import { api, errorText } from '../lib/api.ts';
import { passwordLogin } from '../lib/session.ts';
import { PRESETS } from '../../shared/presets.ts';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'NZD', 'SGD', 'AED', 'JPY', 'CHF', 'ZAR', 'MXN', 'BRL'];

export function Setup() {
  const zones = useMemo(() => (Intl as any).supportedValuesOf?.('timeZone') as string[] ?? [], []);
  const [f, setF] = useState({
    code: '', name: '', preset: 'restaurant', currency: 'USD', locale: navigator.language || 'en-US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, ownerName: '', email: '', password: '', password2: '', pin: '', pin2: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const problems = [
    f.password && f.password.length < 10 && 'Password needs at least 10 characters.',
    f.password2 && f.password !== f.password2 && 'Passwords do not match.',
    f.pin && !/^\d{4,8}$/.test(f.pin) && 'PIN must be 4–8 digits.',
    f.pin2 && f.pin !== f.pin2 && 'PINs do not match.',
  ].filter(Boolean) as string[];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problems.length) return;
    setBusy(true); setError('');
    try {
      await api('POST', '/api/setup', {
        code: f.code, preset: f.preset,
        business: { name: f.name, currency: f.currency, locale: f.locale, timezone: f.timezone },
        owner: { name: f.ownerName, email: f.email, password: f.password, pin: f.pin },
      });
      await passwordLogin(f.email, f.password);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  return (
    <main className="center-page">
      <form className="card pad-lg auth-card wide stack lg" onSubmit={submit}>
        <div className="hero-mark"><img src="/icon.svg" alt="" /><div><h1>Welcome to p0rtal</h1><p className="muted">Set up your venue in a minute.</p></div></div>

        <section className="stack">
          <h2 className="row nowrap"><KeyRound /> Setup code</h2>
          <label className="field"><span>Code from the server log</span>
            <input className="code" required value={f.code} onChange={up('code')} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            <span className="hint">Printed when the server started for the first time. It stops strangers claiming a fresh install.</span>
          </label>
        </section>

        <section className="stack">
          <h2 className="row nowrap"><Store /> Your business</h2>
          <div className="form-grid">
            <label className="field"><span>Venue name</span><input required maxLength={80} value={f.name} onChange={up('name')} /></label>
            <label className="field"><span>Type (starter menu & tables)</span>
              <select value={f.preset} onChange={up('preset')}>{Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select>
            </label>
            <label className="field"><span>Currency</span>
              <select value={f.currency} onChange={up('currency')}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
            </label>
            <label className="field"><span>Timezone</span>
              <select value={f.timezone} onChange={up('timezone')}>{(zones.length ? zones : [f.timezone]).map((z) => <option key={z}>{z}</option>)}</select>
            </label>
            <label className="field"><span>Language / number format</span><input required value={f.locale} onChange={up('locale')} /></label>
          </div>
        </section>

        <section className="stack">
          <h2 className="row nowrap"><UserRound /> Owner account</h2>
          <div className="form-grid">
            <label className="field"><span>Your name</span><input required maxLength={60} value={f.ownerName} onChange={up('ownerName')} autoComplete="name" /></label>
            <label className="field"><span>Email</span><input required type="email" value={f.email} onChange={up('email')} autoComplete="username" /></label>
            <label className="field"><span>Password (10+ characters)</span><input required type="password" minLength={10} value={f.password} onChange={up('password')} autoComplete="new-password" /></label>
            <label className="field"><span>Repeat password</span><input required type="password" value={f.password2} onChange={up('password2')} autoComplete="new-password" /></label>
            <label className="field"><span>Quick PIN for the till (4–8 digits)</span><input required inputMode="numeric" type="password" pattern="\d{4,8}" value={f.pin} onChange={up('pin')} autoComplete="off" /></label>
            <label className="field"><span>Repeat PIN</span><input required inputMode="numeric" type="password" value={f.pin2} onChange={up('pin2')} autoComplete="off" /></label>
          </div>
          <p className="small muted">Your password protects reports, payroll and settings. Your PIN is for everyday till use and can never open those.</p>
        </section>

        {problems.map((p) => <div key={p} className="danger-text small">{p}</div>)}
        {error && <div className="banner danger" role="alert">{error}</div>}
        <button className="btn primary lg block" disabled={busy || problems.length > 0}>{busy ? <><Loader2 className="spin" /> Setting up…</> : 'Create venue'}</button>
      </form>
    </main>
  );
}
