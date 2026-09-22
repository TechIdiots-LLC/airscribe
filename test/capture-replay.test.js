import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Segmenter } from '../src/segmenter.js';

// Replays the run structure of a real UV-Pro capture (see the fixture's
// _comment) through the segmenter. Three stations transmitted; the radio
// bracketed each with its own end-of-audio frame. Anything other than three
// clips means the marker handling has regressed.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/uv-pro-chatter.json', import.meta.url)));

/** @param {object} over - Segmenter option overrides. @returns {object[]} Clips produced. */
function replay(over = {}) {
  const clips = [];
  const seg = new Segmenter({
    sampleRate: fixture.sampleRate, preRollMs: 300, holdMs: 1200, minMs: 400,
    maxMs: 120000, overlapMs: 300, energyThreshold: 0.02,
    onClip: (c) => clips.push(c), ...over,
  });
  for (const run of fixture.runs) {
    seg.begin({ transmit: false });
    for (const bytes of run) seg.push(Buffer.alloc(bytes), { rx: true });
    seg.end();
  }
  return clips;
}

test('a real three-transmission capture yields exactly three clips', () => {
  const clips = replay();
  assert.equal(clips.length, fixture.runs.length);
  assert.equal(clips.length, 3);
});

test('clip durations match the audio the radio actually sent', () => {
  const secs = replay().map((c) => +(c.durationMs / 1000).toFixed(1));
  assert.deepEqual(secs, [2.0, 5.7, 14.5]);
});

test('clips run back to back with no overlap or lost audio', () => {
  const clips = replay();
  for (let i = 1; i < clips.length; i++) {
    const gap = clips[i].startMs - (clips[i - 1].startMs + clips[i - 1].durationMs);
    assert.equal(Math.round(gap), 0, `clip ${i + 1} should start where clip ${i} ended`);
  }
});

test('a long transmission is split, and the pieces still cover it', () => {
  // The third run is 14.5 s; with a 5 s cap it must split rather than vanish.
  const clips = replay({ maxMs: 5000, overlapMs: 300 });
  assert.ok(clips.length > 3, 'the long run should have been split');
  // maxMs is tested after each chunk is appended, so a clip may overrun it by
  // up to one chunk. The capture's chunks are ~28 ms.
  const longest = Math.max(...clips.map((c) => c.durationMs));
  assert.ok(longest <= 5000 + 50, `clip overran maxMs by more than a chunk: ${longest}`);

  // Every second of audio must survive: the pieces, less the overlap added at
  // each split, add up to what the radio sent.
  const sent = fixture.runs.flat().reduce((a, b) => a + b, 0) / (fixture.sampleRate * 2) * 1000;
  const got = clips.reduce((a, c) => a + c.durationMs, 0);
  const splits = clips.length - fixture.runs.length;
  assert.ok(Math.abs(got - splits * 300 - sent) < 50,
    `audio should be conserved: sent ${sent|0}ms, got ${got|0}ms over ${splits} splits`);
});

test('without the radio markers, silence-based splitting merges transmissions', () => {
  // The same audio with no begin()/end() and no gaps between runs: this is
  // what the old squelch-only approach had to work with, and why the markers
  // were adopted.
  const clips = [];
  const seg = new Segmenter({
    sampleRate: fixture.sampleRate, preRollMs: 300, holdMs: 1200, minMs: 400,
    maxMs: 120000, overlapMs: 300, energyThreshold: 0.02, onClip: (c) => clips.push(c),
  });
  for (const run of fixture.runs) for (const b of run) seg.push(Buffer.alloc(b), { rx: true });
  seg.flush();
  assert.equal(clips.length, 1, 'three transmissions collapse into one clip');
});
