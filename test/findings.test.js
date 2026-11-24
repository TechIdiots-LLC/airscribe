import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { compact, matchTerm, parseReply, tidy, words } from '../src/findings.js';

// node:sqlite arrived in Node 22.5; on older Node the Store-backed tests report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);

test('terms match however the radio and the model wrote them', () => {
  assert.equal(words('412 Elm St.'), '412 elm street');
  assert.equal(compact('ABC-123'), 'abc123');
  const found = tidy({ addresses: ['412 Elm Street'], roads: ['Elm Street'], plates: ['abc 123'], units: ['Car 12'] });
  assert.deepEqual(found.plates, ['ABC123'], 'a plate is letters and digits');
  assert.deepEqual(matchTerm('Elm St', '', found), { field: 'addresses', value: '412 Elm Street' });
  assert.deepEqual(matchTerm('abc-123', '', found), { field: 'plates', value: 'ABC123' });
  // A plate spelled out letter by letter in the transcript itself
  assert.equal(matchTerm('XYZ789', 'plate x y z 7 8 9 on a gray sedan', null).field, 'transcript');
  assert.equal(matchTerm('Elm', 'helm of the boat', null), null, 'whole words only');
  assert.equal(matchTerm('main street', 'units to Main St and Route 9', null).field, 'transcript');
  assert.equal(matchTerm('   ', 'anything', null), null);
});

test('a reply is held to the shape, whatever the model sent', () => {
  assert.deepEqual(parseReply('<think>hmm</think>```json\n{"summary":"x"}\n```'), { summary: 'x' });
  assert.throws(() => parseReply('I cannot help with that.'), /didn’t answer with JSON/);
  const t = tidy({ summary: 5, plates: ['A', 'abc123', 'ABC 123', 'x'.repeat(20)], people: 'Bob', roads: ['Elm St', 'elm st'] });
  assert.equal(t.summary, '');
  assert.deepEqual(t.plates, ['ABC123'], 'too short, a repeat and too long are dropped');
  assert.deepEqual(t.people, []);
  assert.deepEqual(t.roads, ['Elm St'], 'one of each');
  assert.equal(t.service, 'other', 'no service said: other');
  assert.deepEqual(['Police', 'Law Dispatch', 'public works', 'Ham', 'EMS', 'fire'].map((s) => tidy({ service: s }).service),
    ['police', 'police', 'works', 'amateur', 'ems', 'fire']);
  for (const k of ['addresses', 'vehicles', 'units']) assert.deepEqual(t[k], []);
});

/** A Store with transmissions on one channel, and Findings over it with a fake model and webhook. */
async function setUp({ answer, fail } = {}) {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const store = new Store(':memory:', 'base');
  const manager = new EventEmitter();
  const calls = [];
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, headers: opts.headers });
    if (url.startsWith('https://hook.invalid')) return new Response('{}');
    if (fail) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
    return Response.json({ message: { role: 'assistant', content: JSON.stringify(answer ?? {}) } });
  };
  let clock = 1_800_000_000_000;
  const findings = new Findings({ store, manager, primary: 'base', fetch, now: () => clock });
  const say = (text, at, channel = 'Holden PD') => {
    const id = store.addTransmission({ mac: 'AA:BB', startedAt: at, durationMs: 4000, audioFile: `${at}.wav`, channelName: channel });
    store.saveTranscript(id, 'base', { status: 'done', text });
    return id;
  };
  return { store, manager, findings, calls, say, tick: (ms) => (clock += ms), clock: () => clock };
}

test('a transcript is read with its channel’s last minutes, and watches catch what was found', { skip: !sqlite }, async () => {
  const answer = {
    summary: 'Two-car crash at 412 Elm Street', incident: 'motor vehicle crash',
    addresses: ['412 Elm Street'], roads: ['Elm Street'], plates: ['ABC123'], vehicles: ['Honda'], people: [], units: ['Car 12'],
  };
  const { store, manager, findings, calls, say, clock } = await setUp({ answer });
  findings.start();
  try {
    const earlier = say('Car 12 go ahead', clock() - 60_000);
    say('Unrelated traffic on another channel', clock() - 30_000, 'Paxton FD');
    const id = say('Car 12 respond to four twelve elm for a two car MVA plate Adam Boy Charlie one two three', clock());

    // Off: nothing is sent anywhere
    manager.emit('transcribed', { id, engine: 'base', status: 'done' });
    await findings.drain();
    assert.equal(calls.length, 0);

    assert.throws(() => findings.save({ enabled: true }), /address before turning it on/);
    findings.save({ enabled: true, url: 'http://llm.invalid:11434/', webhook: 'https://hook.invalid/x', apiKey: 'k' });
    assert.equal(findings.settings().url, 'http://llm.invalid:11434', 'the trailing slash is dropped');
    assert.equal(findings.settings().apiKey, true, 'the key is never sent back');
    findings.addWatch({ term: 'abc 123', note: 'the stolen Honda' });
    findings.addWatch({ term: 'Elm St' });
    findings.addWatch({ term: 'Paxton' });

    manager.emit('transcribed', { id: earlier, engine: 'other', status: 'done' });   // not the default engine
    manager.emit('transcribed', { id, engine: 'base', status: 'done' });
    await findings.drain();

    const model = calls.filter((c) => c.url.startsWith('http://llm.invalid'));
    assert.equal(model.length, 1);
    assert.equal(model[0].url, 'http://llm.invalid:11434/api/chat');
    assert.equal(model[0].body.think, false);
    assert.equal(model[0].body.format.type, 'object', 'the schema goes with it');
    assert.equal(model[0].headers.Authorization, 'Bearer k');
    const user = model[0].body.messages[1].content;
    assert.match(user, /Earlier on this channel:\n- Car 12 go ahead/);
    assert.doesNotMatch(user, /another channel/, 'only this channel’s traffic is context');
    assert.doesNotMatch(user, /static/, 'a clear signal isn’t called static');

    const [r] = findings.results({});
    assert.equal(r.id, id);
    assert.equal(r.sent, user, 'what was sent is kept');
    assert.equal(r.static, false);
    assert.deepEqual(r.found.plates, ['ABC123']);
    assert.deepEqual(r.hits.map((h) => [h.term, h.field]).sort(), [['Elm St', 'addresses'], ['abc 123', 'plates']]);
    assert.equal(findings.results({ q: 'abc 123' }).length, 1, 'a plate is found however it’s spaced');
    assert.equal(findings.results({ q: 'nothing like it' }).length, 0);
    assert.equal(findings.results({ hits: true }).length, 1);

    const hooks = calls.filter((c) => c.url.startsWith('https://hook.invalid'));
    assert.equal(hooks.length, 2, 'one post for each watch that matched');
    assert.equal(hooks.find((h) => h.body.term === 'abc 123').body.note, 'the stolen Honda');
    assert.equal(hooks[0].body.transmission.summary, 'Two-car crash at 412 Elm Street');

    // Read again: the same match isn't posted twice
    await findings.read(id);
    assert.equal(calls.filter((c) => c.url.startsWith('https://hook.invalid')).length, 2);

    // A deleted transmission's findings go at the next sweep
    store.db.prepare('DELETE FROM transmissions WHERE id = ?').run(id);
    findings.sweep();
    assert.equal(findings.settings().counts.findings, 0);
    assert.equal(findings.settings().counts.hits, 0);
  } finally {
    findings.stop();
  }
});

test('a clip heard through static is still read, and the model is told so', { skip: !sqlite }, async () => {
  const { store, findings, calls, say, clock } = await setUp({ answer: { summary: 'Engine 2 to Main' } });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  const earlier = say('copy that engine two', clock() - 60_000);
  store.setQuality(earlier, 2);
  const id = say('engine 2 to main st for smoke showing', clock());
  store.setQuality(id, 3);
  await findings.read(id);
  const user = calls[0].body.messages[1].content;
  assert.match(user, /- \(heard through static\) copy that engine two/);
  assert.match(user, /New transmission, heard through static/);
  assert.match(calls[0].body.messages[0].content, /heard through static came in weak/);
  assert.equal(findings.results({})[0].static, true);
});

test('with the model down, the error is kept and watches still see the transcript', { skip: !sqlite }, async () => {
  const { findings, say, clock, tick } = await setUp({ fail: true });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434', keepDays: 2 });
  findings.addWatch({ term: 'Main Street' });
  const id = say('engine 2 to main st for smoke showing', clock());
  // Too little said to be worth asking about
  const beep = say('(beeping)', clock());
  assert.equal(findings.backfill(1).queued, 2);
  await findings.drain();
  const row = findings.db.prepare('SELECT status, error FROM findings WHERE transmission_id = ?').get(id);
  assert.equal(row.status, 'error');
  assert.match(row.error, /can’t reach http:\/\/llm\.invalid:11434: ECONNREFUSED/);
  assert.equal(findings.db.prepare('SELECT count(*) AS n FROM findings WHERE transmission_id = ?').get(beep).n, 0);
  assert.deepEqual(findings.db.prepare('SELECT term, field FROM finding_hits').all().map((h) => ({ ...h })),
    [{ term: 'Main Street', field: 'transcript' }]);
  assert.match(findings.settings().lastError.error, /ECONNREFUSED/);
  // Past keepDays they go
  tick(3 * 86_400_000);
  findings.sweep();
  assert.equal(findings.settings().counts.findings, 0);
  assert.equal(findings.settings().counts.hits, 0);
  assert.equal(findings.watches().length, 1, 'the watch list stays');
});

test('an OpenAI-style server is asked the OpenAI way', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return Response.json({ choices: [{ message: { content: '{"summary":"ok","plates":["xyz 9"]}' } }] });
  };
  const findings = new Findings({ store: new Store(':memory:', 'base'), fetch });
  findings.save({ api: 'openai', url: 'http://server.invalid', model: 'gpt-x' });
  const t = await findings.test('hello there');
  assert.equal(seen[0].url, 'http://server.invalid/v1/chat/completions');
  assert.equal(seen[0].body.response_format.type, 'json_schema');
  assert.deepEqual([t.model, t.found.summary, t.found.plates], ['gpt-x', 'ok', ['XYZ9']]);
  assert.throws(() => findings.save({ api: 'other' }), /ollama or openai/);
  assert.throws(() => findings.save({ url: 'ftp://x' }), /http:\/\/ or https:\/\//);
});

test('signed-in users read Findings, only an admin changes it, the public neither', { skip: !sqlite }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Store } = await import('../src/store.js');
  const { Accounts } = await import('../src/accounts.js');
  const { Findings } = await import('../src/findings.js');
  const { createApp } = await import('../src/api.js');
  const store = new Store(':memory:', 'base');
  const accounts = new Accounts(new DatabaseSync(':memory:'));
  accounts.create({ username: 'alice', password: 'correct horse', role: 'admin' });
  accounts.create({ username: 'bob', password: 'battery staple', role: 'viewer' });
  const manager = Object.assign(new EventEmitter(), { radios: () => [] });
  const { Roads } = await import('../src/roads.js');
  const findings = new Findings({ store, manager, roads: new Roads({ store }) });
  const app = createApp({ manager, store, sidecar: {}, config: { host: '127.0.0.1', twoStep: { required: false }, auth: {} }, dataDir: '.', accounts, findings });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const as = async (username, password) => {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return (method, path, body) => fetch(`${base}${path}`, {
      method, body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', cookie },
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  };
  try {
    for (const path of ['/admin/findings', '/findings', '/findings/results', '/findings/watches', '/findings/map']) {
      assert.equal((await fetch(`${base}${path}`)).status, 401, `${path}: not without signing in`);
    }
    const bob = await as('bob', 'battery staple');
    const seen = await bob('GET', '/findings');
    assert.equal(seen.status, 200, 'a viewer reads it');
    assert.ok(!('url' in seen.body) && !('lastError' in seen.body), 'but not where it sends');
    assert.match(seen.body.instructions, /radio traffic/);
    assert.equal((await bob('GET', '/findings/results')).status, 200);
    assert.equal((await bob('GET', '/findings/watches')).status, 200);
    assert.equal((await bob('GET', '/findings/map')).status, 200, 'and the roads it mentioned');
    assert.equal((await bob('GET', '/admin/findings')).status, 403, 'not its settings');
    assert.equal((await bob('POST', '/admin/findings/watches', { term: 'x' })).status, 403, 'nor the watch list');
    assert.equal((await bob('DELETE', '/admin/findings/roads')).status, 403);
    const alice = await as('alice', 'correct horse');
    const s = await alice('PUT', '/admin/findings', { url: 'http://llm.invalid:11434', model: 'qwen3:8b', apiKey: 'secret' });
    assert.equal(s.status, 200);
    assert.equal(s.body.apiKey, true);
    assert.ok(!JSON.stringify(s.body).includes('secret'), 'the key never comes back');
    const w = await alice('POST', '/admin/findings/watches', { term: 'Elm St' });
    assert.equal(w.body.term, 'Elm St');
    assert.equal((await alice('GET', '/admin/findings/watches')).body.length, 1);
    assert.equal((await alice('DELETE', `/admin/findings/watches/${w.body.id}`)).status, 200);
    assert.equal((await alice('DELETE', `/admin/findings/watches/${w.body.id}`)).status, 404);
    assert.equal((await alice('POST', '/admin/findings/backfill', { hours: 1 })).status, 400, 'not while it’s off');

    // Roads: a file as the body, read as it arrives
    const cookie = (await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
    const feature = { type: 'Feature', properties: { highway: 'residential', name: 'Elm Street' }, geometry: { type: 'LineString', coordinates: [[-71.86, 42.35], [-71.85, 42.351]] } };
    const up = await fetch(`${base}/admin/findings/roads?name=town.geojsonseq`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', cookie }, body: `${JSON.stringify(feature)}\n` });
    assert.equal(up.status, 200);
    assert.equal((await up.json()).ways, 1);
    assert.equal((await alice('GET', '/admin/findings/roads')).body.source.name, 'town.geojsonseq');
    assert.equal((await alice('GET', '/admin/findings/map?hours=24')).body.ways, 1);
    assert.equal((await alice('PUT', '/admin/findings/roads', { not: 'a file' })).status, 415);
    assert.equal((await alice('DELETE', '/admin/findings/roads')).body.ways, 0);
  } finally {
    server.close();
  }
});
