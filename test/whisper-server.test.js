import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WhisperServerEngine, cleanWhisperText } from '../src/stt/whisper-server.js';
import { createEngine, createEngines } from '../src/stt/index.js';

const dir = mkdtempSync(join(tmpdir(), 'whisper-server-'));
const wav = join(dir, 'clip.wav');
writeFileSync(wav, Buffer.alloc(1234, 1));

/**
 * A stand-in for whisper-server: the same arguments, /health and /inference,
 * and the same JSON. The transcript it returns describes the request, so the
 * tests see what the engine sent. `--fake MODE` picks a misbehaviour.
 */
const fake = join(dir, 'fake-whisper-server.mjs');
writeFileSync(fake, `
  import { createServer } from 'node:http';
  import { existsSync, writeFileSync } from 'node:fs';
  const argv = process.argv.slice(2);
  const arg = (k) => argv[argv.indexOf(k) + 1];
  const mode = argv.includes('--fake') ? arg('--fake') : 'ok';
  if (mode === 'bad-model') {
    console.error('whisper_init_from_file_with_params_no_state: failed to open ' + arg('-m'));
    console.error('error: failed to initialize whisper context');
    process.exit(3);
  }
  console.error('ggml_vulkan: Found 1 Vulkan devices:');
  console.error('ggml_vulkan: 0 = Intel(R) Arc(tm) A750 Graphics (DG2) (Intel open-source Mesa driver) | uma: 0');
  console.error('whisper_init_with_params_no_state: devices    = 2');
  console.error('whisper_backend_init_gpu: device 0: Vulkan0 (type: 1)');
  console.error('some other chatter');
  createServer(async (req, res) => {
    if (req.url === '/health') return res.end('{"status":"ok"}');
    if (req.url !== '/inference') { res.statusCode = 404; return res.end(); }
    if (mode === 'die-once' && !existsSync(arg('--marker'))) {
      writeFileSync(arg('--marker'), '');
      process.exit(1);
    }
    if (mode === 'fail') { res.statusCode = 500; return res.end('{"error":"failed to process audio"}'); }
    if (mode === 'blank') return res.end(JSON.stringify({ text: ' [BLANK_AUDIO]\\n' }));
    const form = await new Response(req, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const fields = {};
    for (const [k, v] of form) fields[k] = typeof v === 'string' ? v : 'file:' + v.name + ':' + v.size;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: ' ' + JSON.stringify({ argv, fields, pid: process.pid }) + '\\n  \\n' }));
  }).listen(Number(arg('--port')), arg('--host'));
`);

/**
 * @param {object} c - Engine config, on top of the fake server.
 * @returns {WhisperServerEngine} An engine that starts the fake.
 */
const engineWith = (c = {}) =>
  new WhisperServerEngine({ binary: process.execPath, binaryArgs: [fake], model: wav, ...c });

/**
 * @param {WhisperServerEngine} e - The engine.
 * @returns {Promise<object>} What the fake saw.
 */
const sent = async (e) => JSON.parse((await e.transcribe(wav)).text);

/**
 * @param {() => Promise<void>} fn - Run with console.log captured.
 * @returns {Promise<string[]>} What was logged.
 */
async function logged(fn) {
  const lines = [];
  const real = console.log;
  console.log = (m) => lines.push(String(m));
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return lines;
}

test('a model or a url is required', () => {
  assert.throws(() => new WhisperServerEngine({}), /needs model .* or url/);
});

test('it starts the server on loopback with the model, and keeps it for the next clip', async () => {
  const e = engineWith({ language: 'en', args: ['-t', '2'] });
  try {
    let first;
    const log = await logged(async () => (first = await sent(e)));
    const { argv, fields } = first;
    assert.equal(argv[argv.indexOf('-m') + 1], wav);
    assert.equal(argv[argv.indexOf('--host') + 1], '127.0.0.1');
    assert.match(argv[argv.indexOf('--port') + 1], /^\d+$/);
    assert.deepEqual(argv.slice(-2), ['-t', '2'], 'args come last');
    assert.equal(fields.file, 'file:clip.wav:1234');
    assert.equal(fields.response_format, 'json');
    assert.equal(fields.no_timestamps, 'true');
    assert.equal(fields.language, 'en');
    assert.ok(log.some((l) => /whisper-server: ggml_vulkan: 0 = Intel\(R\) Arc/.test(l)),
      'the log says which device it found');
    assert.ok(log.some((l) => /whisper-server: whisper_backend_init_gpu: device 0: Vulkan0/.test(l)));
    assert.ok(!log.some((l) => /chatter|devices +=/.test(l)), 'and nothing else of its output');
    assert.equal((await sent(e)).pid, first.pid, 'the same server reads the second clip');
  } finally {
    e.stop();
  }
});

test('a prompt is sent when one is given, and not otherwise', async () => {
  const e = engineWith();
  try {
    assert.ok(!('prompt' in (await sent(e)).fields));
    const { fields } = JSON.parse((await e.transcribe(wav, { prompt: 'Copy. Plate Alpha Bravo.' })).text);
    assert.equal(fields.prompt, 'Copy. Plate Alpha Bravo.');
    assert.equal(e.prompts, true);
  } finally {
    e.stop();
  }
});

test('no language is sent unless one is set, leaving the server its own', async () => {
  const e = engineWith();
  try {
    assert.ok(!('language' in (await sent(e)).fields));
  } finally {
    e.stop();
  }
});

test('a server that will not start fails the clip with what it printed', async () => {
  const e = engineWith({ args: ['--fake', 'bad-model'] });
  await assert.rejects(e.transcribe(wav), (err) => {
    assert.match(err.message, /whisper-server exited \(code 3\)/);
    assert.match(err.message, /failed to initialize whisper context/);
    return true;
  });
  assert.equal(e.ready, null, 'the next clip tries again');
});

test('a binary that does not exist says so', async () => {
  const e = new WhisperServerEngine({ binary: join(dir, 'no-such-server'), model: wav });
  await assert.rejects(e.transcribe(wav), /could not start/);
});

test('a server that dies mid-clip fails that clip, and the next starts a new one', async () => {
  const e = engineWith({ args: ['--fake', 'die-once', '--marker', join(dir, 'died')] });
  try {
    await assert.rejects(e.transcribe(wav), /whisper-server at http:\/\/127\.0\.0\.1:\d+/);
    assert.ok(existsSync(join(dir, 'died')));
    for (let i = 0; i < 50 && e.child; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok((await sent(e)).argv.includes('die-once'), 'a fresh server read the next clip');
  } finally {
    e.stop();
  }
});

test("the server's error becomes the clip's error", async () => {
  const e = engineWith({ args: ['--fake', 'fail'] });
  try {
    await assert.rejects(e.transcribe(wav), /answered 500: failed to process audio/);
  } finally {
    e.stop();
  }
});

test("whisper.cpp's [BLANK_AUDIO] is no speech, not a transcript", async () => {
  const e = engineWith({ args: ['--fake', 'blank'] });
  try {
    assert.deepEqual(await e.transcribe(wav), { text: '' });
  } finally {
    e.stop();
  }
  assert.equal(cleanWhisperText(' [BLANK_AUDIO]\n'), '');
  assert.equal(cleanWhisperText('[BLANK_AUDIO] Copy that.\n [blank_audio]'), 'Copy that.', 'around real words too');
  assert.equal(cleanWhisperText(' (static) '), '(static)', "an annotation of its own is kept: it's honest");
});

test('with a url it uses that server and starts nothing', async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(req.url);
    res.end('{"text":" over and out \\n"}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const e = new WhisperServerEngine({ url: `http://127.0.0.1:${srv.address().port}/`, binary: '/nonexistent' });
    assert.deepEqual(await e.transcribe(wav), { text: 'over and out' });
    assert.deepEqual(seen, ['/inference']);
    assert.equal(e.child, null);
  } finally {
    srv.close();
  }
});

test('it is selectable in both config shapes', () => {
  const model = wav;
  assert.equal(createEngine({ engine: 'whisper-server', 'whisper-server': { model } }).name, 'whisper-server');
  const { engines } = createEngines({ engines: { arc: { type: 'whisper-server', model } } });
  assert.equal(engines.get('arc').name, 'arc');
});
