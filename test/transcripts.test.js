import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Manager } from '../src/manager.js';

const MAC = 'AA:BB:CC:DD:EE:FF';

/** A store stand-in with the transcripts table's behaviour, minus SQLite. */
class FakeStore {
  rows = new Map();
  scripts = new Map(); // id -> Map(engine -> record)
  radios() { return []; }
  addTransmission(t) {
    const id = this.rows.size + 1;
    this.rows.set(id, { id, ...t, audio_file: t.audioFile, status: 'pending' });
    return id;
  }
  saveTranscript(id, engine, r) {
    if (!this.scripts.has(id)) this.scripts.set(id, new Map());
    this.scripts.get(id).set(engine, { engine, ...r });
  }
  transcripts(id) { return [...(this.scripts.get(id)?.values() ?? [])]; }
  transmission(id) { return { ...this.rows.get(id), transcripts: this.transcripts(id) }; }
  needingTranscript(engine) {
    return [...this.rows.values()].filter(
      (r) => this.scripts.get(r.id)?.get(engine)?.status !== 'done',
    );
  }
}

/** @returns {object} A Manager with named engines and a real clip on disk. */
function make({ extra = [], order = [] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'airscribe-ts-'));
  mkdirSync(join(dataDir, 'clips', 'AABBCCDDEEFF'), { recursive: true });
  const engine = (name, delay = 0) => ({
    name,
    transcribe: async (wav) => {
      order.push(name);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (name === 'broken') throw new Error('model missing');
      return { text: `${name} heard it` };
    },
  });
  const engines = new Map([
    ['base', engine('base')],
    ['tiny', engine('tiny')],
    ['broken', engine('broken')],
  ]);
  const store = new FakeStore();
  const manager = new Manager({
    sidecar: Object.assign(new EventEmitter(), { call: async () => {} }),
    store, engines, primary: 'base', extra,
    audio: { sampleRate: 8000, preRollMs: 0, holdMs: 500, minMs: 1, maxMs: 9999, energyThreshold: 0.05 },
    dataDir,
  });
  return { manager, store, dataDir, order };
}

/** @returns {number} A transmission id with its 16k clip present on disk. */
function addClip(manager, store, dataDir, n = 1) {
  const file = join('AABBCCDDEEFF', `c${n}.wav`);
  for (const name of [file, file.replace('.wav', '.16k.wav')]) {
    writeFileSync(join(dataDir, 'clips', name), Buffer.alloc(64));
  }
  return store.addTransmission({ mac: MAC, startedAt: Date.now(), durationMs: 1000, audioFile: file });
}

test('one engine produces one transcript', async () => {
  const { manager, store, dataDir } = make();
  const id = addClip(manager, store, dataDir);
  manager.enqueue({ priority: 0, id, engineName: 'base', wav: join(dataDir, 'clips', 'AABBCCDDEEFF', 'c1.16k.wav') });
  await manager.pump();
  assert.deepEqual(store.transcripts(id).map((t) => [t.engine, t.text]), [['base', 'base heard it']]);
});

test('several engines each keep their own transcript', async () => {
  const { manager, store, dataDir } = make();
  const id = addClip(manager, store, dataDir);
  const wav = join(dataDir, 'clips', 'AABBCCDDEEFF', 'c1.16k.wav');
  manager.enqueue({ priority: 0, id, engineName: 'base', wav });
  manager.enqueue({ priority: 1, id, engineName: 'tiny', wav });
  await manager.pump();
  const got = store.transcripts(id).map((t) => t.engine).sort();
  assert.deepEqual(got, ['base', 'tiny'], 'both are kept, neither overwrites the other');
});

test('re-running an engine replaces only its own transcript', async () => {
  const { manager, store, dataDir } = make();
  const id = addClip(manager, store, dataDir);
  store.saveTranscript(id, 'base', { status: 'error', error: 'model missing' });
  store.saveTranscript(id, 'tiny', { status: 'done', text: 'kept' });
  const wav = join(dataDir, 'clips', 'AABBCCDDEEFF', 'c1.16k.wav');
  manager.enqueue({ priority: 1, id, engineName: 'base', wav });
  await manager.pump();
  const by = Object.fromEntries(store.transcripts(id).map((t) => [t.engine, t]));
  assert.equal(by.base.status, 'done', 'the failure is replaced by the retry');
  assert.equal(by.tiny.text, 'kept', 'the other engine is untouched');
});

test('a failing engine records why, and does not stop the others', async () => {
  const { manager, store, dataDir } = make();
  const id = addClip(manager, store, dataDir);
  const wav = join(dataDir, 'clips', 'AABBCCDDEEFF', 'c1.16k.wav');
  manager.enqueue({ priority: 1, id, engineName: 'broken', wav });
  manager.enqueue({ priority: 1, id, engineName: 'tiny', wav });
  await manager.pump();
  const by = Object.fromEntries(store.transcripts(id).map((t) => [t.engine, t]));
  assert.equal(by.broken.status, 'error');
  assert.match(by.broken.error, /model missing/);
  assert.equal(by.tiny.status, 'done');
});

test('live traffic goes ahead of a comparison backlog', async () => {
  const order = [];
  const { manager, store, dataDir } = make({ order });
  const id = addClip(manager, store, dataDir);
  const wav = join(dataDir, 'clips', 'AABBCCDDEEFF', 'c1.16k.wav');
  // A queue full of low-priority work, then a clip off the air.
  for (let i = 0; i < 3; i++) manager.enqueue({ priority: 1, id, engineName: 'tiny', wav });
  manager.enqueue({ priority: 0, id, engineName: 'base', wav });
  await manager.pump();
  // The job already running cannot be preempted - a speech model is not
  // interruptible - so the guarantee is about everything after it: the new
  // clip waits for at most one comparison run, not for the whole backlog.
  assert.equal(order.indexOf('base'), 1,
    `live work should be next in line, got ${order.join(' -> ')}`);
  assert.deepEqual(order, ['tiny', 'base', 'tiny', 'tiny']);
});

test('the recovery sweep queues every clip an engine has not done', async () => {
  const { manager, store, dataDir } = make();
  for (let i = 1; i <= 3; i++) addClip(manager, store, dataDir, i);
  const queued = manager.retranscribe('base');
  assert.equal(queued, 3);
  await manager.pump();
  for (let i = 1; i <= 3; i++) {
    assert.equal(store.transcripts(i)[0]?.text, 'base heard it', `clip ${i} recovered`);
  }
});

test('the sweep skips clips whose audio is gone', async () => {
  const { manager, store } = make();
  store.addTransmission({ mac: MAC, startedAt: 1, durationMs: 1000, audioFile: 'gone/missing.wav' });
  assert.equal(manager.retranscribe('base'), 1, 'it is counted as needing work');
  await manager.pump();
  assert.equal(store.transcripts(1).length, 0, 'but nothing is invented for missing audio');
});

test('an unknown engine is refused rather than silently doing nothing', () => {
  const { manager } = make();
  assert.throws(() => manager.retranscribe('nope'), /unknown engine/);
});
