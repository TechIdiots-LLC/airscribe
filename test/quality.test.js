import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, quieting } from '../src/quality.js';

const RATE = 32000;

/**
 * Three seconds of audio: a 1 kHz tone keyed on and off four times a second
 * (syllables), with noise throughout.
 * @param {number} tone - The tone's peak, 0..1.
 * @param {number} noise - The noise's peak, 0..1.
 * @returns {Buffer} 16-bit PCM.
 */
function clip(tone, noise, seconds = 3) {
  const n = RATE * seconds;
  const b = Buffer.alloc(n * 2);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const on = Math.floor(i / (RATE / 8)) % 2 === 0;
    const s = (on ? tone * Math.sin((2 * Math.PI * 1000 * i) / RATE) : 0) + noise * rand();
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  return b;
}

test('quieting: a strong signal stands far above its gaps, static doesn\'t', () => {
  const strong = quieting(clip(0.5, 0.001), RATE);
  const weak = quieting(clip(0.3, 0.15), RATE);
  const hiss = quieting(clip(0, 0.3), RATE);
  assert.ok(strong > 40, `strong, near silent between words: ${strong} dB`);
  assert.ok(weak > 6 && weak < 15, `weak, hiss between words: ${weak} dB`);
  assert.ok(hiss < 3, `static throughout: ${hiss} dB`);
  assert.equal(quieting(clip(0.5, 0, 0.3), RATE), null, 'under half a second is too short to tell');
  assert.equal(quieting(Buffer.alloc(RATE * 2), RATE), null, 'silence has nothing to measure');
  assert.equal(quieting(clip(0.3, 0.15).subarray(0, 2 * RATE), RATE / 2) > 0, true, 'any rate');
});

test('judging a channel by its transmissions', () => {
  const rows = (n, r) => Array.from({ length: n }, () => ({ rssi: null, snr_db: null, no_speech: 0, ...r }));
  assert.deepEqual(judge(rows(5, { rssi: 9, snr_db: 25 })), { count: 5, noSpeech: 0, rssi: 9, snrDb: 25, tags: [] });
  assert.deepEqual(judge(rows(4, { rssi: 2, snr_db: 3.5, no_speech: 1 })).tags, ['static', 'weak']);
  assert.deepEqual(judge(rows(4, { rssi: 8, snr_db: 9 })).tags, [], 'weak-ish audio, but not mostly static');
  assert.deepEqual(judge([...rows(4, { no_speech: 1 }), ...rows(1, {})]).tags, ['static'],
    'not measured (older transmissions): four in five no speech');
  assert.deepEqual(judge(rows(3, { rssi: 3, snr_db: 20 })).tags, ['weak']);
  assert.deepEqual(judge(rows(2, { rssi: 1, snr_db: 1 })).tags, [], 'two aren\'t enough to judge');
  const mixed = judge([{ rssi: 2, snr_db: 30, no_speech: 0 }, { rssi: 10, snr_db: 4, no_speech: 1 }, { rssi: 12, snr_db: 5, no_speech: 1 }]);
  assert.deepEqual([mixed.rssi, mixed.snrDb, mixed.noSpeech], [10, 5, 2], 'medians, and the count with no speech');
});

test('a saved clip read back for measuring', async () => {
  const { encodeWav, decodeWav } = await import('../src/wav.js');
  const pcm = clip(0, 0.3, 1);
  const wav = decodeWav(encodeWav(pcm, RATE));
  assert.equal(wav.rate, RATE);
  assert.ok(wav.pcm.equals(pcm));
  // Static as it came off a 2 m repeater channel: steady hiss at about -6 dBFS,
  // which measured 2.1 dB over 81 s
  assert.ok(quieting(decodeWav(encodeWav(clip(0, 0.85, 2), RATE)).pcm, RATE) < 3);
  assert.equal(decodeWav(Buffer.from('not a wav file')), null);
  const stereo = encodeWav(pcm, RATE);
  stereo.writeUInt16LE(2, 22);
  assert.equal(decodeWav(stereo), null, 'only the mono 16-bit kind AirScribe saves');
});

// node:sqlite arrived in Node 22.5; on older Node this reports as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);

test('static is no speech, whatever a model wrote for it', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const s = new Store(':memory:', 'openvino');
  const add = (at, snrDb, text) => {
    const id = s.addTransmission({ mac: 'AA:BB:CC:DD:EE:FF', startedAt: at, durationMs: 81000, audioFile: `${at}.wav`,
      channelName: 'Clinton 65', channelHz: 146655000, snrDb });
    s.saveTranscript(id, 'openvino', { status: 'done', text });
    return id;
  };
  const hiss = add(1, 2.1, 'So, we\'re going to be doing this. So, we\'re going to be doing this. The');
  const clear = add(2, 24, 'Clinton 65 testing');
  const old = add(3, null, 'from before it was measured');
  assert.equal(s.transmission(hiss).static, true, 'marked for the feed');
  assert.equal(s.transmission(clear).static, false);
  assert.equal(s.transmission(old).static, false, 'not measured is not static');
  assert.deepEqual(s.transmissions({ speech: true }).map((t) => t.id).sort(), [clear, old], 'Hide no speech leaves it out');
  assert.deepEqual(s.purgeCandidates({ noSpeech: true }).map((t) => t.id), [hiss], 'and a cleanup of no speech takes it');
  assert.deepEqual(s.channelQuality({}).get('Clinton 65').map((r) => r.no_speech), [1, 0, 0]);
  assert.ok(!s.insightRows({}).texts.some((t) => t.includes('going to be doing')), 'its made-up words aren\'t in Insights');
  assert.deepEqual(s.needingQuality({}).map((r) => r.id), [old], 'only the one not measured');
  s.setQuality(old, 31.5);
  assert.deepEqual(s.needingQuality({}), []);
});

test('older clips measured from their saved audio', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Manager } = await import('../src/manager.js');
  const { encodeWav } = await import('../src/wav.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { EventEmitter } = await import('node:events');
  const dataDir = mkdtempSync(join(tmpdir(), 'htq-'));
  mkdirSync(join(dataDir, 'clips', 'AABB'), { recursive: true });
  const store = new Store(':memory:', 'mock');
  const add = (name, pcm, transmit = false) => {
    if (pcm) writeFileSync(join(dataDir, 'clips', 'AABB', name), encodeWav(pcm, RATE));
    return store.addTransmission({ mac: 'AA:BB', startedAt: 1, durationMs: 3000, audioFile: join('AABB', name), transmit });
  };
  const hiss = add('hiss.wav', clip(0, 0.3));
  const voice = add('voice.wav', clip(0.5, 0.001));
  const gone = add('gone.wav', null);
  const short = add('short.wav', clip(0.5, 0, 0.2));
  const sent = add('sent.wav', clip(0, 0.3), true);
  const manager = new Manager({
    sidecar: Object.assign(new EventEmitter(), { call: async () => {} }), store, dataDir,
    audio: { sampleRate: RATE, preRollMs: 0, holdMs: 500, minMs: 200, maxMs: 60000, overlapMs: 0, energyThreshold: 0.05 },
    engine: { name: 'mock', transcribe: async () => ({ text: '' }) },
  });
  assert.equal(await manager.measureOlder({ batch: 2 }), 2, 'in batches, the two that could be');
  assert.ok(store.transmission(hiss).snr_db < 3 && store.transmission(hiss).static);
  assert.ok(store.transmission(voice).snr_db > 40 && !store.transmission(voice).static);
  for (const id of [gone, short, sent]) assert.equal(store.transmission(id).snr_db, null, `left alone: ${id}`);
  assert.equal(await manager.measureOlder(), 0, 'and not read again for nothing');
});

test('the store gives each channel\'s received transmissions, since a time', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const s = new Store(':memory:', 'base');
  const add = (name, at, rssi, snrDb, text, transmit = false) => {
    const id = s.addTransmission({ mac: 'AA:BB:CC:DD:EE:FF', startedAt: at, durationMs: 1000, audioFile: `${at}.wav`,
      channelName: name, channelHz: 154250000, rssi, snrDb, transmit });
    if (text !== undefined) s.saveTranscript(id, 'base', { status: 'done', text });
    return id;
  };
  add('Rutland FD', 100, 2, 3.1, '');
  add('Rutland FD', 200, 3, 2.5, '');
  add('Rutland FD', 300, 2, 4, 'engine 2 responding');
  add('Holden PD', 400, 11, 28, 'car 4');
  add('Holden PD', 50, 11, 28, 'too old');
  add('Holden PD', 500, null, null, undefined, true);
  const q = s.channelQuality({ since: 100 });
  assert.deepEqual(q.get('Rutland FD'), [
    { rssi: 2, snr_db: 3.1, no_speech: 1 }, { rssi: 3, snr_db: 2.5, no_speech: 1 }, { rssi: 2, snr_db: 4, no_speech: 1 }],
  'static at 4 dB is no speech, though the model wrote words for it');
  assert.deepEqual(q.get('Holden PD'), [{ rssi: 11, snr_db: 28, no_speech: 0 }], 'not before the time, nor its own');
  assert.deepEqual(judge(q.get('Rutland FD')).tags, ['static', 'weak']);
  assert.equal(s.channelQuality({ since: 0, mac: '11:22:33:44:55:66' }).size, 0, 'another radio\'s');
});
