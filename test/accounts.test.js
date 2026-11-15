import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeToListen, hashPassword } from '../src/auth.js';

// node:sqlite arrived in Node 22.5; on older Node these tests report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);

/** Accounts over an in-memory database, on a clock the test moves. */
async function accountsAt(start = 1_800_000_000_000) {
  const { DatabaseSync } = await import('node:sqlite');
  const { Accounts } = await import('../src/accounts.js');
  const clock = { now: start };
  const db = new DatabaseSync(':memory:');
  return { a: new Accounts(db, { now: () => clock.now }), clock, db };
}

test('accounts: names, passwords, and never the hash', { skip: !sqlite }, async () => {
  const { a } = await accountsAt();
  const alice = a.create({ username: ' Alice ', password: 'correct horse', role: 'admin' });
  assert.deepEqual([alice.username, alice.role, alice.disabled, alice.has_password], ['Alice', 'admin', false, true]);
  assert.ok(!('password_hash' in alice), 'the hash stays in');
  assert.throws(() => a.create({ username: 'alice', password: 'whatever1', role: 'viewer' }), /already an account called alice/i,
    'names differ by more than case');
  assert.throws(() => a.create({ username: 'bob', password: 'short', role: 'viewer' }), /at least 8/);
  assert.throws(() => a.create({ username: '<script>', password: 'whatever1', role: 'viewer' }), /letters or numbers/);
  assert.throws(() => a.create({ username: 'bob', password: 'whatever1', role: 'owner' }), /admin or viewer/);
  assert.equal(a.create({ username: 'José Ü', password: 'whatever1', role: 'viewer' }).username, 'José Ü', 'any language');
  assert.equal(a.count(), 2);
});

test('signing in: five wrong passwords lock an account for 15 minutes', { skip: !sqlite }, async () => {
  const { a, clock } = await accountsAt();
  a.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  assert.equal(a.signIn('nobody', 'x'), null, 'no account by that name is no answer, not a refusal');
  assert.equal(a.signIn('ALICE', 'correct horse').username, 'alice', 'the name in any case');
  for (let i = 0; i < 4; i++) assert.throws(() => a.signIn('alice', 'wrong'), (e) => e.status === 401);
  assert.equal(a.signIn('alice', 'correct horse').username, 'alice', 'four wrong, then right, is in');
  for (let i = 0; i < 5; i++) assert.throws(() => a.signIn('alice', 'wrong'), (e) => e.status === 401);
  assert.throws(() => a.signIn('alice', 'correct horse'), (e) => e.status === 429, 'locked: not even the right one');
  clock.now += 15 * 60 * 1000 + 1;
  assert.equal(a.signIn('alice', 'correct horse').username, 'alice', 'and open again after');
  const bob = a.create({ username: 'bob', password: 'bob password', role: 'viewer' });
  a.create({ username: 'carol', password: 'carol password', role: 'admin' });
  a.update(bob.id, { disabled: true });
  assert.throws(() => a.signIn('bob', 'bob password'), (e) => e.status === 403 && /turned off/.test(e.message));
});

test('sessions: kept in the database, and ended by a new password, a role or turning off', { skip: !sqlite }, async () => {
  const { a, clock } = await accountsAt();
  const alice = a.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  const bob = a.create({ username: 'bob', password: 'bob password', role: 'viewer' });
  const phone = a.startSession({ userId: bob.id, role: 'viewer' });
  const laptop = a.startSession({ userId: bob.id, role: 'viewer' });
  assert.deepEqual(a.session(phone), { role: 'viewer', user: { id: bob.id, username: 'bob', role: 'viewer' } });
  assert.ok(a.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?').get(phone).n === 0, 'only its hash is kept');
  assert.equal(a.user(bob.id).last_login_at, clock.now);

  a.update(bob.id, { role: 'admin' });
  assert.equal(a.session(phone).role, 'admin', 'a new role at once');
  a.update(bob.id, { role: 'viewer' });

  clock.now += 1000;
  assert.throws(() => a.setPassword(bob.id, 'new password', { current: 'wrong', keep: laptop }), (e) => e.status === 403);
  a.setPassword(bob.id, 'new password', { current: 'bob password', keep: laptop });
  assert.equal(a.session(phone), null, 'a new password signs the other browsers out');
  assert.equal(a.session(laptop).user.username, 'bob', 'but not the one it was changed from');
  assert.equal(a.signIn('bob', 'new password').username, 'bob');

  const config = a.startSession({ role: 'admin' });
  assert.deepEqual(a.session(config), { role: 'admin', user: null }, 'the settings file\'s password has a session, and no account');

  a.update(bob.id, { disabled: true });
  assert.equal(a.session(laptop), null, 'turning an account off ends its sessions');
  a.update(bob.id, { disabled: false });

  const later = a.startSession({ userId: alice.id, role: 'admin' });
  clock.now += 12 * 60 * 60 * 1000 + 1;
  assert.equal(a.session(later), null, 'twelve hours unused, it\'s over');
  assert.equal(a.session('not a session'), null);
});

test('the last admin account can\'t stop being one', { skip: !sqlite }, async () => {
  const { a } = await accountsAt();
  const alice = a.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  assert.throws(() => a.update(alice.id, { role: 'viewer' }), (e) => e.status === 409);
  assert.throws(() => a.update(alice.id, { disabled: true }), (e) => e.status === 409);
  assert.throws(() => a.remove(alice.id), (e) => e.status === 409);
  const carol = a.create({ username: 'carol', password: 'carol password', role: 'admin' });
  a.update(alice.id, { role: 'viewer' });
  assert.throws(() => a.remove(carol.id), (e) => e.status === 409, 'carol is now the only one');
  a.remove(alice.id);
  assert.equal(a.count(), 1);
  assert.throws(() => a.update(999, { role: 'admin' }), (e) => e.status === 404);
});

test('invites: one account each, with their role, until they run out', { skip: !sqlite }, async () => {
  const { a, clock } = await accountsAt();
  a.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  assert.throws(() => a.invite({ role: 'viewer', days: 0 }), /1 to 30 days/);
  assert.throws(() => a.invite({ role: 'root' }), /admin or viewer/);
  const { token, invite } = a.invite({ role: 'viewer', days: 7, note: 'for Bob', by: 'alice' });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([invite.role, invite.note, invite.created_by, invite.used_at], ['viewer', 'for Bob', 'alice', null]);
  assert.ok(!JSON.stringify(a.invites()).includes(token), 'the token isn\'t kept, only its hash');
  assert.equal(a.checkInvite(token).role, 'viewer');

  assert.throws(() => a.register({ invite: token, username: 'alice', password: 'bob password' }), /already an account/);
  assert.equal(a.checkInvite(token).role, 'viewer', 'a refused sign-up leaves the invite unused');
  const bob = a.register({ invite: token, username: 'bob', password: 'bob password' });
  assert.equal(bob.role, 'viewer');
  assert.throws(() => a.register({ invite: token, username: 'eve', password: 'eve password' }), (e) => e.status === 410, 'used once');
  assert.equal(a.invites()[0].used_by, 'bob');

  const old = a.invite({ role: 'admin', days: 1 });
  clock.now += 24 * 60 * 60 * 1000 + 1;
  assert.throws(() => a.checkInvite(old.token), (e) => e.status === 410, 'run out');
  const gone = a.invite({ role: 'viewer' });
  assert.equal(a.revokeInvite(gone.invite.id), true);
  assert.throws(() => a.checkInvite(gone.token), (e) => e.status === 410, 'taken back');
  assert.throws(() => a.checkInvite('made-up'), (e) => e.status === 410);
});

test('linked sign-ins: one per provider, each to one account', { skip: !sqlite }, async () => {
  const { a } = await accountsAt();
  const alice = a.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  const bob = a.create({ username: 'bob', password: 'bob password', role: 'viewer' });
  a.link(alice.id, 'google', { subject: '1234', name: 'Alice A', email: 'alice@example.com' });
  assert.equal(a.linkedUser('google', '1234').id, alice.id);
  assert.equal(a.linkedUser('github', '1234'), null, 'by provider and its id, never by e-mail');
  a.link(alice.id, 'google', { subject: '1234' });   // again: nothing new
  assert.throws(() => a.link(bob.id, 'google', { subject: '1234' }), (e) => e.status === 409, 'not to a second account');
  assert.throws(() => a.link(alice.id, 'google', { subject: '5678' }), (e) => e.status === 409, 'one Google account each');
  assert.deepEqual(a.user(alice.id).links.map((l) => [l.provider, l.email]), [['google', 'alice@example.com']]);
  assert.equal(a.unlink(alice.id, 'google'), true);
  assert.equal(a.linkedUser('google', '1234'), null);
});

test('an admin account is a credential, as one in the settings file is', () => {
  assert.throws(() => assertSafeToListen({ host: '0.0.0.0', auth: {} }), /refusing/);
  assertSafeToListen({ host: '0.0.0.0', auth: {} }, { admins: 1 });
});

/** The app over accounts in a temporary database, listening. */
async function serve(config, db) {
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../src/store.js');
  const { Accounts } = await import('../src/accounts.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:', 'base');
  const accounts = new Accounts(db ?? new DatabaseSync(':memory:'));
  const manager = Object.assign(new EventEmitter(), { radios: () => [] });
  const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', ...config }, dataDir: '.', accounts });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  /** A browser: keeps its cookie. */
  const browser = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(`${base}${path}`, {
        method, body: body && JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  return { server, accounts, browser };
}

test('accounts through the API: the first admin, invites, and who may do what', { skip: !sqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const { server, browser } = await serve({ auth: {} }, db);
  const local = browser();
  try {
    // A node with no credential: everyone on the machine is admin, until there's an account
    assert.equal((await local('GET', '/session')).body.guarded, false);
    const viewerFirst = await local('POST', '/admin/users', { username: 'alice', password: 'correct horse', role: 'viewer' });
    assert.equal(viewerFirst.status, 400, 'the first account has to be an admin');
    assert.equal((await local('POST', '/admin/users', { username: 'alice', password: 'correct horse', role: 'admin' })).status, 200);
    assert.equal((await local('GET', '/radios')).status, 401, 'now there is an account, it takes signing in');
    const s = (await local('GET', '/session')).body;
    assert.deepEqual([s.guarded, s.username, s.passwordLogin, s.authenticated], [true, true, true, false]);

    const alice = browser();
    assert.equal((await alice('POST', '/login', { username: 'alice', password: 'wrong' })).status, 401);
    const signedIn = await alice('POST', '/login', { username: 'alice', password: 'correct horse' });
    assert.deepEqual([signedIn.status, signedIn.body.user.username], [200, 'alice']);
    const me = (await alice('GET', '/session')).body;
    assert.deepEqual([me.authenticated, me.role, me.user.username, me.user.links], [true, 'admin', 'alice', []]);

    // An invite for a viewer, and joining with it
    const made = await alice('POST', '/admin/invites', { role: 'viewer', days: 3, note: 'Bob' });
    assert.equal(made.status, 200);
    const { token } = made.body;
    const bob = browser();
    assert.equal((await bob('GET', `/invite/${token}`)).body.role, 'viewer');
    assert.equal((await bob('GET', '/invite/nonsense')).status, 410);
    const joined = await bob('POST', '/register', { invite: token, username: 'bob', password: 'bob password' });
    assert.deepEqual([joined.status, joined.body.user.role], [200, 'viewer']);
    assert.equal((await bob('GET', '/account')).body.username, 'bob', 'and signed in');
    assert.equal((await bob('GET', '/radios')).status, 200, 'a viewer reads');
    assert.equal((await bob('GET', '/admin/users')).status, 403, 'but doesn\'t administer');
    assert.equal((await browser()('POST', '/register', { invite: token, username: 'eve', password: 'eve password' })).status, 410, 'used up');

    const list = (await alice('GET', '/admin/users')).body;
    assert.deepEqual(list.users.map((u) => `${u.username}:${u.role}`), ['alice:admin', 'bob:viewer']);
    assert.equal(list.invites[0].used_by, 'bob');
    assert.equal(list.fileCredential, false);

    // Bob's own password: the old one first
    assert.equal((await bob('PUT', '/account/password', { current: 'nope', password: 'bob new password' })).status, 403);
    assert.equal((await bob('PUT', '/account/password', { current: 'bob password', password: 'bob new password' })).status, 200);
    assert.equal((await bob('GET', '/account')).status, 200, 'still signed in where it was changed');

    // Turned off by an admin: out at once
    const bobId = list.users.find((u) => u.username === 'bob').id;
    assert.equal((await alice('PATCH', `/admin/users/${bobId}`, { disabled: true })).body.disabled, true);
    assert.equal((await bob('GET', '/radios')).status, 401);
    await alice('PATCH', `/admin/users/${bobId}`, { disabled: false });
    assert.equal((await alice('PUT', `/admin/users/${bobId}/password`, { password: 'set by alice' })).status, 200);
    assert.equal((await browser()('POST', '/login', { username: 'bob', password: 'set by alice' })).status, 200);
    const aliceId = list.users.find((u) => u.username === 'alice').id;
    assert.equal((await alice('DELETE', `/admin/users/${aliceId}`)).status, 409, 'the only admin stays');
    assert.equal((await alice('DELETE', `/admin/users/${bobId}`)).status, 200);
  } finally {
    server.close();
  }

  // The same database after a restart: still signed in
  const again = await serve({ auth: {} }, db);
  try {
    const fresh = again.browser();
    await fresh('POST', '/login', { username: 'alice', password: 'correct horse' });
    assert.equal((await fresh('GET', '/account')).body.username, 'alice');
  } finally {
    again.server.close();
  }
});

test('the settings file\'s password still works beside accounts, as an admin with no account', { skip: !sqlite }, async () => {
  const { server, accounts, browser } = await serve({ auth: { passwordHash: hashPassword('file password') } });
  try {
    accounts.create({ username: 'alice', password: 'correct horse', role: 'viewer' });
    const root = browser();
    const r = await root('POST', '/login', { password: 'file password' });
    assert.deepEqual([r.status, r.body.role], [200, 'admin']);
    assert.equal((await root('GET', '/admin/users')).status, 200, 'it administers');
    assert.equal((await root('GET', '/account')).status, 400, 'with no account of its own');
    assert.equal((await root('POST', '/admin/users', { username: 'viewer2', password: 'whatever1', role: 'viewer' })).status, 200,
      'the file\'s password is a way back in, so a first account needn\'t be an admin');
    const wrong = browser();
    assert.equal((await wrong('POST', '/login', { username: 'alice', password: 'file password' })).status, 401,
      'an account\'s name takes only that account\'s password');
    for (let i = 0; i < 4; i++) await wrong('POST', '/login', { username: 'alice', password: 'wrong' });
    assert.equal((await wrong('POST', '/login', { username: 'alice', password: 'correct horse' })).status, 429, 'locked');
  } finally {
    server.close();
  }
});
