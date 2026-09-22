import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, halveRate } from '../src/wav.js';
import { createEngine } from '../src/stt/index.js';
import { assertSafeToListen } from '../src/auth.js';

test('WAV header describes the payload', () => {
  const w = encodeWav(Buffer.alloc(100), 16000);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(40), 100);
  assert.equal(w.length, 144);
});

test('halveRate averages pairs', () => {
  const b = Buffer.alloc(8);
  [100, 300, -50, -150].forEach((v, i) => b.writeInt16LE(v, i * 2));
  const h = halveRate(b);
  assert.deepEqual([h.readInt16LE(0), h.readInt16LE(2)], [200, -100]);
});

test('command engine substitutes {wav} and returns stdout without a shell', async () => {
  const e = createEngine({
    engine: 'command',
    command: { template: [process.execPath, '-e', 'console.log("heard " + process.argv[1])', '{wav}'] },
  });
  assert.deepEqual(await e.transcribe('a b;c.wav'), { text: 'heard a b;c.wav' });
});

test('command engine surfaces a failing command', async () => {
  const e = createEngine({ engine: 'command', command: { template: [process.execPath, '-e', 'process.exit(3)'] } });
  await assert.rejects(e.transcribe('x.wav'), /exited 3/);
});

test('unknown engine is rejected with the choices', () => {
  assert.throws(() => createEngine({ engine: 'nope' }), /have: mock, sherpa-onnx, whisper-cpp, command/);
});

test('refuses a reachable bind with no tokens, allows loopback or tokens', () => {
  assert.throws(() => assertSafeToListen('0.0.0.0', { tokens: [] }), /refusing/);
  assertSafeToListen('127.0.0.1', { tokens: [] });
  assertSafeToListen('0.0.0.0', { tokens: ['t'] });
});
