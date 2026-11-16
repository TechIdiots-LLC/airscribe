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

// node:sqlite arrived in Node 22.5; on older Node this reports as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);

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
    { rssi: 2, snr_db: 3.1, no_speech: 1 }, { rssi: 3, snr_db: 2.5, no_speech: 1 }, { rssi: 2, snr_db: 4, no_speech: 0 }]);
  assert.deepEqual(q.get('Holden PD'), [{ rssi: 11, snr_db: 28, no_speech: 0 }], 'not before the time, nor its own');
  assert.deepEqual(judge(q.get('Rutland FD')).tags, ['static', 'weak']);
  assert.equal(s.channelQuality({ since: 0, mac: '11:22:33:44:55:66' }).size, 0, 'another radio\'s');
});
