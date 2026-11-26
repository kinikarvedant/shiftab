import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/index.ts';

// Starts a server on `dir`, returns its database's instance id, and shuts it down again.
async function instanceOf(dir: string) {
  const { app } = buildApp({ dataDir: dir, production: false, logger: false, setupCode: 'TEST-CODE' });
  const id = (await app.inject({ method: 'GET', url: '/api/state' })).json().instance as string;
  await app.close();
  return id;
}

test('RESET_DATABASE starts with an empty database once per new value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftab-reset-'));
  try {
    delete process.env.RESET_DATABASE;
    const first = await instanceOf(dir);
    assert.equal(await instanceOf(dir), first, 'a normal restart keeps the same database');
    process.env.RESET_DATABASE = 'demo-1';
    const reset = await instanceOf(dir);
    assert.notEqual(reset, first, 'a new value starts a fresh database');
    assert.equal(await instanceOf(dir), reset, 'the same value does not wipe it again');
    process.env.RESET_DATABASE = 'demo-2';
    assert.notEqual(await instanceOf(dir), reset, 'another new value resets again');
  } finally {
    delete process.env.RESET_DATABASE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the setup code stays the same across restarts until a reset', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftab-code-'));
  const codeOf = async () => { const { app, ctx } = buildApp({ dataDir: dir, production: false, logger: false }); await app.close(); return ctx.config.setupCode; };
  try {
    delete process.env.RESET_DATABASE;
    delete process.env.SETUP_CODE;
    const first = await codeOf();
    assert.match(first, /^[0-9A-F]{10}$/);
    assert.equal(await codeOf(), first, 'a restart keeps the code people already copied');
    process.env.RESET_DATABASE = 'fresh';
    assert.notEqual(await codeOf(), first, 'a reset issues a new code');
  } finally {
    delete process.env.RESET_DATABASE;
    rmSync(dir, { recursive: true, force: true });
  }
});
