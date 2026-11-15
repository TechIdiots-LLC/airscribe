import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkChannel, checkChannels, radioName, tone } from '../src/channels.js';

// node:sqlite arrived in Node 22.5; on older Node the API test reports as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);
const MAC = '38:D2:00:01:56:51';
const OTHER = '38:D2:00:01:56:52';

test('tones as RadioReference and the radio link write them', () => {
  assert.equal(tone('127.3 PL'), '127.3');
  assert.equal(tone('67'), '67.0');
  assert.equal(tone('100.0'), '100.0');
  assert.equal(tone('023 DPL'), 'D023');
  assert.equal(tone('D754N'), 'D754');
  assert.equal(tone('d023'), 'D023');
  for (const none of ['', 'CSQ', null, undefined, 'none']) assert.equal(tone(none), '', `${none} is no tone`);
  for (const bad of ['D089', '089 DPL', 'D023I', '300.0 PL', 'NAC 293', '12']) {
    assert.throws(() => tone(bad), { status: 400 }, `${bad} isn't a tone the radio takes`);
  }
});

test('a name the radio can show', () => {
  assert.equal(radioName('Rutland FD Dispatch'), 'Rutland FD');
  assert.equal(radioName('  HOLDEN  PD  '), 'HOLDEN PD');
  assert.equal(radioName('Café 1'), 'Caf 1');
  assert.equal(radioName('Worcester x'), 'Worcester', 'not left ending in a space');
});

test('a channel is checked, and transmits only in the ham bands', () => {
  const fire = checkChannel({ id: 0, name: 'Rutland FD', rx_hz: 154250000, bandwidth: 'narrow', rx_tone: '100.0 PL', scan: true });
  assert.deepEqual(fire, {
    id: 0, name: 'Rutland FD', rx_hz: 154250000, tx_hz: 154250000, mod: 'FM', bandwidth: 'narrow',
    rx_tone: '100.0', tx_tone: '', scan: true, power: 'low', tx_disable: true,
  }, 'filled out, and receive-only outside the ham bands');
  const ham = checkChannel({ id: 1, name: 'W1BIM', rx_hz: 146970000, tx_hz: 146370000, tx_tone: '114.8', power: 'high' });
  assert.equal(ham.tx_disable, false, 'a repeater in the 2 m band may transmit');
  assert.equal(checkChannel({ ...ham, tx_disable: true }).tx_disable, true, 'unless asked not to');
  assert.equal(checkChannel({ id: 2, rx_hz: 146520000, tx_hz: 151820000 }).tx_disable, true,
    'transmitting outside the band is off even when receiving in it');
  assert.equal(checkChannel({ id: 3, name: 'BOS TWR', rx_hz: 119100000 }).mod, 'AM', 'the airband is AM');
  assert.deepEqual(checkChannel({ id: 4 }), { id: 4, rx_hz: 0 }, 'no frequency is an empty slot');

  for (const [bad, why] of [
    [{ id: -1, rx_hz: 154250000 }, /slot/],
    [{ id: 0, rx_hz: 851012500 }, /can’t receive 851\.0125 MHz/],
    [{ id: 0, rx_hz: 45000000 }, /can’t receive/],
    [{ id: 0, rx_hz: 154250000.5 }, /whole hertz/],
    [{ id: 0, rx_hz: 119100000, mod: 'FM' }, /airband is AM only/],
    [{ id: 0, rx_hz: 154250000, mod: 'DMR' }, /FM or AM/],
    [{ id: 0, rx_hz: 154250000, bandwidth: 'medium' }, /wide or narrow/],
    [{ id: 0, rx_hz: 154250000, rx_tone: 'NAC 293' }, /tone/],
    [{ id: 0, rx_hz: 154250000, name: '火' }, /nothing the radio can show/],
  ]) {
    assert.throws(() => checkChannel(bad), (e) => e.status === 400 && why.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => checkChannels([{ id: 1, rx_hz: 154250000 }, { id: 1 }]), /given twice/);
  assert.throws(() => checkChannels([]), /at least one/);
});

/** A radio as the manager sees it: 30 slots in each of two regions, and what it was asked. */
function fakeRadio() {
  const blank = (id) => ({ id, name: '', rx_hz: 0, empty: true, raw: `${id.toString(16).padStart(2, '0')}${'00'.repeat(24)}` });
  const tables = [Array.from({ length: 30 }, (_, i) => blank(i)), Array.from({ length: 30 }, (_, i) => blank(i))];
  tables[0][0] = { id: 0, name: 'Holden PD', rx_hz: 460387500, empty: false, raw: `00${'11'.repeat(24)}` };
  const calls = [];
  const manager = Object.assign(new EventEmitter(), {
    radios: () => [],
    readChannels: async (mac, region) => {
      calls.push(['read', mac, region]);
      if (mac === OTHER) throw new Error(`${mac} isn't connected`);
      const r = region ?? 0;
      return { region: r, name: ['Local', 'Travel'][r], count: 30, channels: tables[r].map((c) => ({ ...c })) };
    },
    writeChannels: async (mac, region, channels) => {
      calls.push(['write', mac, region, channels]);
      for (const c of channels) {
        tables[region][c.id] = c.raw ? { id: c.id, raw: c.raw, name: 'restored', empty: false } : { ...c, empty: !c.rx_hz };
      }
      return { region, name: ['Local', 'Travel'][region], results: channels.map((c) => ({ id: c.id, ok: true })) };
    },
  });
  return { manager, calls, tables };
}

test('a radio\'s channels: read, written after a backup, and put back', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const store = new Store(':memory:');
  store.saveRadio({ mac: MAC, name: 'Bench', model: 'uv-pro' });
  store.saveRadio({ mac: OTHER, name: 'Off', model: 'uv-pro' });
  const { manager, calls, tables } = fakeRadio();
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'admin' }, { token: 'viewer', role: 'viewer' }] } };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/radios`;
  const call = async (method, path, token = 'admin', body) => {
    const res = await fetch(`${base}${path}`, {
      method, body: method === 'GET' || !body ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    for (const [method, path] of [['GET', '/channels'], ['PUT', '/channels'], ['GET', '/backups'], ['POST', '/backups'],
      ['POST', '/backups/1/restore'], ['DELETE', '/backups/1']]) {
      assert.equal((await call(method, `/${MAC}${path}`, 'viewer', {})).status, 403, `${method} ${path} is an admin's`);
    }
    assert.equal(calls.length, 0);

    // Reading: the region the radio is on, or another
    assert.equal((await call('GET', `/${MAC}/channels`)).body.channels.length, 30);
    assert.equal((await call('GET', `/${MAC}/channels?region=1`)).body.name, 'Travel');
    assert.deepEqual(calls.map((c) => c[2]), [null, 1]);
    assert.equal((await call('GET', `/${MAC}/channels?region=x`)).status, 400);
    assert.equal((await call('GET', '/AA:BB:CC:DD:EE:FF/channels')).status, 404, 'a radio not added');
    const down = await call('GET', `/${OTHER}/channels`);
    assert.equal(down.status, 502);
    assert.match(down.body.error, /isn't connected/, 'the radio link\'s reason');

    // Writing: refused before the radio is asked anything, or backed up first
    calls.length = 0;
    const bad = await call('PUT', `/${MAC}/channels`, 'admin', { region: 1, channels: [{ id: 0, rx_hz: 851012500 }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /can’t receive/);
    assert.equal(calls.length, 0);
    const wrote = await call('PUT', `/${MAC}/channels`, 'admin', {
      region: 1, channels: [{ id: 2, name: 'Rutland FD', rx_hz: 154250000, bandwidth: 'narrow', rx_tone: '100.0 PL', scan: true }],
    });
    assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
    assert.deepEqual(calls.map((c) => c[0]), ['read', 'write'], 'the region read for its backup, then written');
    assert.equal(calls[1][2], 1);
    assert.deepEqual(calls[1][3][0], { id: 2, name: 'Rutland FD', rx_hz: 154250000, tx_hz: 154250000, mod: 'FM',
      bandwidth: 'narrow', rx_tone: '100.0', tx_tone: '', scan: true, power: 'low', tx_disable: true });
    assert.equal(wrote.body.backup.label, 'Before writing 1 channel');
    assert.equal(wrote.body.backup.region, 1);
    assert.equal(wrote.body.backup.region_name, 'Travel');
    assert.equal(wrote.body.results[0].ok, true);

    // Backing up by hand, and the list
    const kept = await call('POST', `/${MAC}/backups`, 'admin', { region: 0, label: 'Before the trip' });
    assert.equal(kept.body.programmed, 1);
    assert.deepEqual(kept.body.names, ['Holden PD']);
    const list = await call('GET', `/${MAC}/backups`);
    assert.deepEqual(list.body.map((b) => b.label), ['Before the trip', 'Before writing 1 channel'], 'newest first');
    const one = await call('GET', `/${MAC}/backups/${kept.body.id}`);
    assert.equal(one.body.channels.length, 30, 'every slot, the empty ones too');

    // Putting one back: backed up first, then every slot written as it was read
    calls.length = 0;
    tables[0][0] = { id: 0, name: 'Changed', rx_hz: 155000000, empty: false, raw: `00${'22'.repeat(24)}` };
    const put = await call('POST', `/${MAC}/backups/${kept.body.id}/restore`);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(calls.map((c) => c[0]), ['read', 'write']);
    assert.equal(calls[1][2], 0, 'into the region it came from');
    assert.equal(calls[1][3].length, 30);
    assert.deepEqual(calls[1][3][0], { id: 0, raw: `00${'11'.repeat(24)}` }, 'the record as it was read');
    assert.equal(put.body.backup.label, 'Before putting back “Before the trip”');
    assert.deepEqual(put.body.backup.names, ['Changed'], 'so putting it back can be undone too');

    // Another radio's backup isn't this one's; deleting
    assert.equal((await call('POST', `/${OTHER}/backups/${kept.body.id}/restore`)).status, 404);
    assert.equal((await call('DELETE', `/${MAC}/backups/${kept.body.id}`)).status, 200);
    assert.equal((await call('GET', `/${MAC}/backups/${kept.body.id}`)).status, 404);
    assert.equal((await call('GET', `/${MAC}/backups`)).body.length, 2);
  } finally {
    server.close();
  }
});

test('each radio keeps its newest 50 backups', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const store = new Store(':memory:');
  for (let i = 0; i < 53; i++) {
    store.addChannelBackup({ mac: MAC, region: 0, label: `b${i}`, channels: [{ id: 0, empty: true, raw: '00' }] });
  }
  store.addChannelBackup({ mac: OTHER, region: 0, label: 'other', channels: [] });
  const kept = store.channelBackups(MAC);
  assert.equal(kept.length, 50);
  assert.equal(kept[0].label, 'b52');
  assert.equal(kept.at(-1).label, 'b3');
  assert.equal(store.channelBackups(OTHER).length, 1);
  assert.equal(store.placeChannelIfUnplaced('Rutland FD', 42.37, -71.95), true);
  assert.equal(store.placeChannelIfUnplaced('Rutland FD', 1, 1), false, 'a place already set is kept');
});
