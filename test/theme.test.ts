// Every brand combination must stay readable: WCAG AA text, 3:1 non-text, in dark and light.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditTokens, contrast, paletteFromPixels, PRESET_IDS, themeTokens, toOklch, fromOklch, type Brand, type Neutral } from '../shared/theme.ts';

const NEUTRALS: Neutral[] = ['cool', 'warm', 'neutral'];
const CUSTOM = ['#FFE000', '#FFFFFF', '#000000', '#111111', '#FFB6C1', '#00FF00', '#0000FF', '#7F7F7F', '#FF0000', '#00FFFF'];

function check(brand: Partial<Brand>, label: string) {
  for (const mode of ['dark', 'light'] as const) {
    const a = auditTokens(themeTokens(brand, mode));
    const where = `${label} ${mode}`;
    assert.ok(a.text >= 7, `${where}: text ${a.text.toFixed(2)}`);
    assert.ok(a.muted >= 4.5, `${where}: muted ${a.muted.toFixed(2)}`);
    assert.ok(a.borderStrong >= 3, `${where}: border-strong ${a.borderStrong.toFixed(2)}`);
    assert.ok(a.accent >= 4.5, `${where}: accent ${a.accent.toFixed(2)}`);
    assert.ok(a.onAccent >= 4.5, `${where}: on-accent ${a.onAccent.toFixed(2)}`);
    assert.ok(a.accentOnSoft >= 4.5, `${where}: accent on soft ${a.accentOnSoft.toFixed(2)}`);
    assert.ok(a.status >= 4.5, `${where}: status ${a.status.toFixed(2)}`);
    assert.ok(a.statusOnSoft >= 4.5, `${where}: status on soft ${a.statusOnSoft.toFixed(2)}`);
    assert.ok(a.onStatus >= 4.5, `${where}: on-status ${a.onStatus.toFixed(2)}`);
  }
}

test('every preset on every neutral is AA readable', () => {
  for (const preset of PRESET_IDS) for (const neutral of NEUTRALS) check({ preset, neutral }, `${preset}/${neutral}`);
});

test('hostile custom brand colours are corrected to AA', () => {
  for (const accent of CUSTOM) for (const neutral of NEUTRALS) check({ preset: 'custom', accent, neutral }, `${accent}/${neutral}`);
});

test('invalid brand data falls back to defaults', () => {
  assert.equal(themeTokens({ preset: 'nope' } as any, 'dark')['--accent'], themeTokens(undefined, 'dark')['--accent']);
  assert.equal(themeTokens({ preset: 'custom', accent: 'red' } as any, 'light')['--accent'], themeTokens(undefined, 'light')['--accent']);
});

test('colour maths round-trips and contrast is WCAG', () => {
  for (const hex of ['#D2693F', '#3566D6', '#116B34']) assert.equal(fromOklch(...toOklch(hex)), hex);
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(1), '21.0');
});

test('logo palette ignores greys and transparency', () => {
  const px = [255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 210, 105, 63, 255, 210, 105, 63, 255, 50, 100, 220, 0];
  const p = paletteFromPixels(px);
  assert.equal(p.length, 1);
  assert.equal(p[0], '#D2693F');
});
