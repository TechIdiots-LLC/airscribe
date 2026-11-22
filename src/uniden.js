/**
 * Uniden's database: the HPDB the SDS100, SDS150, SDS200 and BCDx36HP scanners carry (BCDx36HP/HPDB on the SD
 * card), imported to place channels on the Map (docs/radioreference.md#from-unidens-database). Each conventional
 * frequency is kept with its group's place and range, and each talkgroup with its group's, or its system's sites. A channel the scanner
 * named is found by that name, which is the database's own; by its frequency; or by its talkgroup.
 */
import { similarity } from './radioreference.js';

const NATIONWIDE_DEG = 6;   // a group whose rectangles span more than this has no place of its own
const NEAR_KM = 150;        // a frequency's listings further than this from home are someone else's
const MAX_PLACES = 10;
const NAME_MAX = 60;        // the most of a scanner's channel name AirScribe keeps
const FILE = /^(hpdb\.cfg|s_\d{6}\.hpd)$/i;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** A name as it's compared: lowercased, spaces evened, as much as AirScribe keeps of a channel's. */
export const nameKey = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

function km(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Where a group or site is: its circle, or the middle of its rectangles; none for one covering a whole region.
 * @param {{lat: number, lon: number, range: number, rects: number[][]}} g - As read.
 * @returns {{lat: number, lon: number, rangeMi: number|null}|null} Its place.
 */
function placeOf(g) {
  if (g.rects.length) {
    const lats = g.rects.flatMap((r) => [r[0], r[2]]);
    const lons = g.rects.flatMap((r) => [r[1], r[3]]);
    const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    if (n - s > NATIONWIDE_DEG || e - w > NATIONWIDE_DEG) return null;
    const mid = { lat: (s + n) / 2, lon: (w + e) / 2 };
    return { ...mid, rangeMi: Math.round((km(mid, { lat: n, lon: e }) / 1.609344) * 10) / 10 };
  }
  if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon) || (g.lat === 0 && g.lon === 0)) return null;
  return { lat: g.lat, lon: g.lon, rangeMi: Number.isFinite(g.range) && g.range > 0 ? g.range : null };
}

/**
 * One of the database's files, read: its frequencies and talkgroups with their places, its trunked sites, and from
 * hpdb.cfg the states, counties and the database's date.
 * @param {string} text - The file.
 * @returns {{entries: object[], sites: object[], areas: object[], date: string|null}} What's kept.
 */
export function parseHpd(text) {
  const lines = String(text).split(/\r?\n/);
  if (!/^TargetModel\tBCDx36HP\s*$/.test(lines[0] ?? '')) {
    throw fail('that isn’t one of Uniden’s database files (BCDx36HP/HPDB)');
  }
  const out = { entries: [], sites: [], areas: [], date: null };
  const systems = new Map();   // 'c:<CountyId|AgencyId>' or 't:<TrunkId>' -> {name, stateId, countyId}
  const groups = new Map();    // 'c:<CGroupId>' or 't:<TGroupId>' -> {name, system, lat, lon, range, rects}
  const sites = [];
  const rows = [];             // [kind, value, name, group key]
  let last = null;             // what a Rectangle line belongs to
  for (const line of lines) {
    const f = line.split('\t');
    const ids = {};
    let i = 1;
    for (; i < f.length && /^[A-Za-z]+=-?\d*$/.test(f[i]); i++) {
      const [k, v] = f[i].split('=');
      ids[k] = v === '' ? null : Number(v);
    }
    const rest = f.slice(i);
    const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
    switch (f[0]) {
      case 'DateModified': out.date = f[1] || null; break;
      case 'StateInfo':
        out.areas.push({ kind: 'state', id: ids.StateId, stateId: ids.StateId, name: rest[0] ?? '', code: rest[1] ?? '' });
        break;
      case 'CountyInfo':
        out.areas.push({ kind: 'county', id: ids.CountyId, stateId: ids.StateId, name: rest[0] ?? '', code: '' });
        break;
      case 'Conventional':
        systems.set(`c:${ids.CountyId ?? `a${ids.AgencyId}`}`,
          { name: rest[0] ?? '', stateId: ids.StateId ?? null, countyId: ids.CountyId ?? null });
        break;
      case 'Trunk':
        systems.set(`t:${ids.TrunkId}`, { name: rest[0] ?? '', stateId: ids.StateId ?? null, countyId: null, trunk: ids.TrunkId });
        break;
      case 'C-Group':
      case 'T-Group': {
        const system = f[0] === 'C-Group' ? `c:${ids.CountyId ?? `a${ids.AgencyId}`}` : `t:${ids.TrunkId}`;
        last = { name: rest[0] ?? '', system, lat: num(rest[2]), lon: num(rest[3]), range: num(rest[4]), rects: [] };
        groups.set(f[0] === 'C-Group' ? `c:${ids.CGroupId}` : `t:${ids.TGroupId}`, last);
        break;
      }
      case 'Site':
        last = { name: rest[0] ?? '', trunk: ids.TrunkId, lat: num(rest[2]), lon: num(rest[3]), range: num(rest[4]),
          rects: [] };
        sites.push(last);
        break;
      case 'Rectangle': {
        const r = f.slice(2, 6).map(Number);
        if (last && r.every(Number.isFinite)) last.rects.push(r);
        break;
      }
      case 'C-Freq': rows.push(['freq', num(rest[2]), rest[0] ?? '', `c:${ids.CGroupId}`]); last = null; break;
      case 'TGID': rows.push(['tgid', num(rest[2]), rest[0] ?? '', `t:${ids.TGroupId}`]); last = null; break;
      default: break;
    }
  }
  for (const [kind, value, name, gkey] of rows) {
    const g = groups.get(gkey);
    const sys = g && systems.get(g.system);
    if (!g || !Number.isFinite(value) || !name) continue;
    const p = placeOf(g);
    out.entries.push({
      kind, hz: kind === 'freq' ? value : null, tgid: kind === 'tgid' ? value : null, name, key: nameKey(name),
      group: g.name, system: sys?.name ?? '', trunk: sys?.trunk ?? null, stateId: sys?.stateId ?? null,
      countyId: sys?.countyId ?? null, lat: p?.lat ?? null, lon: p?.lon ?? null, rangeMi: p?.rangeMi ?? null,
    });
  }
  for (const s of sites) {
    const p = placeOf(s);
    if (p) out.sites.push({ trunk: s.trunk, name: s.name, ...p });
  }
  return out;
}

export class Uniden {
  /** @param {{store: import('./store.js').Store}} o - Where it's kept. */
  constructor({ store }) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      -- Uniden's database, as the scanners carry it: what places a channel (docs/radioreference.md)
      CREATE TABLE IF NOT EXISTS uniden_entries (
        file TEXT NOT NULL, kind TEXT NOT NULL, hz INTEGER, tgid INTEGER, name TEXT NOT NULL, key TEXT NOT NULL,
        grp TEXT, system TEXT, trunk INTEGER, state_id INTEGER, county_id INTEGER,
        lat REAL, lon REAL, range_mi REAL);
      CREATE INDEX IF NOT EXISTS uniden_entries_hz ON uniden_entries(hz);
      CREATE INDEX IF NOT EXISTS uniden_entries_key ON uniden_entries(key);
      CREATE INDEX IF NOT EXISTS uniden_entries_tgid ON uniden_entries(tgid);
      CREATE INDEX IF NOT EXISTS uniden_entries_file ON uniden_entries(file);
      CREATE TABLE IF NOT EXISTS uniden_sites (
        file TEXT NOT NULL, trunk INTEGER, name TEXT, lat REAL NOT NULL, lon REAL NOT NULL, range_mi REAL);
      CREATE INDEX IF NOT EXISTS uniden_sites_trunk ON uniden_sites(trunk);
      CREATE TABLE IF NOT EXISTS uniden_areas (
        kind TEXT NOT NULL, id INTEGER NOT NULL, state_id INTEGER, name TEXT, code TEXT, PRIMARY KEY (kind, id));`);
  }

  /** @returns {number} How many frequencies and talkgroups are kept. */
  count() {
    return this.db.prepare('SELECT count(*) AS n FROM uniden_entries').get().n;
  }

  stats() {
    return {
      entries: this.count(),
      files: this.db.prepare('SELECT count(DISTINCT file) AS n FROM uniden_entries').get().n,
      placed: this.db.prepare('SELECT count(*) AS n FROM uniden_entries WHERE lat IS NOT NULL').get().n,
      date: this.store.setting('uniden.date') ?? null,
      importedAt: Number(this.store.setting('uniden.importedAt')) || null,
    };
  }

  /**
   * Import one file of the HPDB folder: hpdb.cfg (states, counties, the date) or an s_000000.hpd, replacing what
   * that file gave before.
   * @param {string} name - Its name.
   * @param {Buffer|string} body - Its contents.
   * @returns {object} What it held, and stats().
   */
  importFile(name, body) {
    const file = String(name ?? '');
    if (!FILE.test(file)) throw fail('only hpdb.cfg and the s_000000.hpd files are read');
    const got = parseHpd(Buffer.isBuffer(body) ? body.toString('utf8') : body);
    this.db.exec('BEGIN');
    try {
      if (/^hpdb\.cfg$/i.test(file)) {
        this.db.exec('DELETE FROM uniden_areas');
        const ins = this.db.prepare(`INSERT OR REPLACE INTO uniden_areas (kind, id, state_id, name, code)
                                       VALUES (?, ?, ?, ?, ?)`);
        for (const a of got.areas) if (Number.isInteger(a.id)) ins.run(a.kind, a.id, a.stateId, a.name, a.code);
        if (got.date) this.store.setSetting('uniden.date', got.date);
      } else {
        this.db.prepare('DELETE FROM uniden_entries WHERE file = ?').run(file);
        this.db.prepare('DELETE FROM uniden_sites WHERE file = ?').run(file);
        const ins = this.db.prepare(`INSERT INTO uniden_entries (file, kind, hz, tgid, name, key, grp, system, trunk,
                                       state_id, county_id, lat, lon, range_mi)
                                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const e of got.entries) {
          ins.run(file, e.kind, e.hz, e.tgid, e.name, e.key, e.group, e.system, e.trunk, e.stateId, e.countyId,
            e.lat, e.lon, e.rangeMi);
        }
        const site = this.db.prepare(`INSERT INTO uniden_sites (file, trunk, name, lat, lon, range_mi)
                                        VALUES (?, ?, ?, ?, ?, ?)`);
        for (const s of got.sites) site.run(file, s.trunk, s.name, s.lat, s.lon, s.rangeMi);
      }
      this.store.setSetting('uniden.importedAt', Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { file, entries: got.entries.length, sites: got.sites.length, areas: got.areas.length, ...this.stats() };
  }

  clear() {
    this.db.exec('DELETE FROM uniden_entries; DELETE FROM uniden_sites; DELETE FROM uniden_areas;');
    this.store.setSetting('uniden.date', null);
    this.store.setSetting('uniden.importedAt', null);
    return this.stats();
  }

  /**
   * Places a channel might be, from the database, best first.
   * @param {{name: string, hz: number|null, details?: object|null}} channel - The channel, and what a scanner said
   *   about its latest transmission (system, department, talkgroup).
   * @param {{lat: number, lon: number}|null} home - Where the radios are, near enough; null when unknown.
   * @returns {{candidates: object[], confident: boolean, date: string|null}} The places; confident when the best
   *   is clearly it (its name and its frequency or department).
   */
  candidates({ name, hz, details }, home) {
    const key = nameKey(name);
    const d = details ?? {};
    const tg = Number(d.talkgroup);
    const select = `SELECT e.rowid AS id, e.*, s.name AS state, s.code AS state_code, c.name AS county
                      FROM uniden_entries e
                      LEFT JOIN uniden_areas s ON s.kind = 'state' AND s.id = e.state_id
                      LEFT JOIN uniden_areas c ON c.kind = 'county' AND c.id = e.county_id`;
    const found = new Map();
    const add = (rows) => rows.forEach((r) => found.set(r.id, r));
    if (key) add(this.db.prepare(`${select} WHERE e.key = ? LIMIT 300`).all(key));
    if (hz) add(this.db.prepare(`${select} WHERE e.hz BETWEEN ? AND ? LIMIT 3000`).all(hz - 50, hz + 50));
    if (Number.isInteger(tg) && tg > 0) add(this.db.prepare(`${select} WHERE e.tgid = ? LIMIT 1000`).all(tg));
    const nearestSite = this.db.prepare('SELECT name, lat, lon, range_mi FROM uniden_sites WHERE trunk = ?');
    const out = [];
    const seen = new Set();   // the database lists some channels twice in one group
    for (const r of found.values()) {
      let place = r.lat === null ? null : { lat: r.lat, lon: r.lon, rangeMi: r.range_mi, site: null };
      if (!place && r.kind === 'tgid' && r.trunk !== null) {
        // A talkgroup with no place of its own: its system's site nearest home
        const s = nearestSite.all(r.trunk).sort((a, b) => (home ? km(home, a) - km(home, b) : 0))[0];
        if (s) place = { lat: s.lat, lon: s.lon, rangeMi: s.range_mi, site: s.name };
      }
      if (!place) continue;
      const same = (a, b) => a && b && nameKey(a) === nameKey(b);
      const byName = r.key === key;
      const byDept = same(d.department, r.grp);
      const score = (byName ? 4 : Math.min(2, similarity(name, `${r.name} ${r.grp}`) / 2)) + (byDept ? 2 : 0) +
        (same(d.system, r.system) ? 1 : 0) + (hz && r.hz && Math.abs(r.hz - hz) <= 50 ? 2 : 0) +
        (tg && r.tgid === tg ? 2 : 0);
      const dist = home ? km(home, place) : null;
      // A scanner hears what's near it: the same name and frequency a state away is someone else's
      if (dist !== null && dist > NEAR_KM) continue;
      const area = r.county ? `${r.county} County` : r.system;
      const where = [r.state_code || r.state, area, r.grp].filter(Boolean).join(' › ');
      const dup = `${r.name}|${where}|${place.lat}|${place.lon}`;
      if (seen.has(dup)) continue;
      seen.add(dup);
      out.push({
        id: `uniden:${r.id}`, kind: 'uniden', title: r.name, alpha: '', score: Math.round(score * 100) / 100, where,
        system: r.system, group: r.grp, site: place.site, lat: place.lat, lon: place.lon, range: place.rangeMi,
        km: dist === null ? null : Math.round(dist * 10) / 10,
        mhz: r.hz ? r.hz / 1e6 : null, tgid: r.tgid,
      });
    }
    out.sort((a, b) => b.score - a.score || (a.km ?? Infinity) - (b.km ?? Infinity));
    const [best, next] = out;
    return {
      candidates: out.slice(0, MAX_PLACES),
      confident: Boolean(best && best.score >= 6 && (!next || next.score < best.score)),
      date: this.store.setting('uniden.date') ?? null,
    };
  }
}
