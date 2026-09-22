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
  finishTransmission(id, r) { Object.assign(this.rows.get(id), r); }
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
