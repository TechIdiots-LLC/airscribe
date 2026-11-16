import test from 'node:test';
import assert from 'node:assert/strict';
import { AfskDecoder, decodeAfsk, fcs } from '../src/afsk.js';
import { decodePacket } from '../src/aprs.js';
import { frame, modulate, random, toPcm } from './fixtures/afsk.js';

const FRAMES = [
  frame('N1HLD-9', 'APRS', ['WIDE1-1'], '!4221.06N/07151.78W>090/035 Mobile'),
  frame('W1BIM', 'APRS', ['N1DIG*', 'WIDE2-1'], ':N1HLD-9  :Net at 8pm{12'),
  frame('KC1WX-13', 'APRS', [], '_10090556c220s004g005t077r000p000P000h50b09900wRSW'),
];
const hex = (list) => list.map((f) => f.toString('hex'));

test('the frame check sequence is CRC-16/X.25', () => {
  assert.equal(fcs(Buffer.from('123456789')), 0x906e);
});

test('packets in clean audio: each once, in order, and readable as APRS', () => {
  const got = decodeAfsk(toPcm(modulate(FRAMES)), 32000);
  assert.deepEqual(hex(got), hex(FRAMES), 'every slicer that got one hands it on once between them');
  const p = decodePacket(got[0]);
  assert.deepEqual([p.source, p.type, p.lat, p.lon], ['N1HLD-9', 'position', 42.351, -71.863]);
  assert.equal(decodePacket(got[1]).summary, 'To N1HLD-9: Net at 8pm');
});

test('the same whatever pieces the audio comes in, odd byte counts included', () => {
  const pcm = toPcm(modulate(FRAMES));
  const got = [];
  const modem = new AfskDecoder(32000, (f) => got.push(f));
  const rng = random(7);
  for (let at = 0; at < pcm.length;) {
    const n = 1 + Math.floor(rng() * 3000);
    modem.push(pcm.subarray(at, at + n));
    at += n;
  }
  assert.deepEqual(hex(got), hex(FRAMES));
});

test('through noise, with the tones 6 dB apart either way, and the bit rate 1% off', () => {
  for (const [what, o, snrDb] of [
    ['noise', {}, 0],
    ['2200 Hz 6 dB down, as de-emphasis leaves a flat signal', { spaceDb: -6 }, 3],
    ['2200 Hz 6 dB up, as a pre-emphasized one arrives on a flat receiver', { spaceDb: 6 }, 3],
    ['1212 baud', { baud: 1212 }, 3],
    ['1188 baud', { baud: 1188 }, 3],
  ]) {
    const got = decodeAfsk(toPcm(modulate(FRAMES, o), { snrDb, rng: random(11) }), 32000);
    assert.deepEqual(hex(got), hex(FRAMES), what);
  }
});

test('at the other rates radio audio comes at', () => {
  for (const rate of [8000, 16000, 44100, 48000]) {
    assert.deepEqual(hex(decodeAfsk(toPcm(modulate(FRAMES, { rate })), rate)), hex(FRAMES), `${rate} Hz`);
  }
});

test('static decodes to nothing, nor does a frame with its check wrong', () => {
  // Loud, clipped hiss, as a radio plays with its squelch open on no signal
  const rng = random(3);
  const hiss = Float64Array.from({ length: 32000 * 10 }, () => 0.9 * Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()));
  assert.deepEqual(decodeAfsk(toPcm(hiss), 32000), []);
  assert.deepEqual(decodeAfsk(toPcm(modulate(FRAMES, { badFcs: true })), 32000), []);
});
