import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../src/trial.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);

const T = (...f) => f.join('\t');
const MAC = '00:11:22:33:44:55';
const HOME = { lat: 42.35, lon: -71.85 };
const CFG = [T('TargetModel', 'BCDx36HP'), T('FormatVersion', '1.00'), T('DateModified', '11/15/2026 08:00:00'),
  T('StateInfo', 'StateId=25', 'CountryId=1', 'Massachusetts', 'MA'), T('CountyInfo', 'CountyId=1213', 'StateId=25', 'Worcester')].join('\r\n');
const DB = [T('TargetModel', 'BCDx36HP'), T('FormatVersion', '1.00'),
  T('Conventional', 'CountyId=1213', 'StateId=25', 'Worcester', 'Off', '', 'Conventional'),
  T('C-Group', 'CGroupId=5', 'CountyId=1213', 'Around', 'Off', '42.300000', '-71.800000', '10.0', 'Circle', 'Off', 'Global'),
  T('C-Freq', 'CFreqId=51', 'CGroupId=5', 'W1BIM Paxton', 'Off', '146970000', 'FM', 'TONE=C114.8', '13'),
  T('C-Freq', 'CFreqId=52', 'CGroupId=5', 'Holden FD Dispatch', 'Off', '154385000', 'NFM', 'TONE=C100.0', '3'),
  T('C-Freq', 'CFreqId=53', 'CGroupId=5', 'Holden 70cm', 'Off', '449925000', 'FM', 'TONE=D023', '13'),
  T('C-Freq', 'CFreqId=54', 'CGroupId=5', 'Paxton Fire Tac', 'Off', '154280000', 'NFM', '', '8'),
  T('C-Freq', 'CFreqId=55', 'CGroupId=5', 'Club DMR', 'Off', '442500000', 'AUTO', 'ColorCode=1', '13'),
  T('C-Freq', 'CFreqId=56', 'CGroupId=5', 'Holden PD', 'Off', '155070000', 'NFM', '', '2'),
].join('\r\n');

/** A radio of a few regions of 4 slots, kept as the radio link reads them: each slot with its record as raw. */
class FakeRadio {
  constructor() {
    const empty = (id) => ({ id, name: '', rx_hz: 0, empty: true });
    this.regions = [0, 1, 2].map(() => [0, 1, 2, 3].map(empty));
    this.regions[0][0] = { id: 0, name: 'W1BIM', rx_hz: 146970000, tx_hz: 146370000, scan: true, empty: false };
    this.regions[1][0] = { id: 0, name: 'Spare', rx_hz: 162550000, tx_hz: 162550000, scan: true, empty: false };
    this.state = new Map([[MAC, { state: 'connected', region: 0, rx: false, tx: false }]]);
    this.writes = [];
    this.controls = [];
  }

  static raw(c) { return Buffer.from(JSON.stringify(c)).toString('hex'); }

  async readChannels(mac, region) {
    const r = region ?? this.state.get(mac).region;
    return { region: r, name: `R${r}`, channels: this.regions[r].map((c) => ({ ...c, raw: FakeRadio.raw(c) })) };
  }

  async writeChannels(mac, region, channels) {
    if (this.offline) throw new Error('the radio isn’t connected');
    this.writes.push({ region, channels });
    for (const c of channels) {
      const was = c.raw ? JSON.parse(Buffer.from(c.raw, 'hex').toString()) : {};
      this.regions[region][c.id] = c.raw
        ? { ...was, ...(c.set ?? {}), id: c.id }
        : c.rx_hz ? { ...c, empty: false } : { id: c.id, name: '', rx_hz: 0, empty: true };
    }
    return { region, results: channels.map((c) => ({ id: c.id, ok: true, channel: this.regions[region][c.id] })) };
  }

  async control(mac, action, value) {
    this.controls.push([action, value]);
    if (action === 'region') this.state.get(mac).region = value;
  }
}

test('a frequency’s verdict from what came in on it', () => {
  assert.equal(verdict({ heard: 3, static: 1, speech: 2 }), 'good');
  assert.equal(verdict({ heard: 1, static: 0, speech: 1 }), 'good', 'once, clearly');
  assert.equal(verdict({ heard: 6, static: 5, speech: 1 }), 'some', 'words once among static: weak');
  assert.equal(verdict({ heard: 4, static: 4, speech: 0 }), 'static');
  assert.equal(verdict({ heard: 3, static: 0, speech: 0 }), 'static', 'opened three times and never with words');
  assert.equal(verdict({ heard: 1, static: 1, speech: 0 }), 'quiet', 'too little to tell');
  assert.equal(verdict({ heard: 0, static: 0, speech: 0 }), 'quiet');
});

test('a region’s empty channels tried one by one: words kept, static out at once, quiet out when its time is up', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Uniden } = await import('../src/uniden.js');
  const { Trials } = await import('../src/trial.js');
  const store = new Store(':memory:', 'base');
  const uniden = new Uniden({ store });
  uniden.importFile('hpdb.cfg', CFG);
  uniden.importFile('s_000025.hpd', DB);
  const radio = new FakeRadio();
  let now = Date.UTC(2026, 10, 27, 12);
  const trials = new Trials({ store, manager: radio, uniden, home: async () => HOME, now: () => now });
  const tx = (hz, { snrDb = 25, text = null, at = now + 60e3 } = {}) => {
    const id = store.addTransmission({ mac: MAC, startedAt: at, durationMs: 4000, audioFile: 'x.wav', channelHz: hz, snrDb });
    if (text !== null) store.saveTranscript(id, 'base', { status: 'done', text });
    return id;
  };
  const on = () => radio.regions[1].map((c) => (c.empty ? null : c.rx_hz));
  const wait = async (min) => {
    for (let i = 0; i < min; i += 4) { now += 4 * 60e3; await trials.tick(); }
  };

  await assert.rejects(trials.begin(MAC, { region: 1, services: [] }), /at least one service/);
  radio.regions[2] = radio.regions[2].map((c, id) => ({ id, name: `C${id}`, rx_hz: 146520000 + id, empty: false }));
  await assert.rejects(trials.begin(MAC, { region: 2, services: ['ham'] }), /no empty channels/);
  let s = await trials.begin(MAC, { region: 1, services: ['ham', 'fire'], miles: 30, hours: 0.5 });
  assert.equal(s.trial.state, 'running');
  assert.deepEqual(radio.controls.slice(-2), [['region', 1], ['scan', true]], 'the radio put on the region');
  assert.ok(s.trial.listening);
  // Its own channel left alone; the empty ones filled, nearest first, listened to only
  assert.deepEqual(on(), [162550000, 146970000, 154280000, 154385000]);
  assert.ok(radio.regions[1].slice(1).every((c) => c.tx_disable && c.scan));
  assert.equal(radio.regions[1][3].rx_tone, '100.0', 'opened by its tone');
  assert.equal(store.channelBackup(s.trial.backupId).label, 'Before trying channels');
  await assert.rejects(trials.begin(MAC, { region: 1, services: ['ham'] }), /already/);

  // Words twice: kept at once. Static three times with none: out at once, and the ham repeater tried again listening
  // only with its tone
  tx(154385000, { text: 'Engine 1 respond to Main Street' });
  tx(154385000, { text: 'Engine 1 on scene', at: now + 120e3 });
  for (let i = 0; i < 3; i++) tx(146970000, { snrDb: 2, text: 'So, we are going.', at: now + (1 + i) * 60e3 });
  await wait(4);
  s = trials.status(MAC);
  assert.deepEqual(on(), [162550000, 146970000, 154280000, 154385000]);
  assert.deepEqual(s.channels.map((c) => [c.slot, c.key]), [[1, 'uniden:146970000:114.8:tone'], [2, 'uniden:154280000:']]);
  assert.equal(radio.regions[1][1].rx_tone, '114.8');
  assert.deepEqual([s.trial.tried, s.trial.kept], [2, 1]);
  assert.deepEqual(s.results.map((r) => [r.station.name, r.verdict, r.kept]),
    [['Holden FD Dispatch', 'good', true], ['W1BIM Paxton', 'static', false]]);
  assert.equal(s.results[0].sample.text, 'Engine 1 on scene');

  // Only time on the region counts
  radio.state.get(MAC).region = 0;
  await wait(8);
  s = trials.status(MAC);
  assert.equal(s.trial.listening, false);
  assert.equal(s.channels[1].listenedHours, 4 / 60, 'not while the radio was elsewhere');
  await trials.listen(MAC);
  assert.equal(radio.state.get(MAC).region, 1);

  // Dropped by hand: the next one in
  await assert.rejects(trials.decide(MAC, 3, 'keep'), /no channel being tried there/);
  s = await trials.decide(MAC, 1, 'drop');
  assert.deepEqual(s.channels.map((c) => [c.slot, c.key]), [[1, 'uniden:449925000:D023'], [2, 'uniden:154280000:']]);

  // Time up: nothing at all comes off, then words once among static (a weak one), tried again with its tone
  tx(449925000, { text: 'Monitoring the repeater', at: now + 60e3 });
  tx(449925000, { snrDb: 2, text: 'Uh', at: now + 120e3 });
  tx(449925000, { snrDb: 2, text: 'Uh', at: now + 180e3 });
  await wait(28);
  s = trials.status(MAC);
  assert.deepEqual(s.channels.map((c) => c.key), ['uniden:449925000:D023'], 'the quiet one off, nothing left to put in');
  assert.deepEqual(on(), [162550000, 449925000, null, 154385000]);
  await wait(4);
  s = trials.status(MAC);
  assert.equal(trials.verdicts(MAC).get('uniden:449925000:D023'), 'some');
  assert.deepEqual(s.channels.map((c) => [c.slot, c.key, c.toneSquelch]), [[1, 'uniden:449925000:D023:tone', true]]);
  assert.equal(radio.regions[1][1].rx_tone, 'D023');

  // Kept: written as found, a ham repeater with its input and tone; then nothing left to try
  tx(449925000, { text: 'Monitoring, go ahead', at: now + 60e3 });
  tx(449925000, { text: 'Clear on the repeater', at: now + 120e3 });
  await wait(4);
  const kept = radio.regions[1][1];
  assert.deepEqual([kept.rx_hz, kept.tx_hz, kept.rx_tone, kept.tx_tone, Boolean(kept.tx_disable)],
    [449925000, 444925000, 'D023', 'D023', false]);
  assert.equal(trials.status(MAC).trial.state, 'done');
  assert.deepEqual(on(), [162550000, 449925000, null, 154385000]);
  assert.deepEqual(Object.fromEntries(trials.verdicts(MAC)), {
    'uniden:154385000:100.0': 'good', 'uniden:449925000:D023:tone': 'good', 'uniden:449925000:D023': 'some',
    'uniden:146970000:114.8': 'static', 'uniden:154280000:': 'quiet', 'uniden:146970000:114.8:tone': 'quiet' });

  // Every one tried: not started, and said why; how many are left counted for the page
  const left = () => uniden.stations(HOME, { miles: 30, services: ['fire'], fresh: trials.toTry(MAC) }).counts;
  assert.deepEqual([left().fire.ok, left().fire.left, left().ham.left], [2, 0, 0]);
  await assert.rejects(trials.begin(MAC, { region: 1, services: ['fire'], miles: 30 }), /tried on this radio already/);
  assert.equal(trials.status(MAC).trial.state, 'done', 'no trial started');

  // The quiet ones forgotten, tried again; stopped early, even after the radio was out of reach
  assert.deepEqual(trials.forget(MAC, null, { verdict: 'quiet' }), { forgotten: 2 });
  assert.deepEqual([left().fire.left, left().ham.left], [1, 1], 'the fire tac, and the repeater’s tone retry');
  assert.equal(trials.verdicts(MAC).get('uniden:146970000:114.8'), 'static', 'the static one kept');
  s = await trials.begin(MAC, { region: 1, services: ['fire'], miles: 30 });
  assert.deepEqual(s.channels.map((c) => [c.slot, c.name]), [[2, 'Paxton Fir']], 'only what hasn’t been tried, in the empty one');
  radio.offline = true;
  await assert.rejects(trials.end(MAC));
  assert.equal(trials.status(MAC).trial.state, 'ending');
  radio.offline = false;
  await trials.tick();
  assert.equal(trials.status(MAC).trial.state, 'done');
  assert.deepEqual(on(), [162550000, 449925000, null, 154385000], 'the quiet one off');
});

test('a trial of the first version, under way at an upgrade, has its region put back', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Trials } = await import('../src/trial.js');
  const store = new Store(':memory:', 'base');
  const radio = new FakeRadio();
  const trials = new Trials({ store, manager: radio, uniden: null, home: async () => HOME });
  const before = await radio.readChannels(MAC, 1);
  const backup = store.addChannelBackup({ mac: MAC, region: 1, regionName: 'R1', label: 'Before trying channels', channels: before.channels });
  radio.regions[1][2] = { id: 2, name: 'Tried', rx_hz: 154280000, empty: false };
  radio.state.get(MAC).region = 1;
  store.db.prepare(`INSERT INTO trials (mac, region, home_region, trial_min, home_min, hours, services, backup_id, state, batch_at, started_at)
                    VALUES (?, 1, 0, 20, 40, 6, '["fire"]', ?, 'running', 1, 1)`).run(MAC, backup.id);
  await trials.tick();
  assert.equal(trials.status(MAC).trial.state, 'done');
  assert.deepEqual(radio.regions[1].filter((c) => !c.empty).map((c) => c.name), ['Spare']);
  assert.equal(radio.state.get(MAC).region, 0);
});
