import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sidecar } from '../src/sidecar.js';
import { Manager } from '../src/manager.js';
import { createEngine } from '../src/stt/index.js';

/** In-memory stand-in for Store, so this runs on Node versions without node:sqlite. */
class FakeStore {
  rows = new Map();
  radios() { return []; }
  addTransmission(t) {
    const id = this.rows.size + 1;
    // Same column names as the real Store's rows.
    this.rows.set(id, { id, mac: t.mac, started_at: t.startedAt, duration_ms: Math.round(t.durationMs), audio_file: t.audioFile, status: 'pending' });
    return id;
  }
  finishTransmission(id, r) { Object.assign(this.rows.get(id), r); }
  transmission(id) { return this.rows.get(id); }
}

test('simulated radio -> one clip -> transcript, end to end through the Python sidecar', { timeout: 40000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'htradio-'));
  const store = new FakeStore();
  const sidecar = new Sidecar({ python: process.env.PYTHON ?? 'python3', backend: 'sim' });
  const manager = new Manager({
    sidecar, store, engine: createEngine({ engine: 'mock' }), dataDir,
    audio: { sampleRate: 32000, preRollMs: 300, holdMs: 500, minMs: 400, maxMs: 120000, energyThreshold: 0.02 },
  });
  sidecar.start();
  try {
    const done = new Promise((resolve) =>
      manager.on('update', (u) => u.type === 'transmission' && u.status === 'done' && resolve(u)));
    assert.equal(await sidecar.call('ping'), 'pong');
    const scan = await sidecar.call('scan');
    assert.ok(scan.length >= 1);
    await manager.connect('00:11:22:33:44:55');
    const tx = await done;
    assert.match(tx.text, /mock transcript/);
    assert.ok(tx.duration_ms > 1500, `clip should span the burst, got ${tx.duration_ms}`);
    assert.ok(existsSync(join(dataDir, 'clips', tx.audio_file)));
    await manager.disconnect('00:11:22:33:44:55');
  } finally {
    sidecar.stop();
  }
});
