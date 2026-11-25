// Top-bar sync status: icon + text, never colour alone.
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CloudOff, CloudCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import { db } from '../lib/db.ts';
import { discardStuck, syncNow, useSyncState } from '../lib/sync.ts';
import { useCan } from '../lib/session.ts';
import { Dialog, confirmBox, toast } from './index.tsx';

export function SyncPill() {
  const s = useSyncState();
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const [open, setOpen] = useState(false);
  const can = useCan();
  const head = useLiveQuery(() => db.outbox.orderBy('seq').first(), []);

  let cls = 'ok', icon = <CloudCheck />, text = 'Synced';
  if (s.blocked) { cls = 'error'; icon = <TriangleAlert />; text = `Sync paused${pending ? ` · ${pending}` : ''}`; }
  else if (!s.online) { cls = 'offline'; icon = <CloudOff />; text = pending ? `Offline · ${pending} queued` : 'Offline'; }
  else if (s.syncing || pending) { cls = 'ok'; icon = <RefreshCw className="spin" />; text = pending ? `Saving ${pending}` : 'Syncing'; }

  return (
    <>
      <button className={`sync ${cls}`} onClick={() => setOpen(true)} aria-label={`Sync status: ${text}`}>{icon}<span>{text}</span></button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Sync status"
        footer={<button className="btn primary" onClick={() => { void syncNow(); setOpen(false); }}><RefreshCw /> Sync now</button>}>
        <p>{s.online ? 'Connected to the server.' : 'No connection — everything you do is saved on this device and sent when the connection returns.'}</p>
        <p className="muted">{pending} change{pending === 1 ? '' : 's'} waiting to upload.{s.lastSync ? ` Last synced ${new Date(s.lastSync).toLocaleTimeString()}.` : ''}</p>
        {s.blocked && <div className="banner danger" role="alert"><TriangleAlert /> {s.blocked}</div>}
        {s.blocked && head && can('timeclock.manage') && (
          <button className="btn danger" onClick={async () => {
            if (!(await confirmBox({ title: 'Discard the stuck change?', message: `The oldest queued change (${head.collection}) will be thrown away so the rest can sync. This cannot be undone.`, confirm: 'Discard', danger: true }))) return;
            await discardStuck();
            toast('Discarded one change', 'warning');
          }}>Discard the stuck change</button>
        )}
      </Dialog>
    </>
  );
}
