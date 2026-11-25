import test from 'node:test';
import assert from 'node:assert/strict';
import { codeAt, stepAt } from '../src/totp.js';
import { hashPassword } from '../src/auth.js';
import { authenticator } from './fake-authenticator.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);
// The HTTPS name a proxy says the page was on, which passkeys belong to
const HTTPS = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'air.example.net' };

async function node() {
  const { Store } = await import('../src/store.js');
  const { Accounts } = await import('../src/accounts.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:', 'base');
  const accounts = new Accounts(store.db);
  accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  accounts.create({ username: 'bob', password: 'battery staple', role: 'viewer' });
  const manager = Object.assign(new EventEmitter(), { radios: () => [] });
  const config = { host: '127.0.0.1', auth: { passwordHash: hashPassword('file password') } };
  const server = createApp({ manager, store, sidecar: {}, config, dataDir: '.', accounts }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, accounts, base: `http://127.0.0.1:${server.address().port}/api` };
}

/** A browser: its cookies, kept between requests. */
function browser(base) {
  const jar = new Map();
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      if (!v || attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a))) jar.delete(k.trim());
      else jar.set(k.trim(), v.trim());
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, jar };
}

test('two-step through the API: set up, sign in, Admin’s check apart', { skip: !sqlite }, async () => {
  const { server, base } = await node();
  try {
    const b = browser(base);
    const signIn = (who = b) => who.call('POST', '/login', { username: 'alice', password: 'correct horse' });
    assert.equal((await signIn()).body.ok, true, 'no two-step yet: signed in on the password');
    const old = browser(base);
    await signIn(old);

    // An admin without it reads, and is told to set it up to do more
    assert.equal((await b.call('GET', '/transmissions')).status, 200);
    const radio = await b.call('POST', '/radios/02:00:00:00:00:01/connect');
    assert.deepEqual([radio.status, radio.body.twoStep], [403, 'setup']);
    assert.equal((await b.call('GET', '/admin/users')).body.twoStep, 'setup');
    assert.equal((await b.call('GET', '/session')).body.canOperate, false);

    // Setting it up asks for the password again first
    assert.equal((await b.call('POST', '/two-step/authenticator/start')).body.twoStep, 'password');
    assert.equal((await b.call('POST', '/two-step/password', { password: 'wrong' })).status, 403);
    assert.equal((await b.call('POST', '/two-step/password', { password: 'correct horse' })).status, 200);
    const { key } = (await b.call('POST', '/two-step/authenticator/start')).body;
    const secret = key.replace(/ /g, '');
    const now = stepAt(Date.now());
    const on = await b.call('POST', '/two-step/authenticator/enable', { code: codeAt(secret, now) });
    assert.equal(on.body.recoveryCodes.length, 10);
    const codes = on.body.recoveryCodes;
    // Just set up, with the password and a code: both checks are passed
    assert.equal((await b.call('POST', '/radios/02:00:00:00:00:01/connect')).status, 404, 'past the guard: no such radio');
    assert.equal((await b.call('GET', '/admin/users')).status, 200);

    // A browser signed in before it was set up: asked for a step before the radios
    const asked = await old.call('POST', '/radios/02:00:00:00:00:01/connect');
    assert.deepEqual([asked.status, asked.body.twoStep], [403, 'step']);
    await old.call('POST', '/two-step/check', { code: codes[1] });
    assert.equal((await old.call('POST', '/radios/02:00:00:00:00:01/connect')).status, 404);
    assert.equal((await old.call('GET', '/admin/users')).body.twoStep, 'verify', 'a step for the radios isn’t Admin’s check');

    // Signing in again: the password alone; the second step is asked for when the radios need it
    const c = browser(base);
    assert.equal((await signIn(c)).body.ok, true, 'signed in on the password');
    assert.equal((await c.call('GET', '/transmissions')).status, 200);
    assert.equal((await c.call('POST', '/radios/02:00:00:00:00:01/connect')).body.twoStep, 'step');
    assert.equal((await c.call('POST', '/two-step/check', { code: '000000' })).status, 403);
    await c.call('POST', '/two-step/check', { code: codeAt(secret, now + 1), remember: true });
    assert.ok(c.jar.has('airscribe_browser'));
    assert.equal((await c.call('POST', '/radios/02:00:00:00:00:01/connect')).status, 404, 'the radios, once asked');
    const admin = await c.call('GET', '/admin/users');
    assert.deepEqual([admin.status, admin.body.twoStep], [403, 'verify'], 'Admin wants a check of its own');
    const s = (await c.call('GET', '/session')).body;
    assert.deepEqual([s.canOperate, s.canAdmin], [true, false]);
    const check = await c.call('POST', '/two-step/check', { code: codes[0], admin: true });
    assert.equal(check.body.recoveryCodesLeft, 8);
    assert.equal((await c.call('GET', '/admin/users')).status, 200);
    assert.ok((await c.call('GET', '/session')).body.twoStep.checkedUntil > Date.now() + 11 * 3600000);

    // The remembered browser signs in on the password alone, stepped, and Admin still asks
    await c.call('POST', '/logout');
    assert.equal((await signIn(c)).body.ok, true);
    assert.equal((await c.call('POST', '/radios/02:00:00:00:00:01/connect')).status, 404);
    assert.equal((await c.call('GET', '/admin/users')).body.twoStep, 'verify');

    // Asked at sign-in too, when the account chooses it; turning that off wants a recent step
    assert.equal((await c.call('PUT', '/two-step/ask-at-signin', { on: true })).body.askAtSignIn, true);
    const d = browser(base);
    const first = await signIn(d);
    assert.deepEqual([first.body.ok, first.body.twoStep, first.body.methods.authenticator], [false, 'signin', true]);
    assert.equal((await d.call('GET', '/transmissions')).status, 401, 'not signed in until the second step');
    assert.equal((await d.call('POST', '/login/two-step', { code: '000000' })).status, 403);
    assert.equal((await d.call('POST', '/login/two-step', { code: codes[2] })).body.ok, true);
    assert.equal((await d.call('POST', '/radios/02:00:00:00:00:01/connect')).status, 404, 'the sign-in step counts for the radios');
    const off = await d.call('PUT', '/two-step/ask-at-signin', { on: false });
    assert.equal(off.body.askAtSignIn, false, 'the sign-in step was recent');

    // A viewer still can't, whatever they set up
    const v = browser(base);
    await v.call('POST', '/login', { username: 'bob', password: 'battery staple' });
    assert.equal((await v.call('GET', '/admin/users')).status, 403);
    assert.equal((await v.call('GET', '/admin/users')).body.twoStep, undefined, 'a role, not a step, is what’s missing');
  } finally {
    server.close();
  }
});

test('passkeys through the API: added on the HTTPS name, a second step only', { skip: !sqlite }, async () => {
  const { server, base, accounts } = await node();
  try {
    const b = browser(base);
    await b.call('POST', '/login', { username: 'alice', password: 'correct horse' });
    await b.call('POST', '/two-step/password', { password: 'correct horse' });
    assert.match((await b.call('POST', '/two-step/passkeys/options')).body.error, /HTTPS/, 'not on plain http');
    const options = (await b.call('POST', '/two-step/passkeys/options', undefined, HTTPS)).body;
    assert.equal(options.rp.id, 'air.example.net');
    const key = authenticator();
    const added = await b.call('POST', '/two-step/passkeys', { credential: key.create(options), name: 'Test key' }, HTTPS);
    assert.equal(added.body.passkey.name, 'Test key');
    assert.equal(added.body.recoveryCodes.length, 10);

    // Never on its own: there's no signing in on a passkey without a password or a linked account
    const p = browser(base);
    await p.call('POST', '/login', { username: 'alice', password: 'correct horse' }, HTTPS);
    assert.equal((await p.call('POST', '/login/passkey/options', undefined, HTTPS)).status, 404, 'no such route');
    assert.equal((await p.call('GET', '/admin/users')).body.twoStep, 'step', 'not stepped: the radios’ step first');
    const check = (await p.call('POST', '/two-step/check/options', undefined, HTTPS)).body;
    assert.equal((await p.call('POST', '/two-step/check', { credential: key.get(check), admin: true }, HTTPS)).status, 200);
    assert.equal((await p.call('GET', '/admin/users')).status, 200);

    // As a sign-in's second step, for an account that asked for one, and not on another name
    accounts.twoStep.setAskAtSignIn(1, true);
    const q = browser(base);
    const first = await q.call('POST', '/login', { username: 'alice', password: 'correct horse' }, HTTPS);
    assert.equal(first.body.methods.passkey, true);
    const other = await q.call('POST', '/login/two-step/options', undefined, { ...HTTPS, 'x-forwarded-host': 'elsewhere.example.net' });
    assert.match(other.body.error, /no passkey for this address/);
    const step = (await q.call('POST', '/login/two-step/options', undefined, HTTPS)).body;
    assert.equal((await q.call('POST', '/login/two-step', { credential: key.get(step) }, HTTPS)).body.ok, true);

    // Removing it needs a recent step; an admin resets another's
    const id = encodeURIComponent(key.id);
    assert.equal((await q.call('DELETE', `/two-step/passkeys/${id}`)).status, 200, 'the sign-in step is recent');
    assert.equal(accounts.twoStep.isSetUp(1), false);
  } finally {
    server.close();
  }
});

test('Admin → Users resets another account’s two-step; the settings file’s password passes both checks', { skip: !sqlite }, async () => {
  const { server, base, accounts } = await node();
  try {
    accounts.twoStep.startAuthenticator(2, 'bob');
    const secret = accounts.db.prepare('SELECT secret FROM authenticators WHERE user_id = 2').get().secret;
    accounts.twoStep.enableAuthenticator(2, codeAt(secret, stepAt(Date.now())));
    const f = browser(base);
    assert.equal((await f.call('POST', '/login', { password: 'file password' })).body.ok, true);
    assert.equal((await f.call('GET', '/admin/users')).status, 200, 'the way back in');
    const r = await f.call('POST', '/admin/users/2/two-step/reset');
    assert.equal(r.body.two_step, false);
    assert.equal(accounts.twoStep.isSetUp(2), false);
    const proxied = await browser(base).call('POST', '/login', { password: 'file password' }, { 'x-forwarded-for': '203.0.113.7' });
    assert.equal(proxied.status, 401, 'but not through a proxy');
  } finally {
    server.close();
  }
});
