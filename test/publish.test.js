import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLISH_DEFAULTS, publicCutoff, publishable, publicView } from '../src/publish.js';

const NOW = 1_800_000_000_000;
const ago = (min) => NOW - min * 60_000;
const row = (min) => ({ id: 1, started_at: ago(min), duration_ms: 3000, transcripts: [] });
const open = { enabled: true, transcripts: true, audio: true, delayMinutes: 30 };
const pubRadio = { public: 1, name: 'UV-PRO' };

test('nothing is public until it is turned on', () => {
  assert.equal(PUBLISH_DEFAULTS.enabled, false);
  assert.equal(PUBLISH_DEFAULTS.audio, false, 'clips are voices; they stay off by default');
  assert.equal(publishable(row(60), pubRadio, {}, NOW), false);
  assert.equal(publishable(row(60), pubRadio, { enabled: false }, NOW), false);
});

test('a radio must itself be marked public', () => {
  assert.equal(publishable(row(60), { public: 0 }, open, NOW), false);
  assert.equal(publishable(row(60), undefined, open, NOW), false, 'a forgotten radio publishes nothing');
  assert.equal(publishable(row(60), pubRadio, open, NOW), true);
});

test('the delay holds a transmission back until it has passed', () => {
  assert.equal(publishable(row(29), pubRadio, open, NOW), false, 'inside the window');
  assert.equal(publishable(row(30), pubRadio, open, NOW), true, 'exactly at it');
  assert.equal(publishable(row(31), pubRadio, open, NOW), true);
});

test('a zero or missing delay publishes immediately', () => {
  assert.equal(publishable(row(0), pubRadio, { ...open, delayMinutes: 0 }, NOW), true);
  // A negative delay must not become a window into the future.
  assert.equal(publicCutoff({ delayMinutes: -60 }, NOW), NOW);
});

test('the cutoff is a timestamp a query can use', () => {
  assert.equal(publicCutoff({ delayMinutes: 30 }, NOW), ago(30));
  assert.equal(publicCutoff({}, NOW), ago(PUBLISH_DEFAULTS.delayMinutes));
});

test('the public view shows one transcript, not the disagreement', () => {
  const r = {
    ...row(60),
    transcripts: [
      { engine: 'base', status: 'done', text: 'engine two on arrival' },
      { engine: 'tiny', status: 'done', text: 'engine to on a rival' },
    ],
  };
  const v = publicView(r, open, 'base');
  assert.equal(v.text, 'engine two on arrival');
  assert.equal(v.engine, 'base');
  assert.equal(v.transcripts, undefined, 'the other engines are not exposed');
});

test('it falls back to any finished transcript when the default failed', () => {
  const r = {
    ...row(60),
    transcripts: [
      { engine: 'base', status: 'error', error: 'model missing' },
      { engine: 'tiny', status: 'done', text: 'heard it' },
    ],
  };
  assert.equal(publicView(r, open, 'base').text, 'heard it');
});

test('a failure is not published as if it were a transcript', () => {
  const r = { ...row(60), transcripts: [{ engine: 'base', status: 'error', error: 'boom' }] };
  const v = publicView(r, open, 'base');
  assert.equal(v.text, null);
  assert.ok(!JSON.stringify(v).includes('boom'), 'an internal error is not public');
});

test('turning transcripts off leaves the row but not the words', () => {
  const r = { ...row(60), transcripts: [{ engine: 'base', status: 'done', text: 'secret' }] };
  const v = publicView(r, { ...open, transcripts: false }, 'base');
  assert.equal(v.text, null);
  assert.ok(!JSON.stringify(v).includes('secret'));
});

test('audio is advertised only when it is published', () => {
  const r = { ...row(60), audio_file: 'AABB/clip.wav' };
  assert.equal(publicView(r, { ...open, audio: false }, 'base').has_audio, false);
  assert.equal(publicView(r, open, 'base').has_audio, true);
  // The path on disk is never part of a public row either way.
  for (const audio of [true, false]) {
    assert.ok(!JSON.stringify(publicView(r, { ...open, audio }, 'base')).includes('clip.wav'));
  }
});

test('the public row keeps the context but drops the internals', () => {
  const r = {
    ...row(60), mac: 'AA:BB:CC:DD:EE:FF', audio_file: 'x.wav', status: 'done',
    channel: 3, channel_name: 'Holden PD', channel_hz: 460387500,
    radio_name: 'Scanner', radio_group: 'emergency',
  };
  const v = publicView(r, open, 'base');
  assert.equal(v.channel_name, 'Holden PD');
  assert.equal(v.radio, 'Scanner');
  assert.equal(v.group, 'emergency');
  assert.equal(v.mac, undefined, 'a MAC identifies hardware and is not public');
  assert.equal(v.audio_file, undefined);
});
