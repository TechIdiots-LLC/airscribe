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
