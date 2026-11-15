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

test('a radio can be renamed, but not to nothing', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:');
  store.saveRadio({ mac: '38:D2:00:01:56:51', name: 'UV-PRO', model: 'uv-pro' });
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', auth: { tokens: ['secret'] } }, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/radios/38:D2:00:01:56:51`;
  const patch = (body) => fetch(url, { method: 'PATCH', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' } });
  try {
    const res = await patch({ name: '  Fire dispatch  ' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, 'Fire dispatch', 'trimmed');
    assert.equal((await patch({ name: '   ' })).status, 400, 'a blank name is refused');
    assert.equal(store.radio('38:D2:00:01:56:51').name, 'Fire dispatch', 'and the old one kept');
    assert.equal((await patch({ public: true })).status, 200, 'publishing alone still works');
    assert.equal(store.radio('38:D2:00:01:56:51').name, 'Fire dispatch');
  } finally {
    server.close();
  }
});

test('the feed pages by key: every transmission once, newest first, with a total', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:', 'base');
  store.saveRadio({ mac: '38:D2:00:01:56:51', name: 'Fire dispatch', model: 'uv-pro' });
  // Seven clips; 4 and 5 start in the same millisecond, as two radios can
  const at = [1000, 2000, 3000, 4000, 4000, 5000, 6000];
  const ids = at.map((startedAt, i) => {
    const id = store.addTransmission({ mac: '38:D2:00:01:56:51', startedAt, durationMs: 900, audioFile: `${i}.wav` });
    store.saveTranscript(id, 'base', { status: 'done', text: i % 2 ? 'engine fire on Main Street' : 'copy' });
    return id;
  });
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', auth: { tokens: ['secret'] } }, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/transmissions`;
  const get = (qs) => fetch(`${base}?${qs}`, { headers: { authorization: 'Bearer secret' } });
  try {
    const seen = [];
    let before = '';
    for (let page = 0; page < 5; page++) {
      const res = await get(`limit=3${before ? `&before=${before}` : ''}`);
      assert.equal(res.headers.get('x-total-count'), '7');
      const rows = await res.json();
      seen.push(...rows.map((r) => r.id));
      before = res.headers.get('x-next-before');
      if (!before) break;
    }
    assert.equal(seen.length, 7, `three pages: 3, 3, 1, and then no cursor; got ${seen}`);
    assert.deepEqual(new Set(seen).size, 7, 'none twice, the tie included');
    assert.deepEqual(seen, [...ids].sort((a, b) => at[ids.indexOf(b)] - at[ids.indexOf(a)] || b - a), 'newest first');

    // A search is the whole history's, not what a page happened to hold
    const fire = await get('q=fire&limit=2');
    assert.equal(fire.headers.get('x-total-count'), '3');
    assert.equal((await fire.json()).length, 2);
    assert.ok(fire.headers.get('x-next-before'), 'and it pages too');
    // An exact page leaves no cursor to an empty one
    const exact = await get('limit=7');
    assert.equal(exact.headers.get('x-next-before'), null);
    assert.equal((await get('before=yesterday')).status, 400);

    // The radio's name reaches a clip's own record and the CSV
    assert.equal(store.transmission(ids[0]).radio_name, 'Fire dispatch');
    const csv = await (await fetch(`${base}/export?format=csv`, { headers: { authorization: 'Bearer secret' } })).text();
    assert.match(csv.split('\n')[1], /,38:D2:00:01:56:51,Fire dispatch,/);
  } finally {
    server.close();
  }
});

test('the channels heard, and the feed filtered to one of them', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:', 'base');
  const add = (startedAt, channelName, channelHz) =>
    store.addTransmission({ mac: '38:D2:00:01:56:51', startedAt, durationMs: 900, audioFile: `${startedAt}.wav`,
      channelName, channelHz });
  add(1, 'Holden PD', 460387500);
  add(2, 'Rutld FD', 154250000);
  add(3, 'Holden PD', 460387500);
  add(4, null, null);   // a radio that reported no channel
  assert.deepEqual(store.channelsSeen().map((c) => ({ ...c })), [
    { name: 'Holden PD', hz: 460387500, count: 2, last: 3, lat: null, lon: null },
    { name: 'Rutld FD', hz: 154250000, count: 1, last: 2, lat: null, lon: null },
  ]);
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', auth: { tokens: ['secret'] } }, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = (p) => fetch(`${base}${p}`, { headers: { authorization: 'Bearer secret' } });
  try {
    assert.equal((await (await get('/channels')).json()).length, 2);
    const holden = await get('/transmissions?channel=Holden%20PD');
    assert.equal(holden.headers.get('x-total-count'), '2');
    assert.ok((await holden.json()).every((t) => t.channel_name === 'Holden PD'));
    // Several at once, as the Map's list asks for the channels in view
    const both = await get('/transmissions?channel=Holden%20PD&channel=Rutld%20FD');
    assert.equal(both.headers.get('x-total-count'), '3');
    assert.deepEqual((await both.json()).map((t) => t.started_at), [3, 2, 1], 'both channels, not the one with none');
    assert.equal((await (await get('/transmissions?channel=')).json()).length, 4, 'an empty filter is every channel');
    assert.equal(store.transmissions({ channel: [] }).length, 4, 'and so is an empty list');
    const csv = await (await get('/transmissions/export?format=csv&channel=Rutld%20FD')).text();
    assert.equal(csv.trim().split('\n').length, 1, 'no transcripts yet, so only the header');
  } finally {
    server.close();
  }
});

test('channels on the map: admins place and remove them, anyone sees them', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:', 'base');
  store.addTransmission({ mac: '38:D2:00:01:56:51', startedAt: 1, durationMs: 900, audioFile: 'a.wav',
    channelName: 'Holden PD', channelHz: 460387500 });
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const config = {
    host: '127.0.0.1', auth: { tokens: [{ token: 'admin' }, { token: 'viewer', role: 'viewer' }] },
    map: { styles: [{ name: 'Color relief', url: 'https://tiles.wifidb.net/styles/WDB_COLOR_RELIEF/style.json' }] },
  };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, path, token, body) => fetch(`${base}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const place = '/channels/Holden%20PD/place';
  try {
    assert.equal((await call('PUT', place, 'viewer', { lat: 42.36, lon: -71.85 })).status, 403, 'a viewer can\'t place');
    assert.equal((await call('PUT', place, 'admin', { lat: 91, lon: 0 })).status, 400);
    assert.equal((await call('PUT', place, 'admin', { lat: 'x', lon: 0 })).status, 400);
    assert.equal((await call('PUT', '/channels/Nowhere/place', 'admin', { lat: 1, lon: 1 })).status, 404, 'only a channel heard');
    const put = await (await call('PUT', place, 'admin', { lat: 42.36, lon: -71.85 })).json();
    assert.deepEqual([put.lat, put.lon], [42.36, -71.85]);
    const seen = await (await call('GET', '/channels', 'viewer')).json();
    assert.deepEqual([seen[0].name, seen[0].lat, seen[0].lon], ['Holden PD', 42.36, -71.85], 'a viewer sees where');
    await call('PUT', place, 'admin', { lat: 42.4, lon: -71.9 });
    assert.equal(store.channelsSeen()[0].lat, 42.4, 'moved, not duplicated');
    assert.equal((await call('DELETE', place, 'viewer')).status, 403);
    assert.equal((await call('DELETE', place, 'admin')).status, 204);
    assert.equal((await call('DELETE', place, 'admin')).status, 404);
    assert.equal(store.channelsSeen()[0].lat, null);
    const map = await (await call('GET', '/map', 'viewer')).json();
    assert.equal(map.styles[0].url, 'https://tiles.wifidb.net/styles/WDB_COLOR_RELIEF/style.json');
  } finally {
    server.close();
  }
});
