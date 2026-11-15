import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, parseXml, decode, call, list, xsd, struct, SoapFault } from '../src/soap.js';
import { similarity } from '../src/radioreference.js';
import { ACCOUNT, fakeFetch, replyXml, faultXml } from './fixtures/radioreference-fake.js';

// node:sqlite arrived in Node 22.5; on older Node the Store-backed tests report as skipped.
const sqlite = await import('node:sqlite').then(() => true, () => false);

const reply = (body, status = 200, seen = []) => async (url, opts) => {
  seen.push({ url, opts });
  return new Response(typeof body === 'string' ? Buffer.from(body, 'utf8') : body, { status });
};

test('a SOAP call: escaped and typed going out, decoded as NuSOAP sends it coming back', async () => {
  const xml = envelope('urn:x', 'getThing', {
    zipcode: xsd.int('01520'),
    authInfo: struct('ns1:authInfo', { username: xsd.string('a&b <c> "d"') }),
  });
  assert.match(xml, /<zipcode xsi:type="xsd:int">01520<\/zipcode>/, 'a ZIP code keeps its leading zero');
  assert.match(xml, /<username xsi:type="xsd:string">a&amp;b &lt;c&gt; &quot;d&quot;<\/username>/);
  const op = parseXml(xml).kids[0].kids[0].kids[0];
  assert.equal(op.name, 'ns1:getThing');
  assert.deepEqual(decode(op), { zipcode: 1520, authInfo: { username: 'a&b <c> "d"' } }, 'it reads back as sent');

  const seen = [];
  const county = await call({
    endpoint: 'https://rr.invalid/soap2/index.php', ns: 'http://api.radioreference.com/soap2', method: 'getCountyInfo',
    params: { ctid: xsd.int(1) },
    fetch: reply(replyXml('getCountyInfo', {
      ctid: 1225, countyName: 'Worcester & Co', lat: 42.35, cats: [{ cid: 1, cName: 'Holden', subcats: [] }],
    }, 'CountyInfo'), 200, seen),
  });
  assert.deepEqual(county, {
    ctid: 1225, countyName: 'Worcester & Co', lat: 42.35, cats: [{ cid: 1, cName: 'Holden', subcats: [] }],
  }, 'numbers as numbers, arrays as arrays, an empty one too');
  assert.equal(seen[0].opts.headers.SOAPAction, '"http://api.radioreference.com/soap2#getCountyInfo"');
  assert.equal(seen[0].opts.redirect, 'error', 'a redirect is not followed with the sign-in');
  assert.deepEqual(list(''), [], 'an empty value is an empty list');
  assert.deepEqual(list({ a: 1 }), [{ a: 1 }], 'and one value a list of one');

  // As the real service faults: Latin-1, HTTP 500
  await assert.rejects(
    call({ endpoint: 'x', ns: 'n', method: 'm', params: {}, fetch: reply(Buffer.from(faultXml('AUTH', 'Café says no'), 'latin1'), 500) }),
    (e) => e instanceof SoapFault && e.code === 'AUTH' && e.message === 'Café says no');
  // UTF-8 declared over Latin-1 bytes reads as Latin-1, not as replacement characters
  const mislabelled = Buffer.from(replyXml('getUserData', { username: 'José' }, 'UserInfo'), 'latin1');
  assert.equal((await call({ endpoint: 'x', ns: 'n', method: 'm', params: {}, fetch: reply(mislabelled) })).username, 'José');
  // A web server's error page is no reply at all
  await assert.rejects(call({ endpoint: 'x', ns: 'n', method: 'm', params: {}, fetch: reply('<html><body>Bad gateway', 502) }),
    /HTTP 502, and not a SOAP reply/);
  assert.throws(() => parseXml('<a><b></a>'), /closes nothing open/);
});

test('a channel\'s name decides which listing it is', () => {
  assert.ok(similarity('Holden PD', 'Holden PD Police Dispatch') >= 2);
  assert.ok(similarity('Holden FD', 'Holden FD Fire Dispatch') > similarity('Holden FD', 'Paxton FG Fireground'));
  assert.ok(similarity('Rutld FD', 'Rutland FD Fire Dispatch Worcester › Rutland › Fire') > 1.5, 'ten letters, cut down');
  assert.equal(similarity('Simplex', 'Police Dispatch'), 0);
  assert.equal(similarity('Holden PD', ''), 0);
});

/** A RadioReference over the stand-in, set up as the Admin page would. */
async function setUp(extra = {}) {
  const { Store } = await import('../src/store.js');
  const { RadioReference } = await import('../src/radioreference.js');
  const store = new Store(':memory:', 'base');
  const calls = [];
  const rr = new RadioReference({ store, fetch: fakeFetch(calls), ...extra });
  return { store, rr, calls };
}

test('the account is kept, but never shown, and is needed before anything is asked', { skip: !sqlite }, async () => {
  const { rr, calls } = await setUp({ config: { appKey: 'FROMFILE' } });
  assert.deepEqual(rr.settings(), { username: '', password: false, appKey: 'settings file', zip: '', ready: false });
  await assert.rejects(rr.lookup({ name: 'Holden PD', hz: 460387500 }), (e) => e.status === 400 && /ZIP code/.test(e.message));
  await assert.rejects(rr.test(), (e) => e.status === 400 && /username, password and app key/.test(e.message));
  assert.equal(calls.length, 0, 'nothing was sent');

  assert.throws(() => rr.save({ zip: '1520' }), /five digits/);
  const saved = rr.save({ username: ' tester ', password: ACCOUNT.password, appKey: ACCOUNT.appKey, zip: '01520' });
  assert.deepEqual(saved, { username: 'tester', password: true, appKey: 'saved', zip: '01520', ready: true });
  assert.ok(!JSON.stringify(saved).includes(ACCOUNT.password) && !JSON.stringify(saved).includes(ACCOUNT.appKey));
  // The page sends the form back with the password and key blank: they stay
  rr.save({ username: 'tester', password: '', appKey: '', zip: '01520' });
  assert.equal(rr.get('password'), ACCOUNT.password);
  assert.equal(rr.appKey(), ACCOUNT.appKey, "an admin's key over the settings file's");

  const t = await rr.test();
  assert.deepEqual([t.username, t.expires, t.zip.city, t.zip.ctid], ['tester', '03-01-2027', 'Holden', 1225]);
  assert.deepEqual(calls[0].params.authInfo,
    { username: 'tester', password: ACCOUNT.password, appKey: ACCOUNT.appKey, version: '18', style: 'rpc' },
    'signed in as the account, at the version this was written for');
  assert.equal(calls[1].params.zipcode, 1520);

  rr.save({ password: 'wrong' });
  await assert.rejects(rr.test(), (e) => e.status === 502 && e.message === 'RadioReference: Invalid Username or Password');
  assert.deepEqual(rr.save({ forget: true }), { username: '', password: false, appKey: 'settings file', zip: '', ready: false });
});

test('looking a channel up: the licence\'s site on its frequency first, then its area', { skip: !sqlite }, async () => {
  const { rr, calls } = await setUp();
  rr.save({ ...ACCOUNT, zip: '01520' });

  const pd = await rr.lookup({ name: 'Holden PD', hz: 460387500 });
  assert.deepEqual([pd.scope, pd.listings, pd.mhz, pd.area.city], ['county', 1, 460.3875, 'Holden']);
  const [site, area, ...rest] = pd.candidates;
  assert.deepEqual([site.kind, site.callsign, site.address, site.lat, site.lon, site.onFrequency],
    ['fcc', 'KZZ900', '1370 Main St, Holden, MA', 42.35105, -71.86312, true], 'where the licence transmits on it');
  assert.equal(site.title, 'Police Dispatch');
  assert.equal(site.where, 'Worcester › Holden › Police');
  assert.ok(site.km < 1, `near the ZIP code: ${site.km} km`);
  assert.deepEqual([area.kind, area.lat, area.lon, area.range, area.countyWide], ['area', 42.3526, -71.8626, 3, false]);
  assert.equal(rest.length, 0, 'not the hill site, which receives on the input, nor the mobiles');
  const freq = calls.find((c) => c.method === 'searchCountyFreq').params;
  assert.deepEqual([freq.ctid, freq.freq], [1225, 460.3875]);

  // Two towns' listings on one frequency: the one its name says first
  const fd = await rr.lookup({ name: 'Holden FD', hz: 154310000 });
  assert.deepEqual(fd.candidates.map((c) => `${c.kind} ${c.alpha}`), ['fcc Holden FD', 'area Holden FD', 'area Paxton FG']);

  // A licence giving its longitude without the sign is put right
  const rutland = await rr.lookup({ name: 'Rutld FD', hz: 154250000 });
  assert.deepEqual([rutland.candidates[0].kind, rutland.candidates[0].lon], ['fcc', -71.9468]);

  // A callsign with no licence (an amateur's) leaves the area, which here is the county's
  const ham = await rr.lookup({ name: 'W1BIM', hz: 146970000 });
  assert.deepEqual(ham.candidates.map((c) => [c.kind, c.lat, c.lon, c.countyWide]), [['area', 42.35, -71.9, true]]);

  // Nothing in the county: the state, where an agency's place is the one there is
  const ems = await rr.lookup({ name: 'Holden EMS', hz: 155175000 });
  assert.deepEqual([ems.scope, ems.candidates[0].where, ems.candidates[0].lat], ['state', 'Massachusetts EMS › Statewide › Mutual Aid', 42.36]);

  // A trunked system's frequency isn't a channel's
  const trunked = await rr.lookup({ name: 'Control', hz: 851012500 });
  assert.deepEqual([trunked.listings, trunked.candidates.length], [0, 0]);
  await assert.rejects(rr.lookup({ name: 'Nameless', hz: null }), /no frequency/);

  // The county, the licences and the ZIP code were each asked for once
  const count = (m) => calls.filter((c) => c.method === m).length;
  assert.deepEqual([count('getZipcodeInfo'), count('getCountyInfo')], [1, 1]);
  await rr.lookup({ name: 'Holden PD', hz: 460387500 });
  assert.equal(calls.filter((c) => c.method === 'fccGetCallsign' && c.params.callsign === 'KZZ900').length, 1);
  rr.save({ zip: '01520' });
  await rr.lookup({ name: 'Holden PD', hz: 460387500 });
  assert.equal(count('getZipcodeInfo'), 2, 'saving starts afresh');
});

test('Find, through the API: admins only, and the account never comes back out', { skip: !sqlite }, async () => {
  const { Store } = await import('../src/store.js');
  const { RadioReference } = await import('../src/radioreference.js');
  const { createApp } = await import('../src/api.js');
  const { EventEmitter } = await import('node:events');
  const store = new Store(':memory:', 'base');
  store.addTransmission({ mac: '38:D2:00:01:56:51', startedAt: 1, durationMs: 900, audioFile: 'a.wav',
    channelName: 'Holden PD', channelHz: 460387500 });
  const radioreference = new RadioReference({ store, fetch: fakeFetch() });
  const manager = Object.assign(new EventEmitter(), { radios: () => store.radios() });
  const config = { host: '127.0.0.1', auth: { tokens: [{ token: 'admin' }, { token: 'viewer', role: 'viewer' }] } };
  const app = createApp({ manager, store, sidecar: {}, config, dataDir: '.', radioreference });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, path, token, body) => fetch(`${base}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  try {
    assert.equal((await (await call('GET', '/map', 'viewer')).json()).lookup, false);
    assert.equal((await call('GET', '/admin/radioreference', 'viewer')).status, 403);
    assert.equal((await call('PUT', '/admin/radioreference', 'viewer', { username: 'x' })).status, 403);
    assert.equal((await call('GET', '/channels/Holden%20PD/lookup', 'viewer')).status, 403);
    const notYet = await call('GET', '/channels/Holden%20PD/lookup', 'admin');
    assert.equal(notYet.status, 400, 'not set up is the admin\'s to fix');
    assert.match((await notYet.json()).error, /Admin → RadioReference/);

    const bad = await call('PUT', '/admin/radioreference', 'admin', { zip: 'abc' });
    assert.equal(bad.status, 400);
    const put = await call('PUT', '/admin/radioreference', 'admin', { ...ACCOUNT, zip: '01520' });
    const text = await put.text();
    assert.ok(!text.includes(ACCOUNT.password) && !text.includes(ACCOUNT.appKey), 'the password and key stay in');
    assert.equal(JSON.parse(text).ready, true);
    assert.equal((await (await call('GET', '/map', 'viewer')).json()).lookup, true, 'the Map offers Find now');
    const t = await (await call('POST', '/admin/radioreference/test', 'admin')).json();
    assert.deepEqual([t.username, t.expires, t.settings.ready], ['tester', '03-01-2027', true]);

    const found = await (await call('GET', '/channels/Holden%20PD/lookup', 'admin')).json();
    assert.equal(found.candidates[0].callsign, 'KZZ900');
    assert.equal((await call('GET', '/channels/Nowhere/lookup', 'admin')).status, 404);

    await call('PUT', '/admin/radioreference', 'admin', { password: 'wrong' });
    const refused = await call('POST', '/admin/radioreference/test', 'admin');
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).error, 'RadioReference: Invalid Username or Password');
  } finally {
    server.close();
  }
});
