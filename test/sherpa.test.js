import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SherpaEngine, SHERPA_MODELS } from '../src/stt/sherpa.js';
import { createEngine } from '../src/stt/index.js';

/**
 * A stand-in for sherpa_transcribe.py speaking the same JSON-line protocol, so
 * the Node side is tested without sherpa-onnx or a 200 MB model.
 * @param {'ready'|'loadfail'|'crash'} mode - Which behaviour to exercise.
 * @returns {SherpaEngine} An engine wired to that fake worker.
 */
function engineWith(mode) {
  const script = join(mkdtempSync(join(tmpdir(), 'sherpa-')), 'fake.js');
  writeFileSync(script, `
    const rl = require('readline').createInterface({ input: process.stdin });
    const say = (o) => console.log(JSON.stringify(o));
    const mode = process.argv[process.argv.length - 1];
    if (mode === 'loadfail') { say({ event: 'error', error: 'model not found' }); process.exit(1); }
    say({ event: 'ready' });
    rl.on('line', (l) => {
      const r = JSON.parse(l);
      if (mode === 'crash') process.exit(7);
      if (r.wav.includes('bad')) say({ id: r.id, ok: false, error: 'not a wav' });
      else say({ id: r.id, ok: true, text: 'heard ' + r.wav });
    });
  `);
  // The fake reads its mode from the last argv entry, which is --threads' value.
  return new SherpaEngine({ modelDir: '/models/x', python: process.execPath, script, threads: mode });
}

test('model ids map to the right family and are unique', () => {
  assert.equal(new Set(SHERPA_MODELS.map((m) => m.id)).size, SHERPA_MODELS.length);
  assert.equal(new SherpaEngine({ modelDir: '/x', model: 'whisper-base.en' }).family, 'whisper');
  assert.equal(new SherpaEngine({ modelDir: '/x', model: 'sense-voice' }).family, 'sense-voice');
  assert.equal(new SherpaEngine({ modelDir: '/x' }).family, 'sense-voice', 'defaults to sense-voice');
});

test('config errors are caught before anything is spawned', () => {
  assert.throws(() => new SherpaEngine({}), /modelDir is required/);
  assert.throws(() => new SherpaEngine({ modelDir: '/x', model: 'nope' }), /have: sense-voice/);
  assert.equal(new SherpaEngine({ modelDir: '/x', model: 'nope', family: 'whisper' }).family, 'whisper');
});

test('createEngine builds it from the sherpa-onnx config key', () => {
  assert.equal(createEngine({ engine: 'sherpa-onnx', 'sherpa-onnx': { modelDir: '/x' } }).name, 'sherpa-onnx');
});

test('the worker is loaded once and reused across clips', async () => {
  const e = engineWith('ready');
  try {
    assert.deepEqual(await e.transcribe('/clips/a.wav'), { text: 'heard /clips/a.wav' });
    const pid = e.child.pid;
    assert.deepEqual(await e.transcribe('/clips/b.wav'), { text: 'heard /clips/b.wav' });
    assert.equal(e.child.pid, pid, 'same worker, not a fresh model load');
  } finally { e.stop(); }
});

test('concurrent clips are matched to their own replies', async () => {
  const e = engineWith('ready');
  try {
    const out = await Promise.all(['/1.wav', '/2.wav', '/3.wav'].map((w) => e.transcribe(w)));
    assert.deepEqual(out.map((o) => o.text), ['heard /1.wav', 'heard /2.wav', 'heard /3.wav']);
  } finally { e.stop(); }
});

test('a per-clip failure rejects that clip only', async () => {
  const e = engineWith('ready');
  try {
    await assert.rejects(e.transcribe('/clips/bad.wav'), /not a wav/);
    assert.deepEqual(await e.transcribe('/clips/ok.wav'), { text: 'heard /clips/ok.wav' });
  } finally { e.stop(); }
});

test('a model that will not load surfaces the reason', async () => {
  const e = engineWith('loadfail');
  await assert.rejects(e.transcribe('/clips/a.wav'), /model not found/);
});

test('a crashed worker fails the clip, then a later clip starts a new worker', async () => {
  const e = engineWith('crash');
  try {
    await assert.rejects(e.transcribe('/clips/a.wav'), /sherpa worker exited/);
    assert.equal(e.ready, null, 'the dead worker is not left cached');
    await assert.rejects(e.transcribe('/clips/b.wav'), /sherpa worker exited/);
  } finally { e.stop(); }
});

test('a missing model directory is reported at startup, not at the first clip', () => {
  const warned = [];
  const real = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    new SherpaEngine({ modelDir: '/EDIT-ME/models/sherpa-onnx-whisper-base.en' });
  } finally {
    console.warn = real;
  }
  assert.equal(warned.length, 1, 'the operator should hear about this at boot');
  assert.match(warned[0], /EDIT-ME/, 'and be told which path is wrong');
});

test('an existing model directory warns about nothing', () => {
  const warned = [];
  const real = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    new SherpaEngine({ modelDir: process.cwd() });
  } finally {
    console.warn = real;
  }
  assert.deepEqual(warned, []);
});
