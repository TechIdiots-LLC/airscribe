import test from 'node:test';
import assert from 'node:assert/strict';
import { base32, fromBase32, codeAt, check, stepAt, otpauthUri, newSecret } from '../src/totp.js';
import { verifyRegistration, verifyAssertion, creationOptions, requestOptions } from '../src/webauthn.js';
import { authenticator } from './fake-authenticator.js';

// RFC 6238's SHA-1 key, "12345678901234567890"
const RFC = base32(Buffer.from('12345678901234567890'));

test('authenticator codes match RFC 6238', () => {
  // The RFC's 8-digit answers, of which an app shows the last 6
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(codeAt(RFC, stepAt(seconds * 1000)), code, `at ${seconds}`);
  }
  assert.deepEqual(fromBase32(RFC), Buffer.from('12345678901234567890'));
  assert.deepEqual(fromBase32('gezd gnbv'), fromBase32('GEZDGNBV'), 'any case, spaces ignored');
  assert.match(newSecret(), /^[A-Z2-7]{32}$/);
});

test('a code is accepted a step either side, and only once', () => {
  const now = 1_800_000_000_000;
  const here = stepAt(now);
  assert.equal(check(RFC, codeAt(RFC, here), { now }), here);
  assert.equal(check(RFC, codeAt(RFC, here - 1), { now }), here - 1, 'a phone a little slow');
  assert.equal(check(RFC, codeAt(RFC, here + 1), { now }), here + 1, 'or fast');
  assert.equal(check(RFC, codeAt(RFC, here - 2), { now }), null, 'but not a minute off');
  assert.equal(check(RFC, codeAt(RFC, here), { now, after: here }), null, 'a code used is used');
  assert.equal(check(RFC, codeAt(RFC, here - 1), { now, after: here }), null, 'and so is one before it');
  const spaced = codeAt(RFC, here).replace(/^(...)/, '$1 ');
  assert.equal(check(RFC, spaced, { now }), here, 'typed as the app shows it');
  assert.equal(check(RFC, 'abcdef', { now }), null);
});

test('the otpauth link names the issuer and account', () => {
  const uri = otpauthUri('ABC', { issuer: 'AirScribe', account: 'Al ice' });
  assert.ok(uri.startsWith('otpauth://totp/AirScribe:Al%20ice?'));
  assert.equal(new URL(uri).searchParams.get('secret'), 'ABC');
  assert.equal(new URL(uri).searchParams.get('issuer'), 'AirScribe');
});

const expect = { challenge: 'Y2hhbGxlbmdl', origins: ['https://air.example.net'], rpId: 'air.example.net' };
const makeOptions = () => creationOptions({ rpId: 'air.example.net', rpName: 'AirScribe', userId: Buffer.from('1'), name: 'alice', challenge: expect.challenge });

for (const kind of ['ec', 'ed25519', 'rsa']) {
  test(`a ${kind} passkey registers and signs in`, () => {
    const a = authenticator({ kind });
    const kept = verifyRegistration(a.create(makeOptions()), expect);
    assert.equal(kept.id, a.id);
    assert.equal(kept.alg, { ec: -7, ed25519: -8, rsa: -257 }[kind]);
    const opts = requestOptions({ rpId: expect.rpId, challenge: 'c2Vjb25k', allow: [{ id: kept.id }] });
    const used = verifyAssertion(a.get(opts), { ...expect, challenge: 'c2Vjb25k', ...kept, requireUv: true });
    assert.ok(used.signCount > kept.signCount);
  });
}

test('a passkey is refused for the wrong question, page, site or key', () => {
  const a = authenticator();
  const kept = verifyRegistration(a.create(makeOptions()), expect);
  const ask = { ...expect, ...kept };
  assert.throws(() => verifyAssertion(a.get({ challenge: 'b2xk' }), ask), /old question/);
  assert.throws(() => verifyAssertion(a.get({ challenge: expect.challenge }, { origin: 'https://evil.example' }), ask), /evil\.example, not this address/);
  assert.throws(() => verifyAssertion(a.get({ challenge: expect.challenge }), { ...ask, rpId: 'other.example' }), /another site/);
  const other = verifyRegistration(authenticator().create(makeOptions()), expect);
  assert.throws(() => verifyAssertion(a.get({ challenge: expect.challenge }), { ...ask, publicKey: other.publicKey }), /signature/);
  assert.throws(() => verifyAssertion(a.get({ challenge: expect.challenge }, { counter: 1 }), { ...ask, signCount: 5 }), /went backwards/);
  assert.throws(() => verifyRegistration(a.create(makeOptions(), { origin: 'http://air.example.net' }), expect), /not this address/,
    'the http address is another origin');
});

test('signing in on a passkey alone needs one that checked a fingerprint, face or PIN', () => {
  const a = authenticator({ uv: false });
  const kept = verifyRegistration(a.create(makeOptions()), expect);
  assert.throws(() => verifyAssertion(a.get({ challenge: expect.challenge }), { ...expect, ...kept, requireUv: true }), /fingerprint, face or PIN/);
  assert.equal(verifyAssertion(a.get({ challenge: expect.challenge }), { ...expect, ...kept }).uv, false, 'as a second step, a touch is enough');
});

test('a synced passkey says so, and its counter stays at 0', () => {
  const a = authenticator({ synced: true });
  const kept = verifyRegistration(a.create(makeOptions()), expect);
  assert.equal(kept.backedUp, true);
  assert.equal(kept.signCount, 0);
  for (let i = 0; i < 2; i++) verifyAssertion(a.get({ challenge: expect.challenge }), { ...expect, ...kept });
});
