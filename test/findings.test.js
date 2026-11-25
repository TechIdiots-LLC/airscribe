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
    assert.match(user, /Meanwhile on other channels:\n- \[Paxton FD, under a minute before\] Unrelated traffic on another channel/);
    assert.doesNotMatch(user.split('Earlier on this channel')[1], /another channel/, 'kept apart from this channel’s');
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

test('read once every engine is done, with the other engines and radios as other readings', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const store = new Store(':memory:', 'base');
  const manager = new EventEmitter();
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Response.json({ message: { content: '{"summary":"x"}' } });
  };
  const findings = new Findings({ store, manager, primary: 'base', engines: ['ov'], fetch });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  findings.start();
  try {
    const at = Date.now();
    const tx = (mac, channelName, s, offset = 0) => store.addTransmission({ mac, startedAt: at + offset, durationMs: 4000,
      audioFile: `${mac}${offset}.wav`, channelName, channelHz: 453875000 });
    const id = tx('AA', 'Regional Police Operations');
    const copy = tx('BB', 'Rutld Reg2', '', 1500);
    store.saveTranscript(copy, 'base', { status: 'done', text: 'mileage 3 4 7 9 5' });
    // The default engine heard nothing; it waits for the other
    store.saveTranscript(id, 'base', { status: 'done', text: '[BLANK_AUDIO]' });
    manager.emit('transcribed', { id, engine: 'base', status: 'done' });
    await findings.drain();
    assert.equal(calls.length, 0, 'not before every engine is done');
    store.saveTranscript(id, 'ov', { status: 'done', text: 'Marry mileage, 3-4-7-9-5, 2-1-31.' });
    manager.emit('transcribed', { id, engine: 'ov', status: 'done' });
    await findings.drain();
    assert.equal(calls.length, 1);
    const user = calls[0].messages[1].content;
    assert.match(user, /New transmission:\nMarry mileage, 3-4-7-9-5, 2-1-31\./, 'the engine that heard something');
    assert.match(user, /Other readings of the new transmission:\n- another radio on the same frequency \(Rutld Reg2\): mileage 3 4 7 9 5/);
    assert.doesNotMatch(user, /Meanwhile on other channels/, 'the copy isn’t other traffic');

    // The default engine heard nothing and only one other did, with no other radio: noise made words, not read
    const lone = tx('AA', 'West Dispatch', '', 60_000);
    store.saveTranscript(lone, 'base', { status: 'done', text: '' });
    store.saveTranscript(lone, 'ov', { status: 'done', text: 'May Street in him' });
    manager.emit('transcribed', { id: lone, engine: 'ov', status: 'done' });
    manager.emit('transcribed', { id: lone, engine: 'base', status: 'done' });
    await findings.drain();
    assert.equal(calls.length, 1);
  } finally {
    findings.stop();
  }
});

test('a call heard by two radios is read once, the other attached', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const store = new Store(':memory:', 'base');
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Response.json({ message: { content: '{"summary":"Car 12 out at Walmart","plates":["ABC123"]}' } });
  };
  const findings = new Findings({ store, primary: 'base', fetch });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  findings.addWatch({ term: 'Rutland' });
  const at = Date.now();
  const tx = (mac, channelName, text, offset = 0, hz = 453875000) => {
    const id = store.addTransmission({ mac, startedAt: at + offset, durationMs: 4000, audioFile: `${mac}${offset}.wav`,
      channelName, channelHz: hz });
    if (text) store.saveTranscript(id, 'base', { status: 'done', text });
    return id;
  };
  // Both heard before either is read: the first read has the other's words, the second is only attached
  const a = tx('AA', 'Regional Police Operations', 'car twelve out at walmart plate adam boy charlie one two three');
  const b = tx('BB', 'Rutld Reg2', 'car twelve out at walmart in rutland', 1500);
  await findings.read(a);
  await findings.read(b);
  await findings.drain();
  assert.equal(calls.length, 1, 'read once');
  assert.match(calls[0].messages[1].content, /another radio on the same frequency \(Rutld Reg2\): car twelve out at walmart in rutland/);
  let [r, ...rest] = findings.results({});
  assert.equal(rest.length, 0, 'one finding for the call');
  assert.equal(r.id, a);
  assert.deepEqual(r.copies.map((c) => [c.id, c.channel, c.text]), [[b, 'Rutld Reg2', 'car twelve out at walmart in rutland']]);
  assert.deepEqual(r.hits.map((h) => h.term), ['Rutland'], 'the watches see the copy’s words');
  assert.equal(findings.results({ q: 'rutland' })[0]?.id, a, 'found by what the copy heard');
  assert.equal(findings.settings().counts.findings, 1);
  assert.equal(findings.backfill(1).queued, 0, 'the copy isn’t read later either');

  // The copy's words came after the first was read: the first is read again, with them
  const c = tx('AA', 'Regional Police Operations', 'engine four on scene at the walmart', 60_000);
  const d = tx('BB', 'Rutld Reg2', null, 61_000);
  await findings.read(c);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].messages[1].content, /another radio/);
  store.saveTranscript(d, 'base', { status: 'done', text: 'engine four on scene walmart lot two' });
  await findings.read(d);
  await findings.drain();
  assert.equal(calls.length, 3, 'the first again, not the copy');
  assert.match(calls[2].messages[1].content, /New transmission:\nengine four on scene at the walmart/);
  assert.match(calls[2].messages[1].content, /another radio on the same frequency \(Rutld Reg2\): engine four on scene walmart lot two/);
  [r] = findings.results({});
  assert.equal(r.id, c);
  assert.deepEqual(r.copies.map((x) => x.id), [d]);

  // Another frequency is another call
  const e = tx('BB', 'Rutld Reg2', 'engine four clear', 62_000, 460000000);
  await findings.read(e);
  assert.equal(calls.length, 4);

  // Within the seconds set, but after this one ended: the next call on the frequency, not a copy
  findings.save({ sameCallSeconds: 30 });
  const f = tx('AA', 'Regional Police Operations', 'thanks a lot', 120_000);
  tx('BB', 'Rutld Reg2', 'contact kimberly about the dog', 129_000);
  await findings.read(f);
  assert.equal(calls.length, 5);
  assert.doesNotMatch(calls[4].messages[1].content, /kimberly/);
});

test('what goes with each transmission is set on the Admin page', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const store = new Store(':memory:', 'base');
  const manager = new EventEmitter();
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Response.json({ message: { content: '{"summary":"x"}' } });
  };
  const findings = new Findings({ store, manager, primary: 'base', engines: ['ov'], fetch });
  const s = findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  assert.deepEqual([s.contextMinutes, s.contextCount, s.othersCount, s.sameCallSeconds, s.waitMinutes], [5, 5, 5, 5, 3]);
  assert.throws(() => findings.save({ contextCount: 21 }), /0 to 20/);
  assert.throws(() => findings.save({ contextMinutes: 0 }), /1 to 30 minutes/);
  assert.throws(() => findings.save({ waitMinutes: 1.5 }), /0 to 30 minutes/);
  findings.save({ contextMinutes: 2, contextCount: 1, othersCount: 0, sameCallSeconds: 0, waitMinutes: 0 });
  findings.start();
  try {
    const at = Date.now();
    const tx = (mac, channelName, text, offset) => {
      const id = store.addTransmission({ mac, startedAt: at + offset, durationMs: 4000, audioFile: `${mac}${offset}.wav`,
        channelName, channelHz: 453875000 });
      store.saveTranscript(id, 'base', { status: 'done', text });
      return id;
    };
    tx('AA', 'Fire', 'too long ago to give', -3 * 60_000);
    tx('AA', 'Fire', 'engine two respond', -90_000);
    tx('AA', 'Fire', 'engine two en route', -60_000);
    tx('AA', 'Police', 'car twelve on scene', -30_000);
    tx('BB', 'Other radio', 'engine two on scene now', 1000);
    const id = tx('AA', 'Fire', 'engine two on scene', 0);
    // Not waiting for the other engine
    manager.emit('transcribed', { id, engine: 'base', status: 'done' });
    await findings.drain();
    assert.equal(calls.length, 1);
    manager.emit('transcribed', { id, engine: 'ov', status: 'done' });
    await findings.drain();
    assert.equal(calls.length, 1, 'read once');
    const user = calls[0].messages[1].content;
    assert.match(user, /Earlier on this channel:\n- engine two en route\n\n/, 'the last one, in two minutes');
    assert.doesNotMatch(user, /respond|too long ago/);
    assert.doesNotMatch(user, /Meanwhile on other channels/);
    assert.doesNotMatch(user, /another radio/);
  } finally {
    findings.stop();
  }
});

test('earlier findings go with each transmission, and a later one can correct them', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const store = new Store(':memory:', 'base');
  const answers = [];
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return Response.json({ message: { content: JSON.stringify(answers.shift() ?? {}) }, prompt_eval_count: 812, eval_count: 64 });
  };
  let clock = 1_800_000_000_000;
  const findings = new Findings({ store, primary: 'base', fetch, now: () => clock });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  const say = (text, at, channel) => {
    const id = store.addTransmission({ mac: 'AA', startedAt: at, durationMs: 4000, audioFile: `${at}.wav`, channelName: channel });
    store.saveTranscript(id, 'base', { status: 'done', text });
    return id;
  };
  findings.addWatch({ term: 'ABC 123' });
  const old = say('car nine, too long ago to matter', clock - 20 * 60_000, 'Holden PD');
  answers.push({ summary: 'Old call', units: ['Car 9'] });
  await findings.read(old);
  const first = say('car twelve stop on twelve main plate adam boy charlie one two eight', clock - 3 * 60_000, 'Holden PD');
  answers.push({ summary: 'Car 12 traffic stop on Main St', addresses: ['12 Main St'], plates: ['ABC128'], units: ['Car 12'] });
  await findings.read(first);
  const quiet = say('copy that', clock - 2 * 60_000, 'Holden FD');
  answers.push({ summary: '' });
  await findings.read(quiet);

  const next = say('correction one twelve main and the plate is adam boy charlie one two three', clock - 60_000, 'Holden PD');
  answers.push({
    summary: 'Car 12 corrects the address and plate', addresses: ['112 Main St'], plates: ['ABC123'],
    corrections: [
      { finding: first, field: 'addresses', was: '12 Main Street', now: '112 Main St' },
      { finding: first, field: 'plates', was: 'ABC 128', now: 'ABC 123' },
      { finding: old, field: 'units', was: 'Car 9', now: 'Car 19' },          // not shown to the model: ignored
      { finding: first, field: 'vehicles', was: 'blue Ford', now: 'red Ford' }, // not in that finding: ignored
    ],
  });
  await findings.read(next);
  const user = calls[3].messages[1].content;
  assert.match(user, new RegExp(`Earlier findings:\\n- finding ${first} \\[Holden PD, 2 min before\\] Car 12 traffic stop on Main St; ` +
    'addresses: 12 Main St; plates: ABC128; units: Car 12\\n'));
  assert.doesNotMatch(user, /Old call|finding \d+ \[Holden FD/, 'too old, or nothing found');

  const rows = Object.fromEntries(findings.results({}).map((r) => [r.id, r]));
  assert.deepEqual(rows[first].found.addresses, ['112 Main St']);
  assert.deepEqual(rows[first].found.plates, ['ABC123']);
  assert.deepEqual(rows[first].correctedBy.map((c) => [c.id, c.field, c.was, c.now]),
    [[next, 'addresses', '12 Main St', '112 Main St'], [next, 'plates', 'ABC128', 'ABC123']]);
  assert.deepEqual(rows[next].corrects.map((c) => c.id), [first, first]);
  assert.deepEqual(rows[old].found.units, ['Car 9']);
  assert.deepEqual(rows[first].hits.map((h) => h.term), ['ABC 123'], 'the corrected plate is one watched for');
  assert.deepEqual(rows[next].usage, { prompt: 812, answer: 64, ms: 0 });
  assert.equal(findings.settings().biggestPrompt, 812);
  const original = JSON.parse(store.db.prepare('SELECT original FROM findings WHERE transmission_id = ?').get(first).original);
  assert.deepEqual(original.plates, ['ABC128'], 'what was first found is kept');

  // None: no earlier findings in the prompt
  findings.save({ findingsCount: 0 });
  answers.push({ summary: 'x' });
  await findings.read(say('car twelve clear', clock, 'Holden PD'));
  assert.doesNotMatch(calls[4].messages[1].content, /Earlier findings/);

  // Those made from a moment on, in the order made: what Speak new findings reads out
  assert.equal(findings.status().latestAt, clock);
  clock += 1000;
  answers.push({ summary: 'y' });
  const later = say('engine two clear', clock - 5 * 60_000, 'Holden FD');
  await findings.read(later);
  const made = findings.results({ after: findings.status().latestAt });
  assert.deepEqual(made.map((r) => [r.id, r.madeAt]), [[later, clock]], 'by when it was made, not when it was heard');
});

test('another channel’s finding goes with a transmission only when it names a unit, road or address said', { skip: !sqlite }, async () => {
  const { store, findings, calls, say, clock } = await setUp();
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  const done = (id, found) => store.db.prepare(`INSERT INTO findings (transmission_id, status, result, created_at)
    VALUES (?, 'done', ?, ?)`).run(id, JSON.stringify({ summary: 's', ...found }), clock());
  const ham = say('thanksgiving plans', clock() - 120_000, 'Marlboro W');
  done(ham, { summary: 'A ham talks about stuffing', people: ['Verma'] });
  const domestic = say('domestic', clock() - 100_000, 'PD F1 East');
  done(domestic, { summary: 'A domestic dispute', addresses: ['520 South Ridge Street'] });
  const dispatch = say('engine two respond', clock() - 90_000, 'Fire Dispatch');
  done(dispatch, { summary: 'Engine 2 sent to a fire alarm', units: ['Engine 2'] });
  const before = say('engine two go ahead', clock() - 60_000);
  done(before, { summary: 'Engine 2 checks in', units: ['Engine 2'] });
  await findings.read(say('Engine 2 on scene, nothing showing', clock(), 'Fireground'));
  const user = calls[0].body.messages[1].content;
  assert.match(user, new RegExp(`finding ${dispatch} \\[Fire Dispatch`), 'the same unit, sent on dispatch');
  assert.match(user, new RegExp(`finding ${before} \\[Holden PD`));
  assert.doesNotMatch(user, /stuffing|domestic dispute/, 'calls that share nothing with it');
});

test('a channel’s service is the model’s to go by, and holds over a guess of ham or other', { skip: !sqlite }, async () => {
  const { serviceByName } = await import('../src/findings.js');
  assert.deepEqual(['Holden PD', 'Holden Fir', 'W1EMC Sout', 'EMS Citywide - EMS Dispatch', 'C8 Fire/EMS Dispatch', 'Rutld Reg2']
    .map(serviceByName), ['police', 'fire', 'amateur', 'ems', null, null], 'a name that says two says nothing');
  // "Sierra Alpha" on a fire channel read as a ham, as it was
  const { store, findings, calls, say, clock, tick } = await setUp({ answer: { summary: 'x', service: 'amateur' } });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  await findings.read(say('Sierra Alpha 762-1400, copy one', clock(), 'Holden Fir'));
  assert.match(calls[0].body.messages[1].content, /^Channel: Holden Fir \(a fire channel\)\n/);
  assert.equal(findings.results({})[0].found.service, 'fire');
  // A channel its name says nothing about: what its findings mostly said, once there are enough
  const done = (n, s) => {
    for (let i = 0; i < n; i++) {
      const id = say(`traffic ${s} ${i}`, clock() - 1000 * (i + 10), 'Rutld Reg2');
      store.db.prepare("INSERT INTO findings (transmission_id, status, result, created_at) VALUES (?, 'done', ?, ?)")
        .run(id, JSON.stringify({ summary: 's', service: s }), clock());
    }
  };
  done(4, 'fire');
  assert.equal(findings.channelService('Rutld Reg2'), null, 'four is too few');
  done(1, 'amateur');
  done(2, 'fire');
  tick(10 * 60_000);
  assert.deepEqual(findings.channelService('Rutld Reg2'), { service: 'fire', from: 'usual' });
  // Uniden's database over the name
  store.db.exec(`CREATE TABLE IF NOT EXISTS uniden_entries (key TEXT, func INTEGER)`);
  store.db.prepare('INSERT INTO uniden_entries (key, func) VALUES (?, 13)').run('holden pd');
  tick(10 * 60_000);
  assert.deepEqual(findings.channelService('Holden PD'), { service: 'amateur', from: 'uniden' });
});

test('findings can be had for one channel, or one radio', { skip: !sqlite }, async () => {
  const { store, findings, say, clock } = await setUp({ answer: { summary: 'x' } });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  await findings.read(say('one here', clock() - 2000, 'Holden PD'));
  await findings.read(say('two here', clock() - 1000, 'Paxton FD'));
  const other = store.addTransmission({ mac: 'CC:DD', startedAt: clock(), durationMs: 1, audioFile: 'c.wav', channelName: 'Paxton FD' });
  store.saveTranscript(other, 'base', { status: 'done', text: 'three here' });
  await findings.read(other);
  assert.deepEqual(findings.results({ channel: 'Paxton FD' }).map((r) => r.text), ['three here', 'two here']);
  assert.deepEqual(findings.results({ radio: 'CC:DD' }).map((r) => r.text), ['three here']);
  assert.deepEqual(findings.results({ radio: 'AA:BB', channel: 'Paxton FD' }).map((r) => r.text), ['two here']);
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

test('a plate spelled out is given to the model, and kept when it leaves it out', { skip: !sqlite }, async () => {
  // What qwen3:8b made of it: the letters as a road, the plate dropped
  const { findings, calls, say, clock } = await setUp({ answer: { summary: 'An Audi A3', vehicles: ['Audi A3'], roads: ['Sierra Street'] } });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  findings.addWatch({ term: '4SSR33' });
  const id = say("It's going to be an Audi A3, Mass Reg 4, Sierra, Sierra, Romeo 33.", clock());
  await findings.read(id);
  assert.match(calls[0].body.messages[1].content, /Plates spelled out in it: 4SSR33$/);
  assert.match(calls[0].body.messages[0].content, /are letters, not roads or people/);
  const [r] = findings.results({});
  assert.deepEqual(r.found.plates, ['4SSR33']);
  assert.equal(r.hits[0]?.field, 'plates', 'a watch for it matches');
});

test('a plate the model says is misheard is heard again, told the alphabet, and read again once', { skip: !sqlite }, async () => {
  const { store, manager, findings, calls, say, clock } = await setUp({ answer: { summary: 'Car 12 runs a plate', again: 'plate' } });
  const asked = [];
  manager.engines = new Map([['base', { prompts: true }], ['sherpa', {}]]);
  manager.hearAgain = (o) => (asked.push(o), true);
  findings.start();
  try {
    findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
    assert.throws(() => findings.save({ againEngine: 'sherpa' }), /takes a prompt/);
    assert.deepEqual(findings.settings().againEngines, ['base']);
    const id = say('car twelve running plate adam boy charlie one', clock());
    await findings.read(id);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].as, 'base+again1');
    assert.match(asked[0].prompt, /^Copy\. En route\. Received\. Plate Alpha Bravo .* Zulu, 1 2 3/);
    assert.equal(findings.results({})[0].heardAgain, 'plate');

    // Heard again: read again with it, and not sent a second time
    store.saveTranscript(id, 'base+again1', { status: 'done', text: 'car twelve running plate adam boy charlie one two three' });
    manager.emit('transcribed', { id, engine: 'base+again1', status: 'done' });
    await findings.drain();
    assert.match(calls[1].body.messages[1].content, /- heard again, told which words to expect \(so it may lean to them\): car twelve/);
    assert.match(calls[1].body.messages[1].content, /Plates spelled out in it: ABC1, ABC123/);
    assert.equal(asked.length, 1, 'once, as set');

    // A road with no roads near to tell it: hearing it again would hear the same
    findings.save({ againTimes: 2 });
    assert.equal(findings.hearAgain(id, { again: 'road' }, ['x'], []), null);
    findings.save({ againTimes: 0 });
    assert.equal(findings.hearAgain(id, { again: 'plate' }, ['x'], []), null);
  } finally {
    findings.stop();
  }
});

test('the export holds what was sent, every engine’s transcript and what came of it, never where it was sent', { skip: !sqlite }, async () => {
  const { store, findings, say, clock } = await setUp({ answer: { summary: 'Engine 2 en route', units: ['Engine 2'], addresses: ['20 Elm Street'] } });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434', apiKey: 'secret', webhook: 'https://hook.invalid/x' });
  const id = say('Engine 2 en route', clock());
  store.saveTranscript(id, 'tiny', { status: 'done', text: 'engine to en route' });
  await findings.read(id);
  findings.read(say('other channel traffic here', clock(), 'Paxton FD'));
  await findings.drain();
  const out = findings.exported({ hours: 1, channel: 'Holden PD' });
  assert.equal(out.findings.length, 1);
  const [f] = out.findings;
  assert.deepEqual(f.transcripts.map((t) => t.engine), ['base', 'tiny']);
  assert.match(f.sent, /New transmission:\nEngine 2 en route/);
  assert.deepEqual(f.found.units, ['Engine 2']);
  assert.deepEqual(f.found.unheard, [{ field: 'addresses', value: '20 Elm Street' }]);
  assert.equal(out.instructions.length > 100, true);
  assert.doesNotMatch(JSON.stringify(out), /llm\.invalid|secret|hook\.invalid/);
  assert.throws(() => findings.exported({ hours: 0 }), /1 to 744 hours/);
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
  const t = await findings.test('plate x ray yankee zulu nine');
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
    assert.equal((await bob('GET', '/admin/findings/export')).status, 403, 'nor the export, which holds what was sent');
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
    const ex = await alice('GET', '/admin/findings/export?hours=2');
    assert.equal(ex.status, 200);
    assert.match(ex.body.instructions, /radio traffic/);
    assert.equal(ex.body.settings.apiKey, undefined, 'never the key');
    assert.equal((await alice('GET', '/admin/findings/export?hours=9999')).status, 400);

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
