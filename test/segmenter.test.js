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

/** A segmenter plus helpers for feeding it. @returns {object} The harness. */
function make(over = {}) {
  const clips = [];
  const seg = new Segmenter({
    sampleRate: RATE, preRollMs: 200, holdMs: 500, minMs: 300, maxMs: 5000,
    overlapMs: 0, energyThreshold: 0.05, onClip: (c) => clips.push(c), ...over,
  });
  const feed = (count, amp, o = {}) => { for (let i = 0; i < count; i++) seg.push(chunk(amp), o); };
  return { seg, clips, feed };
}

// --- the radio's own run markers, which are the boundary to trust -----------

test('a run marked by the radio becomes exactly one clip', () => {
  const { seg, clips, feed } = make();
  seg.begin();
  feed(20, 0.3, { rx: true });
  seg.end();
  assert.equal(clips.length, 1);
  assert.ok(clips[0].durationMs >= 2000);
});

test('end() closes at once instead of waiting out holdMs', () => {
  const { seg, clips, feed } = make({ holdMs: 5000 });
  seg.begin();
  feed(10, 0.3, { rx: true });
  seg.end();
  assert.equal(clips.length, 1, 'the clip is not still open waiting for silence');
});

test('two runs back to back stay two clips even with no gap', () => {
  const { seg, clips, feed } = make();
  seg.begin();
  feed(10, 0.3, { rx: true });
  seg.end();
  seg.begin();
  feed(10, 0.3, { rx: true });
  seg.end();
  assert.equal(clips.length, 2, 'this is the case squelch alone cannot separate');
});

test('a repeated begin() mid-run does not chop the transmission', () => {
  const { seg, clips, feed } = make();
  seg.begin();
  feed(10, 0.3, { rx: true });
  seg.begin();
  feed(10, 0.3, { rx: true });
  seg.end();
  assert.equal(clips.length, 1);
});

test('a pause inside one marked run does not split it', () => {
  const { seg, clips, feed } = make();
  seg.begin();
  feed(10, 0.3, { rx: true });
  feed(3, 0, {}); // 300 ms < 500 ms hold
  feed(10, 0.3, { rx: true });
  seg.end();
  assert.equal(clips.length, 1);
});

test('end() with no run open is harmless', () => {
  const { seg, clips } = make();
  seg.end();
  seg.end();
  assert.equal(clips.length, 0);
});

// --- direction ------------------------------------------------------------

test('clips carry their direction', () => {
  const { seg, clips, feed } = make();
  seg.begin({ transmit: true });
  feed(10, 0.3, { transmit: true });
  seg.end();
  assert.equal(clips[0].transmit, true);
});

test('a turnaround with no end marker still splits receive from transmit', () => {
  const { clips, feed } = make();
  feed(10, 0.3, { rx: true });
  feed(10, 0.3, { transmit: true });
  feed(10, 0, {});
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map((c) => c.transmit), [false, true]);
});

// --- fallbacks, for when the markers are absent ----------------------------

test('audio with no begin() still opens a clip', () => {
  const { clips, feed } = make();
  feed(10, 0.3, { rx: true });
  feed(10, 0, {});
  assert.equal(clips.length, 1, 'a run already in progress when we connected');
});

test('a run that never ends is still closed after holdMs of quiet', () => {
  const { seg, clips, feed } = make();
  seg.begin();
  feed(10, 0.3, { rx: true });
  feed(8, 0, {}); // a continuous broadcast that sends no end marker
  assert.equal(clips.length, 1);
});

test('energy alone opens a clip when the squelch flag is unreliable', () => {
  const { clips, feed } = make();
  feed(10, 0.3, {});
  feed(10, 0, {});
  assert.equal(clips.length, 1);
});

test('a blip shorter than minMs is dropped', () => {
  const { clips, feed } = make();
  feed(1, 0.3, { rx: true });
  feed(10, 0, {});
  assert.equal(clips.length, 0);
});

test('pre-roll audio is included at the head of the clip', () => {
  const { seg, clips, feed } = make({ preRollMs: 200 });
  feed(10, 0, {});
  seg.begin();
  feed(10, 0.3, { rx: true });
  seg.end();
  assert.ok(clips[0].durationMs >= 1000 + 200);
});

test('flush closes a clip in progress, e.g. on disconnect', () => {
  const { seg, clips, feed } = make();
  seg.begin();
  feed(10, 0.3, { rx: true });
  assert.equal(clips.length, 0);
  seg.flush();
  assert.equal(clips.length, 1);
});

// --- long transmissions ---------------------------------------------------

test('a clip past maxMs is split rather than lost', () => {
  const { seg, clips, feed } = make({ maxMs: 1000 });
  seg.begin();
  feed(35, 0.3, { rx: true });
  assert.ok(clips.length >= 3);
});

test('a split carries an overlap tail into the next clip', () => {
  const { seg, clips, feed } = make({ maxMs: 1000, overlapMs: 200 });
  seg.begin();
  feed(30, 0.3, { rx: true });
  seg.end();
  const [first, second] = clips;
  assert.ok(first.durationMs >= 1000);
  // The second clip starts before the first one ended: that is the overlap.
  assert.ok(
    second.startMs < first.startMs + first.durationMs,
    `expected overlap, got first ${first.startMs}+${first.durationMs}, second ${second.startMs}`,
  );
});

test('the overlap is the requested length and keeps sample alignment', () => {
  const { seg, clips, feed } = make({ maxMs: 1000, overlapMs: 200 });
  seg.begin();
  feed(30, 0.3, { rx: true });
  seg.end();
  for (const c of clips) assert.equal(c.pcm.length % 2, 0, 'whole 16-bit samples');
  const [first, second] = clips;
  const overlap = first.startMs + first.durationMs - second.startMs;
  assert.ok(Math.abs(overlap - 200) < CHUNK_MS, `overlap ${overlap}ms should be about 200ms`);
});

test('overlapMs 0 splits with no carried audio', () => {
  const { seg, clips, feed } = make({ maxMs: 1000, overlapMs: 0 });
  seg.begin();
  feed(30, 0.3, { rx: true });
  seg.end();
  const [first, second] = clips;
  assert.equal(second.startMs, first.startMs + first.durationMs);
});

test('an overlap longer than the clip carries what there is, not more', () => {
  const { seg, clips, feed } = make({ maxMs: 500, overlapMs: 10000, minMs: 0 });
  seg.begin();
  feed(12, 0.3, { rx: true });
  seg.end();
  assert.ok(clips.length >= 2);
  for (const c of clips) assert.ok(c.durationMs <= 1000, `clip ${c.durationMs}ms stayed bounded`);
});
