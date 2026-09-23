import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Manager } from '../src/manager.js';

const MAC = 'AA:BB:CC:DD:EE:FF';
const AUDIO = {
  sampleRate: 8000, preRollMs: 100, holdMs: 500, minMs: 200,
  maxMs: 60000, overlapMs: 100, energyThreshold: 0.05,
};

/** In-memory Store stand-in, so this runs without node:sqlite. */
class FakeStore {
  rows = new Map();
  radios() { return []; }
  addTransmission(t) {
    const id = this.rows.size + 1;
    this.rows.set(id, { id, ...t, transmit: t.transmit ? 1 : 0, status: 'pending' });
    return id;
  }
  saveTranscript(id, engine, r) {
    const row = this.rows.get(id);
    row.transcripts = (row.transcripts ?? []).filter((t) => t.engine !== engine);
    row.transcripts.push({ engine, ...r });
    Object.assign(row, { status: r.status, text: r.text ?? null, engine, error: r.error ?? null });
  }
  needingTranscript() { return []; }
  transmission(id) { return this.rows.get(id); }
}

/** @returns {object} A Manager wired to fakes, plus the events it emits. */
function make() {
  const sidecar = Object.assign(new EventEmitter(), { call: async () => {} });
  const store = new FakeStore();
  const updates = [];
  const manager = new Manager({
    sidecar, store, audio: AUDIO,
    dataDir: mkdtempSync(join(tmpdir(), 'htmgr-')),
    engine: { name: 'mock', transcribe: async () => ({ text: 'ok' }) },
  });
  manager.on('update', (u) => updates.push(u));
  /** @param {number} count - Chunks. @param {number} amp - Level. @param {object} extra - Event fields. */
  const audio = (count, amp, extra = {}) => {
    const n = 800; // 100 ms at 8 kHz
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * (i % 2 ? 1 : -1)), i * 2);
    for (let i = 0; i < count; i++) {
      sidecar.emit('event', { event: 'audio', mac: MAC, pcm: b.toString('base64'), ...extra });
    }
  };
  const fire = (e) => sidecar.emit('event', e);
  return { manager, store, updates, audio, fire };
}

test('run markers from the sidecar bracket one transmission', () => {
  const { store, audio, fire } = make();
  fire({ event: 'audio-start', mac: MAC, transmit: false });
  audio(10, 0.3, { rx: true });
  fire({ event: 'audio-end', mac: MAC });
  assert.equal(store.rows.size, 1);
  assert.equal(store.transmission(1).transmit, 0);
});

test('two marked runs with no gap stay two transmissions', () => {
  const { store, audio, fire } = make();
  for (let i = 0; i < 2; i++) {
    fire({ event: 'audio-start', mac: MAC, transmit: false });
    audio(10, 0.3, { rx: true });
    fire({ event: 'audio-end', mac: MAC });
  }
  assert.equal(store.rows.size, 2);
});

test('a transmitted run is recorded as sent', () => {
  const { store, audio, fire } = make();
  fire({ event: 'audio-start', mac: MAC, transmit: true });
  audio(10, 0.3, { transmit: true });
  fire({ event: 'audio-end', mac: MAC });
  assert.equal(store.transmission(1).transmit, 1);
});

test('activity is emitted on change only, not per audio chunk', () => {
  const { updates, audio, fire } = make();
  fire({ event: 'audio-start', mac: MAC, transmit: false });
  audio(10, 0.3, { rx: true });
  fire({ event: 'audio-end', mac: MAC });
  const activity = updates.filter((u) => u.type === 'activity');
  assert.deepEqual(activity.map((a) => [a.rx, a.tx]), [[true, false], [false, false]]);
});

test('a disconnect closes the clip in progress and clears activity', () => {
  const { store, updates, audio, fire } = make();
  fire({ event: 'audio-start', mac: MAC, transmit: false });
  audio(10, 0.3, { rx: true });
  fire({ event: 'status', mac: MAC, state: 'disconnected' });
  assert.equal(store.rows.size, 1, 'the partial transmission is not thrown away');
  const last = updates.at(-1);
  assert.equal(last.type, 'status');
  assert.equal(last.rx, false);
});

test('each radio is segmented on its own', () => {
  const { store, fire } = make();
  const other = '11:22:33:44:55:66';
  const n = 800;
  const loud = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) loud.writeInt16LE(i % 2 ? 9000 : -9000, i * 2);
  for (const mac of [MAC, other]) fire({ event: 'audio-start', mac, transmit: false });
  for (let i = 0; i < 10; i++) {
    for (const mac of [MAC, other]) {
      fire({ event: 'audio', mac, rx: true, pcm: loud.toString('base64') });
    }
  }
  for (const mac of [MAC, other]) fire({ event: 'audio-end', mac });
  assert.equal(store.rows.size, 2);
  assert.deepEqual([...store.rows.values()].map((r) => r.mac).sort(), [MAC, other].sort());
});

test('radio-status from the BlueZ backend drives the indicator', () => {
  const { updates, fire } = make();
  fire({ event: 'radio-status', mac: MAC, rssi: 9, in_rx: true, squelch: true, in_tx: false });
  fire({ event: 'radio-status', mac: MAC, rssi: 9, in_rx: true, squelch: true, in_tx: false });
  fire({ event: 'radio-status', mac: MAC, rssi: 0, in_rx: false, squelch: false, in_tx: false });
  const activity = updates.filter((u) => u.type === 'activity');
  // Polled once a second, so only the changes may be emitted.
  assert.deepEqual(activity.map((a) => [a.rx, a.tx]), [[true, false], [false, false]]);
});

test('a transmitting radio is shown as transmitting, not receiving', () => {
  const { updates, fire } = make();
  fire({ event: 'radio-status', mac: MAC, rssi: 0, in_rx: false, in_tx: true });
  const last = updates.filter((u) => u.type === 'activity').at(-1);
  assert.deepEqual([last.rx, last.tx], [false, true]);
});

test('a sidecar error is surfaced rather than swallowed', () => {
  const { updates, fire } = make();
  const errs = [];
  const realError = console.error;
  console.error = (m) => errs.push(m);
  try {
    fire({ event: 'sidecar-error', mac: MAC, error: 'no SBC-capable ffmpeg found' });
  } finally {
    console.error = realError;
  }
  // Logged, because this is the thing that explains an absence of transcripts.
  assert.equal(errs.length, 1);
  assert.match(errs[0], /no SBC-capable ffmpeg found/);
  const u = updates.find((x) => x.type === 'error');
  assert.ok(u, 'the UI is told too');
  assert.equal(u.mac, MAC);
});

test('an unknown sidecar event is ignored without throwing', () => {
  const { fire } = make();
  assert.doesNotThrow(() => fire({ event: 'something-new', mac: MAC }));
});

test('a change in signal level reaches the UI', () => {
  const { updates, fire } = make();
  fire({ event: 'radio-status', mac: MAC, rssi: 0, in_rx: false, in_tx: false });
  fire({ event: 'radio-status', mac: MAC, rssi: 7, in_rx: false, in_tx: false });
  fire({ event: 'radio-status', mac: MAC, rssi: 7, in_rx: false, in_tx: false });
  const act = updates.filter((u) => u.type === 'activity');
  // Two changes, not three polls: RSSI 0 -> 7, and the repeat is silent.
  assert.deepEqual(act.map((a) => a.rssi), [0, 7]);
});

test('an unchanged poll emits nothing', () => {
  const { updates, fire } = make();
  for (let i = 0; i < 5; i++) {
    fire({ event: 'radio-status', mac: MAC, rssi: 3, in_rx: false, in_tx: false });
  }
  assert.equal(updates.filter((u) => u.type === 'activity').length, 1,
    'a radio polled every second must not emit every second');
});

test('battery reaches the UI and is warned about once per threshold', () => {
  const { updates, fire } = make();
  const warned = [];
  const real = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    for (const battery of [80, 25, 18, 15, 9, 4]) {
      fire({ event: 'radio-status', mac: MAC, rssi: 5, in_rx: false, in_tx: false, battery });
    }
  } finally {
    console.warn = real;
  }
  const seen = updates.filter((u) => u.type === 'activity').map((u) => u.battery);
  assert.deepEqual(seen, [80, 25, 18, 15, 9, 4], 'every change is reported');
  // Crossing 20, then 10, then 5 - not once per poll below them.
  assert.equal(warned.length, 3, `expected three warnings, got: ${warned.join(' | ')}`);
  assert.match(warned[0], /18%/);
});

test('a radio that reports no battery is not warned about', () => {
  const { updates, fire } = make();
  const warned = [];
  const real = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    fire({ event: 'radio-status', mac: MAC, rssi: 5, in_rx: false, in_tx: false });
    fire({ event: 'radio-status', mac: MAC, rssi: 6, in_rx: false, in_tx: false, battery: null });
  } finally {
    console.warn = real;
  }
  assert.deepEqual(warned, []);
  assert.ok(updates.some((u) => u.type === 'activity'));
});

test('a clip records the channel the run started on', () => {
  const { store, fire, audio } = make();
  fire({ event: 'channels', mac: MAC, channels: [
    { id: 3, name: 'FIRE DISP', rx_hz: 154265000 },
    { id: 4, name: 'PD1', rx_hz: 155475000 },
  ] });
  fire({ event: 'radio-status', mac: MAC, rssi: 8, in_rx: false, in_tx: false, channel: 3 });
  fire({ event: 'audio-start', mac: MAC, transmit: false });
  audio(10, 0.3, { rx: true });
  // The radio scans on while the clip is still being written; the channel it
  // started on is the one that matters.
  fire({ event: 'radio-status', mac: MAC, rssi: 2, in_rx: false, in_tx: false, channel: 4 });
  fire({ event: 'audio-end', mac: MAC });
  const row = store.transmission(1);
  assert.equal(row.channel, 3);
  assert.equal(row.channelName, 'FIRE DISP');
  assert.equal(row.channelHz, 154265000);
});

test('an unknown channel index is recorded without a name', () => {
  const { store, fire, audio } = make();
  fire({ event: 'radio-status', mac: MAC, rssi: 8, in_rx: false, in_tx: false, channel: 9 });
  fire({ event: 'audio-start', mac: MAC, transmit: false });
  audio(10, 0.3, { rx: true });
  fire({ event: 'audio-end', mac: MAC });
  const row = store.transmission(1);
  assert.equal(row.channel, 9);
  assert.equal(row.channelName, null, 'no invented name for a channel we never read');
});
