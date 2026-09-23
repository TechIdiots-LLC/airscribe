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
  assert.equal(s.transmission(id).transmit, 0, 'received unless stated otherwise');
  const sent = s.addTransmission({ mac: 'AA:BB:CC:DD:EE:FF', startedAt: 2, durationMs: 900, audioFile: 'y.wav', transmit: true });
  assert.equal(s.transmission(sent).transmit, 1);
  s.saveTranscript(id, 'mock', { status: 'done', text: 'net check in' });
  assert.equal(s.transmissions({ q: 'check' }).length, 1);
  assert.equal(s.transmissions({ q: 'nomatch' }).length, 0);
  s.deleteRadio('AA:BB:CC:DD:EE:FF');
  assert.equal(s.transmissions().length, 2, 'transmissions outlive the radio');
});

test('a database written before the transmit column is upgraded in place', { skip: !sqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../src/store.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'htdb-')), 'old.sqlite');

  // The schema as it shipped first, with a row already in it.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE radios (mac TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT, added_at INTEGER NOT NULL);
    CREATE TABLE transmissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      audio_file TEXT NOT NULL, status TEXT NOT NULL, text TEXT, engine TEXT, error TEXT);
    INSERT INTO transmissions (mac, started_at, duration_ms, audio_file, status, text)
      VALUES ('AA:BB:CC:DD:EE:FF', 1, 100, 'old.wav', 'done', 'net check in');
  `);
  old.close();

  const s = new Store(file);
  const rows = s.transmissions();
  assert.equal(rows.length, 1, 'the existing row survives');
  assert.equal(rows[0].text, 'net check in');
  assert.equal(rows[0].transmit, 0, 'older rows default to received');
  s.addTransmission({ mac: 'AA:BB:CC:DD:EE:FF', startedAt: 2, durationMs: 50, audioFile: 'new.wav', transmit: true });
  assert.equal(s.transmissions()[0].transmit, 1);
});

test('API adds a radio, rejects bad input, and enforces tokens', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:');
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', auth: { tokens: ['secret'] } }, dataDir: '.' });
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
