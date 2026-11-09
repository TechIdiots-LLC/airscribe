import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVinoEngine } from '../src/stt/openvino.js';
import { createEngine, createEngines } from '../src/stt/index.js';

/**
 * A stand-in for openvino_transcribe.py that echoes the arguments it was given
 * as the transcript, so the tests see exactly what the worker would receive.
 * @param {object} c - Engine config.
 * @returns {OpenVinoEngine} An engine wired to the fake worker.
 */
function engineWith(c) {
  const script = join(mkdtempSync(join(tmpdir(), 'openvino-')), 'fake.js');
  writeFileSync(script, `
    const rl = require('readline').createInterface({ input: process.stdin });
    const say = (o) => console.log(JSON.stringify(o));
    say({ event: 'ready', device: 'CPU' });
    rl.on('line', (l) => say({ id: JSON.parse(l).id, ok: true, text: process.argv.slice(2).join(' ') }));
  `);
  return new OpenVinoEngine({ modelDir: process.cwd(), python: process.execPath, script, ...c });
}

test('the GPU is the default, with the CPU behind it', () => {
  const args = new OpenVinoEngine({ modelDir: process.cwd() }).workerArgs();
  assert.equal(args[args.indexOf('--device') + 1], 'GPU');
  assert.equal(args[args.indexOf('--fallback-device') + 1], 'CPU');
  assert.ok(!args.includes('--cache-dir'), 'no cache unless asked for');
});

test('a null fallback is left out, so a missing GPU is an error', () => {
  const args = new OpenVinoEngine({ modelDir: process.cwd(), fallbackDevice: null }).workerArgs();
  assert.ok(!args.includes('--fallback-device'));
});

test('a model directory is required before anything is spawned', () => {
  assert.throws(() => new OpenVinoEngine({}), /stt\.openvino\.modelDir is required/);
});

test('config reaches the worker, and a clip comes back through it', async () => {
  const e = engineWith({ device: 'GPU.1', cacheDir: '/var/cache/ov', language: 'en' });
  const logged = [];
  const real = console.log;
  console.log = (m) => logged.push(m);
  try {
    const { text } = await e.transcribe('/clips/a.wav');
    assert.match(text, /--device GPU\.1/);
    assert.match(text, /--cache-dir \/var\/cache\/ov/);
    assert.match(text, /--language en/);
    assert.ok(logged.some((m) => /openvino worker running on CPU/.test(m)),
      'the log says where the model really landed');
  } finally {
    console.log = real;
    e.stop();
  }
});

test('it is selectable in both config shapes', () => {
  const modelDir = process.cwd();
  assert.equal(createEngine({ engine: 'openvino', openvino: { modelDir } }).name, 'openvino');
  const { engines } = createEngines({ engines: { arc: { type: 'openvino', modelDir } } });
  assert.equal(engines.get('arc').name, 'arc');
});
