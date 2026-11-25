// Small pieces shared by the settings sections.
import { useCallback, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { ApiError, errorText } from '../../lib/api.ts';
import { write } from '../../lib/sync.ts';
import { Dialog, toast } from '../../ui/index.tsx';
import type { Doc } from '../../../shared/schema.ts';

export const OFFLINE = "You're offline — this needs a connection.";
export const failText = (e: unknown) => (e instanceof ApiError && e.status === 0 ? OFFLINE : errorText(e));

/** [busy, run]: run(fn) disables buttons while it works and toasts any error. Resolves true on success. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); return true; } catch (e) { toast(failText(e), 'error'); return false; } finally { setBusy(false); }
  }, []);
  return [busy, run] as const;
}

type Parsed = { error?: { issues: { path: PropertyKey[]; message: string }[] } };
/** First problem per top-level field; `nice` replaces zod's wording for that field. */
export function fieldErrors(r: Parsed, nice: Record<string, string> = {}) {
  const out: Record<string, string> = {};
  for (const i of r.error?.issues ?? []) { const k = String(i.path[0] ?? ''); out[k] ??= nice[k] ?? i.message; }
  return out;
}

export function Field({ label, hint, error, children, wide }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span>{label}</span>{children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="error">{error}</span>}
    </label>
  );
}

export const bySort = (a: { sort: number; name: string }, b: { sort: number; name: string }) =>
  a.sort - b.sort || a.name.localeCompare(b.name, undefined, { numeric: true });
export const nextSort = (list: { sort: number }[]) => list.reduce((m, d) => Math.max(m, d.sort + 1), 0);

type Sortable = 'categories' | 'items' | 'areas' | 'tables';
/** Move list[i] one step and renumber sort 0..n, so duplicate sort values can't stall a move. */
export async function move<C extends Sortable>(c: C, list: (Doc<C> & { sort: number })[], i: number, by: -1 | 1) {
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  await Promise.all(next.map((d, k) => (d.sort === k ? null : write(c, { ...d, sort: k }))));
}

export function MoveButtons({ name, i, n, onMove }: { name: string; i: number; n: number; onMove: (by: -1 | 1) => void }) {
  return <>
    <button type="button" className="btn ghost icon" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => onMove(-1)}><ArrowUp aria-hidden="true" /></button>
    <button type="button" className="btn ghost icon" aria-label={`Move ${name} down`} disabled={i === n - 1} onClick={() => onMove(1)}><ArrowDown aria-hidden="true" /></button>
  </>;
}

/** Add/edit dialog: fields as children, Save submits; Delete is shown disabled with `deleteNote` when not allowed. */
export function Editor({ title, open, onClose, onSave, onDelete, deleteNote, busy, children }: {
  title: string; open: boolean; onClose: () => void; onSave: () => void; onDelete?: () => void; deleteNote?: string; busy?: boolean; children: ReactNode;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<>
      {onDelete && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} disabled={busy || !!deleteNote} onClick={onDelete}><Trash2 aria-hidden="true" /> Delete</button>}
      <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      <button type="submit" form="settings-editor" className="btn primary" disabled={busy}>Save</button>
    </>}>
      <form id="settings-editor" className="stack" noValidate onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        {children}
        {onDelete && deleteNote && <p className="muted small">{deleteNote}</p>}
      </form>
    </Dialog>
  );
}
