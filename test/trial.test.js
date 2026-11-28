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

test('channels tried on a radio a batch at a time, graded, and the region put back', { skip: !sqlite }, async () => {
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

  await assert.rejects(trials.begin(MAC, { region: 0, homeRegion: 0, services: ['ham'] }), /other than the one/);
  await assert.rejects(trials.begin(MAC, { region: 1, homeRegion: 0, services: [] }), /at least one service/);
  let s = await trials.begin(MAC, { region: 1, homeRegion: 0, trialMin: 20, homeMin: 40, hours: 6, services: ['ham', 'fire'], miles: 30 });
  assert.equal(s.trial.state, 'running');
  assert.equal(s.trial.batch, 1);
  assert.equal(s.trial.on, 'trial');
  // Not 146.97 (on the radio's own region), not the DMR one, not police (not asked for); nearest first, 4 slots
  assert.deepEqual(s.channels.map((c) => c.hz).sort(), [154280000, 154385000, 449925000]);
  const written = radio.regions[1].filter((c) => !c.empty);
  assert.equal(written.length, 3, 'the old channel in the trial region written over, the slot left empty');
  assert.ok(written.every((c) => c.tx_disable && c.scan), 'listened to only, and scanned');
  assert.equal(written.find((c) => c.rx_hz === 154385000).rx_tone, '100.0', 'opened by its tone');
  assert.deepEqual(radio.controls.slice(-2), [['region', 1], ['scan', true]], 'the radio moved to the trial region');
  assert.equal(store.channelBackup(1).label, 'Before trying channels');
  await assert.rejects(trials.begin(MAC, { region: 2, homeRegion: 0, services: ['ham'] }), /already/);

  // What came in: words on the fire dispatch, static on the 70 cm repeater, nothing on the fire tac
  const tx = (hz, { snrDb = 25, text = null, at = now + 60e3 } = {}) => {
    const id = store.addTransmission({ mac: MAC, startedAt: at, durationMs: 4000, audioFile: 'x.wav', channelHz: hz, snrDb });
    if (text !== null) store.saveTranscript(id, 'base', { status: 'done', text });
    return id;
  };
  tx(154385000, { text: 'Engine 1 respond to Main Street' });
  tx(154385000, { text: 'Engine 1 on scene', at: now + 120e3 });
  for (let i = 0; i < 4; i++) tx(449925000, { snrDb: 2, text: 'So, we are going.' });
  now += 10 * 60e3;
  await trials.tick();
  s = trials.status(MAC);
  const by = Object.fromEntries(s.channels.map((c) => [c.hz, c]));
  assert.deepEqual([by[154385000].speech, by[154385000].verdict], [2, 'good']);
  assert.deepEqual([by[449925000].static, by[449925000].skipped, by[449925000].verdict], [4, true, 'static']);
  assert.equal(radio.regions[1].find((c) => c.rx_hz === 449925000).scan, false, 'the static one skipped when scanning');
  assert.equal(by[154280000].verdict, 'quiet');

  // The schedule: 20 minutes on the trial region, 40 on its own
  now += 15 * 60e3;
  await trials.tick();
  assert.equal(radio.state.get(MAC).region, 0);
  assert.equal(trials.status(MAC).trial.on, 'home');
  radio.state.get(MAC).rx = true;
  now += 40 * 60e3;
  await trials.tick();
  assert.equal(radio.state.get(MAC).region, 0, 'not moved while something’s coming in');
  radio.state.get(MAC).rx = false;
  await trials.tick();
  assert.equal(radio.state.get(MAC).region, 1);

  // A transmission still to be transcribed holds the grading up a while
  const late = tx(154280000, { at: now });
  now = s.trial.batchAt + 6 * 3600e3 + 60e3;
  await trials.tick();
  assert.equal(trials.status(MAC).results.length, 0, 'waiting on the transcript');
  store.saveTranscript(late, 'base', { status: 'done', text: '' });
  await trials.tick();
  s = trials.status(MAC);
  assert.deepEqual(s.results.map((r) => [r.station.name, r.verdict]),
    [['Holden FD Dispatch', 'good'], ['Holden 70cm', 'static'], ['Paxton Fire Tac', 'quiet']], 'good first');
  assert.equal(s.results[0].sample.text, 'Engine 1 on scene');
  assert.equal(s.results[0].station.channel.rx_hz, 154385000, 'the station as found, to keep');
  // Nothing left to try: the region put back as it was, the radio on its own
  await trials.tick();
  s = trials.status(MAC);
  assert.equal(s.trial.state, 'done');
  assert.deepEqual(radio.regions[1].filter((c) => !c.empty).map((c) => c.name), ['Spare'], 'the region as it was');
  assert.equal(radio.state.get(MAC).region, 0);
  assert.deepEqual(Object.fromEntries(trials.verdicts(MAC)),
    { 'uniden:154385000:100.0': 'good', 'uniden:449925000:D023': 'static', 'uniden:154280000:': 'quiet' });

  // Forgotten, tried again; ended early, put back even after the radio was out of reach
  assert.deepEqual(trials.forget(MAC, 'uniden:154280000:'), { forgotten: 1 });
  s = await trials.begin(MAC, { region: 1, homeRegion: 0, services: ['fire'], miles: 30 });
  assert.deepEqual(s.channels.map((c) => c.name), ['Paxton Fir'], 'only what hasn’t been tried');
  radio.offline = true;
  await assert.rejects(trials.end(MAC));
  assert.equal(trials.status(MAC).trial.state, 'ending');
  radio.offline = false;
  await trials.tick();
  s = trials.status(MAC);
  assert.equal(s.trial.state, 'done');
  assert.equal(s.results.find((r) => r.hz === 154280000).verdict, 'quiet', 'graded on what came in before it ended');
  assert.deepEqual(radio.regions[1].filter((c) => !c.empty).map((c) => c.name), ['Spare']);
});
