/**
 * Roads: the names and lines of the roads around the channels, from OpenStreetMap, for Findings
 * (docs/findings.md#roads). Their names near a channel go to the model with each transmission, so a road
 * speech recognition misheard can come back as the one that's there; and the roads a finding mentions are
 * found here to be drawn on the Map.
 *
 * Fetched from an Overpass server for the area around the placed channels, or imported from a GeoJSON file
 * (osmium's export of an OpenStreetMap extract, say). An import is written beside the last one and swapped in
 * at the end, so the roads in use never stop being whole.
 */
import { createInterface } from 'node:readline';
import { features as tileFeatures, tileOf } from './mvt.js';
import * as mapPlaces from './places.js';
import { VERSION } from './updates.js';

export const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NEAR_KM = 25;           // the roads a channel's transmissions are about: within this of it
const TOWN_KM = 60;           // the towns a channel's transmissions may name: a county dispatch's are far apart
const HOUSE_KM = 0.3;         // a house of the road's name this far from its stretch is on another of that name
const MAX_SPAN_DEG = 1.5;     // the largest area fetched from Overpass in one go; bigger is a file's job
const SAME_ROAD_KM = 1.5;     // two stretches of a name this much further than the nearest are another road
const CROSSING_KM = 0.05;     // two roads this close have a corner
const JOIN_KM = 0.04;         // two stretches of a name whose ends come this close are one road (tiles cut them)
const TILE_ZOOM = 14;         // OpenMapTiles names every street from here
const MAX_TILES = 4000;
const TILE_FETCHES = 8;       // at once
const BATCH = 2000;
const WHOLE_MAX = 256 * 1024 * 1024;   // a FeatureCollection is parsed whole: no bigger than this
const CACHE_MAX = 2000;

// The keys a named place is fetched by from Overpass (places.js reads them)
const OSM_PLACE_KEYS = 'amenity|shop|leisure|tourism|office|healthcare|craft|historic|aeroway|emergency|club';
// Not roads anyone is sent to
const SKIP = /^(footway|path|cycleway|steps|bridleway|corridor|proposed|construction|abandoned|disused|platform|elevator|bus_stop|raceway|via_ferrata|bus_guideway|escape|emergency_bay|rest_area|services)$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// What an import can hold, each swapped in on its own
const KINDS = ['roads', 'places', 'addresses'];

// ---- Names ----------------------------------------------------------------

const SUFFIX = {
  st: 'street', rd: 'road', ave: 'avenue', av: 'avenue', dr: 'drive', ln: 'lane', rt: 'route', rte: 'route',
  hwy: 'highway', blvd: 'boulevard', ct: 'court', pl: 'place', pkwy: 'parkway', cir: 'circle', ter: 'terrace',
  tpke: 'turnpike', expy: 'expressway', fwy: 'freeway', sq: 'square', trl: 'trail', ext: 'extension',
  n: 'north', s: 'south', e: 'east', w: 'west',
};
// The kind of road, at the end of its name: "Elm" is what tells Elm Street from Oak Street
export const TYPES = new Set(['street', 'road', 'avenue', 'drive', 'lane', 'boulevard', 'court', 'place', 'parkway', 'circle',
  'terrace', 'way', 'trail', 'turnpike', 'pike', 'expressway', 'freeway', 'square', 'row', 'loop', 'extension', 'alley',
  'highway']);
export const DIRS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);

/** Words, lowercased, street abbreviations spelled out: "Elm St." and "elm street" read the same. */
export function words(s) {
  // Accents off first, so "Peñasco" is one word, not "pe" and "asco"
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => SUFFIX[w] ?? w).join(' ');
}

/**
 * A road's name without its kind and direction ("north elm street" is "elm"), for a name said without them or
 * misheard; null when that leaves no letters ("route 9" is only ever itself).
 * @param {string} key - words() of the name.
 * @returns {string|null} The base.
 */
export function base(key) {
  const t = key.split(' ').filter(Boolean);
  // "Ann Street East" is Ann: its kind and directions, in whatever order they come
  let typed = false;
  for (;;) {
    if (t.length > 1 && DIRS.has(t[0])) t.shift();
    else if (t.length > 1 && DIRS.has(t.at(-1))) t.pop();
    else if (t.length > 1 && !typed && TYPES.has(t.at(-1))) (t.pop(), typed = true);
    else break;
  }
  // North Street is North Street, not "street"
  if (t.every((w) => TYPES.has(w) || DIRS.has(w))) return key.split(' ').some((w) => /^\d+[a-z]?$/.test(w)) ? null : key;
  // A number is only ever itself: Route 8 isn't a mishearing of Route 9 ("5th" is a name)
  if (t.some((w) => /^\d+[a-z]?$/.test(w) && !/^\d+(st|nd|rd|th)$/.test(w))) return null;
  return t.join(' ');
}

/**
 * The ways a road's number is said: "MA 9" is Route 9, "I 290" is Interstate 290.
 * @param {string} ref - OpenStreetMap's ref, maybe several with ";".
 * @returns {string[]} words() of each.
 */
export function refNames(ref) {
  const out = [];
  for (const one of String(ref ?? '').split(';')) {
    const m = /^\s*([a-z]+)[\s-]*(\d+[a-z]?)\s*$/i.exec(one);
    if (!m) {
      if (words(one)) out.push(words(one));
      continue;
    }
    const p = m[1].toLowerCase();
    const n = m[2].toLowerCase();
    if (p === 'i') out.push(`i ${n}`, `interstate ${n}`, `route ${n}`, `highway ${n}`);
    else if (p === 'us') out.push(`us ${n}`, `us route ${n}`, `us highway ${n}`, `route ${n}`, `highway ${n}`);
    else if (['cr', 'co', 'c'].includes(p)) out.push(`county road ${n}`, `county route ${n}`, `route ${n}`);
    else out.push(`${p} ${n}`, `route ${n}`, `state route ${n}`, `highway ${n}`, `state highway ${n}`);
  }
  return out;
}

/** The phrase a road is named by in an address: "412 Elm St" is Elm Street. */
const phrase = (s) => words(s).split(' ').filter((w, i, a) => !(i < a.length - 1 && /^\d+[a-z]?$/.test(w) &&
  !['route', 'highway', 'interstate', 'i', 'us'].includes(a[i - 1]))).join(' ');

/**
 * The roads an address names: "Main St and Route 9" is two, a corner.
 * @param {string} address - As the model wrote it.
 * @returns {string[]} words() of each road.
 */
export function addressRoads(address) {
  return words(address).split(/\b(?:and|at|on|near|by|off|corner of)\b/).map((p) => phrase(p.trim())).filter(Boolean);
}

/** How many edits apart two strings are, or more than `max` once that's certain. */
export function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      low = Math.min(low, cur[j]);
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How far a misheard name can be from the real one: none for a short one, which would match anything. */
const slack = (b) => (b.length >= 8 ? 2 : b.length >= 5 ? 1 : 0);

// ---- Names said -------------------------------------------------------------

// Words said all the time: "the" isn't The Boulevard, "a" isn't A Street, "my" isn't My Way
const COMMON = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'his', 'her', 'their', 'its', 'i', 'me', 'we', 'you',
  'he', 'she', 'it', 'they', 'is', 'be', 'go', 'do', 'so', 'no', 'yes', 'ok', 'all', 'any', 'one', 'this', 'that',
  'what', 'who', 'how', 'here', 'there', 'on', 'in', 'at', 'to', 'of', 'and', 'or', 'for', 'up', 'out', 'off', 'by']);
// A name only an earlier transmission says ranks after every one the new transmission says
const CONTEXT_RANK = 10;

/** The runs of one to four words in what was said, words() of each. */
function grams(text) {
  const t = words(text).split(' ').filter(Boolean);
  const out = new Set();
  for (let n = 1; n <= 4; n++) for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' '));
  return out;
}

/**
 * How likely a road near is the one said, lower likelier: 0 its name said whole, 1 said without its kind, 2 or 3
 * a mishearing away, 4 one of several with a base said whole for another (Main Circle when "Main Street" was), 5 a
 * name only of a kind ("Circle"); null not said, or a name only of common words ("My Way").
 * @param {{key: string, base: string|null}} r - A name, from near().
 * @param {Set<string>} said - grams() of what was said.
 * @param {Set<string>} whole - The bases of the names said whole.
 * @returns {number|null}
 */
function rankOf(r, said, whole) {
  const b = r.base;
  const t = (b ?? r.key).split(' ');
  // "A Street", "The Boulevard", "My Way": said in every other sentence ("on my way")
  if (t.every((w) => COMMON.has(w))) return null;
  // "Circle" alone; not North Street
  const plain = t.length === 1 && (TYPES.has(t[0]) || DIRS.has(t[0]));
  if (said.has(r.key)) return plain ? 5 : 0;
  if (!b || plain || b.length < 3) return null;
  if (said.has(b)) return whole.has(b) ? 4 : 1;
  const max = slack(b);
  const n = b.split(' ').length;
  if (!max || n > 3) return null;
  let d = null;
  for (const g of said) {
    // "street" said isn't a mishearing of Streeter Road
    if (g.split(' ').length !== n || g.split(' ').every((w) => TYPES.has(w) || DIRS.has(w))) continue;
    const e = distance(g, b, max);
    if (e <= max && (d === null || e < d)) d = e;
    if (d === 1) break;
  }
  return d === null ? null : 1 + d;
}

/**
 * How likely a town or named place is the one said, as rankOf() for roads: 0 its name said, 1 or 2 a mishearing
 * away; null not said, or a name too plain to tell ("The Store", "AB").
 * @param {string} key - words() of its name.
 * @param {Set<string>} said - grams() of what was said.
 * @returns {number|null}
 */
function placeRank(key, said) {
  const k = key.replace(/^the /, '');
  const t = k.split(' ');
  if (k.length < 3 || t.length > 4 || t.every((w) => COMMON.has(w) || TYPES.has(w) || DIRS.has(w))) return null;
  if (said.has(key) || said.has(k)) return 0;
  const max = slack(k.replace(/ /g, ''));
  if (!max) return null;
  let d = null;
  for (const g of said) {
    if (g.split(' ').length !== t.length) continue;
    const e = distance(g, k, max);
    if (e <= max && (d === null || e < d)) d = e;
    if (d === 1) break;
  }
  return d === null ? null : d;
}

// ---- Distances ------------------------------------------------------------

/** Kilometres between two places, near enough over a county. */
function km(a, b) {
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * 111.32;
  const y = (b.lat - a.lat) * 110.57;
  return Math.hypot(x, y);
}

/** Kilometres from a place to the nearest point of a line. */
function toLine(p, line) {
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const a = { lon: line[i][0], lat: line[i][1] };
    if (i === line.length - 1) {
      best = Math.min(best, km(p, a));
      break;
    }
    const b = { lon: line[i + 1][0], lat: line[i + 1][1] };
    // The nearest point of the segment, on a flat sheet scaled to the latitude
    const k = Math.cos(p.lat * Math.PI / 180);
    const dx = (b.lon - a.lon) * k;
    const dy = b.lat - a.lat;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, (((p.lon - a.lon) * k) * dx + (p.lat - a.lat) * dy) / len)) : 0;
    best = Math.min(best, km(p, { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t }));
  }
  return best;
}

/** A box around a place, `r` km each way: [minlon, minlat, maxlon, maxlat]. */
function around(p, r) {
  const dlat = r / 110.57;
  const dlon = r / (111.32 * Math.max(0.05, Math.cos(p.lat * Math.PI / 180)));
  return [p.lon - dlon, p.lat - dlat, p.lon + dlon, p.lat + dlat];
}

// ---- Reading what's imported ------------------------------------------------

/**
 * One road from OpenStreetMap's tags and its lines.
 * @param {object} tags - Its tags.
 * @param {number[][][]} lines - Its lines, each [[lon, lat], ...].
 * @returns {object|null} {name, ref, kind, keys, lines}, or null for what isn't a road with a name.
 */
export function road(tags, lines) {
  if (!tags || (tags.highway && SKIP.test(tags.highway)) || tags.area === 'yes') return null;
  const named = ['name', 'alt_name', 'official_name', 'short_name', 'loc_name', 'old_name']
    .flatMap((k) => String(tags[k] ?? '').split(';')).map((s) => s.trim()).filter(Boolean);
  const keys = [...new Set([...named.map(words), ...refNames(tags.ref)].filter(Boolean))];
  const kept = (lines ?? []).map((l) => l.filter((c) => Number.isFinite(c?.[0]) && Number.isFinite(c?.[1]))
    .map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6])).filter((l) => l.length >= 2);
  if (!keys.length || !kept.length) return null;
  const ref = tags.ref ? String(tags.ref).trim() : null;
  return { name: named[0] ?? ref.split(';')[0].replace(/^([a-z]+)[\s-]*/i, '$1 '), ref, kind: tags.highway ?? null, keys, lines: kept };
}

/** A GeoJSON feature (osmium export, overpass turbo, any) as a road. */
export function fromFeature(f) {
  const g = f?.geometry;
  const lines = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : null;
  if (!lines) return null;
  const p = f.properties ?? {};
  return road(p.tags && typeof p.tags === 'object' ? p.tags : p, lines);
}

/** A road number as it's written ("MA 31", "I 190"), from OpenMapTiles' bare ref and its network. */
function tileRef(p) {
  const ref = String(p.ref ?? '').trim();
  if (!ref || !/^\d+[a-z]?$/i.test(ref)) return ref || null;
  const net = String(p.network ?? '');
  if (net === 'us-interstate') return `I ${ref}`;
  if (net === 'us-highway') return `US ${ref}`;
  const state = /^US:([A-Z]{2})$/.exec(String(p.route_1_network ?? ''))?.[1];
  return `${state ?? (net === 'us-state' ? 'SR' : 'Route')} ${ref}`;
}

/** A transportation_name feature from OpenMapTiles' tiles as a road; its class stands for OSM's highway. */
export const fromTile = (p, lines) => road({
  highway: p.class === 'path' ? 'path' : p.class, name: p.name ?? p.name_en ?? p['name:latin'], ref: tileRef(p),
}, lines);

/** An Overpass way, from `out tags geom`, as a road. */
export const fromOverpass = (e) => (e?.type === 'way' && Array.isArray(e.geometry)
  ? road(e.tags, [e.geometry.map((c) => [c.lon, c.lat])]) : null);

/**
 * What an import gathers, written a batch at a time. Tiles and Overpass list a place more than once (a tile's
 * buffer, a shop that's an address too): `once` keeps each once.
 */
class Batch {
  constructor(write, { once = false } = {}) {
    this.out = write;
    this.seen = once ? new Set() : null;
    this.clear();
  }

  clear() {
    this.roads = [];
    this.places = [];
    this.addresses = [];
  }

  first(k) {
    if (!this.seen) return true;
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }

  road(r) {
    if (r) this.roads.push(r);
    this.check();
  }

  other({ place, addresses }) {
    // To about 10 m: neighbouring tiles put their copies a pixel apart
    const at = (x) => `${x.lon.toFixed(4)},${x.lat.toFixed(4)}`;
    if (place && this.first(`p|${place.kind}|${place.key}|${at(place)}`)) this.places.push(place);
    for (const a of addresses) if (this.first(`a|${a.key}|${a.number}|${at(a)}`)) this.addresses.push(a);
    this.check();
  }

  feature(f) {
    this.road(fromFeature(f));
    this.other(mapPlaces.fromFeature(f));
  }

  check() {
    if (this.roads.length + this.places.length + this.addresses.length >= BATCH) this.flush();
  }

  flush() {
    if (this.roads.length || this.places.length || this.addresses.length) {
      this.out({ roads: this.roads, places: this.places, addresses: this.addresses });
    }
    this.clear();
  }
}

export class Roads {
  /**
   * @param {object} o - Dependencies.
   * @param {import('./store.js').Store} o.store - Settings, and the channels' places.
   * @param {string} [o.overpass] - The Overpass server: the settings file's findings.overpass.
   * @param {string} [o.tiles] - The road tiles' TileJSON: the settings file's findings.roadTiles; otherwise the
   *   OpenMapTiles source of the Map's base maps.
   * @param {{url: string}[]} [o.styles] - The Map's base maps (map.styles), where those tiles are found.
   * @param {typeof fetch} [o.fetch] - For tests.
   * @param {() => number} [o.now] - The clock, for tests.
   */
  constructor({ store, overpass, tiles, styles = [], fetch = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    this.db = store.db;
    this.overpass = overpass || OVERPASS;
    this.tiles = tiles || null;
    this.styles = styles;
    this.fetch = fetch;
    this.now = now;
    this.busy = null;
    this.cache = new Map();
    this.db.exec(`
      -- The roads around the channels (docs/findings.md#roads). gen tells an import underway from the one in use.
      CREATE TABLE IF NOT EXISTS roads (
        id INTEGER PRIMARY KEY AUTOINCREMENT, gen INTEGER NOT NULL,
        name TEXT NOT NULL, ref TEXT, kind TEXT, coords TEXT NOT NULL,
        a TEXT NOT NULL, b TEXT NOT NULL,
        minlon REAL NOT NULL, minlat REAL NOT NULL, maxlon REAL NOT NULL, maxlat REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS roads_box ON roads(gen, minlat, maxlat);
      CREATE TABLE IF NOT EXISTS road_names (road_id INTEGER NOT NULL, key TEXT NOT NULL, base TEXT);
      CREATE INDEX IF NOT EXISTS road_names_key ON road_names(key);
      CREATE INDEX IF NOT EXISTS road_names_base ON road_names(base);
      CREATE INDEX IF NOT EXISTS road_names_road ON road_names(road_id);
      -- Towns and named places (docs/findings.md#places-and-addresses); kind is 'town' or 'place'
      CREATE TABLE IF NOT EXISTS places (
        id INTEGER PRIMARY KEY AUTOINCREMENT, gen INTEGER NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, key TEXT NOT NULL, class TEXT, street TEXT, lon REAL NOT NULL, lat REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS places_box ON places(gen, kind, lat);
      CREATE INDEX IF NOT EXISTS places_key ON places(key);
      -- House numbers: key is words() of the street
      CREATE TABLE IF NOT EXISTS addresses (
        gen INTEGER NOT NULL, number TEXT NOT NULL, street TEXT NOT NULL, key TEXT NOT NULL, town TEXT,
        lon REAL NOT NULL, lat REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS addresses_street ON addresses(key, number);
      CREATE INDEX IF NOT EXISTS addresses_gen ON addresses(gen);`);
  }

  /** The import in use of roads, places or addresses: each is swapped in on its own. */
  gen(kind = 'roads') {
    return Number(this.store.setting(`${kind}.gen`) ?? 0);
  }

  /** What's imported, and an import underway. */
  stats() {
    const g = this.gen();
    const about = JSON.parse(this.store.setting('roads.source') ?? 'null');
    const count = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    const pg = this.gen('places');
    return {
      ways: count('SELECT count(*) AS n FROM roads WHERE gen = ?', g),
      names: count(`SELECT count(DISTINCT n.key) AS n FROM road_names n JOIN roads r ON r.id = n.road_id
                     WHERE r.gen = ?`, g),
      source: about,
      places: count("SELECT count(*) AS n FROM places WHERE gen = ? AND kind = 'place'", pg),
      towns: count("SELECT count(*) AS n FROM places WHERE gen = ? AND kind = 'town'", pg),
      placesSource: JSON.parse(this.store.setting('places.source') ?? 'null'),
      addresses: count('SELECT count(*) AS n FROM addresses WHERE gen = ?', this.gen('addresses')),
      addressesSource: JSON.parse(this.store.setting('addresses.source') ?? 'null'),
      busy: this.busy && { from: this.busy.from, startedAt: this.busy.startedAt, read: this.busy.read, tiles: this.busy.tiles,
        downloaded: this.busy.downloaded, places: this.busy.places, addresses: this.busy.addresses },
      lastError: this.lastError ?? null,
      overpass: this.overpass,
    };
  }

  // ---- Importing ------------------------------------------------------------

  /** Start an import; one at a time. */
  begin(from) {
    if (this.busy) throw fail(`roads are being ${this.busy.from === 'file' ? 'imported' : 'fetched'} already`, 409);
    const gen = Math.max(...KINDS.map((k) => this.gen(k))) + 1;
    this.drop('>=', gen);
    this.busy = { from, gen, startedAt: this.now(), read: 0, places: 0, addresses: 0 };
    this.lastError = null;
    return this.busy;
  }

  /** Delete what an import wrote, of every kind: gens `op` gen. */
  drop(op, gen, kinds = KINDS) {
    if (kinds.includes('roads')) {
      this.db.prepare(`DELETE FROM road_names WHERE road_id IN (SELECT id FROM roads WHERE gen ${op} ?)`).run(gen);
      this.db.prepare(`DELETE FROM roads WHERE gen ${op} ?`).run(gen);
    }
    if (kinds.includes('places')) this.db.prepare(`DELETE FROM places WHERE gen ${op} ?`).run(gen);
    if (kinds.includes('addresses')) this.db.prepare(`DELETE FROM addresses WHERE gen ${op} ?`).run(gen);
  }

  /**
   * Write into the import underway: no await inside, so nothing else's writes join in.
   * @param {object[]|{roads?: object[], places?: object[], addresses?: object[]}} what - road()s; or those, and
   *   places.place()s and places.addresses().
   */
  write(what) {
    const { roads = [], places: named = [], addresses: houses = [] } = Array.isArray(what) ? { roads: what } : what;
    const { gen } = this.busy;
    const ins = this.db.prepare(`INSERT INTO roads (gen, name, ref, kind, coords, a, b, minlon, minlat, maxlon, maxlat)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const nm = this.db.prepare('INSERT INTO road_names (road_id, key, base) VALUES (?, ?, ?)');
    const pl = this.db.prepare('INSERT INTO places (gen, kind, name, key, class, street, lon, lat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const ad = this.db.prepare('INSERT INTO addresses (gen, number, street, key, town, lon, lat) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const r of roads) {
        for (const line of r.lines) {
          const xs = line.map((c) => c[0]);
          const ys = line.map((c) => c[1]);
          const { lastInsertRowid: id } = ins.run(gen, r.name, r.ref, r.kind, JSON.stringify(line),
            line[0].join(','), line.at(-1).join(','), Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
          for (const k of r.keys) nm.run(id, k, base(k));
        }
      }
      for (const p of named) pl.run(gen, p.kind, p.name, p.key, p.class, p.street, p.lon, p.lat);
      for (const a of houses) ad.run(gen, a.number, a.street, a.key, a.town, a.lon, a.lat);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.busy.read += roads.length;
    this.busy.places += named.length;
    this.busy.addresses += houses.length;
  }

  /**
   * Swap the import in, or throw it away. Each kind it has replaces that kind's last import; a kind it hasn't (an
   * address file has no roads) keeps the one there.
   */
  finish(about, error) {
    const { gen } = this.busy;
    this.busy = null;
    if (error) {
      this.drop('=', gen);
      this.lastError = { at: this.now(), error: error.message };
      throw error;
    }
    const n = {
      roads: this.db.prepare('SELECT count(*) AS n FROM roads WHERE gen = ?').get(gen).n,
      places: this.db.prepare('SELECT count(*) AS n FROM places WHERE gen = ?').get(gen).n,
      addresses: this.db.prepare('SELECT count(*) AS n FROM addresses WHERE gen = ?').get(gen).n,
    };
    if (!n.roads && !n.places && !n.addresses) {
      this.lastError = { at: this.now(), error: 'there were no named roads, places or addresses in it' };
      throw fail('there were no named roads, places or addresses in it: nothing was changed');
    }
    this.db.exec('BEGIN');
    try {
      for (const k of KINDS.filter((x) => n[x])) {
        this.store.setSetting(`${k}.gen`, gen);
        this.store.setSetting(`${k}.source`, JSON.stringify({ ...about, at: this.now(), ...(k === 'roads' ? { ways: n.roads } : { count: n[k] }) }));
        this.drop('<', gen, [k]);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.cache.clear();
    return this.stats();
  }

  /**
   * Import roads: replaces those there.
   * @param {Iterable<object>} list - road()s.
   * @param {object} about - Where they came from, for stats().
   * @returns {object} stats().
   */
  load(list, about) {
    this.begin(about.from);
    try {
      const all = [...list].filter(Boolean);
      for (let i = 0; i < all.length; i += BATCH) this.write(all.slice(i, i + BATCH));
    } catch (e) {
      return this.finish(about, e);
    }
    return this.finish(about);
  }

  /**
   * Import a GeoJSON file as it arrives: one feature a line (GeoJSONSeq, as `osmium export -f geojsonseq` writes),
   * or a FeatureCollection.
   * @param {import('node:stream').Readable} input - The file.
   * @param {string} [name] - What it was called.
   * @returns {Promise<object>} stats().
   */
  async importStream(input, name = 'a file', from = 'file') {
    this.begin(from);
    let mode = null;
    let whole = '';
    const batch = new Batch((b) => this.write(b));
    let n = 0;
    try {
      for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
        n++;
        if (mode === 'whole') {
          whole += `${raw}\n`;
          if (whole.length > WHOLE_MAX) throw fail('a FeatureCollection that big can’t be read whole: export it as GeoJSONSeq (one feature a line)', 413);
          continue;
        }
        const line = raw.replace(/^\x1e/, '').trim();
        if (!line) continue;
        let f = null;
        try {
          f = JSON.parse(line);
        } catch { /* not a line of its own */ }
        if (mode === null) mode = f?.type === 'Feature' ? 'seq' : 'whole';
        if (mode === 'whole') {
          whole = `${raw}\n`;
          continue;
        }
        if (f?.type !== 'Feature') throw fail(`line ${n} isn’t a GeoJSON feature`);
        batch.feature(f);
      }
      if (mode === 'whole') {
        let doc;
        try {
          doc = JSON.parse(whole);
        } catch {
          throw fail('that isn’t GeoJSON: a FeatureCollection, or one feature a line');
        }
        whole = '';
        const features = doc?.type === 'FeatureCollection' ? doc.features : doc?.type === 'Feature' ? [doc] : null;
        if (!Array.isArray(features)) throw fail('that isn’t GeoJSON: a FeatureCollection, or one feature a line');
        for (const f of features) batch.feature(f);
      }
      batch.flush();
    } catch (e) {
      return this.finish(null, e);
    }
    return this.finish({ from, name: String(name).slice(0, 200) });
  }

  /**
   * Fetch the roads within `radius` km of the placed channels from Overpass, in the background.
   * @param {{km?: number}} o - How far around.
   * @returns {{started: true}} Under way; stats() says how it went.
   */
  fetchOsm({ km: radius = NEAR_KM } = {}) {
    const r = Number(radius);
    if (!Number.isFinite(r) || r < 1 || r > 60) throw fail('fetch roads 1 to 60 km around the channels');
    const places = this.places();
    if (!places.length) throw fail('place a channel on the map first: the roads fetched are those around the channels');
    const boxes = places.map((p) => around(p, r));
    const box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
    if (box[2] - box[0] > MAX_SPAN_DEG || box[3] - box[1] > MAX_SPAN_DEG) {
      throw fail(`the channels are spread too widely to fetch in one go; import a file made from an OpenStreetMap extract instead`);
    }
    this.begin('openstreetmap');
    const [w, s, e, n] = box.map((v) => v.toFixed(5));
    const bbox = `(${s},${w},${n},${e})`;
    const query = `[out:json][timeout:240];way["highway"][~"^(name|ref)$"~"."]${bbox};out tags geom qt;`
      + `nwr["place"]["name"]${bbox};out tags center qt;`
      + `nwr["name"][~"^(${OSM_PLACE_KEYS})$"~"."]${bbox};out tags center qt;`
      + `nwr["addr:housenumber"]["addr:street"]${bbox};out tags center qt;`;
    const about = { from: 'openstreetmap', server: this.overpass, km: r, box: box.map((v) => Number(v.toFixed(5))) };
    (async () => {
      let elements;
      try {
        let res;
        try {
          res = await this.fetch(this.overpass, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `AirScribe/${VERSION}` },
            body: new URLSearchParams({ data: query }).toString(),
            signal: AbortSignal.timeout(300_000),
          });
        } catch (err) {
          throw new Error(`can’t reach ${this.overpass}: ${err.cause?.message ?? err.message}`);
        }
        if (!res.ok) throw new Error(`${this.overpass} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        elements = (await res.json()).elements ?? [];
        const batch = new Batch((b) => this.write(b), { once: true });
        for (const el of elements) {
          if (el.geometry) batch.road(fromOverpass(el));
          else batch.other(mapPlaces.fromOverpass(el));
        }
        batch.flush();
      } catch (err) {
        try { this.finish(about, err); } catch { /* kept in lastError */ }
        console.error(`[roads] ${err.message}`);
        return;
      }
      try { this.finish(about); } catch (err) { console.error(`[roads] ${err.message}`); }
    })();
    return { started: true };
  }

  /**
   * The TileJSON whose tiles have OpenMapTiles' transportation_name: the settings file's, or the first the Map's
   * base maps use.
   * @returns {Promise<{url: string, tilejson: object}>} It.
   */
  async tileSource() {
    const get = async (url) => {
      const res = await this.fetch(url, { headers: { 'User-Agent': `AirScribe/${VERSION}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return res.json();
    };
    const named = (tj) => (tj.vector_layers ?? []).some((l) => l.id === 'transportation_name');
    if (this.tiles) {
      const tilejson = await get(this.tiles);
      if (!named(tilejson)) throw fail(`${this.tiles} has no transportation_name layer: it isn’t OpenMapTiles`);
      return { url: this.tiles, tilejson };
    }
    for (const style of this.styles) {
      let doc;
      try {
        doc = await get(style.url);
      } catch {
        continue;
      }
      for (const src of Object.values(doc?.sources ?? {})) {
        if (src?.type !== 'vector') continue;
        // An inline source, or a TileJSON's address (less anything after # a torrent-aware client reads)
        const tilejson = src.tiles ? src : await get(new URL(String(src.url).split('#')[0], style.url).href).catch(() => null);
        if (tilejson && named(tilejson)) return { url: src.tiles ? style.url : String(src.url).split('#')[0], tilejson };
      }
    }
    throw fail('none of the Map’s base maps uses OpenMapTiles tiles: set findings.roadTiles in the settings file');
  }

  /**
   * Read the roads within `radius` km of the placed channels from the Map's own OpenMapTiles tiles (zoom 14, the
   * transportation_name layer), in the background: the same tiles MaplibreNativeRouting routes on.
   * @param {{km?: number}} o - How far around.
   * @returns {Promise<{started: true, tiles: number, from: string}>} Under way; stats() says how it went.
   */
  async fetchTiles({ km: radius = NEAR_KM } = {}) {
    const r = Number(radius);
    if (!Number.isFinite(r) || r < 1 || r > 60) throw fail('read roads 1 to 60 km around the channels');
    const places = this.places();
    if (!places.length) throw fail('place a channel on the map first: the roads read are those around the channels');
    if (this.busy) throw fail('roads are being read already', 409);
    const { url, tilejson } = await this.tileSource();
    const template = tilejson.tiles?.[0];
    if (!template) throw fail(`${url} lists no tiles`);
    const z = Math.min(TILE_ZOOM, Number(tilejson.maxzoom ?? TILE_ZOOM));
    const want = new Map();
    for (const p of places) {
      const [w, s, e, n] = around(p, r);
      const a = tileOf(w, n, z);
      const b = tileOf(e, s, z);
      for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) want.set(`${x}/${y}`, { x, y });
    }
    if (want.size > MAX_TILES) throw fail(`that’s ${want.size} tiles: read fewer km around the channels`);
    const base = new URL(url);
    const tileUrl = ({ x, y }) => new URL(template.replace('{z}', z).replace('{x}', x)
      .replace('{y}', tilejson.scheme === 'tms' ? 2 ** z - 1 - y : y), base).href;
    this.begin('tiles');
    const busy = this.busy;
    busy.tiles = `0 of ${want.size}`;
    const about = { from: 'tiles', tilejson: url, km: r, zoom: z, count: want.size };
    (async () => {
      const queue = [...want.values()];
      let done = 0;
      let failed = 0;
      const batch = new Batch((b) => this.write(b), { once: true });
      const worker = async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          let feats = [];
          try {
            const res = await this.fetch(tileUrl(t), { headers: { 'User-Agent': `AirScribe/${VERSION}` }, signal: AbortSignal.timeout(30_000) });
            if (res.status !== 204 && res.status !== 404) {
              if (!res.ok) throw new Error(`${res.status}`);
              feats = tileFeatures(Buffer.from(await res.arrayBuffer()), { z, ...t }, ['transportation_name', 'poi', 'place']);
            }
          } catch {
            failed++;
          }
          // Written between fetches, with nothing awaited inside: nothing else's writes join in
          for (const f of feats) {
            if (f.lines && f.layer === 'transportation_name') batch.road(fromTile(f.props, f.lines));
            else if (f.points) for (const p of f.points) batch.other(mapPlaces.fromTile(f.layer, f.props, p.map((v) => Math.round(v * 1e6) / 1e6)));
          }
          batch.flush();
          busy.tiles = `${++done} of ${want.size}`;
        }
      };
      try {
        await Promise.all(Array.from({ length: TILE_FETCHES }, worker));
        if (failed > want.size / 10) throw new Error(`${failed} of ${want.size} tiles couldn’t be read from ${base.host}`);
      } catch (err) {
        try { this.finish(about, err); } catch { /* kept in lastError */ }
        console.error(`[roads] ${err.message}`);
        return;
      }
      try { this.finish({ ...about, failed }); } catch (err) { console.error(`[roads] ${err.message}`); }
    })();
    return { started: true, tiles: want.size, from: url };
  }

  /** Delete every road, place and address. */
  clear() {
    if (this.busy) throw fail('roads are being imported: wait for that to finish', 409);
    this.db.exec('DELETE FROM road_names; DELETE FROM roads; DELETE FROM places; DELETE FROM addresses;');
    for (const k of KINDS) this.store.setSetting(`${k}.source`, null);
    this.cache.clear();
    return this.stats();
  }

  // ---- Finding them ---------------------------------------------------------

  /** @returns {{lat: number, lon: number}[]} The channels placed on the map. */
  places() {
    return this.db.prepare('SELECT lat, lon FROM channel_places WHERE lat IS NOT NULL AND lon IS NOT NULL').all()
      .map((r) => ({ lat: r.lat, lon: r.lon }));
  }

  /**
   * Where a channel's roads are looked for: its place on the map, or the middle of the channels placed.
   * @param {string|null} channel - Its name.
   * @returns {{lat: number, lon: number}|null} The place, or null when no channel is placed.
   */
  where(channel) {
    const p = channel && this.db.prepare('SELECT lat, lon FROM channel_places WHERE name = ?').get(channel);
    if (p && p.lat !== null && p.lon !== null) return { lat: p.lat, lon: p.lon };
    const all = this.places();
    if (!all.length) return null;
    return { lat: all.reduce((s, x) => s + x.lat, 0) / all.length, lon: all.reduce((s, x) => s + x.lon, 0) / all.length };
  }

  remember(key, make) {
    const k = `${this.gen()}|${key}`;
    if (this.cache.has(k)) return this.cache.get(k);
    const v = make();
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(k, v);
    return v;
  }

  /**
   * The roads' names within `r` km of a place, each once.
   * @param {{lat: number, lon: number}} at - The place.
   * @param {number} [r] - How far.
   * @returns {{key: string, base: string|null, name: string}[]} Names.
   */
  near(at, r = NEAR_KM) {
    return this.remember(`near|${at.lat.toFixed(3)},${at.lon.toFixed(3)},${r}`, () => {
      const [w, s, e, n] = around(at, r);
      const seen = new Map();
      for (const row of this.db.prepare(`
          SELECT n.key, n.base, r.name FROM roads r JOIN road_names n ON n.road_id = r.id
           WHERE r.gen = ? AND r.minlat <= ? AND r.maxlat >= ? AND r.minlon <= ? AND r.maxlon >= ?`)
        .all(this.gen(), n, s, e, w)) {
        if (!seen.has(row.key)) seen.set(row.key, { key: row.key, base: row.base, name: row.name });
      }
      return [...seen.values()];
    });
  }

  /**
   * The roads near a channel whose names, or something like them, are in what was said: given to the model so
   * it can write a misheard road as the one that's there. Likeliest first, as rankOf() has it, and the new
   * transmission's before those only the earlier ones say, so the few sent are the ones that matter.
   * @param {string} text - The new transmission: its readings.
   * @param {{lat: number, lon: number}|null} at - Where the channel is.
   * @param {{max?: number, context?: string}} [o] - How many; and the earlier transmissions, for the names they say.
   * @returns {string[]} Road names.
   */
  hint(text, at, { max = 25, context = '' } = {}) {
    if (!at) return [];
    const near = this.near(at);
    const best = new Map();
    for (const [said, after] of [[grams(text), 0], [grams(context), CONTEXT_RANK]]) {
      // A name said whole ("Main Street") makes the others with its base (Main Circle) less likely
      const whole = new Set(near.filter((r) => r.base && said.has(r.key)).map((r) => r.base));
      for (const r of near) {
        const rank = rankOf(r, said, whole);
        if (rank !== null && !(best.get(r.name) <= rank + after)) best.set(r.name, rank + after);
      }
    }
    return [...best].sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0])).slice(0, max).map(([name]) => name);
  }

  // ---- Places, towns and addresses ---------------------------------------------

  /**
   * The towns, or the named places, within `r` km of a place.
   * @param {'town'|'place'} kind - Which.
   * @param {{lat: number, lon: number}} at - The place.
   * @param {number} [r] - How far.
   * @returns {{name: string, key: string, class: string, street: string|null, lon: number, lat: number, km: number}[]}
   */
  placesNear(kind, at, r = kind === 'town' ? TOWN_KM : NEAR_KM) {
    return this.remember(`places|${kind}|${at.lat.toFixed(3)},${at.lon.toFixed(3)},${r}`, () => {
      const [w, s, e, n] = around(at, r);
      return this.db.prepare(`SELECT name, key, class, street, lon, lat FROM places
                               WHERE gen = ? AND kind = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`)
        .all(this.gen('places'), kind, s, n, w, e)
        .map((p) => ({ ...p, km: km(at, p) })).filter((p) => p.km <= r).sort((a, b) => a.km - b.km);
    });
  }

  /**
   * The towns and named places near a channel whose names, or something like them, were said: for the model, so a
   * misheard business or town comes back as the one that's there. Likeliest first, then nearest.
   * @param {string} text - The new transmission: its readings.
   * @param {{lat: number, lon: number}|null} at - Where the channel is.
   * @param {{max?: number}} [o] - How many.
   * @returns {{kind: 'town'|'place', name: string, class: string, street: string|null, lon: number, lat: number,
   *   rank: number}[]}
   */
  placeHint(text, at, { max = 12 } = {}) {
    if (!at) return [];
    const said = grams(text);
    const out = [];
    for (const kind of ['town', 'place']) {
      for (const p of this.placesNear(kind, at)) {
        const rank = placeRank(p.key, said);
        if (rank !== null) out.push({ kind, name: p.name, class: p.class, street: p.street, lon: p.lon, lat: p.lat, rank, km: p.km });
      }
    }
    const seen = new Set();
    return out.sort((a, b) => a.rank - b.rank || a.km - b.km)
      .filter((p) => !seen.has(`${p.kind}|${p.name}`) && seen.add(`${p.kind}|${p.name}`)).slice(0, max);
  }

  /**
   * The town or named place a name means, near a place: the nearest one with that name, or with one a mishearing
   * from it.
   * @param {string} said - As the model wrote it.
   * @param {{lat: number, lon: number}|null} at - Where the channel is.
   * @param {'town'|'place'} kind - Which.
   * @returns {{name: string, level: 'exact'|'fuzzy', point: [number, number], km: number}|null}
   */
  findPlace(said, at, kind) {
    const key = words(said).replace(/^the /, '');
    if (!at || !key) return null;
    let best = null;
    for (const p of this.placesNear(kind, at)) {
      const k = p.key.replace(/^the /, '');
      const max = slack(k.replace(/ /g, ''));
      const d = k === key ? 0 : max && Math.abs(k.length - key.length) <= max ? distance(k, key, max) : max + 1;
      if (d <= max && (!best || d < best.d)) best = { d, p };
      if (d === 0) break;
    }
    return best && { name: best.p.name, level: best.d ? 'fuzzy' : 'exact', point: [best.p.lon, best.p.lat], km: best.p.km };
  }

  /**
   * The house numbers a street has near a place, from the addresses imported.
   * @param {string} street - Its name, as words() or as written.
   * @param {{lat: number, lon: number}} at - Near where.
   * @param {number} [r] - How far.
   * @returns {{number: string, lon: number, lat: number, km: number}[]} Nearest first; [] when none are known.
   */
  housesOn(street, at, r = NEAR_KM) {
    const key = words(street);
    return this.remember(`houses|${key}|${at.lat.toFixed(3)},${at.lon.toFixed(3)},${r}`, () =>
      this.db.prepare('SELECT number, lon, lat FROM addresses WHERE key = ? AND gen = ?').all(key, this.gen('addresses'))
        .map((a) => ({ ...a, km: km(at, a) })).filter((a) => a.km <= r).sort((a, b) => a.km - b.km));
  }

  /**
   * A house: the address with that number on a road found by locate(), the one nearest the road's stretch.
   * @param {string} number - Its number.
   * @param {{name: string, lines: number[][][]}} road - From locate().
   * @param {{lat: number, lon: number}} at - Where the channel is.
   * @returns {[number, number]|null} [lon, lat], or null.
   */
  house(number, road, at) {
    const n = mapPlaces.houseNumber(number);
    if (!n || !at) return null;
    let best = null;
    for (const h of this.housesOn(road.name, at)) {
      if (h.number !== n) continue;
      const d = Math.min(...road.lines.map((l) => toLine(h, l)));
      if (d <= HOUSE_KM && (!best || d < best.d)) best = { d, at: [h.lon, h.lat] };
    }
    return best?.at ?? null;
  }

  /**
   * The house numbers said before a road near the channel, checked against the addresses imported: whether each is
   * there, and the street's numbers when it isn't. Only streets with addresses imported are checked.
   * @param {string[]} texts - The new transmission's readings.
   * @param {string[]} roadNames - The roads near it said (hint()).
   * @param {{lat: number, lon: number}|null} at - Where the channel is.
   * @returns {{number: string, road: string, there: boolean, low?: number, high?: number}[]}
   */
  checkAddresses(texts, roadNames, at) {
    if (!at || !roadNames.length) return [];
    const roads = roadNames.map((name) => ({ name, key: words(name), base: base(words(name)) }));
    const out = new Map();
    for (const text of texts) {
      const t = words(text).split(' ').filter(Boolean);
      t.forEach((w, i) => {
        const n = mapPlaces.houseNumber(w);
        if (!n) return;
        // The road named in the next few words: "16 Roxbury Street", "16 Roxbury", "1616 Roxbury Street"
        const after = t.slice(i + 1, i + 6).join(' ');
        const r = roads.find((x) => after === x.key || after.startsWith(`${x.key} `))
          ?? roads.find((x) => x.base && (after === x.base || after.startsWith(`${x.base} `)));
        if (!r || out.has(`${n}|${r.key}`)) return;
        const houses = this.housesOn(r.key, at);
        if (!houses.length) return;
        const there = houses.some((h) => h.number === n);
        const nums = houses.map((h) => parseInt(h.number, 10)).filter(Number.isFinite);
        out.set(`${n}|${r.key}`, { number: n, road: r.name, key: r.key, there,
          ...(there ? {} : { low: Math.min(...nums), high: Math.max(...nums) }) });
      });
    }
    return [...out.values()];
  }

  /**
   * The road a name means, near a place: the stretch of it nearest, with any carrying on from it.
   * @param {string} said - As the model wrote it ("Elm St", "Route 9").
   * @param {{lat: number, lon: number}|null} at - Where the channel is; null to look everywhere.
   * @param {number} [r] - How far from the channel to look.
   * @returns {{name: string, said: string, level: 'exact'|'base'|'fuzzy', km: number|null, ids: number[],
   *   lines: number[][][], all?: boolean}|null} The road, or null.
   */
  locate(said, at, r = NEAR_KM) {
    const key = phrase(said);
    if (!key) return null;
    const placeKey = at ? `${at.lat.toFixed(3)},${at.lon.toFixed(3)}` : '-';
    return this.remember(`locate|${key}|${placeKey}|${r}`, () => {
      const g = this.gen();
      const rows = (col, v) => this.db.prepare(`
          SELECT DISTINCT r.id, r.name, r.ref, r.coords, r.a, r.b FROM road_names n JOIN roads r ON r.id = n.road_id
           WHERE n.${col} = ? AND r.gen = ?`).all(v, g);
      const b = base(key);
      let level = 'exact';
      let found = rows('key', key);
      if (!found.length && b) {
        level = 'base';
        found = rows('base', b);
      }
      if (found.length && at) found = found.filter((x) => toLine(at, JSON.parse(x.coords)) <= r);
      if (!found.length && b && at && slack(b)) {
        // Misheard: the nearest name a letter or two from it
        let best = null;
        for (const n of this.near(at, r)) {
          if (!n.base) continue;
          const d = distance(b, n.base, slack(b));
          if (d <= slack(b) && (!best || d < best.d)) best = { d, base: n.base };
        }
        if (best) {
          level = 'fuzzy';
          found = rows('base', best.base).filter((x) => toLine(at, JSON.parse(x.coords)) <= r);
        }
      }
      if (!found.length) return null;
      const road = this.nearest(found, at);
      // Found by its number: called by it, with the street's own name ("MA 31 (Paxton Road)")
      const numbered = found.find((x) => x.ref && refNames(x.ref).includes(key));
      if (numbered) {
        const ref = numbered.ref.split(';')[0].trim();
        road.name = road.name === ref ? ref : `${ref} (${road.name})`;
      }
      return { said, level, ...road };
    });
  }

  /** Of the stretches of a name, those joined to each other nearest the place (Main Street in this town, not the next). */
  nearest(found, at) {
    const parent = new Map(found.map((x) => [x.id, x.id]));
    const root = (i) => (parent.get(i) === i ? i : (parent.set(i, root(parent.get(i))), parent.get(i)));
    const byEnd = new Map();
    for (const x of found) {
      for (const end of [x.a, x.b]) {
        if (byEnd.has(end)) parent.set(root(x.id), root(byEnd.get(end)));
        else byEnd.set(end, x.id);
      }
    }
    const rows = found.map((x) => {
      const line = JSON.parse(x.coords);
      const ends = [line[0], line.at(-1)].map(([lon, lat]) => ({ lon, lat }));
      const [w, s, e, n] = [Math.min(...line.map((c) => c[0])), Math.min(...line.map((c) => c[1])),
        Math.max(...line.map((c) => c[0])), Math.max(...line.map((c) => c[1]))];
      return { ...x, line, ends, box: [w - 0.001, s - 0.001, e + 0.001, n + 0.001] };
    });
    // A road a tile's edge cut in two: one piece's end lies on the other, near enough
    if (rows.length <= 600) {
      for (const p of rows) {
        for (const q of rows) {
          if (p === q || root(p.id) === root(q.id)) continue;
          if (p.ends.some((c) => c.lon >= q.box[0] && c.lon <= q.box[2] && c.lat >= q.box[1] && c.lat <= q.box[3] &&
            toLine(c, q.line) <= JOIN_KM)) parent.set(root(p.id), root(q.id));
        }
      }
    }
    const groups = new Map();
    for (const x of rows) {
      const k = root(x.id);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    let list = [...groups.values()].map((members) => ({
      members, km: at ? Math.min(...members.map((m) => toLine(at, m.line))) : null,
    }));
    if (at) {
      const best = Math.min(...list.map((x) => x.km));
      list = list.filter((x) => x.km <= best + SAME_ROAD_KM);
    }
    const members = list.flatMap((x) => x.members).sort((x, y) => x.id - y.id);
    return {
      name: members[0].name,
      km: at ? Math.min(...list.map((x) => x.km)) : null,
      ids: members.map((m) => m.id),
      lines: members.map((m) => m.line),
      ...(at ? {} : { all: list.length > 1 }),
    };
  }

  /**
   * Where two roads meet: the nearest points of the two, if they come within a few metres.
   * @param {{lines: number[][][]}} p - One road, from locate().
   * @param {{lines: number[][][]}} q - The other.
   * @returns {[number, number]|null} [lon, lat], or null.
   */
  corner(p, q) {
    let best = null;
    for (const a of p.lines) {
      for (const c of a) {
        const pt = { lon: c[0], lat: c[1] };
        for (const b of q.lines) {
          const d = toLine(pt, b);
          if (d <= CROSSING_KM && (!best || d < best.d)) best = { d, at: c };
        }
      }
    }
    return best?.at ?? null;
  }
}
