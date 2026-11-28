import test from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, parseHpd } from '../src/uniden.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);

const T = (...f) => f.join('\t');
// A made-up database in the scanners' format: a county's conventional groups (one with its own circle, one
// nationwide by its rectangles), and a trunked system whose talkgroups' group has no place but whose site does
const CFG = [T('TargetModel', 'BCDx36HP'), T('FormatVersion', '1.00'), T('DateModified', '11/15/2026 08:00:00'),
  T('StateInfo', 'StateId=25', 'CountryId=1', 'Massachusetts', 'MA'), T('CountyInfo', 'CountyId=1213', 'StateId=25', 'Worcester'),
  T('CountyInfo', 'CountyId=9', 'StateId=6', 'Far Away')].join('\r\n');
const STATE = [T('TargetModel', 'BCDx36HP'), T('FormatVersion', '1.00'),
  T('Conventional', 'CountyId=1213', 'StateId=25', 'Worcester', 'Off', '', 'Conventional'),
  T('C-Group', 'CGroupId=1', 'CountyId=1213', 'Holden - Fire', 'Off', '42.351900', '-71.863400', '3.0', 'Circle', 'Off', 'Global'),
  T('C-Freq', 'CFreqId=11', 'CGroupId=1', 'Holden FD Dispatch', 'Off', '154385000', 'NFM', 'TONE=C100.0', '3'),
  T('C-Freq', 'CFreqId=12', 'CGroupId=1', 'Holden FD Dispatch', 'Off', '154385000', 'NFM', 'TONE=C100.0', '3'),
  T('C-Freq', 'CFreqId=13', 'CGroupId=1', 'Fireground', 'Off', '154280000', 'NFM', '', '3'),
  T('C-Group', 'CGroupId=2', 'CountyId=1213', 'Interop', 'Off', '0.000000', '0.000000', '0.0', 'Rectangles', 'Off', 'Global'),
  T('Rectangle', '', '85.000000', '-170.500000', '15.000000', '-50.000000'),
  T('C-Freq', 'CFreqId=14', 'CGroupId=2', 'National Calling', 'Off', '155475000', 'NFM', '', '3'),
  T('C-Group', 'CGroupId=3', 'CountyId=1213', 'Paxton - Fire', 'Off', '0', '0', '0', 'Rectangles', 'Off', 'Global'),
  T('Rectangle', '', '42.33', '-71.95', '42.29', '-71.90'),
  T('C-Freq', 'CFreqId=15', 'CGroupId=3', 'Paxton Fire', 'Off', '154280000', 'NFM', '', '3'),
  T('Trunk', 'TrunkId=7', 'StateId=25', 'Worcester County Radio', 'Off', '', 'P25Standard'),
  T('Site', 'SiteId=70', 'TrunkId=7', 'Holden Hill', 'Off', '42.360000', '-71.850000', '20.0', 'AUTO', 'Standard', 'Wide', 'Circle'),
  T('T-Freq', 'TFreqId=0', 'SiteId=70', '', '', '851012500', '1'),
  T('T-Group', 'TGroupId=71', 'TrunkId=7', 'County Fire', 'Off', '0.000000', '0.000000', '0.0', 'Circle'),
  T('TGID', 'Tid=1', 'TGroupId=71', 'Fire Dispatch', 'Off', '1201', 'ALL', '3'),
].join('\r\n');
const FAR = [T('TargetModel', 'BCDx36HP'), T('FormatVersion', '1.00'),
  T('Conventional', 'CountyId=9', 'StateId=6', 'Far Away', 'Off', '', 'Conventional'),
  T('C-Group', 'CGroupId=90', 'CountyId=9', 'Far Away Fire', 'Off', '34.000000', '-118.000000', '5.0', 'Circle', 'Off', 'Global'),
  T('C-Freq', 'CFreqId=91', 'CGroupId=90', 'Holden FD Dispatch', 'Off', '154385000', 'NFM', '', '3'),
].join('\n');
const HOME = { lat: 42.35, lon: -71.85 };

test('the scanners’ database files are read for what places a channel', () => {
  const got = parseHpd(STATE);
  assert.equal(got.entries.length, 6);
  const by = Object.fromEntries(got.entries.map((e) => [`${e.name}:${e.hz ?? e.tgid}`, e]));
  assert.deepEqual([by['Fireground:154280000'].group, by['Fireground:154280000'].system, by['Fireground:154280000'].rangeMi],
    ['Holden - Fire', 'Worcester', 3]);
  assert.equal(by['National Calling:155475000'].lat, null, 'a group covering the continent has no place');
  assert.ok(Math.abs(by['Paxton Fire:154280000'].lat - 42.31) < 1e-9, 'the middle of its rectangles');
  assert.deepEqual([by['Fire Dispatch:1201'].kind, by['Fire Dispatch:1201'].trunk, by['Fire Dispatch:1201'].lat], ['tgid', 7, null]);
  assert.deepEqual(got.sites.map((s) => s.name), ['Holden Hill']);
  const cfg = parseHpd(CFG);
  assert.equal(cfg.date, '11/15/2026 08:00:00');
  assert.deepEqual(cfg.areas.map((a) => a.name), ['Massachusetts', 'Worcester', 'Far Away']);
  assert.throws(() => parseHpd('hello'), /isn’t one of Uniden’s database files/);
  assert.equal(nameKey('  Holden   FD Dispatch '), 'holden fd dispatch');
});

test('a channel is placed by its name, frequency or talkgroup, near home', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Uniden } = await import('../src/uniden.js');
  const u = new Uniden({ store: new Store(':memory:', 'base') });
  assert.throws(() => u.importFile('notes.txt', STATE), /only hpdb\.cfg and the s_000000\.hpd files/);
  u.importFile('hpdb.cfg', CFG);
  u.importFile('s_000025.hpd', Buffer.from(STATE));
  u.importFile('s_000006.hpd', FAR);
  u.importFile('s_000025.hpd', STATE);   // again: replaces, doesn't add
  assert.deepEqual([u.stats().entries, u.stats().files, u.stats().date], [7, 2, '11/15/2026 08:00:00']);

  const exact = u.candidates({ name: 'Holden FD Dispatch', hz: 154385000 }, HOME);
  assert.equal(exact.confident, true);
  assert.equal(exact.candidates.length, 1, 'listed twice in its group, offered once; the far one left out');
  assert.equal(exact.candidates[0].where, 'MA › Worcester County › Holden - Fire');
  assert.ok(exact.candidates[0].km < 2);
  assert.equal(u.candidates({ name: 'Holden FD Dispatch', hz: 154385000 }, null).candidates.length, 2, 'no home: both');

  const freq = u.candidates({ name: 'Ch 7', hz: 154280000 }, HOME);
  assert.equal(freq.confident, false, 'a shared frequency alone isn’t sure');
  assert.deepEqual(freq.candidates.map((k) => k.title).sort(), ['Fireground', 'Paxton Fire']);
  const dept = u.candidates({ name: 'Ch 7', hz: 154280000, details: { department: 'Paxton - Fire' } }, HOME);
  assert.equal(dept.candidates[0].title, 'Paxton Fire', 'the scanner’s department decides it');

  const tg = u.candidates({ name: 'Fire Dispatch', hz: null, details: { talkgroup: '1201', system: 'Worcester County Radio' } }, HOME);
  assert.equal(tg.confident, true);
  assert.deepEqual([tg.candidates[0].tgid, tg.candidates[0].site, tg.candidates[0].range], [1201, 'Holden Hill', 20],
    'a talkgroup with no place of its own is at its system’s site');
  assert.equal(u.candidates({ name: 'National Calling', hz: 155475000 }, HOME).candidates.length, 0, 'nowhere to put it');
  assert.equal(u.clear().entries, 0);
});

test('Find, through the API: Uniden’s database, imported by an admin', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { Uniden } = await import('../src/uniden.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:', 'base');
  store.addTransmission({ mac: 'AA:BB', startedAt: 1, durationMs: 900, audioFile: 'a.wav', channelName: 'Holden FD Dispatch',
    channelHz: 154385000, details: { department: 'Holden - Fire', system: 'Worcester' } });
  store.addTransmission({ mac: 'AA:BB', startedAt: 2, durationMs: 900, audioFile: 'b.wav', channelName: 'Elsewhere', channelHz: 155475000 });
  store.setChannelPlace('Elsewhere', HOME.lat, HOME.lon);
  const uniden = new Uniden({ store });
  const manager = Object.assign(new EventEmitter(), { radios: () => [] });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'admin' }, { token: 'viewer', role: 'viewer' }] } };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.', uniden });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, path, token, body, type = 'application/octet-stream') => fetch(`${base}${path}`, {
    method, body, headers: { authorization: `Bearer ${token}`, 'content-type': type },
  });
  try {
    assert.equal((await (await call('GET', '/map', 'viewer')).json()).lookup, false);
    assert.equal((await call('PUT', '/admin/uniden/files/hpdb.cfg', 'viewer', CFG)).status, 403);
    assert.equal((await call('GET', '/channels/Holden%20FD%20Dispatch/lookup', 'admin')).status, 400, 'nothing to look in yet');
    assert.equal((await call('PUT', '/admin/uniden/files/hpdb.cfg', 'admin', CFG)).status, 200);
    const up = await (await call('PUT', '/admin/uniden/files/s_000025.hpd', 'admin', STATE)).json();
    assert.equal(up.entries, 6);
    assert.equal((await call('PUT', '/admin/uniden/files/s_000025.hpd', 'admin', 'not a database')).status, 400);
    assert.deepEqual(await (await call('GET', '/map', 'viewer')).json(), { styles: [], lookup: true, rr: false, uniden: true });
    assert.equal((await call('GET', '/channels/Holden%20FD%20Dispatch/lookup', 'viewer')).status, 403);
    const found = await (await call('GET', '/channels/Holden%20FD%20Dispatch/lookup?quick=1', 'admin')).json();
    assert.equal(found.uniden.confident, true);
    assert.equal(found.uniden.candidates[0].where, 'MA › Worcester County › Holden - Fire');
    assert.equal(found.uniden.candidates[0].score, 9, 'its name, department, system and frequency');
    assert.ok(found.uniden.candidates[0].km < 2, 'from the channels placed, with no ZIP code set');
    assert.equal(found.rr, null);
    assert.equal((await (await call('DELETE', '/admin/uniden', 'admin')).json()).entries, 0);
  } finally {
    server.close();
  }
});

const HAM = [T('TargetModel', 'BCDx36HP'), T('FormatVersion', '1.00'),
  T('Conventional', 'CountyId=1213', 'StateId=25', 'Worcester', 'Off', '', 'Conventional'),
  T('C-Group', 'CGroupId=5', 'CountyId=1213', 'Amateur Radio', 'Off', '42.300000', '-71.800000', '10.0', 'Circle', 'Off', 'Global'),
  T('C-Freq', 'CFreqId=51', 'CGroupId=5', 'W1BIM Paxton', 'Off', '146970000', 'FM', 'TONE=C114.8', '13'),
  T('C-Freq', 'CFreqId=52', 'CGroupId=5', 'Simplex Calling', 'Off', '146520000', 'NFM', '', '13'),
  T('C-Freq', 'CFreqId=53', 'CGroupId=5', 'Holden 70cm', 'Off', '449925000', 'FM', 'TONE=D023', '13'),
  T('C-Freq', 'CFreqId=54', 'CGroupId=5', 'Club DMR', 'Off', '442500000', 'AUTO', 'ColorCode=1', '13'),
  T('C-Freq', 'CFreqId=55', 'CGroupId=5', 'Wachusett', 'Off', '147150000', 'AUTO', 'TONE=C100.0', '13'),
  T('C-Group', 'CGroupId=6', 'CountyId=1213', 'Statewide Amateur', 'Off', '42.400000', '-72.300000', '5.0', 'Circle', 'Off', 'Global'),
  T('C-Freq', 'CFreqId=61', 'CGroupId=6', 'W1BIM again', 'Off', '146970000', 'FM', 'TONE=C114.8', '13'),
  T('C-Freq', 'CFreqId=62', 'CGroupId=5', 'Holden FD Dispatch', 'Off', '154385000', 'NFM', 'TONE=C100.0', '3'),
  T('C-Freq', 'CFreqId=63', 'CGroupId=5', 'Paxton Fire Tac', 'Off', '145230000', 'AUTO', '', '8'),
  T('C-Freq', 'CFreqId=64', 'CGroupId=5', 'Tower', 'Off', '120500000', 'AUTO', '', '15'),
  T('C-Group', 'CGroupId=7', 'CountyId=9', 'Far Ham', 'Off', '34.000000', '-118.000000', '5.0', 'Circle', 'Off', 'Global'),
  T('C-Freq', 'CFreqId=71', 'CGroupId=7', 'Far Repeater', 'Off', '146940000', 'FM', '', '13'),
].join('\r\n');

test('the frequencies near home of the services asked for, as the radio would be written', { skip: !sqlite }, async () => {
  const [e] = parseHpd(HAM).entries;
  assert.deepEqual([e.mode, e.audio, e.func], ['FM', 'TONE=C114.8', 13], 'mode, tone and service are kept');
  const { Store } = await import('../src/store.js');
  const { Uniden } = await import('../src/uniden.js');
  const u = new Uniden({ store: new Store(':memory:', 'base') });
  u.importFile('hpdb.cfg', CFG);
  u.importFile('s_000025.hpd', HAM);
  const got = u.stations(HOME, { miles: 30, services: ['ham'] });
  assert.equal(got.reimport, false);
  const by = Object.fromEntries(got.stations.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ['Club DMR', 'Holden 70cm', 'Simplex Calling', 'W1BIM Paxton', 'Wachusett'],
    'not the fire channel, not the far one, and one listing for a repeater listed twice: the nearest');
  assert.deepEqual(
    [by['W1BIM Paxton'].channel.rx_hz, by['W1BIM Paxton'].channel.tx_hz, by['W1BIM Paxton'].channel.tx_tone,
      by['W1BIM Paxton'].channel.rx_tone, by['W1BIM Paxton'].channel.tx_disable, by['W1BIM Paxton'].amateur],
    [146970000, 146370000, '114.8', '', false, true], 'a repeater: the band plan’s input, its tone to key it');
  assert.equal(by['Simplex Calling'].channel.tx_hz, 146520000, 'simplex');
  assert.equal(by['Simplex Calling'].channel.bandwidth, 'narrow');
  assert.deepEqual([by['Holden 70cm'].channel.tx_hz, by['Holden 70cm'].channel.tx_tone], [444925000, 'D023']);
  assert.deepEqual([by['Club DMR'].ok, by['Club DMR'].why], [false, 'DMR is digital or data, and the radio plays FM and AM']);
  assert.deepEqual([by.Wachusett.modeGuessed, by.Wachusett.channel.mod, by.Wachusett.channel.tx_hz], [true, 'FM', 147750000]);
  assert.deepEqual(got.stations.map((s) => s.km).every((k, i, a) => !i || a[i - 1] <= k), true, 'nearest first');
  const far = u.stations(HOME, { miles: 3000, services: ['ham'] });
  assert.deepEqual([far.miles, far.stations.length], [300, 5], 'at most 300 miles out: never a coast away');
  assert.equal(u.stations(null, { services: ['ham'] }).stations.length, 6, 'home unknown: every one, unsorted by distance');
  assert.deepEqual([got.counts.ham, got.counts.fire, got.counts.police], [{ ok: 4, not: 1 }, { ok: 2, not: 0 }, { ok: 0, not: 0 }],
    'each service counted, whichever were asked for');
  const fire = u.stations(HOME, { miles: 30, services: ['fire'] });
  const fd = Object.fromEntries(fire.stations.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(fd).sort(), ['Holden FD Dispatch', 'Paxton Fire Tac']);
  assert.deepEqual(
    [fd['Holden FD Dispatch'].channel.rx_tone, fd['Holden FD Dispatch'].channel.tx_disable, fd['Holden FD Dispatch'].channel.bandwidth],
    ['100.0', true, 'narrow'], 'receive-only, opened by its tone');
  assert.deepEqual([fd['Paxton Fire Tac'].modeGuessed, fd['Paxton Fire Tac'].channel.bandwidth, fd['Paxton Fire Tac'].channel.tx_hz],
    [true, 'narrow', 145230000], 'not a ham’s, though in the band: narrow, and never keyed');
  const air = u.stations(HOME, { miles: 30, services: ['air'] }).stations;
  assert.deepEqual(air.map((s) => [s.name, s.ok, s.channel?.mod]), [['Tower', true, 'AM']], 'the airband, as AM when the mode isn’t given');
  assert.equal(u.stations(HOME, { miles: 30 }).stations.length, 8, 'no services named: every one');
  assert.deepEqual(u.tones([146970000, 449925000, 146520000, 154385000, 146940000], HOME), { 146970000: '114.8', 449925000: 'D023' },
    'a ham repeater’s listed tone; none for simplex, nothing outside the ham bands, nothing listed only far away');
});
