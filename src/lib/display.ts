// Display: the venue's brand (synced in settings) + per-device preferences (theme, size, stored locally).
// The brand is also cached in localStorage so the very first paint is already on-brand, even offline.
import { normaliseBrand, themeTokens, type Brand } from '../../shared/theme.ts';

export type Theme = 'dark' | 'light' | 'system';
export const SCALES = [{ label: 'S', value: 0.9 }, { label: 'M', value: 1 }, { label: 'L', value: 1.15 }, { label: 'XL', value: 1.3 }];
export const WALL_SCALES = [{ label: 'S', value: 0.85 }, { label: 'M', value: 1 }, { label: 'L', value: 1.2 }, { label: 'XL', value: 1.45 }];

const get = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const put = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage full or blocked */ } };

export const prefs = {
  theme: () => get('p0.theme', 'dark') as Theme,
  scale: () => Number(get('p0.scale', '1')) || 1,
  wallScale: () => Number(get('p0.wallScale', '1')) || 1,
};

let brand: Brand = (() => { try { return normaliseBrand(JSON.parse(get('p0.brand', 'null'))); } catch { return normaliseBrand(null); } })();

const media = matchMedia('(prefers-color-scheme: light)');
export const currentMode = () => {
  const t = prefs.theme();
  return t === 'system' ? (media.matches ? 'light' : 'dark') : t;
};

export function applyDisplay() {
  const mode = currentMode();
  const root = document.documentElement;
  root.dataset.theme = mode;
  for (const [k, v] of Object.entries(themeTokens(brand, mode))) root.style.setProperty(k, v);
  root.style.setProperty('--ui-scale', String(prefs.scale()));
  root.style.setProperty('--wall-scale', String(prefs.wallScale()));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeTokens(brand, mode)['--bg']);
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) { icon.href = brand.logo ?? '/icon.svg'; icon.type = brand.logo ? 'image/png' : 'image/svg+xml'; }
}
media.addEventListener('change', applyDisplay);

export function setPref(k: 'theme' | 'scale' | 'wallScale', v: string | number) { put(`p0.${k}`, String(v)); applyDisplay(); }

/** Called whenever the synced settings change. */
export function setBrand(b: Partial<Brand> | null | undefined) {
  const next = normaliseBrand(b);
  if (JSON.stringify(next) === JSON.stringify(brand)) return;
  brand = next;
  put('p0.brand', JSON.stringify(brand));
  applyDisplay();
}
