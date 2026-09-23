import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/api.js';
import { encodeWav } from '../src/wav.js';

const NOW = Date.now();
const ago = (min) => NOW - min * 60_000;
const dataDir = mkdtempSync(join(tmpdir(), 'airscribe-pub-'));
mkdirSync(join(dataDir, 'clips', 'AABBCCDDEEFF'), { recursive: true });
writeFileSync(join(dataDir, 'clips', 'AABBCCDDEEFF', 'c.wav'), encodeWav(Buffer.alloc(3200), 32000));

const RADIOS = [
  { mac: 'AA:BB:CC:DD:EE:FF', name: 'Scanner', public: 1, group: 'emergency' },
  { mac: '11:22:33:44:55:66', name: 'Ham', public: 0, group: 'amateur' },
];
const ROW = (id, mac, min) => ({
  id, mac, started_at: ago(min), duration_ms: 3000, audio_file: join('AABBCCDDEEFF', 'c.wav'),
  status: 'done', transmit: 0, channel: 3, channel_name: 'Holden PD', channel_hz: 460387500,
  radio_name: 'Scanner', radio_group: 'emergency',
  transcripts: [{ engine: 'base', status: 'done', text: 'engine two on arrival' }],
});
const ALL = [ROW(1, 'AA:BB:CC:DD:EE:FF', 90), ROW(2, 'AA:BB:CC:DD:EE:FF', 5),
              ROW(3, '11:22:33:44:55:66', 90)];

const store = {
  radios: () => RADIOS,
  radio: (mac) => RADIOS.find((r) => r.mac === mac),
  transmission: (id) => ALL.find((r) => r.id === id),
  // The real store filters in SQL; this mirrors it so the route is what is
  // under test rather than the query.
  transmissions: ({ publicOnly, notAfter, group, q } = {}) => ALL.filter((r) => {
    const radio = RADIOS.find((x) => x.mac === r.mac);
    if (publicOnly && !radio?.public) return false;
    if (notAfter !== undefined && r.started_at > notAfter) return false;
    if (group && radio?.group !== group) return false;
    if (q && !r.transcripts.some((t) => (t.text ?? '').includes(q))) return false;
    return true;
  }),
  groups: () => ['amateur', 'emergency'],
};
const manager = Object.assign(new EventEmitter(), {
  radios: () => RADIOS, engines: new Map(), primary: 'base', extra: [],
});

/** @param {object} publish - Publishing config. @returns {Promise<object>} A running app. */
async function serve(publish) {
  const config = { host: '127.0.0.1', auth: { tokens: ['secret'] }, publish };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}/api`, close: () => server.close() };
}

const OPEN = { enabled: true, transcripts: true, audio: true, delayMinutes: 30 };

test('with publishing off, the public surface shows nothing', async () => {
  const s = await serve({ enabled: false });
  try {
    assert.deepEqual(await (await fetch(`${s.base}/public/transmissions`)).json(), []);
    const f = await (await fetch(`${s.base}/public/filters`)).json();
    assert.equal(f.enabled, false);
    assert.equal((await fetch(`${s.base}/public/transmissions/1/text`)).status, 404);
    assert.equal((await fetch(`${s.base}/public/transmissions/1/audio`)).status, 404);
  } finally { s.close(); }
});

test('the public surface needs no credential', async () => {
  const s = await serve(OPEN);
  try {
    // No Authorization header at all: this is the point of a public page.
    assert.equal((await fetch(`${s.base}/public/transmissions`)).status, 200);
    assert.equal((await fetch(`${s.base}/public/filters`)).status, 200);
  } finally { s.close(); }
});

test('a private radio never appears publicly', async () => {
  const s = await serve(OPEN);
  try {
    const rows = await (await fetch(`${s.base}/public/transmissions`)).json();
    assert.deepEqual(rows.map((r) => r.id), [1], 'only the public radio, and only past the delay');
    assert.equal((await fetch(`${s.base}/public/transmissions/3/text`)).status, 404,
      'and its clips are not fetchable by id either');
  } finally { s.close(); }
});

test('the delay applies to the list AND to each download', async () => {
  const s = await serve(OPEN);
  try {
    const rows = await (await fetch(`${s.base}/public/transmissions`)).json();
    assert.ok(!rows.some((r) => r.id === 2), 'id 2 is 5 minutes old, inside a 30 minute delay');
    // The part that matters: counting upwards must not beat the delay.
    assert.equal((await fetch(`${s.base}/public/transmissions/2/text`)).status, 404);
    assert.equal((await fetch(`${s.base}/public/transmissions/2/audio`)).status, 404);
    // While the older one is served.
    assert.equal((await fetch(`${s.base}/public/transmissions/1/text`)).status, 200);
    assert.equal((await fetch(`${s.base}/public/transmissions/1/audio`)).status, 200);
  } finally { s.close(); }
});

test('clips can be withheld while transcripts are published', async () => {
  const s = await serve({ ...OPEN, audio: false });
  try {
    const rows = await (await fetch(`${s.base}/public/transmissions`)).json();
    assert.equal(rows[0].has_audio, false);
    assert.equal((await fetch(`${s.base}/public/transmissions/1/text`)).status, 200);
    assert.equal((await fetch(`${s.base}/public/transmissions/1/audio`)).status, 404,
      'a clip is somebody voice, and stays off even when the words are out');
  } finally { s.close(); }
});

test('a public row carries context but no internals', async () => {
  const s = await serve(OPEN);
  try {
    const [row] = await (await fetch(`${s.base}/public/transmissions`)).json();
    assert.equal(row.channel_name, 'Holden PD');
    assert.equal(row.radio, 'Scanner');
    assert.equal(row.text, 'engine two on arrival');
    const body = JSON.stringify(row);
    assert.ok(!body.includes('AA:BB:CC'), 'no MAC');
    assert.ok(!body.includes('.wav'), 'no path on disk');
    assert.ok(!body.includes('transcripts'), 'not every engine');
  } finally { s.close(); }
});

test('filters list only public radios and their groups', async () => {
  const s = await serve(OPEN);
  try {
    const f = await (await fetch(`${s.base}/public/filters`)).json();
    assert.deepEqual(f.groups, ['emergency'], 'the amateur radio is private, so its group is not offered');
    assert.deepEqual(f.radios.map((r) => r.name), ['Scanner']);
    assert.equal(f.delayMinutes, 30);
  } finally { s.close(); }
});

test('a group filter cannot reach a private radio', async () => {
  const s = await serve(OPEN);
  try {
    const rows = await (await fetch(`${s.base}/public/transmissions?group=amateur`)).json();
    assert.deepEqual(rows, [], 'asking for a private group returns nothing, not its traffic');
  } finally { s.close(); }
});
