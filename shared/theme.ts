// Brand theming: curated presets + any custom brand colour, turned into a full token set for
// dark and light themes. Every generated colour is contrast-checked (WCAG 2.x) — see test/theme.test.ts.

export type Mode = 'dark' | 'light';
export type Neutral = 'cool' | 'warm' | 'neutral';
export type HeadingFont = 'modern' | 'classic' | 'bold';
export type Corners = 'sharp' | 'soft' | 'round';
export interface Brand { preset: PresetId | 'custom'; accent: string | null; neutral: Neutral; headingFont: HeadingFont; corners: Corners; logo: string | null }

export const PRESETS = {
  ember: { label: 'Ember', seed: '#D2693F', neutral: 'warm', note: 'Copper & charcoal — bistros, grills' },
  merlot: { label: 'Merlot', seed: '#B23A62', neutral: 'warm', note: 'Wine & walnut — wine bars, fine dining' },
  eucalyptus: { label: 'Eucalyptus', seed: '#3F8F7A', neutral: 'neutral', note: 'Fresh green — cafés, health food' },
  harbour: { label: 'Harbour', seed: '#3566D6', neutral: 'cool', note: 'Deep blue — seafood, hotels' },
  iris: { label: 'Iris', seed: '#6D68EE', neutral: 'cool', note: 'Violet — cocktail bars, late night' },
  graphite: { label: 'Graphite', seed: '#71717A', neutral: 'neutral', note: 'Monochrome — minimalist brands' },
} as const satisfies Record<string, { label: string; seed: string; neutral: Neutral; note: string }>;
export type PresetId = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export const DEFAULT_BRAND: Brand = { preset: 'ember', accent: null, neutral: 'warm', headingFont: 'modern', corners: 'soft', logo: null };

export const HEADING_FONTS: Record<HeadingFont, { label: string; family: string; weight: number; tracking: string }> = {
  modern: { label: 'Modern', family: "'Inter Variable'", weight: 680, tracking: '-0.015em' },
  classic: { label: 'Classic', family: "'Fraunces Variable', Georgia, serif", weight: 600, tracking: '-0.005em' },
  bold: { label: 'Bold', family: "'Bricolage Grotesque Variable', 'Inter Variable'", weight: 700, tracking: '-0.02em' },
};
export const CORNERS: Record<Corners, { label: string; scale: number }> = {
  sharp: { label: 'Sharp', scale: 0.35 }, soft: { label: 'Soft', scale: 1 }, round: { label: 'Round', scale: 1.6 },
};

// Neutral families (bg, surface, surface-2, surface-3, text, text-muted, border, border-strong)
const NEUTRALS: Record<Neutral, Record<Mode, string[]>> = {
  cool: {
    dark: ['#0E1116', '#161A21', '#1F242D', '#282E39', '#F1F3F6', '#A3ACB9', '#2A303A', '#6B7585'],
    light: ['#F5F6F8', '#FFFFFF', '#ECEEF2', '#E1E4EA', '#11151B', '#525B68', '#D9DDE3', '#767F8D'],
  },
  warm: {
    dark: ['#12100E', '#1A1714', '#24201C', '#2F2A25', '#F4F1EC', '#AEA69B', '#332D27', '#776E63'],
    light: ['#F7F5F2', '#FFFFFF', '#EFEBE5', '#E4DED6', '#1C1916', '#5A5249', '#DED7CD', '#807669'],
  },
  neutral: {
    dark: ['#0F0F11', '#18181B', '#222226', '#2C2C31', '#F4F4F5', '#A8A8B0', '#2E2E33', '#72727B'],
    light: ['#F6F6F7', '#FFFFFF', '#EDEDEF', '#E2E2E5', '#18181B', '#55555E', '#DBDBDF', '#7A7A84'],
  },
};
const NEUTRAL_KEYS = ['--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-muted', '--border', '--border-strong'];

const STATUS: Record<Mode, Record<string, string>> = {
  dark: { success: '#4ADE80', warning: '#FBBF24', danger: '#FF7A7A', info: '#4CC3F5' },
  light: { success: '#116B34', warning: '#9A4A05', danger: '#B42228', info: '#03649A' },
};

// ---------- colour maths (sRGB <-> OKLCH, WCAG contrast) ----------
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = Number.parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
}
export const rgbToHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

export function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex).map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

export function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function oklchToLinear(L: number, C: number, H: number) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH -> hex, reducing chroma until the colour fits in sRGB (keeps hue and lightness). */
export function fromOklch(L: number, C: number, H: number): string {
  for (let c = C; c >= 0; c -= 0.005) {
    const lin = oklchToLinear(L, c, H);
    if (lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return rgbToHex(lin.map((v) => toGam(clamp01(v))));
  }
  return rgbToHex(oklchToLinear(L, 0, H).map((v) => toGam(clamp01(v))));
}

/** Mix two colours in OKLab (like CSS color-mix(in oklab, a p, b)). */
export function mix(a: string, b: string, p: number): string {
  const [L1, C1, H1] = toOklch(a), [L2, C2, H2] = toOklch(b);
  const lab = (L: number, C: number, H: number) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  const [x1, y1, z1] = lab(L1, C1, H1), [x2, y2, z2] = lab(L2, C2, H2);
  const L = x1 * p + x2 * (1 - p), A = y1 * p + y2 * (1 - p), B = z1 * p + z2 * (1 - p);
  return fromOklch(L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360);
}

// ---------- accent derivation ----------
const MIN_TEXT = 4.5;

/** Shift lightness (keeping hue/chroma) until `ok` holds; dir +1 lightens, -1 darkens. */
function adjust(seed: string, dir: 1 | -1, ok: (hex: string) => boolean, start?: number) {
  const [L0, C, H] = toOklch(seed);
  let L = start ?? L0;
  let hex = fromOklch(L, C, H);
  for (let i = 0; i < 100 && !ok(hex); i++) { L = clamp01(L + dir * 0.01); hex = fromOklch(L, C, H); }
  return hex;
}

/** Accent family for one mode, guaranteed readable on every surface and with its on-colour. */
export function accentFor(seed: string, mode: Mode, neutral: Neutral) {
  const [bg, surface, surface2] = NEUTRALS[neutral][mode];
  const surfaces = [bg, surface, surface2];
  const [L, C, H] = toOklch(seed);
  if (mode === 'dark') {
    const on = bg;
    const ok = (h: string) => surfaces.every((s) => contrast(h, s) >= MIN_TEXT) && contrast(h, on) >= MIN_TEXT;
    const accent = adjust(seed, 1, ok, C < 0.03 ? 0.9 : Math.max(L, 0.6)); // greys become near-white
    const [La] = toOklch(accent);
    const pressed = fromOklch(La - 0.05, C, H);
    let p = 0.24, soft = mix(accent, surface, p);
    while (contrast(accent, soft) < MIN_TEXT && p > 0.06) { p -= 0.02; soft = mix(accent, surface, p); }
    return { accent, pressed, on, soft };
  }
  const on = '#FFFFFF';
  const ok = (h: string) => surfaces.every((s) => contrast(h, s) >= MIN_TEXT) && contrast(h, on) >= MIN_TEXT;
  const accent = adjust(seed, -1, ok, C < 0.03 ? 0.3 : Math.min(L, 0.6)); // greys become near-black
  const [La] = toOklch(accent);
  const pressed = fromOklch(La - 0.06, C, H);
  let p = 0.12, soft = mix(accent, surface, p);
  while (contrast(accent, soft) < MIN_TEXT && p > 0.04) { p -= 0.02; soft = mix(accent, surface, p); }
  return { accent, pressed, on, soft };
}

export const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

export function normaliseBrand(b: Partial<Brand> | null | undefined): Brand {
  const out = { ...DEFAULT_BRAND, ...(b ?? {}) } as Brand;
  if (out.preset !== 'custom' && !(out.preset in PRESETS)) out.preset = DEFAULT_BRAND.preset;
  if (out.preset === 'custom' && !isHex(out.accent)) out.preset = DEFAULT_BRAND.preset;
  return out;
}

export const seedOf = (b: Brand) => (b.preset === 'custom' && isHex(b.accent) ? b.accent : PRESETS[b.preset as PresetId]?.seed ?? PRESETS.ember.seed);

/** All colour + shape tokens for a brand in one mode, ready to set as CSS custom properties. */
export function themeTokens(brandIn: Partial<Brand> | null | undefined, mode: Mode): Record<string, string> {
  const brand = normaliseBrand(brandIn);
  const n = NEUTRALS[brand.neutral][mode];
  const t: Record<string, string> = {};
  NEUTRAL_KEYS.forEach((k, i) => { t[k] = n[i]; });
  const a = accentFor(seedOf(brand), mode, brand.neutral);
  Object.assign(t, { '--accent': a.accent, '--accent-pressed': a.pressed, '--on-accent': a.on, '--accent-soft': a.soft });
  for (const [k, v] of Object.entries(STATUS[mode])) {
    t[`--${k}`] = v;
    t[`--${k}-soft`] = mix(v, n[1], mode === 'dark' ? 0.16 : 0.12);
  }
  t['--on-status'] = mode === 'dark' ? n[0] : '#FFFFFF';
  const f = HEADING_FONTS[brand.headingFont] ?? HEADING_FONTS.modern;
  t['--font-heading'] = f.family;
  t['--heading-weight'] = String(f.weight);
  t['--heading-tracking'] = f.tracking;
  t['--radius-scale'] = String((CORNERS[brand.corners] ?? CORNERS.soft).scale);
  return t;
}

/** Contrast report used by tests and the Appearance screen. */
export function auditTokens(t: Record<string, string>) {
  const surfaces = [t['--bg'], t['--surface'], t['--surface-2']];
  const min = (fg: string) => Math.min(...surfaces.map((s) => contrast(fg, s)));
  return {
    text: min(t['--text']),
    muted: min(t['--text-muted']),
    borderStrong: Math.min(contrast(t['--border-strong'], t['--bg']), contrast(t['--border-strong'], t['--surface'])),
    accent: min(t['--accent']),
    onAccent: contrast(t['--on-accent'], t['--accent']),
    accentOnSoft: contrast(t['--accent'], t['--accent-soft']),
    status: Math.min(...['success', 'warning', 'danger', 'info'].map((k) => min(t[`--${k}`]))),
    statusOnSoft: Math.min(...['success', 'warning', 'danger', 'info'].map((k) => contrast(t[`--${k}`], t[`--${k}-soft`]))),
    onStatus: Math.min(...['success', 'warning', 'danger', 'info'].map((k) => contrast(t['--on-status'], t[`--${k}`]))),
  };
}

/** Dominant brand-like colours in an image (RGBA pixels): skips transparent, near-white/black and greys. */
export function paletteFromPixels(data: ArrayLike<number>, max = 4): string[] {
  const buckets = new Map<number, { w: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const hex = rgbToHex([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
    const [L, C, H] = toOklch(hex);
    if (C < 0.05 || L < 0.18 || L > 0.96) continue;
    const key = Math.round(H / 20) % 18;
    const bk = buckets.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    const w = C; // favour saturated pixels
    bk.w += w; bk.r += data[i] * w; bk.g += data[i + 1] * w; bk.b += data[i + 2] * w;
    buckets.set(key, bk);
  }
  return [...buckets.values()].sort((a, b) => b.w - a.w).slice(0, max)
    .map((bk) => rgbToHex([bk.r / bk.w / 255, bk.g / bk.w / 255, bk.b / bk.w / 255]));
}
