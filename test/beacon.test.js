import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { callsign, checkBeacon, checkProfile } from '../src/beacon.js';

// node:sqlite arrived in Node 22.5; on older Node the API test reports as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);
const MAC = '38:D2:00:01:56:51';

test('a callsign, a profile and beacon changes, checked as the radio takes them', () => {
  assert.equal(callsign(' n1abc '), 'N1ABC');
  assert.equal(callsign(''), '');
  for (const bad of ['N1ABC-9', 'ABCDEF', '123456', 'W1', 'TOOLONG7']) {
    assert.throws(() => callsign(bad), { status: 400 }, bad);
  }
  assert.deepEqual(checkProfile({ callsign: 'kk7vzt', ssid: '7', symbol: '/[', beacon: ' Out walking ' }),
    { callsign: 'KK7VZT', ssid: 7, symbol: '/[', beacon: 'Out walking' });
  assert.equal(checkProfile({ callsign: '' }), null, 'no callsign: no profile');
  assert.throws(() => checkProfile({ callsign: 'N1ABC', beacon: 'nineteen characters' }), /up to 18/);
  assert.throws(() => checkProfile({ callsign: 'N1ABC', ssid: 16 }), /0 to 15/);
  assert.throws(() => checkProfile({ callsign: 'N1ABC', symbol: '>' }), /two characters/);

  assert.deepEqual(checkBeacon({ share_location: true, share_interval: 600, format: 'aprs' }),
    { share_location: true, share_interval: 600, format: 'aprs' });
  for (const [bad, why] of [[{ share_interval: 605 }, /in tens/], [{ share_location: 'yes' }, /true or false/],
    [{ format: 'dstar' }, /aprs or bss/], [{ volume: 3 }, /no volume/], [{}, /nothing to change/]]) {
    assert.throws(() => checkBeacon(bad), why, JSON.stringify(bad));
  }
});

test('the profile on an account: set, shown with it, cleared, and gone with it', { skip: !sqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Accounts } = await import('../src/accounts.js');
  const accounts = new Accounts(new DatabaseSync(':memory:'));
  const alice = accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  assert.equal(accounts.user(alice.id).radio, null);
  accounts.setProfile(alice.id, { callsign: 'N1ABC', ssid: 9, symbol: '/>', beacon: 'Mobile' });
  assert.deepEqual(accounts.user(alice.id).radio, { callsign: 'N1ABC', ssid: 9, symbol: '/>', beacon: 'Mobile' });
  accounts.setProfile(alice.id, { callsign: 'N1ABC', ssid: 7, symbol: '/[', beacon: '' });
  assert.equal(accounts.profile(alice.id).ssid, 7, 'changed in place');
  accounts.setProfile(alice.id, null);
  assert.equal(accounts.profile(alice.id), null);
  accounts.setProfile(alice.id, { callsign: 'N1ABC', ssid: 9, symbol: '/>', beacon: '' });
  accounts.create({ username: 'bob', password: 'bob password', role: 'admin' });
  accounts.remove(alice.id);
  assert.equal(accounts.profile(alice.id), null, 'gone with the account');
});

test('a radio\'s beacon through the API: an admin\'s, and filled in from one\'s profile', { skip: !sqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../src/store.js');
  const { Accounts } = await import('../src/accounts.js');
  const { createApp } = await import('../src/api.js');
  const store = new Store(':memory:', 'base');
  store.saveRadio({ mac: MAC, name: 'Bench', model: 'uv-pro' });
  const accounts = new Accounts(new DatabaseSync(':memory:'));
  accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  accounts.create({ username: 'vic', password: 'viewer password', role: 'viewer' });
  let bss = { callsign: 'N0CALL', ssid: 7, symbol: '/[', beacon: 'hello', share_location: false, share_interval: 300,
    ptt_send_location: false, format: 'aprs' };
  const asked = [];
  const manager = Object.assign(new EventEmitter(), {
    radios: () => [],
    radioBeacon: async () => ({ ...bss }),
    setRadioBeacon: async (mac, changes) => {
      asked.push(changes);
      bss = { ...bss, ...changes };
      return { ...bss };
    },
  });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'script' }] } };
  const server = createApp({ manager, store, sidecar: {}, config, dataDir: '.', accounts }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const browser = () => {
    let cookie = '';
    return async (method, path, body, token) => {
      const res = await fetch(`${base}${path}`, { method, body: body && JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  try {
    const alice = browser();
    assert.equal((await alice('POST', '/login', { username: 'alice', password: 'correct horse' })).status, 200);
    const vic = browser();
    await vic('POST', '/login', { username: 'vic', password: 'viewer password' });

    // One's own profile: anyone with an account
    assert.equal((await vic('PUT', '/account/radio', { callsign: 'K1VIC', ssid: 7, symbol: '/[', beacon: '' })).status, 200);
    const bad = await alice('PUT', '/account/radio', { callsign: 'N1ABC-9' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /without the SSID/);
    assert.deepEqual((await alice('PUT', '/account/radio', { callsign: 'n1abc', ssid: 9, symbol: '/>', beacon: 'Mobile' })).body.radio,
      { callsign: 'N1ABC', ssid: 9, symbol: '/>', beacon: 'Mobile' });
    assert.equal((await alice('GET', '/account')).body.radio.callsign, 'N1ABC', 'shown with the account');
    assert.equal((await alice('GET', '/session')).body.user.radio.callsign, 'N1ABC', 'and with the session, for the Map');

    // A radio's beacon: an admin's
    assert.equal((await vic('GET', `/radios/${MAC}/beacon`)).status, 403);
    assert.deepEqual((await alice('GET', `/radios/${MAC}/beacon`)).body.callsign, 'N0CALL');
    assert.equal((await alice('PUT', `/radios/${MAC}/beacon`, { share_interval: 7 })).status, 400);
    assert.equal(asked.length, 0, 'refused before the radio was asked');
    const shared = await alice('PUT', `/radios/${MAC}/beacon`, { share_location: true, share_interval: 600 });
    assert.deepEqual([shared.status, shared.body.share_location], [200, true]);
    const mine = await alice('PUT', `/radios/${MAC}/beacon`, { profile: true });
    assert.deepEqual(asked.at(-1), { callsign: 'N1ABC', ssid: 9, symbol: '/>', beacon: 'Mobile', format: 'aprs' }, 'filled in from it');
    assert.equal(mine.body.callsign, 'N1ABC');
    const script = browser();
    const noAccount = await script('PUT', `/radios/${MAC}/beacon`, { profile: true }, 'script');
    assert.equal(noAccount.status, 400);
    assert.match(noAccount.body.error, /Only an account has a profile/);
    await alice('PUT', '/account/radio', { callsign: '' });
    assert.match((await alice('PUT', `/radios/${MAC}/beacon`, { profile: true })).body.error, /no amateur radio profile yet/);
  } finally {
    server.close();
  }
});
