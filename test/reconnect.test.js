import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Manager } from '../src/manager.js';

const MAC = 'AA:BB:CC:DD:EE:FF';

/** @returns {object} A Manager with a fake sidecar and very short backoff. */
function make(connectBehaviour = async () => {}) {
  const calls = [];
  const sidecar = Object.assign(new EventEmitter(), {
    call: async (cmd, args) => {
      calls.push([cmd, args.mac]);
      if (cmd === 'connect') return connectBehaviour(calls.length);
      return undefined;
    },
  });
  const manager = new Manager({
    sidecar,
    store: { radios: () => [], addTransmission: () => 1, transmission: () => ({}), finishTransmission() {} },
    engine: { name: 'mock', transcribe: async () => ({ text: '' }) },
    audio: { sampleRate: 8000, preRollMs: 0, holdMs: 500, minMs: 100, maxMs: 9999, energyThreshold: 0.05 },
    dataDir: mkdtempSync(join(tmpdir(), 'airscribe-rc-')),
    reconnect: { baseMs: 20, maxMs: 80 },
  });
  const updates = [];
  manager.on('update', (u) => updates.push(u));
  return { manager, sidecar, calls, updates };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a radio that drops on its own is retried', async () => {
  const { manager, sidecar, calls } = make();
  await manager.connect(MAC);
  assert.deepEqual(calls, [['connect', MAC]]);
  sidecar.emit('event', { event: 'status', mac: MAC, state: 'disconnected', detail: 'radio stopped responding' });
  await wait(60);
  assert.ok(calls.filter(([c]) => c === 'connect').length >= 2, 'it should have tried again');
  manager.stopRetrying();
});

test('an explicit disconnect is not retried', async () => {
  const { manager, sidecar, calls } = make();
  await manager.connect(MAC);
  await manager.disconnect(MAC);
  sidecar.emit('event', { event: 'status', mac: MAC, state: 'disconnected' });
  await wait(80);
  assert.equal(calls.filter(([c]) => c === 'connect').length, 1,
    'the operator asked for it to stop; it must stay stopped');
  manager.stopRetrying();
});

test('the wait doubles up to the ceiling instead of hammering the radio', async () => {
  const { manager, sidecar } = make(async (n) => {
    if (n > 1) throw new Error('still unreachable');
  });
  await manager.connect(MAC);
  sidecar.emit('event', { event: 'status', mac: MAC, state: 'disconnected' });
  await wait(300);
  const delays = [];
  // Drive the schedule directly to read the progression it would use.
  manager.stopRetrying();
  manager.retries.set(MAC, { delay: 20 });
  for (let i = 0; i < 4; i++) {
    manager.scheduleRetry(MAC);
    delays.push(manager.retries.get(MAC).delay);
    clearTimeout(manager.retries.get(MAC).timer);
    manager.retries.set(MAC, { delay: manager.retries.get(MAC).delay });
  }
  assert.deepEqual(delays, [40, 80, 80, 80], 'doubling, then capped at maxMs');
  manager.stopRetrying();
});

test('reconnecting is visible rather than silent', async () => {
  const { manager, sidecar, updates } = make();
  await manager.connect(MAC);
  sidecar.emit('event', { event: 'status', mac: MAC, state: 'disconnected' });
  await wait(60);
  assert.ok(updates.some((u) => u.state === 'connecting'), 'the UI should say it is retrying');
  manager.stopRetrying();
});

test('a successful reconnect stops the retries', async () => {
  const { manager, sidecar, calls } = make();
  await manager.connect(MAC);
  sidecar.emit('event', { event: 'status', mac: MAC, state: 'disconnected' });
  await wait(40);
  sidecar.emit('event', { event: 'status', mac: MAC, state: 'connected' });
  const after = calls.length;
  await wait(120);
  assert.equal(calls.length, after, 'nothing further once it is back');
  assert.equal(manager.retries.size, 0);
});

test('pending retries never hold the process open', async () => {
  const { manager, sidecar } = make();
  await manager.connect(MAC);
  sidecar.emit('event', { event: 'status', mac: MAC, state: 'disconnected' });
  const r = manager.retries.get(MAC);
  assert.ok(r?.timer, 'a retry is pending');
  assert.equal(r.timer.hasRef(), false, 'and it is unref\'d, so shutdown is not blocked');
  manager.stopRetrying();
});
