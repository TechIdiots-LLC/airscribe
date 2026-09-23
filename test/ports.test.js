import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/api.js';
import { hashPassword } from '../src/auth.js';

const store = {
  radios: () => [], radio: () => undefined,
  transmission: () => undefined, transmissions: () => [],
};
const manager = Object.assign(new EventEmitter(), {
  radios: () => [], engines: new Map([['base', {}]]), primary: 'base', extra: [],
  disconnect: async () => {}, connect: async () => {},
});

/** @returns {Promise<object>} An app on two ports, with both URLs. */
async function twoPorts(auth = { tokens: ['secret'] }) {
  // Bind the admin listener first so its port is known before the app is
  // built, which is what the gate keys on.
  const probe = (await import('node:net')).createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const adminPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const config = { host: '127.0.0.1', port: 0, adminPort, adminHost: '127.0.0.1', auth };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.' });
  const admin = app.listen(adminPort, '127.0.0.1');
  const pub = app.listen(0, '127.0.0.1');
  await Promise.all([
    new Promise((r) => admin.once('listening', r)),
    new Promise((r) => pub.once('listening', r)),
  ]);
  return {
    admin: `http://127.0.0.1:${adminPort}`,
    public: `http://127.0.0.1:${pub.address().port}`,
    close: () => { admin.close(); pub.close(); },
  };
}

const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });

test('the admin surface is absent on the public port, not merely refused', async () => {
  const s = await twoPorts();
  try {
    // 404, not 403: a refusal confirms there is something behind it.
    for (const path of ['/api/radios', '/api/transmissions', '/api/engines']) {
      const res = await fetch(`${s.public}${path}`, bearer('secret'));
      assert.equal(res.status, 404, `${path} should be absent publicly`);
    }
    // And present on the admin port with the same credential.
    assert.equal((await fetch(`${s.admin}/api/radios`, bearer('secret'))).status, 200);
  } finally { s.close(); }
});

test('a valid token does not open the public port', async () => {
  const s = await twoPorts();
  try {
    // The gate is the port, not the credential: holding an admin token must
    // not make the admin surface appear where it was deliberately removed.
    const res = await fetch(`${s.public}/api/radios`, bearer('secret'));
    assert.equal(res.status, 404);
  } finally { s.close(); }
});

test('signing in stays reachable on the public port', async () => {
  const s = await twoPorts();
  try {
    // Otherwise a public page could never offer a sign-in at all.
    assert.equal((await fetch(`${s.public}/api/session`)).status, 200);
    const body = await (await fetch(`${s.public}/api/session`)).json();
    assert.equal(body.guarded, true);
    assert.equal(body.authenticated, false);
  } finally { s.close(); }
});

test('the health check answers on both ports', async () => {
  const s = await twoPorts();
  try {
    for (const base of [s.public, s.admin]) {
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
    }
  } finally { s.close(); }
});

test('a viewer reads transcripts but cannot touch a radio', async () => {
  const s = await twoPorts({ tokens: [{ name: 'club', token: 'v', role: 'viewer' }] });
  try {
    assert.equal((await fetch(`${s.admin}/api/transmissions`, bearer('v'))).status, 200);
    const res = await fetch(`${s.admin}/api/radios/AA:BB:CC:DD:EE:FF/connect`,
      { method: 'POST', ...bearer('v') });
    assert.equal(res.status, 403, 'reading is not administering');
  } finally { s.close(); }
});

test('a password sign-in yields a cookie that then works', async () => {
  const s = await twoPorts({ passwordHash: hashPassword('hunter2') });
  try {
    const login = await fetch(`${s.admin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('airscribe_session='));
    assert.ok(cookie, 'a session cookie is set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const res = await fetch(`${s.admin}/api/radios`, {
      headers: { cookie: cookie.split(';')[0] },
    });
    assert.equal(res.status, 200, 'the cookie authenticates without a header');
  } finally { s.close(); }
});

test('with no adminPort everything stays on one listener', async () => {
  const config = { host: '127.0.0.1', port: 0, auth: { tokens: ['secret'] } };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/radios`, bearer('secret'))).status, 200);
    assert.equal((await fetch(`${base}/api/radios`)).status, 401, 'still guarded');
  } finally { server.close(); }
});
