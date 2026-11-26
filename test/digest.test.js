import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { dayOf, hourOf } from '../src/digest.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);
const HOUR = 3_600_000;

test('the day so far: each hour summed up once it’s read, then the day’s overview, every radio’s and each one’s', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const store = new Store(':memory:', 'base');
  let now = new Date(2026, 10, 25, 15, 20).getTime();
  const asked = [];
  const answers = [];
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    asked.push(body);
    const system = body.messages[0].content;
    let content;
    if (system.startsWith('You sum up an hour')) content = answers.shift() ?? { items: [] };
    else if (system.startsWith('You write the overview')) content = { overview: `Overview of ${body.messages[1].content.split('\n').length - 1} items.` };
    else content = { summary: body.messages[1].content.match(/New transmission:\n(.*)/)?.[1] ?? '' };
    return Response.json({ message: { content: JSON.stringify(content) } });
  };
  const manager = new EventEmitter();
  const findings = new Findings({ store, manager, primary: 'base', fetch, now: () => now });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434', waitMinutes: 0, findingsCount: 0 });
  const say = async (mac, channel, text, at) => {
    const id = store.addTransmission({ mac, startedAt: at, durationMs: 4000, audioFile: `${mac}${at}.wav`, channelName: channel });
    store.saveTranscript(id, 'base', { status: 'done', text });
    await findings.read(id);
    return id;
  };
  const h13 = new Date(2026, 10, 25, 13, 0).getTime();
  const a = await say('AA', 'Fire Dispatch', 'engine 3 respond to 12 elm street for smoke', h13 + 5 * 60_000);
  const b = await say('AA', 'Fire Dispatch', 'engine 3 on scene, light smoke showing', h13 + 15 * 60_000);
  const c = await say('BB', 'Holden PD', 'car 12 clear of the motor vehicle stop', h13 + 40 * 60_000);
  await say('AA', 'Fire Dispatch', 'engine 3 back in quarters', now - 10 * 60_000);   // this hour: not over yet

  // 13:00 is over and read; 15:00 isn't
  assert.deepEqual(findings.digest.due(), [h13]);
  answers.push({ items: [
    { text: 'Engine 3 went to 12 Elm Street for smoke and found light smoke.', findings: [a, b] },
    { text: 'Car 12 cleared a motor vehicle stop.', findings: [c, 9999] },
    { text: 'Made up.', findings: [9999] },
    { text: '', findings: [a] },
  ] });
  const before = asked.length;
  const r = await findings.digest.run();
  assert.deepEqual(r, { hours: 1, items: 2, days: ['2026-11-25'] });
  assert.match(asked[before].messages[1].content, new RegExp(`#${a} \\[Fire Dispatch, 13:05\\] engine 3 respond to 12 elm street for smoke`));
  assert.equal(asked[before].format.required.join(), 'items', 'its own schema');
  assert.equal(asked.length - before, 4, 'the hour, then the overview for every radio and for each of the two');

  const day = findings.digest.day({ day: '2026-11-25' });
  assert.equal(day.overview.text, 'Overview of 2 items.');
  assert.equal(day.throughHour, h13);
  assert.deepEqual(day.hours[0].items.map((i) => [i.channel, i.radio, i.findings]),
    [['Fire Dispatch', 'AA', [a, b]], ['Holden PD', 'BB', [c]]], 'from the findings it names; one not among them dropped');
  assert.equal(findings.digest.day({ day: '2026-11-25', radio: 'BB' }).overview.text, 'Overview of 1 items.', 'one radio’s own');
  assert.equal(findings.digest.day({ day: '2026-11-25', channel: 'Holden PD' }).hours[0].items.length, 1);
  assert.equal(findings.digest.day({ day: '2026-11-25', channel: 'Holden PD' }).overview, null, 'a channel has its items, no overview');
  assert.deepEqual(findings.digest.due(), [], 'done');

  // A finding of that hour read late: the hour is summed up again
  await say('AA', 'Fire Dispatch', 'engine 3 knocked it down', h13 + 50 * 60_000);
  assert.deepEqual(findings.digest.due(), [h13]);

  // The findings an item came from, for the tab
  assert.deepEqual(findings.results({ ids: `${a},${b}` }).map((x) => x.id).sort(), [a, b].sort());
  assert.throws(() => findings.digest.day({ day: 'tuesday' }), /2026-11-25/);

  // Turned off, the hours wait; kept as long as findings are
  findings.save({ digest: false });
  assert.equal(findings.digest.on(), false);
  assert.equal(findings.settings().digest, false);
  now += 60 * 86_400_000;
  findings.sweep();
  assert.equal(findings.digest.day({ day: '2026-11-25' }).hours.length, 0);
  assert.equal(dayOf(hourOf(h13 + 1234)), '2026-11-25');
});

test('the day so far: the latest hours first, and one that fails waits rather than holding up the rest', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Findings } = await import('../src/findings.js');
  const store = new Store(':memory:', 'base');
  let now = new Date(2026, 10, 25, 16, 20).getTime();
  let broken = null;   // the hour whose question the model fails
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const system = body.messages[0].content;
    if (system.startsWith('You sum up an hour')) {
      if (broken && body.messages[1].content.startsWith(`The hour from ${broken}`)) return Response.json({ error: 'out of memory' }, { status: 500 });
      return Response.json({ message: { content: JSON.stringify({ items: [] }) } });
    }
    if (system.startsWith('You write the overview')) return Response.json({ message: { content: '{"overview":"x"}' } });
    return Response.json({ message: { content: JSON.stringify({ summary: body.messages[1].content.match(/New transmission:\n(.*)/)?.[1] ?? '' }) } });
  };
  const findings = new Findings({ store, manager: new EventEmitter(), primary: 'base', fetch, now: () => now });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434', waitMinutes: 0, findingsCount: 0 });
  const hours = [13, 14, 15].map((h) => new Date(2026, 10, 25, h, 0).getTime());
  for (const h of hours) {
    const id = store.addTransmission({ mac: 'AA', startedAt: h + 600_000, durationMs: 4000, audioFile: `${h}.wav`, channelName: 'Fire' });
    store.saveTranscript(id, 'base', { status: 'done', text: 'engine 3 respond to elm street' });
    await findings.read(id);
  }
  assert.deepEqual(findings.digest.due(), [...hours].reverse(), 'the latest first');

  broken = '15:00';
  await assert.rejects(findings.digest.run(), /out of memory/);
  assert.match(findings.digest.day().lastError.error, /out of memory/);
  const r = await findings.digest.run();
  assert.equal(r.hours, 2, 'the others, while it waits');
  assert.deepEqual(findings.digest.due(), [hours[2]]);
  assert.equal(findings.digest.day().lastError, null);
  assert.equal((await findings.digest.run()).hours, 0, 'not tried again at once');

  broken = null;
  now += 31 * 60_000;
  assert.equal((await findings.digest.run()).hours, 1, 'tried again a while later');
  assert.deepEqual(findings.digest.due(), []);
});
