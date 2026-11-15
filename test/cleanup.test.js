import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sqlite = true;
try {
  await import('node:sqlite');
} catch {
  sqlite = false;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15, 12);
const MAC = '38:D2:00:01:56:51';

/**
 * A real Store and Manager over a temporary data folder, with clips on disk:
 * three days of transmissions, some of them chirps with no speech.
 * @returns {Promise<object>} The parts, and helpers.
 */
async function setup() {
  const { Store } = await import('../src/store.js');
  const { Manager } = await import('../src/manager.js');
  const { Cleanup } = await import('../src/cleanup.js');
  const dataDir = mkdtempSync(join(tmpdir(), 'airscribe-cleanup-'));
  const store = new Store(join(dataDir, 'airscribe.sqlite'), 'base');
  let release;
  const engine = { name: 'base', transcribe: () => new Promise((r) => (release = () => r({ text: 'late' }))) };
  const manager = new Manager({
    sidecar: Object.assign(new EventEmitter(), { call: async () => {} }), store,
    engines: new Map([['base', engine]]), primary: 'base', extra: [], audio: {}, dataDir,
  });
  const updates = [];
  manager.on('update', (u) => updates.push(u));
  const clips = join(dataDir, 'clips', 'AABB');
  mkdirSync(clips, { recursive: true });
  const add = (startedAt, text) => {
    const name = `${startedAt}.wav`;
    writeFileSync(join(clips, name), Buffer.alloc(1000));
    writeFileSync(join(clips, name.replace('.wav', '.16k.wav')), Buffer.alloc(500));
    const id = store.addTransmission({ mac: MAC, startedAt, durationMs: 900, audioFile: join('AABB', name) });
    if (text !== undefined) store.saveTranscript(id, 'base', { status: 'done', text });
    return id;
  };
  const ids = {
    old: add(NOW - 5 * DAY, 'engine 4 respond'),
    oldChirp: add(NOW - 4 * DAY, ''),
    recentChirp: add(NOW - DAY / 2, '   '),
    recent: add(NOW - DAY / 4, 'copy that'),
    pending: add(NOW - 60000),
  };
  const cleanup = new Cleanup({ manager, store, dataDir, now: () => NOW });
  return { store, manager, cleanup, dataDir, clips, ids, updates, release: () => release?.() };
}

test('no speech is a finished, empty transcript from the default engine', { skip: !sqlite }, async () => {
  const { store, ids } = await setup();
  const shown = store.transmissions({ speech: true }).map((t) => t.id);
  assert.ok(!shown.includes(ids.oldChirp) && !shown.includes(ids.recentChirp), 'the chirps are left out');
  assert.ok(shown.includes(ids.pending), 'a clip still waiting for its transcript is not "no speech"');
  assert.equal(store.countTransmissions({ speech: true }), 3);
  assert.equal(store.countTransmissions(), 5);
});

test('a cleanup must say what to delete, and in whole days', { skip: !sqlite }, async () => {
  const { cleanup } = await setup();
  assert.throws(() => cleanup.preview({}), /say what to delete/);
  assert.throws(() => cleanup.preview({ olderThanDays: '' }), /say what to delete/);
  assert.throws(() => cleanup.preview({ olderThanDays: 0 }), /1 or more/);
  assert.throws(() => cleanup.preview({ olderThanDays: 1.5 }), /whole number/);
  assert.throws(() => cleanup.preview({ noSpeech: 'yes' }), /say what to delete/, 'only a real true counts');
});

test('preview and delete agree, by age, by no speech, or both', { skip: !sqlite }, async () => {
  const { cleanup, store, ids } = await setup();
  assert.deepEqual(cleanup.preview({ olderThanDays: 3 }), {
    count: 2, bytes: 3000, oldest: NOW - 5 * DAY, newest: NOW - 4 * DAY,
  });
  assert.equal(cleanup.preview({ noSpeech: true }).count, 2);
  assert.equal(cleanup.preview({ olderThanDays: 3, noSpeech: true }).count, 1, 'both: only the old chirp');
  assert.deepEqual(cleanup.purge({ olderThanDays: 3, noSpeech: true }), { deleted: 1, bytes: 1500 });
  assert.equal(store.hasTransmission(ids.oldChirp), false);
  assert.equal(store.hasTransmission(ids.old), true, 'the old one with speech stays');
});

test('deleting removes the rows, the transcripts and both audio files, and tells the page', { skip: !sqlite }, async () => {
  const { manager, store, clips, ids, updates } = await setup();
  const t = store.transmission(ids.recent);
  assert.deepEqual(manager.deleteTransmissions([ids.recent, 9999]), { deleted: 1, bytes: 1500 });
  assert.equal(store.transmission(ids.recent), undefined);
  assert.deepEqual(store.transcripts(ids.recent), [], 'no orphaned transcript');
  assert.equal(existsSync(join(clips, `${t.started_at}.wav`)), false);
  assert.equal(existsSync(join(clips, `${t.started_at}.16k.wav`)), false);
  assert.deepEqual(updates.at(-1), { type: 'deleted', ids: [ids.recent] });
});

test('a clip deleted while queued or being transcribed gets no transcript back', { skip: !sqlite }, async () => {
  const { manager, store, ids, updates, release } = await setup();
  manager.enqueue({ priority: 0, id: ids.pending, engineName: 'base', wav: 'x.wav' });   // running now
  manager.enqueue({ priority: 1, id: ids.recent, engineName: 'base', wav: 'y.wav' });    // waiting
  await new Promise((r) => setImmediate(r));
  manager.deleteTransmissions([ids.pending, ids.recent]);
  assert.equal(manager.jobs.length, 0, 'the waiting job was dropped');
  release();
  await manager.pump();
  assert.deepEqual(store.transcripts(ids.pending), [], 'the running one saved nothing');
  assert.ok(!updates.some((u) => u.type === 'transmission' && u.id === ids.pending), 'and announced nothing');
});

test('keeping N days: off until set, then deletes what is older, and says what it did', { skip: !sqlite }, async () => {
  const { cleanup, store, ids } = await setup();
  assert.equal(cleanup.sweep(), null, 'off by default');
  assert.equal(store.countTransmissions(), 5);
  assert.throws(() => cleanup.setRetentionDays(0), /1 to 36500/);
  assert.throws(() => cleanup.setRetentionDays('a week'), /1 to 36500/);
  cleanup.setRetentionDays('2');
  assert.equal(cleanup.retentionDays(), 2);
  const r = cleanup.sweep();
  assert.deepEqual({ ...r }, { at: NOW, days: 2, deleted: 2, bytes: 3000 });
  assert.equal(store.hasTransmission(ids.old), false);
  assert.equal(store.hasTransmission(ids.recentChirp), true);
  assert.deepEqual(cleanup.report().lastSweep, r);
  cleanup.setRetentionDays('');
  assert.equal(cleanup.retentionDays(), null, 'blank keeps everything again');
});

test('the storage report counts what is kept', { skip: !sqlite }, async () => {
  const { cleanup } = await setup();
  const r = cleanup.report();
  assert.equal(r.count, 5);
  assert.equal(r.oldest, NOW - 5 * DAY);
  assert.equal(r.clipBytes, 5 * 1500);
  assert.ok(r.databaseBytes > 0);
  assert.equal(r.retentionDays, null);
});

test("whisper.cpp's stored [BLANK_AUDIO] is cleaned when the database opens", { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const file = join(mkdtempSync(join(tmpdir(), 'airscribe-blank-')), 'a.sqlite');
  let s = new Store(file, 'base');
  const id = s.addTransmission({ mac: MAC, startedAt: 1, durationMs: 500, audioFile: 'a.wav' });
  s.saveTranscript(id, 'base', { status: 'done', text: ' [BLANK_AUDIO]' });
  s.close();
  s = new Store(file, 'base');
  assert.equal(s.transcripts(id)[0].text, '');
  assert.equal(s.countTransmissions({ speech: true }), 0, 'so it counts as no speech');
});

test('the API: deleting and Admin → Storage are for admins only', { skip: !sqlite }, async () => {
  const { store, manager, cleanup, ids } = await setup();
  const { createApp } = await import('../src/api.js');
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'admin' }, { token: 'viewer', role: 'viewer' }] } };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.', cleanup });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, path, token, body) => fetch(`${base}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  try {
    assert.equal((await call('DELETE', `/transmissions/${ids.recent}`, 'viewer')).status, 403);
    assert.equal((await call('POST', '/admin/storage/delete', 'viewer', { noSpeech: true })).status, 403);
    assert.equal((await call('GET', '/admin/storage', 'viewer')).status, 403);
    assert.equal(store.countTransmissions(), 5, 'a viewer deleted nothing');

    assert.deepEqual(await (await call('DELETE', `/transmissions/${ids.recent}`, 'admin')).json(), { deleted: 1, bytes: 1500 });
    assert.equal((await call('DELETE', `/transmissions/${ids.recent}`, 'admin')).status, 404, 'gone is 404');
    assert.equal((await call('POST', '/admin/storage/preview', 'admin', {})).status, 400);
    assert.equal((await (await call('POST', '/admin/storage/preview', 'admin', { noSpeech: true })).json()).count, 2);
    assert.equal((await (await call('POST', '/admin/storage/delete', 'admin', { noSpeech: true })).json()).deleted, 2);
    const kept = await (await call('PUT', '/admin/storage/retention', 'admin', { days: 30 })).json();
    assert.equal(kept.retentionDays, 30);
    assert.equal((await call('PUT', '/admin/storage/retention', 'admin', { days: -1 })).status, 400);
    const page = await call('GET', '/transmissions?speech=1', 'viewer');
    assert.equal(page.headers.get('x-total-count'), '2', 'the old one with speech, and the pending one');
  } finally {
    server.close();
  }
});
