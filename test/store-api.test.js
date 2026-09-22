import test from 'node:test';
import assert from 'node:assert/strict';

// node:sqlite arrived in Node 22.5; on older Node these tests report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);

test('store round-trips radios and transmissions', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const s = new Store(':memory:');
  s.saveRadio({ mac: 'AA:BB:CC:DD:EE:FF', name: 'Mine', model: 'uv-pro' });
  assert.equal(s.radios().length, 1);
  const id = s.addTransmission({ mac: 'AA:BB:CC:DD:EE:FF', startedAt: 1, durationMs: 1500.4, audioFile: 'x.wav' });
  s.finishTransmission(id, { status: 'done', text: 'net check in', engine: 'mock' });
  assert.equal(s.transmissions({ q: 'check' }).length, 1);
  assert.equal(s.transmissions({ q: 'nomatch' }).length, 0);
  s.deleteRadio('AA:BB:CC:DD:EE:FF');
  assert.equal(s.transmissions().length, 1, 'transmissions outlive the radio');
});

test('API adds a radio, rejects bad input, and enforces tokens', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:');
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const app = createApp({ manager, store, sidecar: {}, auth: { tokens: ['secret'] }, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const h = { 'content-type': 'application/json', authorization: 'Bearer secret' };
  try {
    assert.equal((await fetch(`${base}/radios`)).status, 401);
    assert.equal((await fetch(`${base}/radios?token=secret`)).status, 200);
    assert.equal((await fetch(`${base}/radios`, { method: 'POST', headers: h, body: '{"mac":"zz"}' })).status, 400);
    assert.equal((await fetch(`${base}/radios`, { method: 'POST', headers: h, body: '{"mac":"aabbccddeeff","model":"nope"}' })).status, 400);
    const ok = await fetch(`${base}/radios`, { method: 'POST', headers: h, body: '{"mac":"aabbccddeeff","model":"uv-pro"}' });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).mac, 'AA:BB:CC:DD:EE:FF');
  } finally {
    server.close();
  }
});
