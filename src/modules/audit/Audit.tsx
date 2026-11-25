// Audit log: the server's append-only record of security-relevant events, newest first, 100 per page.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Clock, KeyRound, Receipt, RefreshCw, ScrollText, Search, Settings2, Users, Wallet, WifiOff, type LucideIcon } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { api, ApiError, errorText } from '../../lib/api.ts';
import { useCan } from '../../lib/session.ts';
import { useFmt } from '../../lib/format.ts';
import { Empty } from '../../ui/index.tsx';
import { detailText } from './detail.ts';
import type { ModuleProps } from '../index.ts';
import './audit.css';

interface Row { id: number; ts: number; actor: string | null; device: string | null; action: string; target: string | null; detail: string | null }
const PAGE = 100;
const NO_USERS = new Map<string, string>();

type Cat = 'access' | 'sales' | 'staff' | 'time' | 'pay' | 'system';
const CATS: Record<Cat, { label: string; icon: LucideIcon }> = {
  access: { label: 'Sign-in', icon: KeyRound },
  sales: { label: 'Sales', icon: Receipt },
  staff: { label: 'Staff', icon: Users },
  time: { label: 'Timesheets', icon: Clock },
  pay: { label: 'Pay & reports', icon: Wallet },
  system: { label: 'System', icon: Settings2 },
};
type Tone = '' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
const ACTIONS: Record<string, [label: string, cat: Cat, tone?: Tone]> = {
  'login': ['Signed in', 'access', 'success'],
  'login.failed': ['Failed sign-in', 'access', 'danger'],
  'password.changed': ['Password changed', 'access', 'warning'],
  'totp.enabled': ['2FA turned on', 'access', 'success'],
  'totp.disabled': ['2FA turned off', 'access', 'warning'],
  'order.voided': ['Order voided', 'sales', 'danger'],
  'item.voided': ['Item voided', 'sales', 'danger'],
  'item.price_override': ['Price override', 'sales', 'warning'],
  'order.discount': ['Discount', 'sales', 'warning'],
  'payment': ['Payment', 'sales', 'success'],
  'payment.removed': ['Payment removed', 'sales', 'danger'],
  'order.reopened': ['Order reopened', 'sales', 'warning'],
  'menu.price': ['Menu price changed', 'sales', 'info'],
  'shift.added': ['Shift added', 'time', 'info'],
  'shift.edited': ['Shift edited', 'time', 'warning'],
  'shift.deleted': ['Shift deleted', 'time', 'danger'],
  'staff.created': ['Staff added', 'staff', 'info'],
  'staff.updated': ['Staff changed', 'staff', 'info'],
  'staff.pin_set': ['PIN set', 'staff', 'info'],
  'staff.login_set': ['Password login given', 'staff', 'warning'],
  'staff.login_removed': ['Password login removed', 'staff', 'warning'],
  'group.created': ['Group added', 'staff', 'info'],
  'group.updated': ['Group changed', 'staff', 'warning'],
  'group.deleted': ['Group deleted', 'staff', 'danger'],
  'payrate.set': ['Pay rate set', 'pay', 'warning'],
  'payrate.deleted': ['Pay rate removed', 'pay', 'warning'],
  'finance.viewed': ['Reports opened', 'pay', 'info'],
  'settings.changed': ['Settings changed', 'system', 'warning'],
  'device.enrolled': ['Device enrolled', 'system', 'info'],
  'device.revoked': ['Device revoked', 'system', 'warning'],
  'backup.downloaded': ['Backup downloaded', 'system', 'warning'],
  'setup': ['Venue set up', 'system', 'accent'],
};
const describe = (action: string): [string, Cat, Tone] => {
  const [label, cat, tone = ''] = ACTIONS[action] ?? [action, 'system'];
  return [label, cat, tone];
};

export default function Audit(_: ModuleProps) {
  const fmt = useFmt();
  const can = useCan();
  const [rows, setRows] = useState<Row[]>([]);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ offline: boolean; text: string } | null>(null);
  const [cat, setCat] = useState<Cat | 'all'>('all');
  const [q, setQ] = useState('');
  const users = useLiveQuery(async () => new Map((await table('users').toArray()).map((u) => [u.id, u.name])), [], NO_USERS);
  const [devices, setDevices] = useState(new Map<string, string>());
  const canDevices = can('devices.manage');

  const load = useCallback(async (before?: number) => {
    setLoading(true); setError(null);
    try {
      const page = await api<Row[]>('GET', `/api/audit${before ? `?before=${before}` : ''}`);
      setRows((r) => (before ? [...r, ...page] : page));
      setMore(page.length === PAGE);
    } catch (e) {
      setError({ offline: e instanceof ApiError && e.status === 0, text: errorText(e) });
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (canDevices) api<{ id: string; name: string }[]>('GET', '/api/devices').then((l) => setDevices(new Map(l.map((d) => [d.id, d.name])))).catch(() => {});
  }, [canDevices]);

  const view = useMemo(() => rows.map((r) => {
    const [label, c, tone] = describe(r.action);
    const subject = r.target ? users.get(r.target) ?? devices.get(r.target) : undefined;
    const detail = [subject, detailText(fmt, r.action, r.detail)].filter(Boolean).join(' · ');
    const who = r.actor ? users.get(r.actor) ?? '—' : '—';
    const device = r.device ? devices.get(r.device) ?? r.device.slice(0, 8) : '—';
    return { r, label, cat: c, tone, detail, who, device, text: `${label} ${r.action} ${who} ${device} ${detail}`.toLowerCase() };
  }), [rows, users, devices, fmt]);

  const present = useMemo(() => (Object.keys(CATS) as Cat[]).filter((c) => view.some((v) => v.cat === c)), [view]);
  const term = q.trim().toLowerCase();
  const shown = view.filter((v) => (cat === 'all' || v.cat === cat) && (!term || v.text.includes(term)));

  const head = (
    <div className="page-head">
      <div><h1>Audit log</h1><p>Sign-ins, voids, discounts, refunds, timesheet, pay and settings changes. Nothing here can be edited.</p></div>
      <button className="btn outline" disabled={loading} onClick={() => void load()}><RefreshCw aria-hidden="true" className={loading ? 'spin' : ''} /> Refresh</button>
    </div>
  );

  if (error && rows.length === 0) {
    return (
      <div className="page">{head}
        <Empty icon={error.offline ? <WifiOff /> : <ScrollText />} title={error.offline ? "You're offline" : "Couldn't load the audit log"}>
          {error.offline ? 'The audit log is kept on the server, so it needs a connection.' : error.text}
          <div style={{ marginTop: 'var(--space-4)' }}><button className="btn primary" onClick={() => void load()}>Try again</button></div>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page audit">
      {head}
      <div className="stack">
        <div className="row">
          <label className="audit-search grow">
            <Search aria-hidden="true" />
            <input type="search" placeholder="Search loaded entries" aria-label="Search loaded entries" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        {present.length > 1 && (
          <div className="row" role="group" aria-label="Filter by category">
            <button className="chip" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>All</button>
            {present.map((c) => { const C = CATS[c]; return <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}><C.icon aria-hidden="true" className="chip-icon" /> {C.label}</button>; })}
          </div>
        )}

        {loading && rows.length === 0 ? <div className="skeleton" style={{ height: '20rem' }} />
          : shown.length === 0 ? <Empty icon={<ScrollText />} title={rows.length ? 'No matching entries' : 'Nothing logged yet'}>{rows.length ? 'Try another filter or search, or load older entries.' : undefined}</Empty>
          : (
            <div className="table-wrap">
              <table className="data audit-table">
                <thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Who</th><th scope="col">Device</th><th scope="col">Details</th></tr></thead>
                <tbody>
                  {shown.map(({ r, label, cat: c, tone, detail, who, device }) => {
                    const C = CATS[c];
                    return (
                      <tr key={r.id}>
                        <td className="a-time"><time dateTime={new Date(r.ts).toISOString()}>{fmt.dateTime(r.ts)}</time></td>
                        <td className="a-action"><span className={`pill ${tone}`} title={`${C.label}: ${r.action}`}><C.icon aria-hidden="true" />{label}</span></td>
                        <td data-label="Who">{who}</td>
                        <td data-label="Device" className={r.device && !devices.has(r.device) ? 'code' : undefined}>{device}</td>
                        <td className="a-detail">{detail || <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        {error && rows.length > 0 && <div className="banner warning" role="alert"><WifiOff aria-hidden="true" /><div className="grow">{error.offline ? "You're offline — this needs a connection." : error.text}</div></div>}
        <div className="row between">
          <span className="muted small">{shown.length === view.length ? `${view.length} entries loaded` : `${shown.length} of ${view.length} loaded entries`}</span>
          {more && rows.length > 0 && <button className="btn outline" disabled={loading} onClick={() => void load(rows[rows.length - 1]!.id)}>Load older</button>}
        </div>
      </div>
    </div>
  );
}
