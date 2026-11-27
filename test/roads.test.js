import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { addressRoads, base, distance, fromOverpass, refNames, road, words } from '../src/roads.js';

const sqlite = await import('node:sqlite').then(() => true, () => false);

test('road names read the way they’re said', () => {
  assert.equal(base('north elm street'), 'elm');
  assert.equal(words('Calle Peñasco'), 'calle penasco', 'accents off, one word');
  assert.equal(base('elm'), 'elm');
  assert.equal(base('route 9'), null, 'a number alone is only ever itself');
  assert.equal(base('5th avenue'), '5th');
  assert.equal(base('ann street east'), 'ann', 'its kind and directions, in any order');
  assert.equal(base('north street'), 'north street', 'not just "street"');
  assert.ok(refNames('MA 9').includes('route 9'));
  assert.ok(refNames('I-290').includes('interstate 290'));
  assert.deepEqual(refNames('US 20;MA 9').filter((n) => n.startsWith('route')), ['route 20', 'route 9']);
  assert.deepEqual(addressRoads('412 Elm St and Route 9'), ['elm street', 'route 9']);
  assert.deepEqual(addressRoads('Walmart on Route 20'), ['walmart', 'route 20']);
  assert.equal(distance('pheasant', 'pleasant', 2), 1);
  assert.equal(distance('elm', 'oak street', 2), 3, 'gives up past the most it’s asked about');
  assert.equal(road({ highway: 'footway', name: 'Elm Path' }, [[[0, 0], [1, 1]]]), null, 'not a road anyone is sent to');
  assert.equal(road({ highway: 'residential' }, [[[0, 0], [1, 1]]]), null, 'no name');
  assert.equal(fromOverpass({ type: 'way', tags: { highway: 'primary', ref: 'MA 9' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1.1, lon: 2 }] }).name, 'MA 9');
});

// A town around a channel at 42.35, -71.85: Elm Street in two stretches meeting Main Street; another Elm Street
// in the next town, 11 km off; Pleasant Street; Route 9 by its number; a footpath
const HOME = { lat: 42.35, lon: -71.85 };
const line = (name, coords, tags = {}) => ({ type: 'Feature', properties: { highway: 'residential', ...(name ? { name } : {}), ...tags },
  geometry: { type: 'LineString', coordinates: coords } });
const TOWN = [
  line('Elm Street', [[-71.86, 42.35], [-71.85, 42.351]]),
  line('Elm Street', [[-71.85, 42.351], [-71.84, 42.352]]),
  line('Main Street', [[-71.85, 42.345], [-71.85, 42.351], [-71.85, 42.36]]),
  line('Elm Street', [[-71.72, 42.35], [-71.71, 42.35]]),
  line('Pleasant Street', [[-71.855, 42.34], [-71.845, 42.34]]),
  line(null, [[-71.9, 42.33], [-71.8, 42.37]], { highway: 'primary', ref: 'MA 9' }),
  line('Elm Path', [[-71.851, 42.349], [-71.849, 42.349]], { highway: 'footway' }),
];
const seq = (features) => Readable.from(features.map((f) => `\x1e${JSON.stringify(f)}\n`).join(''));

async function setUp() {
  const { Store } = await import('../src/store.js');
  const { Roads } = await import('../src/roads.js');
  const store = new Store(':memory:', 'base');
  store.setChannelPlace('Holden PD', HOME.lat, HOME.lon);
  return { store, roads: new Roads({ store }) };
}

test('roads import, and a name is found near the channel, misheard or not', { skip: !sqlite }, async () => {
  const { roads } = await setUp();
  const s = await roads.importStream(seq(TOWN), 'town.geojsonseq');
  assert.equal(s.ways, 6, 'the footpath is left out');
  assert.equal(s.source.name, 'town.geojsonseq');

  const elm = roads.locate('Elm St', HOME);
  assert.equal(elm.level, 'exact');
  assert.equal(elm.lines.length, 2, 'both stretches here, not the next town’s');
  assert.ok(elm.km < 0.2);
  assert.equal(roads.locate('elm', HOME).level, 'base', 'said without its kind');
  const misheard = roads.locate('Pheasant St', HOME);
  assert.deepEqual([misheard.name, misheard.level], ['Pleasant Street', 'fuzzy']);
  assert.equal(roads.locate('Route 9', HOME).name, 'MA 9');
  assert.equal(roads.locate('Oak Street', HOME), null);
  assert.equal(roads.locate('Elm Street', null).all, true, 'with nowhere to start, every Elm Street');

  assert.deepEqual(roads.corner(elm, roads.locate('Main St', HOME)), [-71.85, 42.351]);
  assert.equal(roads.corner(elm, roads.locate('Pleasant St', HOME)), null, 'they don’t meet');

  const hint = roads.hint('engine 2 respond pheasant street off of main', HOME);
  assert.ok(hint.includes('Pleasant Street') && hint.includes('Main Street'), hint.join());
  assert.ok(!hint.includes('Elm Street'));
  assert.deepEqual(roads.hint('anything', null), [], 'no channel placed, nothing to go on');

  // A FeatureCollection, the same; and a failed import leaves the roads as they were
  assert.equal((await roads.importStream(Readable.from(JSON.stringify({ type: 'FeatureCollection', features: TOWN.slice(0, 3) })))).ways, 3);
  await assert.rejects(roads.importStream(Readable.from('{"type":"Feature"}\nnot json\n')), /line 2 isn’t a GeoJSON feature/);
  await assert.rejects(roads.importStream(Readable.from(JSON.stringify({ type: 'FeatureCollection', features: [] }))), /no named roads/);
  assert.equal(roads.stats().ways, 3);
  assert.equal(roads.stats().busy, null);
});

test('the roads given to the model are the likeliest, the new transmission’s first', { skip: !sqlite }, async () => {
  const { roads } = await setUp();
  const at = (i) => [[-71.85 + i * 0.001, 42.35], [-71.849 + i * 0.001, 42.35]];
  const names = ['A Street', 'The Boulevard', 'My Way', 'Circle', 'North Street', 'Main Street', 'Main Avenue', 'Main Circle',
    'Main Court', 'Main Terrace', 'Walnut Street', 'Holly Lane', 'Burncoat Street'];
  await roads.importStream(seq(names.map((n, i) => line(n, at(i)))));
  const hint = (text, o) => roads.hint(text, HOME, o);
  assert.deepEqual(hint('258 walnut street, a 90 year old on my way to the circle'), ['Walnut Street', 'Circle'],
    'a name said whole first; never A Street, My Way or The Boulevard from "a", "my", "the"');
  assert.deepEqual(hint('the north street call, main street at holly'),
    ['Main Street', 'North Street', 'Holly Lane', 'Main Avenue', 'Main Circle', 'Main Court', 'Main Terrace']);
  assert.deepEqual(hint('227 burncot street', { context: 'main street and walnut', max: 2 }), ['Burncoat Street', 'Main Street'],
    'a mishearing of the new one before the earlier ones’ names, and only as many as asked');
});

// Towns, a shop and houses around the same channel, as osmium exports them; and an address file of its own
const point = (props, [lon, lat]) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
const PLACES = [
  line('Roxbury Street', [[-71.86, 42.345], [-71.85, 42.345]]),
  point({ name: 'Holden', place: 'town' }, [-71.85, 42.352]),
  point({ name: 'Brimfield', place: 'town' }, [-72.2, 42.12]),
  point({ name: 'Family Dollar', shop: 'variety_store', 'addr:street': 'Main Street', 'addr:housenumber': '12' }, [-71.851, 42.35]),
  ...['16', '18', '20'].map((n, i) => point({ 'addr:housenumber': n, 'addr:street': 'Roxbury Street' }, [-71.859 + i * 0.001, 42.3452])),
];

test('places, towns and addresses import beside the roads, and are found near the channel', { skip: !sqlite }, async () => {
  const { roads } = await setUp();
  await roads.importStream(seq([...TOWN, ...PLACES]), 'area.geojsonseq');
  const s = roads.stats();
  assert.deepEqual([s.ways, s.places, s.towns, s.addresses], [7, 1, 2, 4]);
  assert.equal(s.addressesSource.name, 'area.geojsonseq');

  // An address file replaces the addresses, and leaves the roads and places as they were
  const more = [point({ number: '22', street: 'ROXBURY ST', city: 'HOLDEN' }, [-71.855, 42.3452])];
  await roads.importStream(seq(more), 'addresses.geojson');
  assert.deepEqual([roads.stats().ways, roads.stats().places, roads.stats().addresses], [7, 1, 1]);
  await roads.importStream(seq(PLACES), 'area.geojsonseq');

  assert.deepEqual(roads.placeHint('we’re right by family dolar off high street', HOME).map((p) => [p.name, p.kind, p.rank]),
    [['Family Dollar', 'place', 1]], 'misheard; the Holden town said nowhere');
  assert.equal(roads.placeHint('126 or 26 east elr road grimfield', HOME)[0].name, 'Brimfield', 'a town 30 km off, misheard');
  assert.deepEqual(roads.placeHint('the store on main street', HOME), [], 'nothing named that');
  assert.equal(roads.findPlace('Family Dollar', HOME, 'place').level, 'exact');
  assert.deepEqual(roads.findPlace('Grimfield', HOME, 'town').point, [-72.2, 42.12]);

  const checked = roads.checkAddresses(['received 1616 roxbury street general fire alarm', '16 roxbury street'], ['Roxbury Street'], HOME);
  assert.deepEqual(checked.map((c) => [c.number, c.there, c.low, c.high]), [['1616', false, 16, 20], ['16', true, undefined, undefined]]);
  assert.deepEqual(roads.checkAddresses(['16 elm street'], ['Elm Street'], HOME), [], 'no houses on Elm Street imported: not checked');
  assert.deepEqual(roads.house('18', roads.locate('Roxbury St', HOME), HOME), [-71.858, 42.3452]);
  assert.equal(roads.house('99', roads.locate('Roxbury St', HOME), HOME), null);

  roads.clear();
  assert.deepEqual([roads.stats().places, roads.stats().addresses], [0, 0]);
});

test('Findings gives the model the places said and checks the house numbers', { skip: !sqlite }, async () => {
  const { store, roads } = await setUp();
  const { Findings } = await import('../src/findings.js');
  await roads.importStream(seq([...TOWN, ...PLACES]));
  const prompts = [];
  const findings = new Findings({ store, roads, primary: 'base', fetch: async (url, o) => {
    prompts.push(JSON.parse(o.body).messages[1].content);
    return Response.json({ message: { content: JSON.stringify({ summary: 'x', incident: '', service: 'fire',
      addresses: ['16 Roxbury Street'], roads: ['Roxbury Street'], plates: [], vehicles: [], people: [], units: [] }) } });
  } });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  const id = store.addTransmission({ mac: 'AA:BB', startedAt: Date.now(), durationMs: 4000, audioFile: 'a.wav', channelName: 'Holden PD' });
  store.saveTranscript(id, 'base', { status: 'done', text: 'received 1616 roxbury street general fire alarm, right by family dolar' });
  await findings.read(id);
  assert.match(prompts[0], /Places near this channel with names like words said:\nFamily Dollar \(variety store, Main Street\)\n/);
  assert.match(prompts[0], /Addresses said, checked against the map: 1616 Roxbury Street isn't \(its numbers run 16 to 20\)/);
});

test('roads are fetched from Overpass around the placed channels', { skip: !sqlite }, async () => {
  const { store } = await setUp();
  const { Roads } = await import('../src/roads.js');
  const asked = [];
  const elements = [
    ...TOWN.map((f, i) => ({ type: 'way', id: i, tags: f.properties, geometry: f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })) })),
    { type: 'node', id: 1, lat: 42.352, lon: -71.85, tags: { name: 'Holden', place: 'town' } },
    // A shop that's an address too comes in both answers
    { type: 'way', id: 9, center: { lat: 42.35, lon: -71.851 }, tags: { name: 'Family Dollar', shop: 'variety_store', 'addr:housenumber': '12', 'addr:street': 'Main Street' } },
    { type: 'way', id: 9, center: { lat: 42.35, lon: -71.851 }, tags: { name: 'Family Dollar', shop: 'variety_store', 'addr:housenumber': '12', 'addr:street': 'Main Street' } },
  ];
  const roads = new Roads({ store, overpass: 'https://overpass.invalid/api', fetch: async (url, o) => {
    asked.push({ url, query: new URLSearchParams(o.body).get('data') });
    return Response.json({ elements });
  } });
  assert.throws(() => roads.fetchOsm({ km: 0 }), /1 to 60 km/);
  roads.fetchOsm({ km: 10 });
  assert.throws(() => roads.fetchOsm({ km: 10 }), /being fetched already/);
  while (roads.stats().busy) await new Promise((r) => setTimeout(r, 5));
  assert.equal(asked[0].url, 'https://overpass.invalid/api');
  assert.match(asked[0].query, /way\["highway"\]\[~"\^\(name\|ref\)\$"~"\."\]\(42\.2\d+,-71\.9\d+,42\.4\d+,-71\.7\d+\)/);
  assert.deepEqual([roads.stats().ways, roads.stats().source.from, roads.stats().source.km], [6, 'openstreetmap', 10]);
  assert.deepEqual([roads.stats().towns, roads.stats().places, roads.stats().addresses], [1, 1, 1], 'each once');
  assert.match(asked[0].query, /nwr\["addr:housenumber"\]\["addr:street"\]/);
  // The channels too far apart: a file's job
  store.setChannelPlace('Far', 44, -69);
  assert.throws(() => roads.fetchOsm({ km: 25 }), /spread too widely/);
});

test('Findings gives the model the roads near the channel, and maps what it mentions', { skip: !sqlite }, async () => {
  const { store, roads } = await setUp();
  const { Findings } = await import('../src/findings.js');
  await roads.importStream(seq(TOWN));
  const prompts = [];
  const answer = { summary: 'Smoke at Elm and Main', incident: 'structure fire', service: 'fire', addresses: ['Elm St and Main St'],
    roads: ['Elm Street', 'Pleasant Street', 'Nowhere Lane'], plates: [], vehicles: [], people: [], units: [] };
  const findings = new Findings({ store, roads, primary: 'base', fetch: async (url, o) => {
    prompts.push(JSON.parse(o.body).messages[1].content);
    return Response.json({ message: { content: JSON.stringify(answer) } });
  } });
  findings.save({ enabled: true, url: 'http://llm.invalid:11434' });
  const at = Date.now();
  const id = store.addTransmission({ mac: 'AA:BB', startedAt: at, durationMs: 4000, audioFile: 'a.wav', channelName: 'Holden PD' });
  store.saveTranscript(id, 'base', { status: 'done', text: 'engine 2 smoke showing elm and main, pheasant street is blocked' });
  await findings.read(id);
  assert.match(prompts[0], /^Channel: Holden PD/);
  assert.match(prompts[0], /Roads near this channel with names like words said:\n.*Pleasant Street/);

  const m = findings.map({ hours: 1 });
  const byName = Object.fromEntries(Object.values(m.places).map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['Elm Street', 'Elm Street and Main Street', 'Main Street', 'Pleasant Street']);
  assert.deepEqual(byName['Elm Street'].ids, [id]);
  assert.equal(byName['Elm Street and Main Street'].kind, 'corner');
  assert.equal(m.transmissions[id].summary, 'Smoke at Elm and Main');
  assert.equal(byName['Elm Street'].service, 'fire', 'a road takes the service that mentioned it');
  assert.ok(m.features.features.every((f) => f.properties.service === 'fire'));
  const corner = m.features.features.find((f) => f.properties.kind === 'corner');
  assert.deepEqual(corner.geometry.coordinates, [-71.85, 42.351]);
  assert.equal(m.features.features.find((f) => m.places[f.properties.key].name === 'Elm Street').geometry.coordinates.length, 2);
  assert.equal(findings.map({ hours: 1, also: id }).transmissions[id].channel, 'Holden PD');
  assert.throws(() => findings.map({ hours: 'x' }), /number of hours/);

  // Not on a ham channel: a chat about antennas sounds like a dozen roads
  const ham = store.addTransmission({ mac: 'AA:BB', startedAt: at + 1000, durationMs: 4000, audioFile: 'b.wav', channelName: 'W1BIM' });
  store.saveTranscript(ham, 'base', { status: 'done', text: 'my elm dipole is up on the tower' });
  await findings.read(ham);
  assert.doesNotMatch(prompts[1], /Roads near this channel/);
  assert.deepEqual(findings.results({}).find((r) => r.id === ham).found.roads, ['Elm Street'],
    'a road said by name is kept; one only sounding like a word said is not');
});

// ---- The map's own tiles --------------------------------------------------------------------------------------

// A vector tile written here: just what the reader needs (layers, string values, line geometry)
const varint = (n) => {
  const out = [];
  for (; n >= 0x80; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
  return [...out, n];
};
const bytes = (f, b) => [...varint(f * 8 + 2), ...varint(b.length), ...b];
const text = (f, s) => bytes(f, [...Buffer.from(s)]);
const packed = (f, nums) => bytes(f, nums.flatMap(varint));
const zz = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);
function mvt(layers) {
  return Buffer.from(layers.flatMap((l) => {
    const keys = [];
    const values = [];
    const at = (arr, v) => (arr.includes(v) ? arr.indexOf(v) : arr.push(v) - 1);
    const feats = l.features.map((f) => {
      const tags = Object.entries(f.props).flatMap(([k, v]) => [at(keys, k), at(values, v)]);
      if (f.point) return bytes(2, [...packed(2, tags), ...varint(3 * 8), 1, ...packed(4, [9, zz(f.point[0]), zz(f.point[1])])]);
      let [x, y] = f.line[0];
      const geom = [9, zz(x), zz(y), ((f.line.length - 1) << 3) | 2];
      for (const [px, py] of f.line.slice(1)) (geom.push(zz(px - x), zz(py - y)), [x, y] = [px, py]);
      return bytes(2, [...packed(2, tags), ...varint(3 * 8), 2, ...packed(4, geom)]);
    });
    return bytes(3, [...text(1, l.name), ...feats.flat(), ...keys.flatMap((k) => text(3, k)),
      ...values.flatMap((v) => bytes(4, text(1, v))), ...varint(5 * 8), ...varint(4096)]);
  }));
}

test('roads are read from the OpenMapTiles tiles the Map’s base maps use', { skip: !sqlite }, async () => {
  const { lineFeatures, tileOf } = await import('../src/mvt.js');
  const { Store } = await import('../src/store.js');
  const { Roads } = await import('../src/roads.js');
  const { x, y } = tileOf(HOME.lon, HOME.lat, 14);
  // Elm Street runs from one tile into the next, each piece reaching a little past the edge, as tiles' do
  const tiles = new Map([
    [`${x}/${y}`, mvt([
      { name: 'transportation', features: [{ props: { class: 'minor' }, line: [[0, 0], [10, 10]] }] },
      { name: 'transportation_name', features: [
        { props: { name: 'Elm Street', class: 'minor' }, line: [[3000, 2048], [4150, 2048]] },
        { props: { ref: '31', network: 'us-state', route_1_network: 'US:MA', class: 'secondary' }, line: [[100, 100], [900, 3000]] },
        { props: { name: 'Elm Path', class: 'path' }, line: [[200, 200], [300, 300]] },
      ] },
      { name: 'poi', features: [{ props: { name: 'Family Dollar', class: 'shop', subclass: 'variety_store' }, point: [2000, 2000] }] },
      { name: 'place', features: [{ props: { name: 'Holden', class: 'town' }, point: [2048, 2048] }] },
    ])],
    [`${x + 1}/${y}`, mvt([{ name: 'transportation_name', features: [
      { props: { name: 'Elm Street', class: 'minor' }, line: [[-60, 2048], [1000, 2048]] },
    ] }])],
  ]);
  const [one] = lineFeatures(tiles.get(`${x + 1}/${y}`), { z: 14, x: x + 1, y }, ['transportation_name']);
  assert.equal(one.props.name, 'Elm Street');
  assert.ok(Math.abs(one.lines[0][0][0] - ((x + 1 - 60 / 4096) / 2 ** 14 * 360 - 180)) < 1e-9, 'in longitude');
  assert.equal(lineFeatures(tiles.get(`${x}/${y}`), { z: 14, x, y }, ['transportation_name']).length, 3);

  const store = new Store(':memory:', 'base');
  store.setChannelPlace('Holden PD', HOME.lat, HOME.lon);
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (url === 'https://maps.invalid/plain.json') return Response.json({ sources: { sat: { type: 'raster', url: 'x' } } });
    if (url === 'https://maps.invalid/style.json') {
      return Response.json({ sources: { omt: { type: 'vector', url: 'https://maps.invalid/omt/tiles.json#torrent=x' } } });
    }
    if (url === 'https://maps.invalid/omt/tiles.json') {
      return Response.json({ tiles: ['https://maps.invalid/omt/{z}/{x}/{y}.pbf'], maxzoom: 14, vector_layers: [{ id: 'transportation_name' }] });
    }
    const m = /omt\/14\/(\d+)\/(\d+)\.pbf$/.exec(url);
    return m && tiles.has(`${m[1]}/${m[2]}`) ? new Response(tiles.get(`${m[1]}/${m[2]}`)) : new Response(null, { status: 204 });
  };
  const styles = [{ url: 'https://maps.invalid/plain.json' }, { url: 'https://maps.invalid/style.json' }];
  await assert.rejects(new Roads({ store, fetch, styles: styles.slice(0, 1) }).fetchTiles({ km: 1 }), /set findings\.roadTiles/);
  const roads = new Roads({ store, fetch, styles });
  const started = await roads.fetchTiles({ km: 3 });
  assert.equal(started.from, 'https://maps.invalid/omt/tiles.json', 'found through the base map, the torrent part left off');
  while (roads.stats().busy) await new Promise((r) => setTimeout(r, 5));
  const s = roads.stats();
  assert.deepEqual([s.source.from, s.source.zoom, s.ways, s.lastError], ['tiles', 14, 3, null], 'the footpath is left out');
  assert.deepEqual([s.places, s.towns, s.addresses], [1, 1, 0], 'the poi and place layers too; tiles have no streets for their house numbers');
  const elm = roads.locate('Elm St', HOME);
  assert.equal(elm.lines.length, 2, 'the two tiles’ pieces are one road');
  assert.equal(roads.locate('Route 31', HOME).name, 'MA 31', 'a bare ref, numbered as its network has it');
  assert.ok(asked.some((u) => u.endsWith(`/14/${x}/${y}.pbf`)));
});
