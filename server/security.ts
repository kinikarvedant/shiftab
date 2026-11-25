// Crypto primitives. Everything here is node:crypto — no third-party crypto.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, pbkdf2, pbkdf2Sync,
  randomBytes, scrypt, timingSafeEqual,
} from 'node:crypto';
import { PIN_CHECK_LABEL, PIN_ITERATIONS, PWD_CHECK_LABEL, PWD_ITERATIONS } from '../shared/schema.ts';

// ---------- passwords: scrypt N=2^17 r=8 p=1 (OWASP minimum) ----------
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

const scryptAsync = (pw: string, salt: Buffer, len: number, o: typeof SCRYPT) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, len, o, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** Burn the same time as a real check so unknown emails can't be detected by timing. */
export const dummyVerify = async (pw: string) => { await verifyPassword(pw, await (dummy ??= hashPassword('dummy-password'))); return false; };

// ---------- tokens ----------
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------- field encryption (AES-256-GCM, key derived from APP_SECRET) ----------
let fieldKey: Buffer | undefined;
export function initSecret(appSecret: string) {
  if (appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
  fieldKey = Buffer.from(hkdfSync('sha256', appSecret, 'p0rtal', 'field-encryption-v1', 32));
}

export function seal(plain: string | Buffer): string {
  if (!fieldKey) throw new Error('secret not initialised');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', fieldKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function open(sealed: string): Buffer {
  if (!fieldKey) throw new Error('secret not initialised');
  if (!sealed.startsWith('v1.')) throw new Error('bad ciphertext');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', fieldKey, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

// ---------- PIN keys (must match src/lib/crypto.ts) ----------
export function makePin(pin: string) {
  const salt = randomBytes(16).toString('base64');
  const key = pbkdf2Sync(pin, Buffer.from(salt, 'base64'), PIN_ITERATIONS, 32, 'sha256');
  const check = createHmac('sha256', key).update(PIN_CHECK_LABEL).digest('base64');
  return { salt, check, keyEnc: seal(key) };
}

/** Password-derived approval key (must match src/lib/crypto.ts derivePwd). Async: 600k iterations. */
export async function makeStrongKey(password: string) {
  const salt = randomBytes(16).toString('base64');
  const key = await new Promise<Buffer>((res, rej) =>
    pbkdf2(password.normalize('NFKC'), Buffer.from(salt, 'base64'), PWD_ITERATIONS, 32, 'sha256', (e, k) => (e ? rej(e) : res(k))));
  const check = createHmac('sha256', key).update(PWD_CHECK_LABEL).digest('base64');
  return { salt, check, keyEnc: seal(key) };
}

export function verifySig(keyEnc: string, message: string, sig: string): boolean {
  const expected = createHmac('sha256', open(keyEnc)).update(message).digest('base64');
  return safeEqual(expected, sig);
}

// ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Returns the matched time-step (for replay protection) or null. Accepts ±1 step of clock drift. */
export function checkTotp(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  for (const s of [step - 1, step, step + 1]) {
    if (s > lastStep && safeEqual(hotp(secret, s), code)) return s;
  }
  return null;
}

export const newTotpSecret = () => base32(randomBytes(20));

// ---------- in-memory rate limiter ----------
// Note: per-process memory; move to the DB/Redis if you ever run more than one server process.
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, windowMs).unref();
  return (key: string) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + windowMs }); return true; }
    return ++h.n <= max;
  };
}
