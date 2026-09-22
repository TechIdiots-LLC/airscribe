import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/api.js';
import { encodeWav } from '../src/wav.js';

const dataDir = mkdtempSync(join(tmpdir(), 'airscribe-audio-'));
mkdirSync(join(dataDir, 'clips', 'AABBCCDDEEFF'), { recursive: true });
const wav = encodeWav(Buffer.alloc(32000 * 2), 32000);   // 1 second
writeFileSync(join(dataDir, 'clips', 'AABBCCDDEEFF', 'c.wav'), wav);

const row = { id: 1, mac: 'AA:BB:CC:DD:EE:FF', started_at: 123,
              duration_ms: 1000, audio_file: join('AABBCCDDEEFF', 'c.wav'),
              status: 'done', text: 'hello' };
const store = { transmission: (id) => (id === 1 ? row : undefined), radios: () => [] };
const manager = Object.assign(new EventEmitter(), { radios: () => [] });
const app = createApp({ manager, store, sidecar: {}, auth: { tokens: [] }, dataDir });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

test('inline audio is playable: length known, ranges allowed, not an attachment', async () => {
  const res = await fetch(`${base}/transmissions/1/audio`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /audio\/wav/);
  assert.equal(res.headers.get('content-length'), String(wav.length),
    'without Content-Length a player cannot show a duration');
  assert.equal(res.headers.get('accept-ranges'), 'bytes', 'needed for seeking');
  assert.equal(res.headers.get('content-disposition'), null,
    'inline playback must not be forced to download');
});

test('the download link does say attachment', async () => {
  const res = await fetch(`${base}/transmissions/1/audio?download`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename=/);
});

test('a range request returns just that range', async () => {
  const res = await fetch(`${base}/transmissions/1/audio`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(res.status, 206, 'a player seeking expects partial content');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, 44);
  assert.equal(body.toString('ascii', 0, 4), 'RIFF');
});

test('a missing or unknown clip is 404, not a hang', async () => {
  assert.equal((await fetch(`${base}/transmissions/999/audio`)).status, 404);
});

test('escaping the clips directory is refused', async () => {
  row.audio_file = join('..', '..', 'escape.wav');
  assert.equal((await fetch(`${base}/transmissions/1/audio`)).status, 404);
  row.audio_file = join('AABBCCDDEEFF', 'c.wav');
});

test.after(() => server.close());
