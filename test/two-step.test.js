import test from 'node:test';
import assert from 'node:assert/strict';
import { codeAt, stepAt, fromBase32 } from '../src/totp.js';
import { creationOptions, requestOptions } from '../src/webauthn.js';
import { authenticator } from './fake-authenticator.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);
const page = { origins: ['https://air.example.net'], rpId: 'air.example.net' };

async function setup(start = 1_800_000_000_000) {
  const { DatabaseSync } = await import('node:sqlite');
  const { Accounts } = await import('../src/accounts.js');
  const clock = { now: start };
  const accounts = new Accounts(new DatabaseSync(':memory:'), { now: () => clock.now });
  const alice = accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  return { accounts, t: accounts.twoStep, clock, alice };
}

/** A passkey added the way the browser would. */
function addPasskey(t, userId, a = authenticator()) {
  const challenge = t.challenge('add', userId);
  const options = creationOptions({ rpId: page.rpId, rpName: 'AirScribe', userId: Buffer.from(String(userId)), name: 'alice', challenge });
  return { a, ...t.addPasskey(userId, a.create(options), { ...page, name: 'Windows passkey' }) };
}

test('the first passkey comes with ten recovery codes; the second doesn’t', { skip: !sqlite }, async () => {
  const { t, alice } = await setup();
  assert.equal(t.isSetUp(alice.id), false);
  const first = addPasskey(t, alice.id);
  assert.equal(first.recoveryCodes.length, 10);
  assert.match(first.recoveryCodes[0], /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(first.passkey.name, 'Windows passkey');
  assert.equal(addPasskey(t, alice.id).recoveryCodes, null);
  assert.deepEqual([t.status(alice.id).passkeys.length, t.status(alice.id).recoveryCodesLeft], [2, 10]);
});

test('a passkey answers only the question it was asked, for its own account', { skip: !sqlite }, async () => {
  const { accounts, t, alice } = await setup();
  const bob = accounts.create({ username: 'bob', password: 'correct horse', role: 'viewer' });
  const { a } = addPasskey(t, alice.id);
  const ask = (purpose, owner) => a.get(requestOptions({ rpId: page.rpId, challenge: t.challenge(purpose, owner) }));
  assert.equal(t.usePasskey(ask('check', alice.id), { purpose: 'check', owner: alice.id, userId: alice.id, ...page }), alice.id);
  assert.throws(() => t.usePasskey(ask('check', bob.id), { purpose: 'check', owner: bob.id, userId: bob.id, ...page }), /isn’t one of this account’s/);
  assert.throws(() => t.usePasskey(ask('signin', null), { purpose: 'check', owner: alice.id, userId: alice.id, ...page }), /old question/,
    'a sign-in’s challenge isn’t a check’s');
  const answer = ask('check', alice.id);
  t.usePasskey(answer, { purpose: 'check', owner: alice.id, userId: alice.id, ...page });
  assert.throws(() => t.usePasskey(answer, { purpose: 'check', owner: alice.id, userId: alice.id, ...page }), /old question/, 'used once');
  assert.equal(t.usePasskey(ask('signin', null), { purpose: 'signin', ...page }), alice.id, 'on its own, it says whose it is');
  assert.throws(() => t.usePasskey(ask('check', alice.id), { purpose: 'check', owner: alice.id, userId: alice.id, ...page, rpId: 'other.example' }),
    /made on air\.example\.net/);
});

test('the authenticator app: on after its first code, then codes once each', { skip: !sqlite }, async () => {
  const { t, alice, clock } = await setup();
  const { key, uri } = t.startAuthenticator(alice.id, 'alice');
  assert.match(uri, /^otpauth:\/\/totp\/AirScribe:alice\?/);
  const secret = key.replace(/ /g, '');
  assert.equal(fromBase32(secret).length, 20);
  assert.equal(t.isSetUp(alice.id), false, 'not on until a code proves the app has it');
  assert.throws(() => t.enableAuthenticator(alice.id, '000000'), /isn’t right/);
  const { recoveryCodes } = t.enableAuthenticator(alice.id, codeAt(secret, stepAt(clock.now)));
  assert.equal(recoveryCodes.length, 10);
  assert.throws(() => t.useCode(alice.id, codeAt(secret, stepAt(clock.now))), /isn’t right/, 'the code that turned it on is used');
  clock.now += 30000;
  assert.deepEqual(t.useCode(alice.id, codeAt(secret, stepAt(clock.now))), { via: 'authenticator' });
  assert.deepEqual(t.useCode(alice.id, recoveryCodes[3].toUpperCase().replace('-', ' ')), { via: 'recovery', recoveryCodesLeft: 9 });
  assert.throws(() => t.useCode(alice.id, recoveryCodes[3]), /isn’t right/, 'a recovery code works once');
});

test('five wrong codes refuse codes for 15 minutes, even right ones', { skip: !sqlite }, async () => {
  const { t, alice, clock } = await setup();
  const { recoveryCodes } = addPasskey(t, alice.id);
  for (let i = 0; i < 5; i++) assert.throws(() => t.useCode(alice.id, 'aaaaa-aaaaa'), (e) => e.status === 403);
  assert.throws(() => t.useCode(alice.id, recoveryCodes[0]), (e) => e.status === 429);
  clock.now += 15 * 60 * 1000 + 1;
  assert.equal(t.useCode(alice.id, recoveryCodes[0]).via, 'recovery');
});

test('a remembered browser lasts 30 days, for its own account', { skip: !sqlite }, async () => {
  const { accounts, t, alice, clock } = await setup();
  const bob = accounts.create({ username: 'bob', password: 'correct horse', role: 'viewer' });
  addPasskey(t, alice.id);
  const token = t.remember(alice.id);
  assert.equal(t.remembered(alice.id, token), true);
  assert.equal(t.remembered(bob.id, token), false);
  clock.now += 30 * 24 * 60 * 60 * 1000;
  assert.equal(t.remembered(alice.id, token), false);
});

test('removing the last way to verify turns it off; deleting the account clears it', { skip: !sqlite }, async () => {
  const { accounts, t, alice } = await setup();
  const { passkey } = addPasskey(t, alice.id);
  const token = t.remember(alice.id);
  assert.equal(t.removePasskey(alice.id, passkey.id), true);
  assert.deepEqual([t.isSetUp(alice.id), t.codesLeft(alice.id), t.remembered(alice.id, token)], [false, 0, false]);
  const other = accounts.create({ username: 'carol', password: 'correct horse', role: 'admin' });
  addPasskey(t, other.id);
  assert.equal(accounts.user(other.id).two_step, true);
  accounts.remove(other.id);
  assert.equal(t.passkeyRows(other.id).length, 0);
});

test('a session is marked when it passes a step, and Admin’s check apart', { skip: !sqlite }, async () => {
  const { accounts, alice, clock } = await setup();
  const plain = accounts.startSession({ userId: alice.id, role: 'admin' });
  assert.equal(accounts.session(plain).marks.stepped_at, null);
  const stepped = accounts.startSession({ userId: alice.id, role: 'admin', stepped: true });
  const at = clock.now;
  assert.deepEqual(accounts.session(stepped).marks, { stepped_at: at, last_step_at: at, checked_at: null, password_at: null },
    'a step at sign-in isn’t Admin’s check');
  clock.now += 1000;
  accounts.markSession(stepped, { admin: true });
  assert.deepEqual(accounts.session(stepped).marks, { stepped_at: at, last_step_at: at + 1000, checked_at: at + 1000, password_at: null });
});
