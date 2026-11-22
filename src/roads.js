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
import { VERSION } from './updates.js';

export const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NEAR_KM = 25;           // the roads a channel's transmissions are about: within this of it
const MAX_SPAN_DEG = 1.5;     // the largest area fetched from Overpass in one go; bigger is a file's job
const SAME_ROAD_KM = 1.5;     // two stretches of a name this much further than the nearest are another road
const CROSSING_KM = 0.05;     // two roads this close have a corner
const BATCH = 2000;
const WHOLE_MAX = 256 * 1024 * 1024;   // a FeatureCollection is parsed whole: no bigger than this
const CACHE_MAX = 2000;

// Not roads anyone is sent to
const SKIP = /^(footway|path|cycleway|steps|bridleway|corridor|proposed|construction|abandoned|disused|platform|elevator|bus_stop|raceway|via_ferrata|bus_guideway|escape|emergency_bay|rest_area|services)$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---- Names ----------------------------------------------------------------

const SUFFIX = {
  st: 'street', rd: 'road', ave: 'avenue', av: 'avenue', dr: 'drive', ln: 'lane', rt: 'route', rte: 'route',
  hwy: 'highway', blvd: 'boulevard', ct: 'court', pl: 'place', pkwy: 'parkway', cir: 'circle', ter: 'terrace',
  tpke: 'turnpike', expy: 'expressway', fwy: 'freeway', sq: 'square', trl: 'trail', ext: 'extension',
  n: 'north', s: 'south', e: 'east', w: 'west',
};
// The kind of road, at the end of its name: "Elm" is what tells Elm Street from Oak Street
const TYPES = new Set(['street', 'road', 'avenue', 'drive', 'lane', 'boulevard', 'court', 'place', 'parkway', 'circle',
  'terrace', 'way', 'trail', 'turnpike', 'pike', 'expressway', 'freeway', 'square', 'row', 'loop', 'extension', 'alley',
  'highway']);
const DIRS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);

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
  if (t.length > 1 && TYPES.has(t.at(-1))) t.pop();
  while (t.length > 1 && DIRS.has(t[0])) t.shift();
  while (t.length > 1 && DIRS.has(t.at(-1))) t.pop();
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

/** An Overpass way, from `out tags geom`, as a road. */
export const fromOverpass = (e) => (e?.type === 'way' && Array.isArray(e.geometry)
  ? road(e.tags, [e.geometry.map((c) => [c.lon, c.lat])]) : null);

export class Roads {
  /**
   * @param {object} o - Dependencies.
   * @param {import('./store.js').Store} o.store - Settings, and the channels' places.
   * @param {string} [o.overpass] - The Overpass server: the settings file's findings.overpass.
   * @param {typeof fetch} [o.fetch] - For tests.
   * @param {() => number} [o.now] - The clock, for tests.
   */
  constructor({ store, overpass, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    this.db = store.db;
    this.overpass = overpass || OVERPASS;
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
      CREATE INDEX IF NOT EXISTS road_names_road ON road_names(road_id);`);
  }

  gen() {
    return Number(this.store.setting('roads.gen') ?? 0);
  }

  /** What's imported, and an import underway. */
  stats() {
    const g = this.gen();
    const about = JSON.parse(this.store.setting('roads.source') ?? 'null');
    return {
      ways: this.db.prepare('SELECT count(*) AS n FROM roads WHERE gen = ?').get(g).n,
      names: this.db.prepare(`SELECT count(DISTINCT n.key) AS n FROM road_names n JOIN roads r ON r.id = n.road_id
                               WHERE r.gen = ?`).get(g).n,
      source: about,
      busy: this.busy && { from: this.busy.from, startedAt: this.busy.startedAt, read: this.busy.read },
      lastError: this.lastError ?? null,
      overpass: this.overpass,
    };
  }

  // ---- Importing ------------------------------------------------------------

  /** Start an import; one at a time. */
  begin(from) {
    if (this.busy) throw fail(`roads are being ${this.busy.from === 'file' ? 'imported' : 'fetched'} already`, 409);
    const gen = this.gen() + 1;
    this.db.prepare('DELETE FROM road_names WHERE road_id IN (SELECT id FROM roads WHERE gen >= ?)').run(gen);
    this.db.prepare('DELETE FROM roads WHERE gen >= ?').run(gen);
    this.busy = { from, gen, startedAt: this.now(), read: 0 };
    this.lastError = null;
    return this.busy;
  }

  /** Write some roads into the import underway: no await inside, so nothing else's writes join in. */
  write(list) {
    const { gen } = this.busy;
    const ins = this.db.prepare(`INSERT INTO roads (gen, name, ref, kind, coords, a, b, minlon, minlat, maxlon, maxlat)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const nm = this.db.prepare('INSERT INTO road_names (road_id, key, base) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const r of list) {
        for (const line of r.lines) {
          const xs = line.map((c) => c[0]);
          const ys = line.map((c) => c[1]);
          const { lastInsertRowid: id } = ins.run(gen, r.name, r.ref, r.kind, JSON.stringify(line),
            line[0].join(','), line.at(-1).join(','), Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
          for (const k of r.keys) nm.run(id, k, base(k));
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.busy.read += list.length;
  }

  /** Swap the import in, or throw it away. */
  finish(about, error) {
    const { gen } = this.busy;
    this.busy = null;
    if (error) {
      this.db.prepare('DELETE FROM road_names WHERE road_id IN (SELECT id FROM roads WHERE gen = ?)').run(gen);
      this.db.prepare('DELETE FROM roads WHERE gen = ?').run(gen);
      this.lastError = { at: this.now(), error: error.message };
      throw error;
    }
    const ways = this.db.prepare('SELECT count(*) AS n FROM roads WHERE gen = ?').get(gen).n;
    if (!ways) {
      this.lastError = { at: this.now(), error: 'there were no named roads in it' };
      throw fail('there were no named roads in it: nothing was changed');
    }
    this.db.exec('BEGIN');
    try {
      this.store.setSetting('roads.gen', gen);
      this.store.setSetting('roads.source', JSON.stringify({ ...about, at: this.now(), ways }));
      this.db.prepare('DELETE FROM road_names WHERE road_id IN (SELECT id FROM roads WHERE gen < ?)').run(gen);
      this.db.prepare('DELETE FROM roads WHERE gen < ?').run(gen);
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
  async importStream(input, name = 'a file') {
    this.begin('file');
    let mode = null;
    let whole = '';
    let batch = [];
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
        batch.push(fromFeature(f));
        if (batch.length >= BATCH) {
          this.write(batch.filter(Boolean));
          batch = [];
        }
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
        batch = features.map(fromFeature);
      }
      for (let i = 0; i < batch.length; i += BATCH) this.write(batch.slice(i, i + BATCH).filter(Boolean));
    } catch (e) {
      return this.finish(null, e);
    }
    return this.finish({ from: 'file', name: String(name).slice(0, 200) });
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
    const query = `[out:json][timeout:240];way["highway"][~"^(name|ref)$"~"."](${s},${w},${n},${e});out tags geom qt;`;
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
        const list = elements.map(fromOverpass).filter(Boolean);
        for (let i = 0; i < list.length; i += BATCH) this.write(list.slice(i, i + BATCH));
      } catch (err) {
        try { this.finish(about, err); } catch { /* kept in lastError */ }
        console.error(`[roads] ${err.message}`);
        return;
      }
      try { this.finish(about); } catch (err) { console.error(`[roads] ${err.message}`); }
    })();
    return { started: true };
  }

  /** Delete every road. */
  clear() {
    if (this.busy) throw fail('roads are being imported: wait for that to finish', 409);
    this.db.exec('DELETE FROM road_names; DELETE FROM roads;');
    this.store.setSetting('roads.source', null);
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
   * it can write a misheard road as the one that's there.
   * @param {string} text - The transmissions.
   * @param {{lat: number, lon: number}|null} at - Where the channel is.
   * @param {number} [max] - How many.
   * @returns {string[]} Road names.
   */
  hint(text, at, max = 25) {
    if (!at) return [];
    const t = words(text).split(' ').filter(Boolean);
    const grams = [new Set(), new Set(), new Set(), new Set()];
    for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= t.length; i++) grams[n].add(t.slice(i, i + n).join(' '));
    const scored = [];
    for (const r of this.near(at)) {
      const b = r.base;
      let score = null;
      if (grams[Math.min(3, r.key.split(' ').length)]?.has(r.key) || (b && grams[Math.min(3, b.split(' ').length)].has(b))) score = 0;
      else if (b && slack(b) && b.split(' ').length <= 3) {
        const max = slack(b);
        for (const g of grams[b.split(' ').length]) {
          const d = distance(g, b, max);
          if (d <= max && (score === null || d < score)) score = d;
          if (score === 1) break;
        }
      }
      if (score !== null) scored.push({ name: r.name, score });
    }
    const names = [...new Set(scored.sort((x, y) => x.score - y.score || x.name.localeCompare(y.name)).map((x) => x.name))];
    return names.slice(0, max);
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
          SELECT DISTINCT r.id, r.name, r.coords, r.a, r.b FROM road_names n JOIN roads r ON r.id = n.road_id
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
      return { said, level, ...this.nearest(found, at) };
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
    const groups = new Map();
    for (const x of found) {
      const k = root(x.id);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ ...x, line: JSON.parse(x.coords) });
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
