import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guessModel, linkOf, sendsRecordings } from '../src/models.js';

// node:sqlite arrived in Node 22.5; on older Node these report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);
const SCANNER = 'DE:B8:5F:00:00:01';
const RADIO = '38:D2:00:01:56:51';

test('an SDS150 found over Bluetooth is the Bluetooth model, reached over LE', () => {
  assert.equal(guessModel('SDS150:12345678'), 'sds150-ble');
  assert.equal(linkOf('sds150-ble'), 'sds-ble');
  assert.equal(sendsRecordings('sds150-ble'), false, 'it is connected to, not sent recordings by');
  assert.equal(linkOf('sds150'), 'radiocli');
  assert.equal(linkOf('uv-pro'), null);
});

/** A manager with a scanner and a radio saved, its sidecar calls recorded. */
async function setup() {
  const { Store } = await import('../src/store.js');
  const { Manager } = await import('../src/manager.js');
  const store = new Store(':memory:', 'mock');
  store.saveRadio({ mac: SCANNER, name: 'Shack SDS150', model: 'sds150-ble' });
  store.saveRadio({ mac: RADIO, name: 'UV-Pro', model: 'uv-pro' });
  const calls = [];
  const sidecar = Object.assign(new EventEmitter(), { call: async (cmd, args) => { calls.push([cmd, args]); } });
  const manager = new Manager({
    sidecar, store, dataDir: mkdtempSync(join(tmpdir(), 'sdsble-')),
    audio: { sampleRate: 32000, preRollMs: 0, holdMs: 500, minMs: 100, maxMs: 60000, overlapMs: 0, energyThreshold: 0.05 },
    engine: { name: 'mock', transcribe: async () => ({ text: 'engine two responding' }) },
  });
  return { store, manager, calls, sidecar };
}

test('its screen, keys and waterfall: admins only, checked, passed to the sidecar', { skip: !sqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Accounts } = await import('../src/accounts.js');
  const { createApp } = await import('../src/api.js');
  const { store, manager, calls, sidecar } = await setup();
  const accounts = new Accounts(new DatabaseSync(':memory:'));
  accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'script' }] } };
  const app = createApp({ manager, store, sidecar, config, dataDir: mkdtempSync(join(tmpdir(), 'sdsapi-')), accounts })
    .listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const call = async (method, path, body, token = 'script') => {
    const res = await fetch(`${base}${path}`, { method, body: body && JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const updates = [];
    manager.on('update', (u) => updates.push(u));
    assert.deepEqual((await call('GET', `/radios/${SCANNER}/screen`)).body, { screen: null }, 'nothing before it says');
    const lines = [{ text: 'Quick Key Navigation', mode: '____', large: true }];
    sidecar.emit('event', { event: 'scanner-screen', mac: SCANNER, lines, muted: true, mode: 'normal' });
    assert.deepEqual((await call('GET', `/radios/${SCANNER}/screen`)).body.screen.lines, lines);
    assert.ok(updates.some((u) => u.type === 'scanner-screen' && u.screen.lines[0].text === 'Quick Key Navigation'),
      'and pages are told as it changes');
    sidecar.emit('event', { event: 'scanner-waterfall', mac: SCANNER, levels: 'AAEC' });
    assert.ok(updates.some((u) => u.type === 'scanner-waterfall' && u.levels === 'AAEC'));

    assert.equal((await call('POST', `/radios/${SCANNER}/key`, { key: 'M', hold_ms: 1500 })).status, 202);
    assert.equal((await call('POST', `/radios/${SCANNER}/waterfall`, { seconds: 15 })).status, 202);
    assert.deepEqual(calls.slice(-2), [['scanner_key', { mac: SCANNER, key: 'M', hold_ms: 1500 }],
      ['scanner_waterfall', { mac: SCANNER, seconds: 15 }]]);
    assert.equal((await call('POST', `/radios/${SCANNER}/key`, { key: 'KEY,M,H' })).status, 400, 'one key code only');
    assert.equal((await call('POST', `/radios/${SCANNER}/key`, { key: 'M', hold_ms: 60000 })).status, 400);
    assert.equal((await call('POST', `/radios/${SCANNER}/waterfall`, { seconds: 3600 })).status, 400);
    assert.equal((await call('POST', `/radios/${RADIO}/key`, { key: 'M' })).status, 400, 'a radio has no such keys');
    assert.equal((await call('POST', `/radios/${SCANNER}/key`, { key: 'M' }, null)).status, 401);
  } finally {
    app.close();
    manager.stopRetrying();
  }
});

test('connecting tells the sidecar to reach the scanner over LE, and a radio as before', { skip: !sqlite }, async () => {
  const { manager, calls } = await setup();
  await manager.connect(SCANNER);
  await manager.connect(RADIO);
  assert.deepEqual(calls, [['connect', { mac: SCANNER, link: 'sds-ble' }], ['connect', { mac: RADIO }]]);
  manager.stopRetrying();
});

test('a transmission is filed under what the scanner said it was', { skip: !sqlite }, async () => {
  const { store, manager, sidecar } = await setup();
  const updates = [];
  manager.on('update', (u) => updates.push(u));
  const done = new Promise((resolve) => manager.on('update', (u) => u.type === 'transmission' && resolve(u)));
  const say = (e) => sidecar.emit('event', { mac: SCANNER, ...e });
  say({ event: 'status', state: 'connected', detail: 'Bluetooth LE' });
  say({ event: 'audio-start', transmit: false });
  say({ event: 'scanner-channel', system: 'Springfield', channel: 'Fire Dispatch' });
  // 1.5 s of a tone that comes and goes, as the sidecar hands it over: 100 ms at a time
  const rate = 32000;
  for (let c = 0; c < 15; c++) {
    const pcm = Buffer.alloc(rate / 10 * 2);
    for (let i = 0; i < pcm.length / 2; i++) {
      const t = (c * rate / 10 + i) / rate;
      pcm.writeInt16LE(Math.round(12000 * Math.max(0.2, Math.sin(2 * Math.PI * 2 * t)) * Math.sin(2 * Math.PI * 600 * t)), i * 2);
    }
    say({ event: 'audio', rx: true, transmit: false, pcm: pcm.toString('base64') });
  }
  say({ event: 'scanner-channel', system: 'Springfield', department: 'Town of Springfield', channel: 'Fire Dispatch',
    frequency: '154.250000MHz' });
  say({ event: 'audio-end' });
  const tx = await done;
  assert.equal(tx.channel_name, 'Fire Dispatch');
  assert.equal(tx.channel_hz, 154250000);
  const row = store.transmission(tx.id);
  assert.deepEqual(row.details, { system: 'Springfield', department: 'Town of Springfield', source: 'bluetooth' });
  const activity = updates.filter((u) => u.type === 'activity' && u.mac === SCANNER);
  assert.ok(activity.some((u) => u.channelName === 'Fire Dispatch'), 'the card says what it is on');
  assert.equal(manager.radios().find((r) => r.mac === SCANNER).channelName, 'Fire Dispatch', 'and still after a reload');
  manager.stopRetrying();
});
