import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// node:sqlite arrived in Node 22.5; on older Node these report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);
const MAC = '38:D2:00:01:56:51';

/** An AX.25 UI frame, as a radio's modem hands one over. */
function frame(source, destination, path, info) {
  const calls = [destination, source, ...path];
  const parts = calls.map((c, i) => {
    const [base, ssid = '0'] = c.replace('*', '').split('-');
    const a = Buffer.alloc(7);
    for (let k = 0; k < 6; k++) a[k] = base.padEnd(6).charCodeAt(k) << 1;
    a[6] = 0x60 | ((Number(ssid) & 0x0f) << 1) | (c.endsWith('*') ? 0x80 : 0) | (i === calls.length - 1 ? 1 : 0);
    return a;
  });
  return Buffer.concat([...parts, Buffer.from([0x03, 0xf0]), Buffer.from(info, 'latin1')]);
}

const POS = frame('N1HLD-9', 'APRS', ['WIDE1-1'], '!4221.06N/07151.78W>090/035 Mobile');

test('packets kept once, listed, and stations by their latest place', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { decodePacket } = await import('../src/aprs.js');
  const s = new Store(':memory:', 'base');
  const add = (raw, at, extra = {}) => s.addPacket({ mac: MAC, receivedAt: at, raw: raw.toString('hex'), ...decodePacket(raw), ...extra });
  const first = add(POS, 1000);
  assert.equal(add(POS, 20000), null, 'a digipeater\'s copy of it, 19 s later, isn\'t kept');
  const later = add(POS, 40000, { channel: 3, channelName: 'APRS', channelHz: 144390000 });
  assert.ok(later > first, 'the same again 39 s later is a new beacon');
  const moved = add(frame('N1HLD-9', 'APRS', [], '!4222.00N/07152.00W>090/035 Mobile'), 50000);
  add(frame('W1BIM', 'APRS', [], ';CRANE    *151200z4221.30N/07152.40WcRoad work'), 60000);
  add(frame('W1BIM', 'APRS', [], ';OLDCRANE _151200z4221.30N/07152.40WcGone'), 61000);
  add(frame('N1HLD-9', 'APRS', [], ':W1BIM    :Net at 8pm{12'), 62000);
  add(frame('W1BIM', 'APRS', [], '>On the air'), 63000);

  const p = s.packet(later);
  assert.deepEqual([p.source, p.who, p.type, p.channel_name, p.channel_hz, p.path, p.symbol.name], ['N1HLD-9', 'N1HLD-9',
    'position', 'APRS', 144390000, ['WIDE1-1'], 'Car']);
  assert.equal(p.comment, 'Mobile', 'what was decoded spread in');
  assert.equal(s.packets().length, 7);
  assert.deepEqual(s.packets({ kind: 'messages' }).map((x) => x.summary), ['To W1BIM: Net at 8pm']);
  assert.deepEqual(s.packets({ kind: 'positions' }).map((x) => x.who), ['OLDCRANE', 'CRANE', 'N1HLD-9', 'N1HLD-9', 'N1HLD-9']);
  assert.equal(s.packets({ q: 'crane' }).length, 2);
  assert.deepEqual(s.packets({ before: moved, limit: 1 }).map((x) => x.id), [later]);

  const stations = s.stations({ since: 0 });
  assert.deepEqual(stations.map((x) => x.who), ['CRANE', 'N1HLD-9'], 'latest first; the object taken away left out');
  const n1 = stations.find((x) => x.who === 'N1HLD-9');
  assert.deepEqual([n1.id, n1.heard, n1.first_heard], [moved, 3, 1000]);
  assert.deepEqual(s.stations({ since: 45000 }).map((x) => x.who), ['CRANE', 'N1HLD-9']);
  assert.deepEqual(s.stationTrack('N1HLD-9').map((x) => x.at), [1000, 50000], 'each place once');
  assert.equal(s.prunePackets(45000), 2);
  assert.equal(s.packets().length, 5);
});

test('a packet in a transmission: shown with it, and a short one that was only data not transcribed', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Manager } = await import('../src/manager.js');
  const store = new Store(':memory:', 'mock');
  const sidecar = Object.assign(new EventEmitter(), { call: async () => {} });
  const transcribed = [];
  const manager = new Manager({
    sidecar, store, dataDir: mkdtempSync(join(tmpdir(), 'htpk-')), packetWaitMs: 30,
    audio: { sampleRate: 8000, preRollMs: 0, holdMs: 500, minMs: 100, maxMs: 60000, overlapMs: 0, energyThreshold: 0.05 },
    engine: { name: 'mock', transcribe: async (wav) => { transcribed.push(wav); return { text: 'heard' }; } },
  });
  const updates = [];
  manager.on('update', (u) => updates.push(u));
  const fire = (e) => sidecar.emit('event', { mac: MAC, ...e });
  const audio = (chunks) => {
    const b = Buffer.alloc(1600);
    for (let i = 0; i < 800; i++) b.writeInt16LE(i % 2 ? 9000 : -9000, i * 2);
    for (let i = 0; i < chunks; i++) fire({ event: 'audio', pcm: b.toString('base64'), rx: true });
  };
  // Newest by id: in a test they all happen at once, and a start is counted back from the end
  const latest = () => store.transmissions().sort((a, b) => b.id - a.id)[0];
  const burst = (chunks) => {
    fire({ event: 'audio-start', transmit: false });
    audio(chunks);
    fire({ event: 'audio-end' });
  };

  // A one-second burst, then the modem's notice: the packet was the burst
  burst(10);
  fire({ event: 'packet', channel: 0, data: POS.toString('hex') });
  const tx1 = latest();
  assert.equal(tx1.data, 1, 'only the packet');
  assert.deepEqual(tx1.packets.map((p) => p.summary), ['Car at 42.3510, -71.8630, 40 mph heading 90° “Mobile”']);
  assert.equal(store.packets()[0].transmission_id, tx1.id);
  assert.ok(updates.some((u) => u.type === 'packet' && u.packet.source === 'N1HLD-9'), 'open pages told');
  assert.deepEqual(store.transmissions({ speech: true }), [], 'data, not speech: Hide no speech leaves it out');

  // Heard while a transmission was still coming in: it waits for that one
  fire({ event: 'audio-start', transmit: false });
  audio(10);
  fire({ event: 'packet', channel: 0, data: frame('W1BIM', 'APRS', [], '>On the air').toString('hex') });
  fire({ event: 'audio-end' });
  const tx2 = latest();
  assert.notEqual(tx2.id, tx1.id);
  assert.deepEqual([tx2.data, tx2.packets.map((p) => p.source)], [1, ['W1BIM']]);

  // Four seconds of voice with a packet at the end, as these radios send on letting go of the talk button
  burst(40);
  fire({ event: 'packet', channel: 0, data: frame('N1HLD-9', 'APRS', [], '>Going home').toString('hex') });
  const tx3 = latest();
  assert.deepEqual([tx3.data, tx3.packets.length], [0, 1], 'shown with it, and still transcribed');
  await new Promise((r) => setTimeout(r, 80));   // the short ones' wait for a packet
  await manager.pump();
  assert.equal(transcribed.length, 1, 'only the voice was transcribed, not the two bursts of data');

  // A packet with no transmission near it stands alone; garbage is only logged
  // (from another radio: on this one, a packet within 3 s of the voice above is that voice's, as a
  // beacon sent on letting go of the talk button is)
  fire({ mac: '11:22:33:44:55:66', event: 'packet', channel: 0, data: frame('KC1WX', 'APRS', [], '>Later').toString('hex') });
  assert.equal(store.packets()[0].transmission_id, null);
  fire({ event: 'packet', channel: 0, data: 'zz' });
  fire({ event: 'packet', channel: 0, data: '00112233' });
  assert.equal(store.packets().length, 4);
  // A transmission deleted keeps its packets
  manager.deleteTransmissions([tx1.id]);
  assert.equal(store.packets().find((p) => p.source === 'N1HLD-9' && p.type === 'position').transmission_id, null);
});

test('packets decoded from the radio\'s audio too: kept once, and marked by what decoded them', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Manager } = await import('../src/manager.js');
  const { modulate, toPcm } = await import('./fixtures/afsk.js');
  const store = new Store(':memory:', 'mock');
  const sidecar = Object.assign(new EventEmitter(), { call: async () => {} });
  const transcribed = [];
  const manager = new Manager({
    sidecar, store, dataDir: mkdtempSync(join(tmpdir(), 'htpk-')), packetWaitMs: 30,
    audio: { sampleRate: 32000, preRollMs: 0, holdMs: 500, minMs: 100, maxMs: 60000, overlapMs: 0, energyThreshold: 0.05 },
    engine: { name: 'mock', transcribe: async (wav) => { transcribed.push(wav); return { text: 'heard' }; } },
  });
  const fire = (e) => sidecar.emit('event', { mac: MAC, ...e });
  // A packet's burst as the radio played it, in 50 ms pieces as the sidecar sends audio
  const play = (frames, o) => {
    const pcm = toPcm(modulate(frames, o));
    fire({ event: 'audio-start', transmit: false });
    for (let at = 0; at < pcm.length; at += 3200) fire({ event: 'audio', pcm: pcm.subarray(at, at + 3200).toString('base64'), rx: true });
    fire({ event: 'audio-end' });
  };

  play([POS]);
  const [p] = store.packets();
  assert.deepEqual([p?.source, p?.decoded_by], ['N1HLD-9', 'airscribe'], 'decoded from the audio');
  const tx = store.transmission(p.transmission_id);
  assert.equal(tx.data, 1, 'the burst it came in was only the packet');
  // The radio's own modem sends the same packet: not kept again, and the one kept was decoded by both
  fire({ event: 'packet', channel: 0, data: POS.toString('hex') });
  assert.equal(store.packets().length, 1);
  assert.equal(store.packets()[0].decoded_by, 'both');
  // One only the radio's modem got
  fire({ event: 'packet', channel: 0, data: frame('W1BIM', 'APRS', [], '>On the air').toString('hex') });
  assert.equal(store.packets()[0].decoded_by, 'radio');
  // Audio the radio sent itself isn't read for packets
  fire({ event: 'audio-start', transmit: true });
  const own = toPcm(modulate([frame('N1HLD-9', 'APRS', [], '>My own beacon')]));
  fire({ event: 'audio', pcm: own.toString('base64'), rx: false, transmit: true });
  fire({ event: 'audio-end' });
  assert.equal(store.packets().length, 2);
  await new Promise((r) => setTimeout(r, 80));
  await manager.pump();
  assert.equal(transcribed.length, 1, 'the burst of data wasn\'t transcribed; the radio\'s own transmission was');
});

test('the API: packets and stations, for anyone signed in', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { decodePacket } = await import('../src/aprs.js');
  const { createApp } = await import('../src/api.js');
  const store = new Store(':memory:', 'base');
  const now = Date.now();
  for (const [raw, ago] of [[POS, 3 * 3600000], [frame('N1HLD-9', 'APRS', [], '!4222.00N/07152.00W>'), 600000],
    [frame('W1BIM', 'APRS', [], '>On the air'), 1000]]) {
    store.addPacket({ mac: MAC, receivedAt: now - ago, raw: raw.toString('hex'), ...decodePacket(raw) });
  }
  const manager = Object.assign(new EventEmitter(), { radios: () => [] });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'viewer', role: 'viewer' }] } };
  const server = createApp({ manager, store, sidecar: {}, config, dataDir: '.' }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const get = async (path, token = 'viewer') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    assert.equal((await get('/packets', 'nobody')).status, 401);
    assert.deepEqual((await get('/packets')).body.map((p) => p.source), ['W1BIM', 'N1HLD-9', 'N1HLD-9']);
    assert.deepEqual((await get('/packets?kind=status')).body.map((p) => p.summary), ['Status: On the air']);
    assert.equal((await get('/stations')).body.length, 1);
    assert.equal((await get('/stations?hours=1')).body[0].heard, 1, 'only what was heard in the hour');
    const n1 = (await get('/stations/N1HLD-9')).body;
    assert.deepEqual([n1.who, n1.track.length, n1.packets.length], ['N1HLD-9', 2, 2]);
  } finally {
    server.close();
  }
});
