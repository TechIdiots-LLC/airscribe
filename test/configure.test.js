import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure, hasCredential } from '../tools/configure.mjs';
import { verifyPassword } from '../src/auth.js';

const TOOL = new URL('../tools/configure.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

test('a password is stored as a hash, and a plaintext one is removed', () => {
  const c = configure({ auth: { password: 'old-plain', tokens: ['t'] } }, { password: 'correct horse' });
  assert.ok(verifyPassword('correct horse', c.auth.passwordHash));
  assert.equal(c.auth.password, undefined, 'a plaintext password beside the hash would still sign in');
  assert.deepEqual(c.auth.tokens, ['t'], 'tokens are left alone');
});

test('bad values are refused rather than written', () => {
  assert.throws(() => configure({}, { port: '80a' }), /not a port/);
  assert.throws(() => configure({}, { port: 70000 }), /not a port/);
  assert.throws(() => configure({}, { host: '0.0.0.0; rm' }), /not a listen address/);
  assert.throws(() => configure({}, { password: 'short' }), /at least 8/);
});

test('any password or token counts as a credential', () => {
  assert.equal(hasCredential({}), false);
  assert.equal(hasCredential({ auth: { passwordHash: null, tokens: [] } }), false);
  assert.equal(hasCredential({ auth: { passwordHash: 'scrypt$a$b' } }), true);
  assert.equal(hasCredential({ auth: { tokens: ['x'] } }), true);
});

test('the command line keeps the rest of the file and takes the password from the environment', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'configure-')), 'c.json');
  writeFileSync(file, JSON.stringify({ _readme: 'kept', host: '127.0.0.1', port: 8100, stt: { engine: 'mock' } }));
  execFileSync(process.execPath, [TOOL, file, '--host', '0.0.0.0', '--port', '8200', '--password-env', 'PW'],
    { env: { ...process.env, PW: 'from the env' } });
  const c = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(c._readme, 'kept');
  assert.deepEqual(c.stt, { engine: 'mock' });
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 8200);
  assert.ok(verifyPassword('from the env', c.auth.passwordHash));
  assert.ok(!readFileSync(file, 'utf8').includes('from the env'), 'no plaintext in the file');

  const has = (f) => {
    try { execFileSync(process.execPath, [TOOL, f, '--has-credential']); return true; } catch { return false; }
  };
  assert.equal(has(file), true);
  writeFileSync(file, '{}');
  assert.equal(has(file), false);
});
