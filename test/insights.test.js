import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { topWords } from '../src/insights.js';

let sqlite = true;
try {
  await import('node:sqlite');
} catch {
  sqlite = false;
}

const HOUR = 60 * 60 * 1000;

test('the word cloud counts what was said, not filler or the model\'s annotations', () => {
  const words = topWords([
    'Engine 4, respond to Main Street. (static)',
    'Engine 4 copy, Main Street, en route',
    '[BLANK_AUDIO] okay so you said MAIN street?',
    'Unit 2783 clear',
    'I\'m on scene, *beep*',
  ]);
  const count = Object.fromEntries(words.map((w) => [w.word, w.count]));
  assert.equal(count.main, 3, 'counted across case');
  assert.equal(count.street, 3);
  assert.equal(count.engine, 2);
  assert.equal(count['2783'], 1, 'call and unit numbers are kept');
  for (const gone of ['static', 'blank_audio', 'blank', 'audio', 'beep', 'okay', 'you', 'so', 'i\'m', 'on', '4']) {
    assert.equal(count[gone], undefined, `"${gone}" is left out`);
  }
  assert.deepEqual(words.slice(0, 2).map((w) => w.word), ['main', 'street'], 'commonest first, ties by name');
  assert.equal(topWords(Array(200).fill('alpha beta').concat(['gamma']), 2).length, 2, 'as many as asked for');
});

test('Insights: per hour, per channel, and only the shown transcripts, in a range and filter', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { insights } = await import('../src/insights.js');
  const store = new Store(':memory:', 'base');
  const now = Date.UTC(2026, 10, 15, 12, 30);
  const add = (agoHours, channelName, text, other) => {
    const id = store.addTransmission({ mac: '38:D2:00:01:56:51', startedAt: now - agoHours * HOUR, durationMs: 2000,
      audioFile: `${agoHours}.wav`, channelName, channelHz: 460387500 });
    store.saveTranscript(id, 'base', { status: 'done', text });
    if (other) store.saveTranscript(id, 'alt', { status: 'done', text: other });
    return id;
  };
  add(0, 'Holden PD', 'motor vehicle stop Main Street', 'hallucinated zebra');
  add(0.2, 'Holden PD', 'Main Street clear');
  add(1, 'Rutld FD', 'engine respond');
  add(30, 'Rutld FD', 'yesterday\'s fire');   // outside a one-day range

  const day = insights(store, { since: now - 24 * HOUR });
  assert.equal(day.total, 3);
  assert.equal(day.airtimeMs, 6000);
  assert.deepEqual(day.hourly.map((h) => [h.hour, h.count]),
    [[Date.UTC(2026, 10, 15, 11), 1], [Date.UTC(2026, 10, 15, 12), 2]], 'UTC hour starts');
  assert.deepEqual(day.channels.map((c) => [c.name, c.count, c.ms]), [['Holden PD', 2, 4000], ['Rutld FD', 1, 2000]]);
  const words = day.words.map((w) => w.word);
  assert.equal(day.words[0].word, 'main');
  assert.ok(!words.includes('zebra'), 'only the default engine\'s transcript, as the feed shows');
  assert.ok(!words.includes('yesterday\'s'), 'and only within the range');

  assert.equal(insights(store, { since: 0 }).total, 4, 'everything');
  assert.equal(insights(store, { since: 0, channel: 'Rutld FD' }).total, 2, 'one channel');
});

test('the API serves Insights to a viewer, and checks the range', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { createApp } = await import('../src/api.js');
  const store = new Store(':memory:', 'base');
  const id = store.addTransmission({ mac: '38:D2:00:01:56:51', startedAt: Date.now() - HOUR, durationMs: 1500,
    audioFile: 'a.wav', channelName: 'Holden PD' });
  store.saveTranscript(id, 'base', { status: 'done', text: 'structure fire' });
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'v', role: 'viewer' }] } };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/insights`;
  const get = (qs, token = 'v') => fetch(`${base}${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  try {
    assert.equal((await get('', null)).status, 401);
    const r = await (await get('?days=1')).json();
    assert.equal(r.total, 1);
    assert.deepEqual(r.words.map((w) => w.word), ['fire', 'structure']);
    assert.equal((await (await get('?days=1&channel=Nowhere')).json()).total, 0);
    assert.equal((await get('?days=-2')).status, 400);
  } finally {
    server.close();
  }
});
