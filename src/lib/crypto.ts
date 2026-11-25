// WebCrypto helpers. PIN derivation must match server/security.ts makePin().
import { PIN_CHECK_LABEL, PIN_ITERATIONS, PWD_CHECK_LABEL, PWD_ITERATIONS } from '../../shared/schema.ts';

const enc = new TextEncoder();
export const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function assertSecureContext() {
  if (!globalThis.crypto?.subtle) throw new Error('p0rtal must be opened over HTTPS (or localhost) for sign-in and encryption to work.');
}

export async function sha256hex(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveSigner(secret: string, saltB64: string, iterations: number, label: string) {
  assertSecureContext();
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, base, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const check = b64(await crypto.subtle.sign('HMAC', key, enc.encode(label)));
  return { key, check };
}

/** PIN -> non-extractable HMAC signing key + the check value the server published. */
export const derivePin = (pin: string, saltB64: string) => deriveSigner(pin, saltB64, PIN_ITERATIONS, PIN_CHECK_LABEL);

/** Password -> approval key for manager overrides (server/security.ts makeStrongKey). */
export const derivePwd = (password: string, saltB64: string) => deriveSigner(password.normalize('NFKC'), saltB64, PWD_ITERATIONS, PWD_CHECK_LABEL);

export const hmac = async (key: CryptoKey, msg: string) => b64(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));

// ---------- finance vault: AES-GCM, key = PBKDF2(password, per-device salt, 600k) ----------
export async function vaultKey(password: string, saltB64: string) {
  assertSecureContext();
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: 600_000 }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealJson(key: CryptoKey, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}

/** Throws if the key is wrong (AES-GCM authentication fails). */
export async function openJson<T>(key: CryptoKey, box: { iv: string; ct: string }): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

export const randomSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));
