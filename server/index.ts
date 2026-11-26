// Shiftab server: API + static PWA. Run: node server/index.ts (Node >= 22.18).
import { createHash, randomBytes } from 'node:crypto';
import { brotliCompressSync, constants as zlibConst, gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb } from './db.ts';
import { initSecret } from './security.ts';
import { authRoutes, type Config, type Ctx } from './auth.ts';
import { syncRoutes } from './sync.ts';
import { staffRoutes } from './staff.ts';
import { financeRoutes } from './finance.ts';
import { DEMO, startDemo } from './demo.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function buildApp(opts: { dataDir: string; production: boolean; setupCode?: string; logger?: boolean; trustProxy?: boolean }) {
  mkdirSync(opts.dataDir, { recursive: true });

  // APP_SECRET encrypts PIN keys, TOTP secrets and pay rates. Back it up with the database.
  let secret = process.env.APP_SECRET;
  if (!secret) {
    const file = join(opts.dataDir, '.secret');
    if (!existsSync(file)) writeFileSync(file, randomBytes(48).toString('base64url'), { mode: 0o600 });
    secret = readFileSync(file, 'utf8').trim();
  }
  initSecret(secret);

  // Demo reset: give RESET_DATABASE a NEW value and the next start begins with an empty database (once per value).
  // Backups in DATA_DIR/backups are kept, so a reset can be undone by restoring the latest one.
  const reset = process.env.RESET_DATABASE;
  if (reset) {
    const mark = join(opts.dataDir, `.reset-${createHash('sha256').update(reset).digest('hex').slice(0, 16)}`);
    if (!existsSync(mark)) {
      for (const f of ['p0rtal.db', 'p0rtal.db-wal', 'p0rtal.db-shm', '.setup-code']) rmSync(join(opts.dataDir, f), { force: true });
      writeFileSync(mark, new Date().toISOString());
      console.warn('RESET_DATABASE: started with an empty database (backups kept). A new setup code follows.');
    }
  }
  const db = openDb(join(opts.dataDir, 'p0rtal.db')); // file keeps the first project name so existing installs open as-is
  // The first-run setup code survives restarts and redeploys (saved beside the database) until a reset.
  const codeFile = join(opts.dataDir, '.setup-code');
  let saved = existsSync(codeFile) ? readFileSync(codeFile, 'utf8').trim() : '';
  if (!saved && !opts.setupCode && !process.env.SETUP_CODE) { saved = randomBytes(5).toString('hex'); writeFileSync(codeFile, saved, { mode: 0o600 }); }
  const setupCode = (opts.setupCode ?? process.env.SETUP_CODE ?? saved).toUpperCase();
  const config: Config = { production: opts.production, dataDir: opts.dataDir, setupCode };
  const ctx: Ctx = { db, config, broadcast: () => {} };

  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 1_048_576, trustProxy: opts.trustProxy ?? false });
  app.addHook('onClose', async () => db.raw.close());

  app.addHook('onRequest', async (req, reply) => {
    // CSRF: every state-changing request must come from our own origin (whatever the path encoding).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      let ok = false;
      try { ok = !!origin && new URL(origin).host === new URL(`${req.protocol}://${req.host}`).host; } catch { /* bad origin */ }
      if (!ok) return reply.code(403).send({ error: 'Cross-origin request refused.' });
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
    if (opts.production) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  // Compress JSON replies (sync pulls, report data): a first sync or a year's report shrinks ~5x on mobile data.
  // Static files are pre-compressed at build time instead (scripts/compress.ts + preCompressed below).
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' || payload.length < 1024 || reply.getHeader('content-encoding')) return payload;
    if (!String(reply.getHeader('content-type') ?? '').includes('json')) return payload;
    const accept = String(req.headers['accept-encoding'] ?? '');
    const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (!enc) return payload;
    reply.header('Content-Encoding', enc).header('Vary', 'Accept-Encoding');
    return enc === 'br' ? brotliCompressSync(payload, { params: { [zlibConst.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(payload);
  });

  app.setErrorHandler((err: any, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'Something went wrong on the server.' : err.message, ...(err.extra ?? {}) });
  });

  authRoutes(app, ctx);
  syncRoutes(app, ctx);
  staffRoutes(app, ctx);
  financeRoutes(app, ctx);

  const dist = join(ROOT, 'dist');
  if (existsSync(dist)) {
    app.register(fastifyStatic, {
      root: dist,
      wildcard: true, // serve new build files without a restart
      preCompressed: true, // .br / .gz written by scripts/compress.ts
      setHeaders: (res, path) => {
        res.header('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET' || !existsSync(dist)) return reply.code(404).send({ error: 'Not found' });
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });

  return { app, ctx };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const production = process.env.NODE_ENV === 'production';
  const { app, ctx } = buildApp({
    dataDir: resolve(process.env.DATA_DIR ?? join(ROOT, 'data')),
    production,
    trustProxy: !!process.env.TRUST_PROXY,
  });
  if (DEMO) await startDemo(app, ctx); // sample venue, rebuilt about once an hour
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  if (!ctx.db.raw.prepare("SELECT 1 FROM docs WHERE collection = 'users' LIMIT 1").get()) {
    app.log.warn(`\n\n  First-run setup code: ${ctx.config.setupCode}\n  Open the app and enter it to create the owner account.\n`);
  }
}
