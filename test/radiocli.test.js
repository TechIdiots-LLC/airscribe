import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { frequencyHz, readSidecar } from '../src/radiocli.js';
import { decodeWav, encodeWav, resample } from '../src/wav.js';

// node:sqlite arrived in Node 22.5; on older Node these report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);
const TOOL = fileURLToPath(new URL('../tools/radiocli-upload.mjs', import.meta.url));

/** A recording as radiocli writes one: 48 kHz, a voice-like tone that comes and goes. */
function recording(seconds = 2, rate = 48000) {
  const pcm = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    const t = i / rate;
    const loud = Math.max(0, Math.sin(2 * Math.PI * 3 * t));
    pcm.writeInt16LE(Math.round(12000 * loud * Math.sin(2 * Math.PI * 440 * t)), i * 2);
  }
  return encodeWav(pcm, rate);
}

/** radiocli's sidecar for a P25 talkgroup (its documented fields). */
const TRUNKED = {
  file: '2026-11-16/19-54-03_COUNTY-PS_SHERIFF_SO-DISPATCH.wav',
  start: '2026-11-16T19:54:03.390720-05:00', end: '2026-11-16T19:54:05.390720-05:00', duration: 2,
  list: 'Worcester County', system: 'COUNTY PS', department: 'SHERIFF', site: 'Simulcast 1',
  channel: 'SO Dispatch', frequency: '851.012500MHz', talkgroup: '1201', unit: '4417', nac: '293',
  digital: 'P25', modulation: 'NFM', rssi: '-87', reason: 'hang', samples: 7,
};

test('radiocli\'s sidecar: when, the channel it\'s filed under, its frequency, and the rest kept', () => {
  assert.equal(frequencyHz('155.550000MHz'), 155550000);
  assert.equal(frequencyHz('851.0375'), 851037500);
  assert.equal(frequencyHz('162.55 MHz'), 162550000);
  assert.equal(frequencyHz('nope'), null);
  const r = readSidecar(TRUNKED, 2000);
  assert.equal(r.startedAt, Date.parse('2026-11-17T00:54:03.390Z'));
  assert.deepEqual([r.channelName, r.channelHz], ['SO Dispatch', 851012500]);
  assert.deepEqual(r.details, { list: 'Worcester County', system: 'COUNTY PS', department: 'SHERIFF', site: 'Simulcast 1',
    talkgroup: '1201', unit: '4417', nac: '293', digital: 'P25', modulation: 'NFM', rssi: '-87' });
  // No channel name: the talkgroup, then the department, then the frequency; no start: counted back from now
  assert.equal(readSidecar({ talkgroup: 77 }, 1000).channelName, 'TG 77');
  assert.equal(readSidecar({ frequency: '154.4150MHz' }, 1000).channelName, '154.4150MHz');
  assert.equal(readSidecar({}, 1500, 10000).startedAt, 8500);
  assert.throws(() => readSidecar([1], 1000), { status: 400 });
});

test('resampling to 16 kHz for the speech models, from 48 and 44.1 kHz', () => {
  const wav = decodeWav(recording(1));
  const at16 = resample(wav.pcm, 48000, 16000);
  assert.equal(at16.length / 2, 16000);
  // A sample of the result is the average of the three it stands for
  const avg = Math.round((wav.pcm.readInt16LE(300) + wav.pcm.readInt16LE(302) + wav.pcm.readInt16LE(304)) / 3);
  assert.equal(at16.readInt16LE(100), avg);
  assert.equal(resample(Buffer.alloc(44100 * 2), 44100, 16000).length / 2, 16000);
  assert.equal(resample(wav.pcm, 16000, 16000), wav.pcm);
});

/** AirScribe with a token, an admin account, and a mock transcriber. */
async function server() {
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../src/store.js');
  const { Manager } = await import('../src/manager.js');
  const { Accounts } = await import('../src/accounts.js');
  const { createApp } = await import('../src/api.js');
  const store = new Store(':memory:', 'mock');
  const sidecar = Object.assign(new EventEmitter(), { call: async () => {} });
  const dataDir = mkdtempSync(join(tmpdir(), 'rcli-'));
  const transcribed = [];
  const manager = new Manager({
    sidecar, store, dataDir,
    audio: { sampleRate: 32000, preRollMs: 0, holdMs: 500, minMs: 100, maxMs: 60000, overlapMs: 0, energyThreshold: 0.05 },
    engine: { name: 'mock', transcribe: async (wav) => { transcribed.push(wav); return { text: 'units responding' }; } },
  });
  const accounts = new Accounts(new DatabaseSync(':memory:'));
  accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  accounts.create({ username: 'vic', password: 'viewer password', role: 'viewer' });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'script' }] } };
  const app = createApp({ manager, store, sidecar, config, dataDir, accounts }).listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, path, { body, headers = {}, token = 'script' } = {}) => {
    const res = await fetch(`${base}/api${path}`, { method, body,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { app, base, store, manager, dataDir, transcribed, call };
}

const upload = (call, mac, wav, sidecar, extra = {}) => call('POST', `/radios/${mac}/recordings`, {
  body: wav, headers: { 'content-type': 'audio/wav', 'x-radiocli': Buffer.from(JSON.stringify(sidecar)).toString('base64') }, ...extra,
});

test('a scanner: added without an address, sent recordings, each kept once and transcribed', { skip: !sqlite }, async () => {
  const { app, store, manager, dataDir, transcribed, call } = await server();
  try {
    const json = { 'content-type': 'application/json' };
    const added = await call('POST', '/radios', { body: JSON.stringify({ model: 'sds150', name: 'SDS150' }), headers: json });
    assert.equal(added.status, 201);
    const mac = added.body.mac;
    assert.match(mac, /^02(:[0-9A-F]{2}){5}$/, 'an id shaped like an address, locally administered');
    const listed = (await call('GET', '/radios')).body.find((r) => r.mac === mac);
    assert.deepEqual([listed.state, listed.last_recording], ['recordings', null]);
    assert.equal((await call('POST', `/radios/${mac}/connect`)).status, 400, 'not connected to');

    const sent = await upload(call, mac, recording(), TRUNKED);
    assert.equal(sent.status, 201);
    const t = store.transmission(sent.body.id);
    assert.deepEqual([t.mac, t.started_at, t.duration_ms, t.channel_name, t.channel_hz, t.transmit],
      [mac, Date.parse(TRUNKED.start), 2000, 'SO Dispatch', 851012500, 0]);
    assert.deepEqual([t.details.talkgroup, t.details.unit, t.details.digital, t.details.source], ['1201', '4417', 'P25', 'radiocli']);
    assert.ok(Number.isFinite(t.snr_db) && !t.static, `measured for static, and isn't: ${t.snr_db} dB`);
    assert.equal(decodeWav(readFileSync(join(dataDir, 'clips', t.audio_file))).rate, 48000, 'kept as recorded');
    assert.equal(decodeWav(readFileSync(join(dataDir, 'clips', t.audio_file).replace('.wav', '.16k.wav'))).rate, 16000);
    await manager.pump();
    assert.equal(transcribed.length, 1);
    assert.equal(store.transmission(t.id).text, 'units responding');
    assert.equal((await call('GET', '/radios')).body.find((r) => r.mac === mac).last_recording, t.started_at);

    const again = await upload(call, mac, recording(), TRUNKED);
    assert.deepEqual([again.status, again.body], [200, { id: t.id, duplicate: true }], 'sent twice, kept once');
    // Found by its talkgroup or unit, not by the name of a field
    assert.equal((await call('GET', '/transmissions?q=4417')).body.length, 1);
    assert.equal((await call('GET', '/transmissions?q=talkgroup')).body.length, 0);

    for (const [what, res, status] of [
      ['no description', await call('POST', `/radios/${mac}/recordings`, { body: recording(), headers: { 'content-type': 'audio/wav' } }), 400],
      ['not a WAV', await upload(call, mac, Buffer.from('hello'), TRUNKED), 400],
      ['an unknown scanner', await upload(call, '02:00:00:00:00:01', recording(), TRUNKED), 404],
      ['no credential', await upload(call, mac, recording(), TRUNKED, { token: null }), 401],
    ]) assert.equal(res.status, status, what);
    store.saveRadio({ mac: '38:D2:00:01:56:51', name: 'UV-PRO 2', model: 'uv-pro' });
    const radio = await upload(call, '38:D2:00:01:56:51', recording(), TRUNKED);
    assert.equal(radio.status, 400);
    assert.match(radio.body.error, /isn't a scanner/);
  } finally {
    app.close();
  }
});

test('the uploader sends what radiocli recorded, files it away, and leaves what\'s unfinished', { skip: !sqlite }, async () => {
  const { app, base, store, call } = await server();
  try {
    const mac = (await call('POST', '/radios', { body: JSON.stringify({ model: 'sds150', name: 'SDS150' }),
      headers: { 'content-type': 'application/json' } })).body.mac;
    const folder = mkdtempSync(join(tmpdir(), 'rcli-rec-'));
    const day = join(folder, '2026-11-16');
    mkdirSync(day);
    const old = new Date(Date.now() - 10000);
    const put = (name, wav, json) => {
      writeFileSync(join(day, `${name}.wav`), wav);
      if (json !== undefined) writeFileSync(join(day, `${name}.json`), json);
      for (const ext of ['wav', 'json']) if (existsSync(join(day, `${name}.${ext}`))) utimesSync(join(day, `${name}.${ext}`), old, old);
    };
    put('19-54-03_SO', recording(), JSON.stringify(TRUNKED));
    put('19-55-10_FIRE', recording(1), JSON.stringify({ start: '2026-11-16T19:55:10-05:00', channel: 'Fire Dispatch', frequency: '154.4150MHz' }));
    put('19-56-00_BAD', Buffer.from('not audio'), JSON.stringify({ channel: 'x' }));
    put('19-57-00_BUSY', recording(), undefined);   // its .json not written yet
    const run = await promisify(execFile)(process.execPath, [TOOL, '--server', base, '--radio', mac, '--once', folder],
      { env: { ...process.env, AIRSCRIBE_TOKEN: 'script' } });
    assert.match(run.stdout, /19-54-03_SO\.wav: sent/);
    assert.equal(store.transmissions({ mac }).length, 2);
    assert.ok(existsSync(join(folder, 'uploaded', '2026-11-16', '19-54-03_SO.wav')));
    assert.ok(existsSync(join(folder, 'uploaded', '2026-11-16', '19-55-10_FIRE.json')));
    assert.match(readFileSync(join(folder, 'rejected', '2026-11-16', '19-56-00_BAD.error.txt'), 'utf8'), /16-bit mono WAV/);
    assert.ok(existsSync(join(day, '19-57-00_BUSY.wav')), 'one without its .json is left for later');
    // A wrong scanner id stops it, saying so
    put('19-57-00_BUSY', recording(), '{}');
    const wrong = await promisify(execFile)(process.execPath, [TOOL, '--server', base, '--radio', '02:00:00:00:00:09', '--once', folder],
      { env: { ...process.env, AIRSCRIBE_TOKEN: 'script' } }).catch((e) => e);
    assert.equal(wrong.code, 1);
    assert.ok(existsSync(join(day, '19-57-00_BUSY.wav')), 'and keeps the recording');
    // Signed in with an account instead of a token: an admin's needs two-step, which a script can't do
    const env = { ...process.env, AIRSCRIBE_PASSWORD: 'correct horse' };
    delete env.AIRSCRIBE_TOKEN;
    const asAlice = await promisify(execFile)(process.execPath,
      [TOOL, '--server', base, '--radio', mac, '--user', 'alice', '--once', folder], { env }).catch((e) => e);
    assert.ok(asAlice.code, 'it stops');
    assert.match(asAlice.stderr, /two-step verification.*AIRSCRIBE_TOKEN/);
    assert.ok(existsSync(join(day, '19-57-00_BUSY.wav')), 'kept for when it can send');
    assert.match(wrong.stderr, /unknown radio/);
  } finally {
    app.close();
  }
});
