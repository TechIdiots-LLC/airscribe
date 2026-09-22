import test from 'node:test';
import assert from 'node:assert/strict';
import { Segmenter } from '../src/segmenter.js';

const RATE = 8000;
const CHUNK_MS = 100;
const n = (RATE * CHUNK_MS) / 1000;

/** @param {number} amp - 0..1 constant level. @returns {Buffer} One chunk. */
function chunk(amp) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * (i % 2 ? 1 : -1)), i * 2);
  return b;
}

function make(over = {}) {
  const clips = [];
  const seg = new Segmenter({
    sampleRate: RATE, preRollMs: 200, holdMs: 500, minMs: 300, maxMs: 5000,
    energyThreshold: 0.05, onClip: (c) => clips.push(c), ...over,
  });
  return { seg, clips, feed: (count, amp, rx) => { for (let i = 0; i < count; i++) seg.push(chunk(amp), rx); } };
}

test('one squelch-open burst becomes one clip', () => {
  const { clips, feed } = make();
  feed(10, 0, false);
  feed(20, 0.3, true);
  feed(10, 0, false);
  assert.equal(clips.length, 1);
  assert.ok(clips[0].durationMs >= 2000);
});

test('a pause shorter than holdMs does not split the message', () => {
  const { clips, feed } = make();
  feed(10, 0.3, true);
  feed(3, 0, false); // 300 ms < 500 ms hold
  feed(10, 0.3, true);
  feed(10, 0, false);
  assert.equal(clips.length, 1);
});

test('a pause longer than holdMs splits into two clips', () => {
  const { clips, feed } = make();
  feed(10, 0.3, true);
  feed(8, 0, false);
  feed(10, 0.3, true);
  feed(8, 0, false);
  assert.equal(clips.length, 2);
});

test('a blip shorter than minMs is dropped', () => {
  const { clips, feed } = make();
  feed(1, 0.3, true);
  feed(10, 0, false);
  assert.equal(clips.length, 0);
});

test('energy alone opens a clip when the radio flag is unreliable', () => {
  const { clips, feed } = make();
  feed(10, 0.3, false);
  feed(10, 0, false);
  assert.equal(clips.length, 1);
});

test('a clip past maxMs is closed and another begins', () => {
  const { clips, feed } = make({ maxMs: 1000 });
  feed(35, 0.3, true);
  assert.ok(clips.length >= 3);
});

test('flush closes a clip in progress', () => {
  const { seg, clips, feed } = make();
  feed(10, 0.3, true);
  assert.equal(clips.length, 0);
  seg.flush();
  assert.equal(clips.length, 1);
});

test('pre-roll audio is included at the head of the clip', () => {
  const { clips, feed } = make({ preRollMs: 200 });
  feed(10, 0, false);
  feed(10, 0.3, true);
  feed(10, 0, false);
  assert.ok(clips[0].durationMs >= 1000 + 200);
});
