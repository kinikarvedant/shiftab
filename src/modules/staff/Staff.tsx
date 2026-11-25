// Staff: people, groups, PINs, back-office logins and pay. Lists render from synced local data;
// every change goes through the online staff/finance APIs and comes back via sync.
import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Camera, Check, Clock, Eye, KeyRound, Lock, Mail, Pencil, Plus, Search, ShieldCheck, Trash2, UserPlus, UserX, Users, Wallet, WifiOff } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { api, ApiError, errorText } from '../../lib/api.ts';
import { syncNow, useSyncState, write } from '../../lib/sync.ts';
import { useApp, useCan } from '../../lib/session.ts';
import { useFmt } from '../../lib/format.ts';
import { photoFromFile } from '../../lib/photo.ts';
import { Avatar, Dialog, Empty, confirmBox, toast } from '../../ui/index.tsx';
import { ALL_PERMISSIONS, outranks, PERMISSIONS, SENSITIVE, type GroupLike, type Permission } from '../../../shared/permissions.ts';
import { parseMoney } from '../../../shared/money.ts';
import type { GroupDoc, UserDoc } from '../../../shared/schema.ts';
import type { ModuleProps } from '../index.ts';
import './staff.css';

const OFFLINE = "You're offline — staff changes need a connection.";
const SWATCHES = [
  ['#a78bfa', 'Violet'], ['#60a5fa', 'Blue'], ['#34d399', 'Green'], ['#fbbf24', 'Amber'], ['#f87171', 'Red'],
  ['#f472b6', 'Pink'], ['#2dd4bf', 'Teal'], ['#fb923c', 'Orange'], ['#94a3b8', 'Slate'],
] as const;
const SECTIONS: [string, Permission[]][] = [
  ['Front of house', ['pos.use', 'orders.discount', 'orders.price', 'orders.void', 'payments.take', 'payments.refund', 'reservations.manage']],
  ['Kitchen & time', ['kitchen.view', 'timeclock.self', 'timeclock.manage']],
  ['Back office', ['menu.manage', 'floor.manage', 'staff.manage', 'finance.view', 'finance.manage', 'settings.manage', 'devices.manage', 'audit.view']],
];
interface Rate { id: string; userId: string; rateCents: number; effectiveFrom: string }

/** Online-only call: busy flag, friendly offline message, success toast, then pull the change via sync. */
function useOnline() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done, 'success');
      syncNow().catch(() => {});
      return true;
    } catch (e) {
      toast(e instanceof ApiError && e.status === 0 ? OFFLINE : errorText(e), 'error');
      return false;
    } finally { setBusy(false); }
  };
  return [busy, run] as const;
}

const GroupPill = ({ g }: { g: GroupDoc }) => <span className="pill"><span className="dot" style={{ background: g.color }} aria-hidden="true" />{g.name}</span>;

export default function Staff(_: ModuleProps) {
  const { session } = useApp();
  const sync = useSyncState();
  const [tab, setTab] = useState<'people' | 'groups'>('people');
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [group, setGroup] = useState<GroupDoc | 'new' | null>(null);
  const data = useLiveQuery(async () => {
    const [users, groups, open] = await Promise.all([
      table('users').toArray(), table('groups').toArray(), table('shifts').filter((s) => s.clockOut == null).toArray(),
    ]);
    return { users: users.sort((a, b) => a.name.localeCompare(b.name)), groups: groups.sort((a, b) => b.rank - a.rank), onShift: new Set(open.map((s) => s.userId)) };
  }, []);
  if (!data || !session) return <div className="page"><div className="skeleton" style={{ height: '12rem' }} /></div>;

  const me = session.user;
  const mine: GroupLike = data.groups.find((g) => g.id === me.groupId) ?? { id: '', rank: 0, permissions: [] };
  const groupOf = (u: UserDoc) => data.groups.find((g) => g.id === u.groupId);
  const assignable = data.groups.filter((g) => outranks(mine, g));
  const term = q.trim().toLowerCase();
  const people = data.users.filter((u) => (all || u.active) && (!term || u.name.toLowerCase().includes(term) || !!u.email?.includes(term)));
  const editUser = data.users.find((u) => u.id === editing);
  const offline = !sync.online || session.level === 'vault';

  return (
    <div className="page staff">
      <div className="page-head">
        <div>
          <h1>Staff</h1>
          <p>{data.users.filter((u) => u.active).length} active people · {data.groups.length} groups</p>
        </div>
        {tab === 'people'
          ? <button className="btn primary" disabled={!assignable.length} onClick={() => setAdding(true)}><UserPlus /> Add person</button>
          : <button className="btn primary" disabled={mine.rank <= 1} onClick={() => setGroup('new')}><Plus /> New group</button>}
      </div>

      <div className="stack">
        {offline && <div className="banner warning"><WifiOff /> <span className="grow">{OFFLINE} You can still look things up.</span></div>}
        <div className="row">
          <div className="seg" role="group" aria-label="Section">
            <button aria-pressed={tab === 'people'} onClick={() => setTab('people')}>People</button>
            <button aria-pressed={tab === 'groups'} onClick={() => setTab('groups')}>Groups</button>
          </div>
          {tab === 'people' && <>
            <div className="seg" role="group" aria-label="Show">
              <button aria-pressed={!all} onClick={() => setAll(false)}>Active</button>
              <button aria-pressed={all} onClick={() => setAll(true)}>All</button>
            </div>
            <label className="staff-search grow">
              <Search aria-hidden="true" />
              <input className="input" type="search" placeholder="Search by name or email" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </>}
        </div>

        {tab === 'people' ? (
          people.length === 0 ? (
            <Empty icon={<Users />} title={term ? 'Nobody matches' : 'No people yet'}>{term ? 'Try another name, or show all people.' : 'Add your team to give them PINs and groups.'}</Empty>
          ) : (
            <div className="grid-auto">
              {people.map((u) => {
                const g = groupOf(u);
                return (
                  <button key={u.id} className={`card person${u.active ? '' : ' inactive'}`} onClick={() => setEditing(u.id)}>
                    <Avatar user={u} />
                    <span className="grow stack sm">
                      <span className="row between nowrap"><strong className="ellipsis">{u.name}</strong>{u.id === me.id && <span className="pill accent">You</span>}</span>
                      {u.email && <span className="xs muted ellipsis">{u.email}</span>}
                      <span className="badges">
                        {g && <GroupPill g={g} />}
                        {!u.active && <span className="pill danger"><UserX aria-hidden="true" />Inactive</span>}
                        {data.onShift.has(u.id) && <span className="pill success"><Clock aria-hidden="true" />On shift</span>}
                        {!u.pinCheck && <span className="pill warning"><KeyRound aria-hidden="true" />No PIN</span>}
                        {u.hasPassword && <span className="pill info"><Mail aria-hidden="true" />Back-office login</span>}
                        {u.hasTotp && <span className="pill success"><ShieldCheck aria-hidden="true" />2FA</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Group</th><th className="num">Rank</th><th className="num">Members</th><th className="num">Permissions</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {data.groups.map((g) => {
                    const ro = !outranks(mine, g);
                    return (
                      <tr key={g.id}>
                        <td><span className="row nowrap"><span className="dot" style={{ background: g.color }} aria-hidden="true" /><strong>{g.name}</strong>{g.id === mine.id && <span className="pill accent">Your group</span>}</span></td>
                        <td className="num">{g.rank}</td>
                        <td className="num">{data.users.filter((u) => u.groupId === g.id).length}</td>
                        <td className="num">{g.permissions.length} / {ALL_PERMISSIONS.length}</td>
                        <td className="num">
                          <button className="btn outline" onClick={() => setGroup(g)} aria-label={`${ro ? 'View' : 'Edit'} ${g.name}`}>{ro ? <><Eye /> View</> : <><Pencil /> Edit</>}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted">Higher ranks manage lower ones. You can create and edit groups ranked below {mine.rank}, and only grant permissions you hold.</p>
          </>
        )}
      </div>

      {adding && <AddPerson groups={assignable} onClose={() => setAdding(false)} />}
      {editUser && <PersonDialog key={editUser.id} user={editUser} me={me} mine={mine} groups={data.groups} onClose={() => setEditing(null)} />}
      {group && <GroupDialog key={group === 'new' ? 'new' : group.id} group={group === 'new' ? null : group} mine={mine}
        members={group === 'new' ? 0 : data.users.filter((u) => u.groupId === group.id).length} onClose={() => setGroup(null)} />}
    </div>
  );
}

// ---------- shared form bits ----------
function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const v = value.toLowerCase();
  return (
    <fieldset className="plain">
      <legend>Colour</legend>
      <div className="swatches">
        {SWATCHES.map(([c, name]) => (
          <button key={c} type="button" className="swatch" style={{ background: c }} aria-pressed={v === c} aria-label={name} onClick={() => onChange(c)}>
            {v === c && <Check aria-hidden="true" />}
          </button>
        ))}
        <input type="color" value={v} onChange={(e) => onChange(e.target.value)} aria-label="Custom colour" />
      </div>
    </fieldset>
  );
}

const pinInput = { type: 'password', inputMode: 'numeric', pattern: '[0-9]{4,8}', maxLength: 8, autoComplete: 'new-password' } as const;

// ---------- add person ----------
function AddPerson({ groups, onClose }: { groups: GroupDoc[]; onClose: () => void }) {
  const [busy, run] = useOnline();
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState(groups[groups.length - 1]?.id ?? '');
  const [color, setColor] = useState<string>(SWATCHES[0][0]);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');

  async function save() {
    if (pin !== pin2) return toast("The PINs don't match.", 'error');
    if (await run(() => api('POST', '/api/staff', { name: name.trim(), groupId, color, pin: pin || undefined }), `${name.trim()} added`)) onClose();
  }

  return (
    <Dialog open onClose={onClose} title="Add person" footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" type="submit" form="add-person" disabled={busy}><UserPlus /> Add person</button>
    </>}>
      <form id="add-person" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span>Name</span><input required autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Group</span>
          <select required value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} (rank {g.rank})</option>)}
          </select>
          <span className="hint">Only groups ranked below yours.</span>
        </label>
        <ColorPicker value={color} onChange={setColor} />
        <div className="form-grid">
          <label className="field"><span>PIN (optional)</span><input {...pinInput} value={pin} onChange={(e) => setPin(e.target.value)} /><span className="hint">4–8 digits, for signing in on terminals.</span></label>
          <label className="field"><span>Repeat PIN</span><input {...pinInput} required={!!pin} value={pin2} onChange={(e) => setPin2(e.target.value)} /></label>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- edit person ----------
function PersonDialog({ user: u, me, mine, groups, onClose }: { user: UserDoc; me: UserDoc; mine: GroupLike; groups: GroupDoc[]; onClose: () => void }) {
  const can = useCan();
  const [busy, run] = useOnline();
  const g = groups.find((x) => x.id === u.groupId);
  const self = u.id === me.id;
  const manage = !self && !!g && outranks(mine, g);
  const editable = self || manage;
  const [name, setName] = useState(u.name);
  const [color, setColor] = useState(u.color);
  const [groupId, setGroupId] = useState(u.groupId);
  const [active, setActive] = useState(u.active);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [email, setEmail] = useState(u.email ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const saveDetails = () => run(() => api('PATCH', `/api/staff/${u.id}`, { name: name.trim(), color, ...(manage ? { groupId, active } : {}) }), 'Saved');
  async function savePin() {
    if (pin !== pin2) return toast("The PINs don't match.", 'error');
    if (await run(() => api('POST', `/api/staff/${u.id}/pin`, { pin }), 'PIN set')) { setPin(''); setPin2(''); }
  }
  async function saveLogin() {
    if (pw !== pw2) return toast("The passwords don't match.", 'error');
    if (await run(() => api('POST', `/api/staff/${u.id}/login`, { email: email.trim(), password: pw }), 'Back-office login saved')) { setPw(''); setPw2(''); }
  }
  async function removeLogin() {
    if (await confirmBox({
      title: `Remove ${u.name}'s back-office login?`, danger: true, confirm: 'Remove login',
      message: 'Their password and 2FA are removed and any back-office session ends. Their PIN still works.',
    })) await run(() => api('DELETE', `/api/staff/${u.id}/login`), 'Back-office login removed');
  }
  async function setPhoto(file?: File) {
    if (!file) return;
    try { await write('photos', { id: u.id, dataUrl: await photoFromFile(file) }); toast('Photo updated', 'success'); }
    catch (e) { toast(errorText(e), 'error'); }
  }

  return (
    <Dialog open wide onClose={onClose} title={u.name} footer={<button className="btn ghost" onClick={onClose}>Done</button>}>
      {!editable && <div className="banner warning"><Lock /> <span className="grow">{u.name} is in {g?.name ?? 'a group'}, ranked at or above you, so you can only view their profile.</span></div>}
      {self && <div className="banner"><Lock /> <span className="grow">This is you. You can change your name, colour, photo and PIN; someone senior changes your group, status and back-office login.</span></div>}

      <div className="row">
        <Avatar user={{ id: u.id, name: name || u.name, color }} size="lg" />
        {editable && <button type="button" className="btn outline" onClick={() => fileRef.current?.click()}><Camera /> Upload photo</button>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void setPhoto(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      <form className="stack" onSubmit={(e) => { e.preventDefault(); void saveDetails(); }}>
        <fieldset className="plain stack" disabled={!editable || busy}>
          <div className="form-grid">
            <label className="field"><span>Name</span><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><span>Group</span>
              <select value={groupId} disabled={!manage} onChange={(e) => setGroupId(e.target.value)}>
                {(manage ? groups.filter((x) => outranks(mine, x)) : groups.filter((x) => x.id === u.groupId)).map((x) => <option key={x.id} value={x.id}>{x.name} (rank {x.rank})</option>)}
              </select>
              {self && <span className="hint">You can't change your own group.</span>}
            </label>
          </div>
          <ColorPicker value={color} onChange={setColor} />
          <label className="switch">
            <input type="checkbox" checked={active} disabled={!manage} onChange={(e) => setActive(e.target.checked)} />
            <span>{active ? 'Active' : 'Inactive — can’t sign in'}{self && <span className="muted small"> · you can't deactivate yourself</span>}</span>
          </label>
          <div className="row end"><button className="btn primary">Save details</button></div>
        </fieldset>
      </form>

      <form className="stack staff-section" onSubmit={(e) => { e.preventDefault(); void savePin(); }}>
        <h3 className="row nowrap"><KeyRound aria-hidden="true" /> PIN</h3>
        <p className="small muted">{u.pinCheck ? 'Has a PIN. A new one replaces it on every terminal.' : 'No PIN yet, so they can’t sign in on terminals.'}</p>
        <fieldset className="plain stack" disabled={!editable || busy}>
          <div className="form-grid">
            <label className="field"><span>New PIN</span><input {...pinInput} required value={pin} onChange={(e) => setPin(e.target.value)} /><span className="hint">4–8 digits.</span></label>
            <label className="field"><span>Repeat PIN</span><input {...pinInput} required value={pin2} onChange={(e) => setPin2(e.target.value)} /></label>
          </div>
          <div className="row end"><button className="btn">Set PIN</button></div>
        </fieldset>
      </form>

      <form className="stack staff-section" onSubmit={(e) => { e.preventDefault(); void saveLogin(); }}>
        <h3 className="row nowrap"><Mail aria-hidden="true" /> Back-office login</h3>
        <p className="small muted">
          {u.hasPassword ? <>Signs in as <strong>{u.email}</strong>{u.hasTotp ? ' with 2FA' : ''}.</> : 'No password login. Give one to people who need reports, staff or settings.'}
        </p>
        {self ? <p className="small muted">Change your own password in Settings.</p> : (
          <fieldset className="plain stack" disabled={!manage || busy}>
            <div className="form-grid">
              <label className="field"><span>Email</span><input type="email" required maxLength={254} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <label className="field"><span>Password</span><input type="password" required minLength={10} maxLength={256} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /><span className="hint">At least 10 characters.</span></label>
              <label className="field"><span>Repeat password</span><input type="password" required minLength={10} maxLength={256} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
            </div>
            <div className="row end">
              {u.hasPassword && <button type="button" className="btn danger" onClick={removeLogin}><Trash2 /> Remove login</button>}
              <button className="btn">{u.hasPassword ? 'Change login' : 'Give login'}</button>
            </div>
          </fieldset>
        )}
      </form>

      {can('finance.view') && <Pay user={u} canEdit={can('finance.manage') && (manage || (self && mine.rank >= 100))} />}
    </Dialog>
  );
}

// ---------- pay (finance API; never stored on the device) ----------
function Pay({ user, canEdit }: { user: UserDoc; canEdit: boolean }) {
  const fmt = useFmt();
  const can = useCan();
  const [busy, run] = useOnline();
  const [rates, setRates] = useState<Rate[] | string | null>(null); // string = load error
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState(''); // '' = today
  const load = () => api<Rate[]>('GET', '/api/finance/rates').then(
    (r) => setRates(r.filter((x) => x.userId === user.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))),
    (e) => setRates(e instanceof ApiError && e.status === 0 ? "You're offline — pay needs a connection." : errorText(e)),
  );
  useEffect(() => { void load(); }, [user.id]);

  const today = fmt.today();
  const list = Array.isArray(rates) ? rates : [];
  const current = list.find((r) => r.effectiveFrom <= today);

  async function add() {
    const cents = parseMoney(amount, fmt.currency);
    if (cents == null) return toast('Enter an amount like 15.50.', 'error');
    if (cents > 1_000_000) return toast('That rate is too high.', 'error');
    if (await run(() => api('POST', '/api/finance/rates', { userId: user.id, rateCents: cents, effectiveFrom: from || today }), 'Pay rate saved')) { setAmount(''); void load(); }
  }
  async function del(r: Rate) {
    if (!(await confirmBox({ title: 'Delete this pay rate?', message: `${fmt.money(r.rateCents)} / hour from ${fmt.day(r.effectiveFrom)}. Reports then use the previous rate.`, confirm: 'Delete rate', danger: true }))) return;
    if (await run(() => api('DELETE', `/api/finance/rates/${r.id}`), 'Pay rate deleted')) void load();
  }

  return (
    <section className="stack staff-section" aria-labelledby="pay-head">
      <h3 id="pay-head" className="row nowrap"><Wallet aria-hidden="true" /> Pay</h3>
      <p className="small muted row nowrap"><Lock className="staff-icon" aria-hidden="true" /> Pay rates are encrypted on the server and never stored on this device.</p>
      {rates === null ? <div className="skeleton" style={{ height: '3rem' }} /> : typeof rates === 'string' ? (
        <div className="banner warning"><WifiOff /> <span className="grow">{rates}</span><button className="btn outline" onClick={() => { setRates(null); void load(); }}>Retry</button></div>
      ) : <>
        <div className="kpi">
          <div className="label">Current hourly rate</div>
          <div className="value money">{current ? fmt.money(current.rateCents) : '—'}</div>
          <div className="small muted">{current ? `Since ${fmt.day(current.effectiveFrom)}` : 'No rate yet: their hours count as 0 labour cost.'}</div>
        </div>
        {list.length > 0 && (
          <ul className="rates">
            {list.map((r) => (
              <li key={r.id} className="row between nowrap">
                <span><span className="money strong">{fmt.money(r.rateCents)}</span> <span className="muted">/ hour from {fmt.day(r.effectiveFrom)}</span>
                  {r.effectiveFrom > today && <span className="pill info">Upcoming</span>}{r === current && <span className="pill success">Current</span>}</span>
                {canEdit && <button className="btn ghost icon" disabled={busy} onClick={() => del(r)} aria-label={`Delete rate from ${fmt.day(r.effectiveFrom)}`}><Trash2 /></button>}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <fieldset className="plain form-grid" disabled={busy}>
              <label className="field"><span>Hourly rate ({fmt.currency})</span><input required inputMode="decimal" placeholder="15.50" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
              <label className="field"><span>Effective from</span><input type="date" required value={from || today} onChange={(e) => setFrom(e.target.value)} /><span className="hint">A rate on the same date replaces it.</span></label>
            </fieldset>
            <div className="row end"><button className="btn" disabled={busy}><Plus /> Add rate</button></div>
          </form>
        ) : <p className="small muted">{can('finance.manage') ? 'You can only set pay for people ranked below you.' : 'Changing pay needs the “Edit pay rates” permission.'}</p>}
      </>}
    </section>
  );
}

// ---------- groups ----------
function GroupDialog({ group, mine, members, onClose }: { group: GroupDoc | null; mine: GroupLike; members: number; onClose: () => void }) {
  const [busy, run] = useOnline();
  const ro = !!group && !outranks(mine, group);
  const maxRank = mine.rank - 1;
  const orig = group?.permissions ?? [];
  const [name, setName] = useState(group?.name ?? '');
  const [rank, setRank] = useState(String(group?.rank ?? Math.max(1, Math.min(10, maxRank))));
  const [color, setColor] = useState<string>(group?.color ?? SWATCHES[1][0]);
  const [perms, setPerms] = useState<Permission[]>(group?.permissions ?? (['timeclock.self'] as Permission[]).filter((p) => mine.permissions.includes(p)));
  const toggle = (p: Permission) => setPerms((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]));

  async function save() {
    const body = { name: name.trim(), rank: Number(rank), color, permissions: ALL_PERMISSIONS.filter((p) => perms.includes(p)) };
    if (await run(() => (group ? api('PATCH', `/api/groups/${group.id}`, body) : api('POST', '/api/groups', body)), group ? 'Group saved' : 'Group created')) onClose();
  }
  async function del() {
    if (!group || !(await confirmBox({ title: `Delete ${group.name}?`, message: 'The group and its permissions are removed.', confirm: 'Delete group', danger: true }))) return;
    if (await run(() => api('DELETE', `/api/groups/${group.id}`), 'Group deleted')) onClose();
  }

  return (
    <Dialog open wide onClose={onClose} title={group ? group.name : 'New group'} footer={<>
      {group && !ro && <button className="btn danger" disabled={busy || members > 0} onClick={del}><Trash2 /> Delete</button>}
      <span className="spacer" />
      <button className="btn ghost" onClick={onClose}>{ro ? 'Close' : 'Cancel'}</button>
      {!ro && <button className="btn primary" type="submit" form="group-form" disabled={busy}>{group ? 'Save group' : 'Create group'}</button>}
    </>}>
      {ro && <div className="banner warning"><Lock /> <span className="grow">{group!.id === mine.id ? 'This is your own group — someone senior has to change it.' : `This group ranks at or above yours (${mine.rank}), so it's read-only for you.`}</span></div>}
      {group && !ro && members > 0 && <p className="small muted">{members} {members === 1 ? 'person is' : 'people are'} in this group. Move them to another group before deleting it.</p>}
      <form id="group-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <fieldset className="plain stack" disabled={ro || busy}>
          <div className="form-grid">
            <label className="field"><span>Name</span><input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><span>Rank</span>
              <input type="number" required min={1} max={Math.max(1, maxRank)} step={1} inputMode="numeric" value={rank} onChange={(e) => setRank(e.target.value)} />
              <span className="hint">1 to {maxRank}: higher ranks manage lower ones.</span>
            </label>
          </div>
          <ColorPicker value={color} onChange={setColor} />
          <div className="perms">
            {SECTIONS.map(([title, list]) => (
              <fieldset key={title}>
                <legend>{title}</legend>
                {list.map((p) => {
                  const off = !mine.permissions.includes(p) && !orig.includes(p);
                  const notes = [SENSITIVE.has(p) && 'Password only', off && "You don't have this permission"].filter(Boolean).join(' · ');
                  return (
                    <label key={p} className="perm">
                      <input type="checkbox" checked={perms.includes(p)} disabled={off} onChange={() => toggle(p)} />
                      <span className="grow stack">
                        <span className="row nowrap">{PERMISSIONS[p]}{SENSITIVE.has(p) && <Lock className="staff-icon" aria-hidden="true" />}</span>
                        {notes && <span className="xs muted">{notes}</span>}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
