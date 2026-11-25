import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/api.js';
import { hashPassword } from '../src/auth.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);

/** What a visitor who isn't signed in may reach under /api (docs/publishing.md#one-address). */
const SIGNED_OUT = [
  /^\/(login|logout|session|register)$/,
  /^\/invite\//,
  /^\/auth\//,
  /^\/login\/(two-step|passkey)/,
  /^\/public\//,
];

/** Every route the API has, with a 1 for each parameter. */
function routes(app) {
  const out = [];
  for (const layer of app.router.stack) {
    for (const l of layer.handle?.stack ?? []) {
      if (!l.route) continue;
      const path = l.route.path.replace(/:\w+/g, '1');
      for (const method of Object.keys(l.route.methods)) out.push({ method: method.toUpperCase(), path });
    }
  }
  return out;
}

async function serve() {
  const { Store } = await import('../src/store.js');
  const { Accounts } = await import('../src/accounts.js');
  const { Logins } = await import('../src/logins.js');
  const store = new Store(':memory:', 'base');
  const accounts = new Accounts(store.db);
  accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  const logins = new Logins({ store, accounts });
  const manager = Object.assign(new EventEmitter(), { radios: () => [], engines: new Map(), primary: 'base', extra: [] });
  const config = { host: '127.0.0.1', auth: { passwordHash: hashPassword('file password'), tokens: ['secret'] } };
  const app = createApp({
    manager, store, sidecar: {}, config, dataDir: '.', accounts, logins, updates: {}, cleanup: {}, radioreference: {},
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { app, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('signed out, every route but signing in and the public ones answers 401', { skip: !sqlite }, async () => {
  const s = await serve();
  try {
    const all = routes(s.app);
    assert.ok(all.length > 80, `the walk found the routes (${all.length})`);
    const closed = all.filter((r) => !SIGNED_OUT.some((re) => re.test(r.path)));
    for (const { method, path } of closed) {
      const res = await fetch(`${s.base}/api${path}`, {
        method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
      });
      assert.equal(res.status, 401, `${method} /api${path}`);
    }
    // And the open ones are few, and named
    const open = all.filter((r) => SIGNED_OUT.some((re) => re.test(r.path))).map((r) => r.path);
    assert.ok(open.every((p) => /^\/(login|logout|session|register|invite|auth|public)\b/.test(p)), open.join(' '));
  } finally { s.close(); }
});

test('one address: the page, the health check and the public routes, signed out', { skip: !sqlite }, async () => {
  const s = await serve();
  try {
    assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
    const page = await (await fetch(`${s.base}/`)).text();
    assert.match(page, /id="public-view"/, 'the page carries the public view');
    assert.equal((await fetch(`${s.base}/live.html`)).status, 404, 'the old separate page is gone');
    // A sign-in provider's consent screen links to these: they're read signed out
    for (const p of ['privacy.html', 'terms.html']) {
      const r = await fetch(`${s.base}/${p}`);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /AirScribe/);
      assert.match(page, new RegExp(`href="${p}"`), `the page links ${p}`);
    }
    const session = await (await fetch(`${s.base}/api/session`)).json();
    assert.deepEqual([session.guarded, session.authenticated], [true, false]);
    assert.equal((await (await fetch(`${s.base}/api/public/filters`)).json()).enabled, false, 'nothing published by default');
    assert.equal((await fetch(`${s.base}/api/public/transmissions`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/nothing-here`)).status, 401, 'nor what isn’t there');
  } finally { s.close(); }
});

test('signed in, the same address is the console', { skip: !sqlite }, async () => {
  const s = await serve();
  try {
    const bearer = { headers: { authorization: 'Bearer secret' } };
    assert.equal((await fetch(`${s.base}/api/radios`, bearer)).status, 200);
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'file password' }),
    });
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('airscribe_session='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.equal((await fetch(`${s.base}/api/radios`, { headers: { cookie: cookie.split(';')[0] } })).status, 200);
  } finally { s.close(); }
});

test('a viewer reads transcripts but cannot touch a radio', async () => {
  const store = { radios: () => [], radio: () => undefined, transmission: () => undefined, transmissions: () => [], countTransmissions: () => 0 };
  const manager = Object.assign(new EventEmitter(), { radios: () => [], engines: new Map([['base', {}]]), primary: 'base', extra: [] });
  const config = { host: '127.0.0.1', auth: { tokens: [{ name: 'club', token: 'v', role: 'viewer' }] } };
  const server = createApp({ manager, store, sidecar: {}, config, dataDir: '.' }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const v = { headers: { authorization: 'Bearer v' } };
  try {
    assert.equal((await fetch(`${base}/api/transmissions`, v)).status, 200);
    const res = await fetch(`${base}/api/radios/AA:BB:CC:DD:EE:FF/connect`, { method: 'POST', ...v });
    assert.equal(res.status, 403, 'reading is not administering');
  } finally { server.close(); }
});
