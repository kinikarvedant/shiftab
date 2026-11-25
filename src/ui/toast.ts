import { useSyncExternalStore } from 'react';

export interface Toast { id: number; kind: 'info' | 'success' | 'error' | 'warning'; text: string; action?: { label: string; run: () => void } }

let toasts: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function dismissToast(id: number) { toasts = toasts.filter((t) => t.id !== id); emit(); }

export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = nextId++;
  toasts = [...toasts.slice(-3), { id, kind, text, action }];
  emit();
  setTimeout(() => dismissToast(id), action || kind === 'error' ? 8000 : 4500);
  if (kind === 'error') navigator.vibrate?.([30, 40, 30]);
  return id;
}

export const useToasts = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => toasts);
