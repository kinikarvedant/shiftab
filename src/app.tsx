// App shell: picks the right screen (setup / lock / login / app), nav, routing, idle lock.
import { Suspense, ViewTransition, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Lock as LockIcon, Loader2, MonitorSmartphone, WifiOff } from 'lucide-react';
import { table } from './lib/db.ts';
import { api, errorText } from './lib/api.ts';
import { canSession, lock, refreshState, setGroupCache, updateSessionUser, useApp } from './lib/session.ts';
import type { Permission } from '../shared/permissions.ts';
import { go, useRoute } from './lib/router.ts';
import { useSettings } from './lib/format.ts';
import { MODULES } from './modules/index.ts';
import { AskHost, Avatar, BrandMark, Toasts, ask, toast } from './ui/index.tsx';
import { setBrand } from './lib/display.ts';
import { ApproveHost } from './ui/approve.tsx';
import { SyncPill } from './ui/sync-pill.tsx';
import { Setup } from './screens/Setup.tsx';
import { Lock } from './screens/Lock.tsx';
import { Login } from './screens/Login.tsx';

export function App() {
  const app = useApp();
  const [password, setPassword] = useState(false);
  const brand = useLiveQuery(async () => (await table('settings').get('business'))?.brand ?? null, []);
  useEffect(() => { if (brand !== undefined) setBrand(brand); }, [brand]);
  useEffect(() => { if (app.session) setPassword(false); }, [app.session]);

  let screen;
  if (!app.ready) screen = <main className="center-page"><Loader2 className="spin" size={40} aria-label="Loading" /></main>;
  else if (app.needsSetup) screen = <Setup />;
  else if (!app.session) screen = app.device && !password ? <Lock onPassword={() => setPassword(true)} /> : <Login onBack={app.device ? () => setPassword(false) : undefined} />;
  else screen = <Shell />;

  return <>{screen}<Toasts /><AskHost /><ApproveHost /></>;
}

function Shell() {
  const { session, device } = useApp();
  const settings = useSettings();
  const [id, ...params] = useRoute();
  const groups = useLiveQuery(() => table('groups').toArray(), []);
  const me = useLiveQuery(async () => (await table('users').get(session!.user.id)) ?? null, [session!.user.id]);
  useEffect(() => { if (groups) setGroupCache(groups); }, [groups]);
  useEffect(() => { if (me !== undefined) updateSessionUser(me ?? undefined); }, [me]);

  const can = (p: Permission) => canSession(session, p, groups ?? []);
  const visible = MODULES.filter((m) => m.anyOf.length === 0 || m.anyOf.some(can));
  const nav = visible.filter((m) => m.nav !== false);
  const mod = visible.find((m) => m.id === id);
  const fallback = nav.find((m) => m.anyOf.length > 0) ?? nav[0];
  useEffect(() => { if (groups && !mod && fallback) go(fallback.id); }, [groups, mod, fallback]);
  const groupName = groups?.find((g) => g.id === session!.user.groupId)?.name;

  // wall surface (kitchen display / TV): vw-based root size, no sidebar
  const wall = !!mod?.wall;
  useEffect(() => {
    if (wall) document.documentElement.dataset.surface = 'wall'; else delete document.documentElement.dataset.surface;
  }, [wall]);

  useIdleLock(session!.level === 'pin' ? (settings?.lockAfterSec ?? 120) * 1000 : 15 * 60_000, wall);

  const level = session!.level;
  return (
    <div className="app" style={wall ? { gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'var(--topbar-h) minmax(0, 1fr)', gridTemplateAreas: "'top' 'main'" } : undefined}>
      <header className="topbar">
        <div className="brand"><BrandMark /><span className="ellipsis">{settings?.name ?? 'p0rtal'}</span></div>
        <div className="spacer" />
        <SyncPill />
        {!device && level === 'password' && can('devices.manage') && <EnrolButton />}
        <span className="row nowrap" title={level === 'pin' ? 'Signed in with PIN' : level === 'vault' ? 'Offline read-only sign-in' : 'Signed in with password'}>
          <Avatar user={session!.user} size="sm" />
          <span className="ellipsis small strong" style={{ maxWidth: '10rem' }}>{session!.user.name}</span>
          {level !== 'pin' && <span className={`pill ${level === 'vault' ? 'warning' : 'accent'}`}>{level === 'vault' ? <><WifiOff /> Read-only</> : groupName}</span>}
        </span>
        <button className="btn outline sm" onClick={() => void lock()} aria-label="Lock and sign out"><LockIcon /><span className="lock-label">Lock</span></button>
      </header>
      {!wall && (
        <nav className="nav" aria-label="Main">
          {nav.map((m) => (
            <a key={m.id} href={`#/${m.id}`} aria-current={m.id === id || (id === 'order' && m.id === 'floor') ? 'page' : undefined}>
              <m.icon aria-hidden="true" /><span>{m.label}</span>
            </a>
          ))}
        </nav>
      )}
      <main className="main" id="main">
        {groups && <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: '3rem', width: '40%' }} /></div>}>
          {/* keyed by module: switching screens animates; edits within a screen don't (default="none") */}
          {mod && <ViewTransition key={mod.id} enter="page" exit="page" default="none"><mod.component params={params} /></ViewTransition>}
        </Suspense>}
      </main>
    </div>
  );
}

function EnrolButton() {
  return (
    <button className="btn outline sm" onClick={async () => {
      const name = await ask({ title: 'Enrol this device', message: 'Staff will be able to sign in here with their PIN. You can revoke it any time from Settings → Devices.', label: 'Device name', placeholder: 'Bar tablet', required: true, confirm: 'Enrol' });
      if (!name) return;
      try { await api('POST', '/api/devices/enrol', { name }); await refreshState(); toast(`Enrolled as “${name}”`, 'success'); }
      catch (e) { toast(errorText(e), 'error'); }
    }}><MonitorSmartphone /> Enrol device</button>
  );
}

/** Lock after `ms` without a touch, key press or pointer move. */
function useIdleLock(ms: number, paused: boolean) {
  const last = useRef(Date.now());
  useEffect(() => {
    const bump = () => { last.current = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach((e) => addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => { if (!paused && Date.now() - last.current > ms) void lock(); }, 5_000);
    return () => { evs.forEach((e) => removeEventListener(e, bump)); clearInterval(t); };
  }, [ms, paused]);
}
