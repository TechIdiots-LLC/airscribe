import test from 'node:test';
import assert from 'node:assert/strict';
import { serve as serveProvider, CLIENT } from './fixtures/oauth-fake.js';

// node:sqlite arrived in Node 22.5; on older Node these tests report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);

/**
 * A browser: keeps cookies by path, for its own origin only, and follows
 * redirects itself so each step can be looked at.
 * @param {string} origin - AirScribe's.
 * @returns {Function} go(url, opts) => Response.
 */
function browser(origin) {
  const jar = new Map();   // name -> {value, path}
  const go = async (url, opts = {}) => {
    const u = new URL(url, origin);
    const mine = u.origin === origin;
    const cookie = mine ? [...jar].filter(([, c]) => u.pathname.startsWith(c.path)).map(([n, c]) => `${n}=${c.value}`).join('; ') : '';
    const res = await fetch(u, {
      redirect: 'manual', ...opts,
      body: opts.body && JSON.stringify(opts.body),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    });
    if (mine) {
      for (const set of res.headers.getSetCookie()) {
        const [pair, ...attrs] = set.split(';').map((s) => s.trim());
        const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        const path = attrs.find((a) => /^path=/i.test(a))?.slice(5) || '/';
        const gone = !value || attrs.some((a) => /^expires=/i.test(a) && new Date(a.slice(8)) < new Date());
        if (gone) jar.delete(name);
        else jar.set(name, { value, path });
      }
    }
    return res;
  };
  go.json = async (method, path, body) => {
    const res = await go(path, { method, body });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  go.has = (name) => jar.has(name);
  /** Start a sign-in at `start` (or a link's url), through the provider, back to AirScribe: where it ends. */
  go.through = async (start) => {
    const toProvider = start.startsWith('http') && !start.startsWith(origin) ? start : (await go(start)).headers.get('location');
    if (!toProvider?.startsWith('http')) return toProvider;
    const back = (await fetch(toProvider, { redirect: 'manual' })).headers.get('location');
    const landed = await go(back);
    return { status: landed.status, location: landed.headers.get('location'), callback: back, provider: toProvider };
  };
  return go;
}

async function setUp() {
  const { Store } = await import('../src/store.js');
  const { Accounts } = await import('../src/accounts.js');
  const { Logins } = await import('../src/logins.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const provider = await serveProvider(0);
  const store = new Store(':memory:', 'base');
  const accounts = new Accounts(store.db);
  const logins = new Logins({ store, accounts, config: { providerEndpoints: provider.fake.endpoints(provider.base) } });
  const manager = Object.assign(new EventEmitter(), { radios: () => [] });
  const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', auth: {} }, dataDir: '.', accounts, logins });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const alice = accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  const bob = accounts.create({ username: 'bob', password: 'bob password', role: 'viewer' });
  const signedIn = async (name, password) => {
    const b = browser(origin);
    assert.equal((await b.json('POST', '/api/login', { username: name, password })).status, 200);
    return b;
  };
  return {
    provider, accounts, logins, origin, alice, bob, signedIn,
    close: () => { server.close(); provider.server.close(); },
  };
}

test('sign-in providers: set up by an admin, the secret kept in', { skip: !sqlite }, async () => {
  const t = await setUp();
  try {
    const anon = browser(t.origin);
    const off = await anon('/api/auth/google/start');
    assert.equal(off.status, 303);
    assert.match(decodeURIComponent(off.headers.get('location')), /^\/#signin:error=signing in with Google isn’t turned on/);
    assert.deepEqual((await anon.json('GET', '/api/session')).body.providers, []);

    const admin = await t.signedIn('alice', 'correct horse');
    const viewer = await t.signedIn('bob', 'bob password');
    assert.equal((await viewer.json('GET', '/api/admin/logins')).status, 403);
    const before = (await admin.json('GET', '/api/admin/logins')).body;
    assert.deepEqual(before.providers.map((p) => p.id), ['google', 'github', 'discord', 'facebook']);
    assert.equal(before.providers[0].redirect, `${t.origin}/api/auth/google/callback`, 'the address to register with Google');

    const noSecret = await admin.json('PUT', '/api/admin/logins', { providers: { github: { enabled: true, clientId: CLIENT.id } } });
    assert.equal(noSecret.status, 400, 'on needs a client ID and secret');
    const saved = await admin.json('PUT', '/api/admin/logins', {
      publicUrl: 'https://airscribe.example.com/',
      providers: { google: { enabled: true, clientId: CLIENT.id, secret: CLIENT.secret } },
    });
    const google = saved.body.providers[0];
    assert.deepEqual([google.on, google.clientId, google.secret], [true, CLIENT.id, true]);
    assert.ok(!JSON.stringify(saved.body).includes(CLIENT.secret), 'the secret isn\'t shown');
    assert.equal(google.redirect, 'https://airscribe.example.com/api/auth/google/callback', 'the address set here, when it is');
    assert.equal((await admin.json('PUT', '/api/admin/logins', { publicUrl: 'not a url' })).status, 400);
    await admin.json('PUT', '/api/admin/logins', { publicUrl: '' });
    assert.deepEqual((await anon.json('GET', '/api/session')).body.providers, [{ id: 'google', name: 'Google' }], 'the sign-in page offers it');
  } finally {
    t.close();
  }
});

test('signing in with Google: linked with a password the first time, straight in after', { skip: !sqlite }, async () => {
  const t = await setUp();
  try {
    t.logins.save({ providers: { google: { enabled: true, clientId: CLIENT.id, secret: CLIENT.secret } } });
    t.provider.fake.as('google', { id: 'g-alice', name: 'Alice A', email: 'alice@example.com' });

    // Not linked yet: held, while the password links it
    const b = browser(t.origin);
    const first = await b.through('/api/auth/google/start');
    assert.match(first.provider, /code_challenge=[\w-]{43}&code_challenge_method=S256/, 'with PKCE');
    assert.deepEqual([first.status, first.location], [303, '/#signin:link']);
    assert.equal((await b.json('GET', '/api/session')).body.authenticated, false, 'not signed in by it, not being linked');
    const waiting = (await b.json('GET', '/api/auth/waiting')).body;
    assert.deepEqual([waiting.provider, waiting.name, waiting.who.name, waiting.who.email], ['google', 'Google', 'Alice A', 'alice@example.com']);
    assert.equal((await b.json('POST', '/api/auth/waiting', { username: 'alice', password: 'wrong' })).status, 401);
    assert.equal((await b.json('POST', '/api/auth/waiting', { username: 'alice', password: 'correct horse' })).status, 200);
    const me = (await b.json('GET', '/api/session')).body;
    assert.deepEqual([me.user.username, me.user.links.map((l) => `${l.provider}:${l.email}`)], ['alice', ['google:alice@example.com']]);
    assert.equal((await b.json('GET', '/api/auth/waiting')).status, 404, 'and nothing waits any more');

    // From now on, straight in
    const c = browser(t.origin);
    const again = await c.through('/api/auth/google/start');
    assert.deepEqual([again.status, again.location], [303, '/']);
    assert.equal((await c.json('GET', '/api/account')).body.username, 'alice');

    // The way back from the provider works once, in the browser that began it
    const thief = browser(t.origin);
    const stolen = await thief(again.callback);
    assert.match(decodeURIComponent(stolen.headers.get('location')), /#signin:error=that Google sign-in didn’t start here/);
    const replay = await c(again.callback);
    assert.match(decodeURIComponent(replay.headers.get('location')), /didn’t start here, or has run out/, 'once');

    t.provider.fake.as('google', 'deny');
    const cancelled = await browser(t.origin).through('/api/auth/google/start');
    assert.equal(decodeURIComponent(cancelled.location), '/#signin:error=Google sign-in was cancelled');

    // A Google account no one linked doesn't get in because its e-mail is someone's
    t.provider.fake.as('google', { id: 'g-other', name: 'Not Alice', email: 'alice@example.com' });
    const other = browser(t.origin);
    assert.equal((await other.through('/api/auth/google/start')).location, '/#signin:link', 'never matched by e-mail');
    assert.equal((await other.json('GET', '/api/session')).body.authenticated, false);
  } finally {
    t.close();
  }
});

test('linking from one\'s account: the password first; one account each; unlinking', { skip: !sqlite }, async () => {
  const t = await setUp();
  try {
    t.logins.save({ providers: {
      google: { enabled: true, clientId: CLIENT.id, secret: CLIENT.secret },
      github: { enabled: true, clientId: CLIENT.id, secret: CLIENT.secret },
      facebook: { enabled: true, clientId: CLIENT.id, secret: CLIENT.secret },
    } });
    const bob = await t.signedIn('bob', 'bob password');
    assert.deepEqual((await bob.json('GET', '/api/account')).body.providers.map((p) => p.id), ['google', 'github', 'facebook']);
    assert.equal((await bob.json('POST', '/api/account/links/google', { password: 'wrong' })).status, 403, 'the password first');
    const start = await bob.json('POST', '/api/account/links/github', { password: 'bob password' });
    assert.equal(start.status, 200);
    assert.ok(!/code_challenge/.test(start.body.url), 'GitHub, without PKCE');
    t.provider.fake.as('github', { id: '424242', name: 'Bob B', email: null });
    const linked = await bob.through(start.body.url);
    assert.equal(linked.location, '/#account:linked=github');
    const links = (await bob.json('GET', '/api/account')).body.links;
    assert.deepEqual(links.map((l) => [l.provider, l.name]), [['github', 'Bob B']]);

    // Signs in with it now; GitHub's numeric id is just an id
    const fresh = browser(t.origin);
    assert.equal((await fresh.through('/api/auth/github/start')).location, '/');
    assert.equal((await fresh.json('GET', '/api/account')).body.username, 'bob');

    // Another account's GitHub can't be linked to Bob's
    const alice = await t.signedIn('alice', 'correct horse');
    const theirs = await alice.json('POST', '/api/account/links/github', { password: 'correct horse' });
    assert.match(decodeURIComponent((await alice.through(theirs.body.url)).location), /#account:error=that account is already linked to another AirScribe account/);

    // Facebook takes its code by GET; a link that fails at the provider goes back to the account page
    t.provider.fake.as('facebook', 'deny');
    const fb = await bob.json('POST', '/api/account/links/facebook', { password: 'bob password' });
    assert.equal(decodeURIComponent((await bob.through(fb.body.url)).location), '/#account:error=Facebook sign-in was cancelled');
    t.provider.fake.as('facebook', { id: 'fb-1', name: 'Bob B', email: 'bob@example.com' });
    const fb2 = await bob.json('POST', '/api/account/links/facebook', { password: 'bob password' });
    assert.equal((await bob.through(fb2.body.url)).location, '/#account:linked=facebook');

    // Turned off: the link doesn't let him in
    t.accounts.update(t.bob.id, { disabled: true });
    const out = await browser(t.origin).through('/api/auth/github/start');
    assert.match(decodeURIComponent(out.location), /#signin:error=this account is turned off/);
    t.accounts.update(t.bob.id, { disabled: false });

    // Unlinking asks for the password too
    const bob2 = await t.signedIn('bob', 'bob password');
    assert.equal((await bob2.json('DELETE', '/api/account/links/github', { password: 'nope' })).status, 403);
    const after = await bob2.json('DELETE', '/api/account/links/github', { password: 'bob password' });
    assert.deepEqual(after.body.links.map((l) => l.provider), ['facebook']);
    assert.equal((await browser(t.origin).through('/api/auth/github/start')).location, '/#signin:link', 'unlinked, it signs in no one');

    // A provider turned off stops sign-ins at once; the links stay for when it's back
    t.logins.save({ providers: { facebook: { enabled: false } } });
    assert.match(decodeURIComponent((await browser(t.origin)('/api/auth/facebook/start')).headers.get('location')), /isn’t turned on/);
    assert.equal(t.accounts.linkedUser('facebook', 'fb-1').username, 'bob');
  } finally {
    t.close();
  }
});
