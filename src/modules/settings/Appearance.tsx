// Business-wide brand: palette (preset or from the logo), neutrals, heading typeface, corners, logo.
// Every combination is contrast-corrected by shared/theme.ts, and previewed live in both themes.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ImageUp, RotateCcw, ShieldCheck, Trash2, Receipt, Utensils, Armchair, Sparkles } from 'lucide-react';
import { table } from '../../lib/db.ts';
import { write } from '../../lib/sync.ts';
import { logoFromFile } from '../../lib/photo.ts';
import { toast } from '../../ui/index.tsx';
import { Brand as BrandSchema } from '../../../shared/schema.ts';
import {
  auditTokens, CORNERS, DEFAULT_BRAND, HEADING_FONTS, isHex, normaliseBrand, PRESET_IDS, PRESETS, themeTokens,
  type Brand, type Corners, type HeadingFont, type Mode, type Neutral,
} from '../../../shared/theme.ts';
import { useBusy } from './lib.tsx';
import '../floor/floor.css';
import './appearance.css';

const NEUTRALS: { id: Neutral; label: string; hint: string }[] = [
  { id: 'warm', label: 'Warm', hint: 'Stone & charcoal' },
  { id: 'cool', label: 'Cool', hint: 'Slate & ink' },
  { id: 'neutral', label: 'Neutral', hint: 'Pure greys' },
];

export default function Appearance() {
  const saved = useLiveQuery(async () => (await table('settings').get('business')) ?? null, []);
  const [draft, setDraft] = useState<Brand | null>(null);
  const [logoColours, setLogoColours] = useState<string[]>([]);
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);
  const savedBrand = useMemo(() => normaliseBrand(saved?.brand), [saved]);
  useEffect(() => { if (saved !== undefined) setDraft(savedBrand); }, [savedBrand]); // eslint-disable-line react-hooks/exhaustive-deps

  if (saved === undefined || !draft) return <div className="skeleton" style={{ height: '30rem' }} />;
  if (!saved) return <p className="muted">Settings haven't synced to this device yet.</p>;

  const b = draft;
  const set = (p: Partial<Brand>) => setDraft({ ...b, ...p });
  const dirty = JSON.stringify(b) !== JSON.stringify(savedBrand);
  const custom = b.preset === 'custom';

  async function pickLogo(file?: File) {
    if (!file) return;
    try {
      const { dataUrl, palette } = await logoFromFile(file);
      setLogoColours(palette);
      set({ logo: dataUrl });
      toast(palette.length ? 'Logo added — pick one of its colours below to match your brand.' : 'Logo added.', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  }

  function save() {
    const parsed = BrandSchema.safeParse(b);
    if (!parsed.success) return toast('Those brand settings are not valid.', 'error');
    const { id: _i, updatedAt: _u, updatedBy: _b, ...rest } = saved!;
    void run(async () => { await write('settings', { id: 'business', ...rest, brand: parsed.data }); toast('Brand saved — every device updates automatically.', 'success'); });
  }

  return (
    <div className="appearance stack lg">
      <p className="muted">Your brand applies to every device and screen, including the kitchen display and printed reports.
        Colours are adjusted automatically so text always stays readable.</p>

      <div className="appearance-grid">
        <div className="stack lg">
          <section className="card pad-lg stack" aria-labelledby="ap-logo">
            <h3 id="ap-logo">Logo</h3>
            <div className="logo-stage">
              {(['dark', 'light'] as Mode[]).map((m) => (
                <div key={m} className="logo-tile" style={themeTokens(b, m) as CSSProperties}>
                  {b.logo ? <img src={b.logo} alt={`Logo on ${m} background`} /> : <span className="muted small">No logo</span>}
                </div>
              ))}
            </div>
            <div className="row">
              <button className="btn outline" onClick={() => fileRef.current?.click()}><ImageUp /> {b.logo ? 'Replace logo' : 'Upload logo'}</button>
              {b.logo && <button className="btn ghost" onClick={() => { set({ logo: null }); setLogoColours([]); }}><Trash2 /> Remove</button>}
            </div>
            <p className="hint muted xs">PNG with a transparent background works best. SVG and JPG are converted on this device.</p>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden
              onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = ''; }} />
            {logoColours.length > 0 && (
              <div className="stack sm">
                <span className="small strong row nowrap"><Sparkles size={16} aria-hidden="true" /> Colours from your logo</span>
                <div className="row">
                  {logoColours.map((c) => (
                    <button key={c} className="swatch-btn" aria-pressed={custom && b.accent === c} onClick={() => set({ preset: 'custom', accent: c })}>
                      <span className="swatch" style={{ background: c }} aria-hidden="true" /><span className="code small">{c}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="card pad-lg stack" aria-labelledby="ap-colour">
            <div className="row between">
              <h3 id="ap-colour">Colour</h3>
              <button className="btn ghost sm" onClick={() => setDraft({ ...DEFAULT_BRAND, logo: b.logo })}><RotateCcw /> Default look</button>
            </div>
            <div className="preset-grid" role="radiogroup" aria-labelledby="ap-colour">
              {PRESET_IDS.map((id) => {
                const p = PRESETS[id];
                const d = themeTokens({ ...b, preset: id }, 'dark'), l = themeTokens({ ...b, preset: id }, 'light');
                return (
                  <button key={id} className="preset" role="radio" aria-checked={b.preset === id} onClick={() => set({ preset: id, neutral: p.neutral, accent: null })}>
                    <span className="preset-swatches" aria-hidden="true">
                      <span style={{ background: d['--bg'] }}><i style={{ background: d['--accent'] }} /></span>
                      <span style={{ background: l['--surface-2'] }}><i style={{ background: l['--accent'] }} /></span>
                    </span>
                    <span className="preset-name">{p.label}{b.preset === id && <Check size={16} aria-hidden="true" />}</span>
                    <span className="xs muted">{p.note}</span>
                  </button>
                );
              })}
              <label className={`preset custom${custom ? ' on' : ''}`}>
                <span className="preset-swatches" aria-hidden="true">
                  <span style={{ background: custom && isHex(b.accent) ? b.accent : 'var(--surface-3)' }} />
                </span>
                <span className="preset-name">Custom{custom && <Check size={16} aria-hidden="true" />}</span>
                <span className="row nowrap">
                  <input type="color" aria-label="Pick a custom brand colour" value={custom && isHex(b.accent) ? b.accent : '#D2693F'}
                    onChange={(e) => set({ preset: 'custom', accent: e.target.value.toUpperCase() })} />
                  <input className="input code hex-input" aria-label="Brand colour hex code" maxLength={7} placeholder="#RRGGBB"
                    defaultValue={custom ? b.accent ?? '' : ''} key={custom ? b.accent : 'none'}
                    onBlur={(e) => { const v = e.target.value.trim(); if (isHex(v)) set({ preset: 'custom', accent: v.toUpperCase() }); else if (v) toast('Use a hex colour like #D2693F.', 'error'); }} />
                </span>
              </label>
            </div>
          </section>

          <section className="card pad-lg stack" aria-labelledby="ap-style">
            <h3 id="ap-style">Style</h3>
            <div className="style-row">
              <span className="small strong">Background tone</span>
              <div className="seg" role="group" aria-label="Background tone">
                {NEUTRALS.map((n) => <button key={n.id} aria-pressed={b.neutral === n.id} onClick={() => set({ neutral: n.id })} title={n.hint}>{n.label}</button>)}
              </div>
            </div>
            <div className="style-row">
              <span className="small strong">Headings</span>
              <div className="seg" role="group" aria-label="Heading typeface">
                {(Object.keys(HEADING_FONTS) as HeadingFont[]).map((f) => (
                  <button key={f} aria-pressed={b.headingFont === f} onClick={() => set({ headingFont: f })}
                    style={{ fontFamily: HEADING_FONTS[f].family, fontWeight: HEADING_FONTS[f].weight }}>{HEADING_FONTS[f].label}</button>
                ))}
              </div>
            </div>
            <div className="style-row">
              <span className="small strong">Corners</span>
              <div className="seg" role="group" aria-label="Corner style">
                {(Object.keys(CORNERS) as Corners[]).map((c) => (
                  <button key={c} aria-pressed={b.corners === c} onClick={() => set({ corners: c })}>
                    <span className="corner-glyph" style={{ borderRadius: `calc(.35rem * ${CORNERS[c].scale})` }} aria-hidden="true" />{CORNERS[c].label}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>

        <section className="stack preview-col" aria-label="Live preview">
          <div className="row between"><h3>Preview</h3><Contrast brand={b} /></div>
          {(['dark', 'light'] as Mode[]).map((m) => <Preview key={m} brand={b} mode={m} name={saved.name} />)}
        </section>
      </div>

      {dirty && (
        <div className="save-bar" role="region" aria-label="Unsaved brand changes">
          <span className="small strong">Unsaved changes</span>
          <div className="row nowrap">
            <button className="btn ghost" disabled={busy} onClick={() => setDraft(savedBrand)}>Discard</button>
            <button className="btn primary" disabled={busy} onClick={save}><Check /> Save brand</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Contrast({ brand }: { brand: Brand }) {
  const worst = Math.min(...(['dark', 'light'] as Mode[]).map((m) => {
    const a = auditTokens(themeTokens(brand, m));
    return Math.min(a.accent, a.onAccent, a.muted, a.status);
  }));
  return <span className="pill success" title="Lowest text contrast across both themes"><ShieldCheck aria-hidden="true" /> AA readable · {worst.toFixed(1)}:1</span>;
}

function Preview({ brand, mode, name }: { brand: Brand; mode: Mode; name: string }) {
  const tokens = themeTokens(brand, mode);
  return (
    <div className="preview" style={{ ...(tokens as CSSProperties), colorScheme: mode }} aria-label={`${mode} theme preview`}>
      <div className="preview-bar">
        {brand.logo ? <img src={brand.logo} alt="" className="brand-logo" /> : <img src="/icon.svg" alt="" className="brand-mark" />}
        <span className="preview-name">{name}</span>
        <span className="pill accent">{mode === 'dark' ? 'Dark' : 'Daylight'}</span>
      </div>
      <div className="preview-body">
        <h2 className="preview-title">Table T4</h2>
        <div className="preview-tables">
          <span className="table-card free"><b>T1</b><span className="t-state"><Armchair aria-hidden="true" />Free</span></span>
          <span className="table-card ordered"><b>T2</b><span className="t-state"><Utensils aria-hidden="true" />Ordered</span></span>
          <span className="table-card bill"><b>T3</b><span className="t-state"><Receipt aria-hidden="true" />Bill</span></span>
        </div>
        <div className="row">
          <span className="chip" aria-pressed="true">Mains</span>
          <span className="chip">Drinks</span>
          <span className="pill success">Synced</span>
          <span className="pill warning">Offline</span>
        </div>
        <div className="row between preview-total"><span className="muted">Total</span><span className="money strong">$64.50</span></div>
        <div className="row">
          <span className="btn outline sm" aria-hidden="true">Send</span>
          <span className="btn primary sm" aria-hidden="true">Pay $64.50</span>
        </div>
      </div>
    </div>
  );
}
