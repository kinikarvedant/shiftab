// p0rtal server: API + static PWA. Run: node server/index.ts (Node >= 22.18).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  const db = openDb(join(opts.dataDir, 'p0rtal.db'));
  const setupCode = (opts.setupCode ?? process.env.SETUP_CODE ?? randomBytes(5).toString('hex')).toUpperCase();
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
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  if (!ctx.db.raw.prepare("SELECT 1 FROM docs WHERE collection = 'users' LIMIT 1").get()) {
    app.log.warn(`\n\n  First-run setup code: ${ctx.config.setupCode}\n  Open the app and enter it to create the owner account.\n`);
  }
}
