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

test('refuses a reachable bind with no credential, allows loopback or a token', () => {
  assert.throws(() => assertSafeToListen({ host: '0.0.0.0', auth: { tokens: [] } }), /refusing/);
  assertSafeToListen({ host: '127.0.0.1', auth: { tokens: [] } });
  assertSafeToListen({ host: '0.0.0.0', auth: { tokens: ['t'] } });
});

test('a flag with no value does not swallow the next argument', async () => {
  const { flagValue } = await import('../src/config.js');
  // The bug this replaces: indexOf returns -1 when absent, and argv[-1 + 1]
  // is argv[0] — so `--simulate` was passed to loadConfig as a file path.
  assert.equal(flagValue(['--simulate'], '--config'), undefined);
  assert.equal(flagValue([], '--config'), undefined);
  assert.equal(flagValue(['--simulate', '--config', 'a.json'], '--config'), 'a.json');
  assert.equal(flagValue(['--config', 'a.json', '--simulate'], '--config'), 'a.json');
  assert.equal(flagValue(['--config'], '--config'), undefined, 'trailing flag has no value');
});

test('loadConfig with no path returns usable defaults', async () => {
  const { loadConfig } = await import('../src/config.js');
  const c = loadConfig(undefined);
  assert.equal(c.port, 8100);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.audio.sampleRate, 32000);
  assert.equal(c.sidecar.backend, 'bluez');
});

test('a public bind is refused without a credential however it was asked for', async () => {
  const { assertSafeToListen } = await import('../src/auth.js');
  // --host is a convenience for headless testing, not a way around the guard.
  for (const host of ['0.0.0.0', '192.168.1.10', '::']) {
    assert.throws(() => assertSafeToListen({ host, auth: { tokens: [] } }), /refusing/);
    assertSafeToListen({ host, auth: { tokens: ['a-long-token'] } });
  }
});

test('the sample config describes a usable engine set', async () => {
  const { createEngines } = await import('../src/stt/index.js');
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('../airscribe.config.json.sample', import.meta.url)));
  const { engines, primary, extra } = createEngines(cfg.stt);
  assert.ok(engines.has(primary), 'the default engine must be one of the configured ones');
  assert.deepEqual(extra, [], 'comparison engines are opt-in, not on by default');
  assert.deepEqual([...engines.keys()].sort(), ['base', 'tiny']);
});

test('the mock default does not survive alongside a configured engine set', async () => {
  const { loadConfig } = await import('../src/config.js');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'airscribe-cfg-')), 'c.json');

  writeFileSync(file, JSON.stringify({
    stt: { engines: { base: { type: 'mock' } }, default: 'base' },
  }));
  const c = loadConfig(file);
  // Left in place, deleting `engines` later would quietly mean mock again.
  assert.equal(c.stt.engine, undefined, 'the default single engine must not linger');
  assert.deepEqual(Object.keys(c.stt).sort(), ['default', 'engines']);

  // The single-engine form still works, and its own `engine` is respected.
  writeFileSync(file, JSON.stringify({ stt: { engine: 'whisper-cpp', 'whisper-cpp': {} } }));
  assert.equal(loadConfig(file).stt.engine, 'whisper-cpp');

  // And a config that says nothing about stt still gets the mock default.
  writeFileSync(file, JSON.stringify({ port: 9000 }));
  assert.equal(loadConfig(file).stt.engine, 'mock');
});
