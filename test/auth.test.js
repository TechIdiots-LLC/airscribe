import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, generateToken, hashToken, hashPassword, verifyPassword, same,
  isLoopback, isGuarded, assertSafeToListen, tokenIndex, Sessions, readCookie, createAuth,
} from '../src/auth.js';

test('tokens are long, random and unguessable', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43, '32 bytes of base64url');
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'survives a URL and a shell without escaping');
});

test('a token is stored hashed and found by hash', () => {
  const t = generateToken();
  assert.equal(hashToken(t), hashToken(t));
  assert.notEqual(hashToken(t), t);
  assert.equal(hashToken(t).length, 64);
});

test('passwords use a slow hash with a per-password salt', () => {
  const one = hashPassword('correct horse');
  const two = hashPassword('correct horse');
  assert.notEqual(one, two, 'the salt differs, so equal passwords do not look equal');
  assert.match(one, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(verifyPassword('correct horse', one));
  assert.ok(!verifyPassword('correct hors', one));
  assert.ok(!verifyPassword('', one));
});

test('a malformed stored hash is refused, not crashed on', () => {
  for (const bad of ['', 'plaintext', 'scrypt$only-salt', undefined, null]) {
    assert.equal(verifyPassword('x', bad), false);
  }
});

test('comparing unequal-length secrets does not throw', () => {
  assert.ok(same('a', 'a'));
  assert.ok(!same('a', 'ab'));
  assert.ok(!same('', 'x'));
});

test('roles rank, so viewer does not reach admin', () => {
  assert.ok(ROLES.admin > ROLES.viewer);
});

test('a node is guarded by any one credential', () => {
  assert.equal(isGuarded({}), false);
  assert.equal(isGuarded({ tokens: [] }), false);
  assert.equal(isGuarded({ tokens: ['x'] }), true);
  assert.equal(isGuarded({ apiKey: 'x' }), true);
  assert.equal(isGuarded({ passwordHash: hashPassword('x') }), true);
});

test('the admin surface may not face a network unguarded', () => {
  assert.throws(() => assertSafeToListen({ host: '0.0.0.0', auth: {} }), /refusing/);
  assertSafeToListen({ host: '127.0.0.1', auth: {} });
  assertSafeToListen({ host: '0.0.0.0', auth: { tokens: ['t'] } });
  // A public listener may face the world as long as admin stays home: that
  // is the whole point of the two-port split.
  assertSafeToListen({ host: '0.0.0.0', adminPort: 8101, adminHost: '127.0.0.1', auth: {} });
  assert.throws(
    () => assertSafeToListen({ host: '0.0.0.0', adminPort: 8101, adminHost: '0.0.0.0', auth: {} }),
    /refusing/,
  );
});

test('tokens carry a role, defaulting to admin', () => {
  const plain = generateToken();
  const named = generateToken();
  const index = tokenIndex({
    apiKey: 'legacy',
    tokens: [plain, { name: 'club', token: named, role: 'viewer' }],
  });
  assert.equal(index.get(hashToken('legacy')).role, 'admin');
  assert.equal(index.get(hashToken(plain)).role, 'admin', 'a bare string stays admin');
  assert.equal(index.get(hashToken(named)).role, 'viewer');
  assert.equal(index.get(hashToken(named)).name, 'club');
});

test('a token may be configured pre-hashed', () => {
  const t = generateToken();
  const index = tokenIndex({ tokens: [{ name: 'x', hash: hashToken(t), role: 'viewer' }] });
  assert.equal(index.get(hashToken(t)).role, 'viewer');
});

test('sessions expire, renew on use, and can be ended', () => {
  const s = new Sessions(50);
  const id = s.create('viewer');
  assert.equal(s.get(id).role, 'viewer');
  s.destroy(id);
  assert.equal(s.get(id), null);

  const short = new Sessions(-1);
  assert.equal(short.get(short.create('admin')), null, 'an expired session is gone');
});

test('cookies are read without a parser dependency', () => {
  const req = { headers: { cookie: 'a=1; airscribe_session=abc%2Fdef; b=2' } };
  assert.equal(readCookie(req, 'airscribe_session'), 'abc/def');
  assert.equal(readCookie(req, 'missing'), null);
  assert.equal(readCookie({ headers: {} }, 'a'), null);
});

/** @param {object} auth - Config auth section. @returns {object} A built auth. */
const build = (auth, rest = {}) => createAuth({ host: '127.0.0.1', auth, ...rest });
/** @param {object} o - Request bits. @returns {object} A fake request. */
const req = ({ token, cookie, body } = {}) => ({
  get: (h) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined),
  query: {}, headers: cookie ? { cookie } : {}, body,
});
/** @returns {object} A fake response capturing what was sent. */
function res() {
  const r = { code: 200, body: null, cookies: [] };
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  r.cookie = (n, v, o) => r.cookies.push([n, v, o]);
  r.clearCookie = (n) => r.cookies.push([n, null]);
  return r;
}

test('an unguarded node treats everyone as admin, because it is loopback-only', () => {
  const a = build({});
  assert.equal(a.roleOf(req()), 'admin');
});

test('a guarded node refuses anyone with no credential', () => {
  const a = build({ tokens: ['secret'] });
  assert.equal(a.roleOf(req()), null);
  assert.equal(a.roleOf(req({ token: 'wrong' })), null);
  assert.equal(a.roleOf(req({ token: 'secret' })), 'admin');
});

test('a viewer token reads but cannot administer', () => {
  const a = build({ tokens: [{ name: 'club', token: 'v', role: 'viewer' }] });
  const asViewer = req({ token: 'v' });

  let r = res();
  a.requireRole('viewer')(asViewer, r, () => (r.code = 'next'));
  assert.equal(r.code, 'next', 'a viewer may read');

  r = res();
  a.requireRole('admin')(asViewer, r, () => (r.code = 'next'));
  assert.equal(r.code, 403, 'and is told it is forbidden, not unauthenticated');
});

test('no credential gives 401 and a wrong role gives 403', () => {
  const a = build({ tokens: [{ token: 'v', role: 'viewer' }] });
  const anon = res();
  a.requireRole('viewer')(req(), anon, () => {});
  assert.equal(anon.code, 401, 'nothing was offered');

  const viewer = res();
  a.requireRole('admin')(req({ token: 'v' }), viewer, () => {});
  assert.equal(viewer.code, 403, 'something was offered, and was not enough');
});

test('signing in with a password gives a session cookie', () => {
  const a = build({ passwordHash: hashPassword('hunter2') });
  const r = res();
  a.login(req({ body: { password: 'hunter2' } }), r);
  assert.equal(r.body.role, 'admin');
  const [name, value, opts] = r.cookies[0];
  assert.equal(name, 'airscribe_session');
  assert.equal(opts.httpOnly, true, 'script must not be able to read it');
  assert.equal(opts.sameSite, 'lax');
  // And the cookie then authenticates.
  assert.equal(a.roleOf(req({ cookie: `airscribe_session=${value}` })), 'admin');
});

test('a wrong password is refused and mints nothing', () => {
  const a = build({ passwordHash: hashPassword('hunter2') });
  const r = res();
  a.login(req({ body: { password: 'hunter3' } }), r);
  assert.equal(r.code, 401);
  assert.equal(r.cookies.length, 0);
});

test('where only tokens exist, the same box takes a token', () => {
  // So the page never asks for a password the node does not have.
  const a = build({ tokens: [{ token: 'v', role: 'viewer' }] });
  const r = res();
  a.login(req({ body: { password: 'v' } }), r);
  assert.equal(r.body.role, 'viewer');
});

test('a configured username must match', () => {
  const a = build({ username: 'andrew', passwordHash: hashPassword('pw') });
  const wrong = res();
  a.login(req({ body: { username: 'someone', password: 'pw' } }), wrong);
  assert.equal(wrong.code, 401);
  const right = res();
  a.login(req({ body: { username: 'andrew', password: 'pw' } }), right);
  assert.equal(right.body.role, 'admin');
});

test('logging out ends the session', () => {
  const a = build({ passwordHash: hashPassword('pw') });
  const r = res();
  a.login(req({ body: { password: 'pw' } }), r);
  const value = r.cookies[0][1];
  const cookie = `airscribe_session=${value}`;
  assert.equal(a.roleOf(req({ cookie })), 'admin');
  a.logout(req({ cookie }), res());
  assert.equal(a.roleOf(req({ cookie })), null);
});
