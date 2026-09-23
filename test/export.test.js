import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/api.js';

const ROWS = [
  {
    id: 7, mac: 'AA:BB:CC:DD:EE:FF', started_at: 1758576694000, duration_ms: 6300,
    transmit: 0, channel: 3, channel_name: 'Holden PD', channel_hz: 460387500,
    status: 'done', text: 'The', engine: 'base',
    transcripts: [
      { engine: 'base', status: 'done', text: 'The' },
      { engine: 'tiny', status: 'done', text: 'over Montregg, he low-lity' },
      { engine: 'small', status: 'error', text: null, error: 'model missing' },
    ],
  },
  {
    id: 8, mac: 'AA:BB:CC:DD:EE:FF', started_at: 1758576700000, duration_ms: 1300,
    transmit: 1, channel: null, channel_name: null, channel_hz: null,
    status: 'done', text: 'copy, "10-4"', engine: 'base',
    transcripts: [{ engine: 'base', status: 'done', text: 'copy, "10-4"' }],
  },
];

const store = {
  radios: () => [],
  transmission: (id) => ROWS.find((r) => r.id === id),
  transmissions: () => ROWS,
};
const manager = Object.assign(new EventEmitter(), {
  radios: () => [], engines: new Map(), primary: 'base', extra: [],
});
const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', auth: {} }, dataDir: '.' });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

test('the text download carries every engine, not just the default', async () => {
  const res = await fetch(`${base}/transmissions/7/text`);
  assert.equal(res.status, 200);
  const body = await res.text();
  // Checked by inspecting lines rather than with a built regex, because the
  // escaping in one of those is easy to get subtly wrong.
  const labels = body.split('\n').map((l) => l.split(/\s+/)[0]).filter(Boolean);
  for (const engine of ['base', 'tiny', 'small']) {
    assert.ok(labels.includes(engine), `${engine} should label a line; got ${labels.join(',')}`);
  }
  assert.match(body, /over Montregg/, 'the disagreement is the useful part');
  assert.match(body, /<error: model missing>/, 'a failure is stated, not omitted');
});

test('it carries the context the transcript needs to mean anything', async () => {
  const body = await (await fetch(`${base}/transmissions/7/text`)).text();
  assert.match(body, /Holden PD/);
  assert.match(body, /460\.3875 MHz/);
  assert.match(body, /6\.3s · heard/);
  assert.match(body, /AA:BB:CC:DD:EE:FF/);
});

test('a clip with no channel says so rather than inventing one', async () => {
  const body = await (await fetch(`${base}/transmissions/8/text`)).text();
  assert.match(body, /channel unknown/);
  assert.match(body, /1\.3s · sent/);
});

test('?format=json gives the structured row', async () => {
  const res = await fetch(`${base}/transmissions/7/text?format=json`);
  assert.match(res.headers.get('content-disposition'), /\.json"$/);
  const body = await res.json();
  assert.equal(body.transcripts.length, 3);
});

test('exporting as CSV gives one row per transcript', async () => {
  const res = await fetch(`${base}/transmissions/export?format=csv`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = (await res.text()).trim().split('\n');
  assert.match(lines[0], /^id,started_at,iso,mac,channel,channel_name/);
  assert.equal(lines.length, 1 + 4, 'header plus three transcripts for id 7 and one for id 8');
});

test('CSV quoting survives commas and quotes in a transcript', async () => {
  const text = await (await fetch(`${base}/transmissions/export?format=csv`)).text();
  // A transcript of: copy, "10-4"
  assert.match(text, /"copy, ""10-4"""/, 'commas and quotes must not break the columns');
});

test('exporting as text runs the clips together readably', async () => {
  const body = await (await fetch(`${base}/transmissions/export?format=txt`)).text();
  assert.match(body, /Holden PD/);
  assert.match(body, /channel unknown/);
});

test('exporting defaults to JSON', async () => {
  const res = await fetch(`${base}/transmissions/export`);
  const body = await res.json();
  assert.equal(body.length, 2);
  assert.equal(body[0].transcripts.length, 3);
});

test('a clip with no transcript is 404, not an empty file', async () => {
  store.transmission = () => ({ ...ROWS[0], transcripts: [] });
  assert.equal((await fetch(`${base}/transmissions/7/text`)).status, 404);
  store.transmission = (id) => ROWS.find((r) => r.id === id);
});

test.after(() => server.close());
