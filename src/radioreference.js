import { call, list, struct, xsd, SoapFault } from './soap.js';
import { VERSION } from './updates.js';

const NS = 'http://api.radioreference.com/soap2';
export const RR_ENDPOINT = 'https://api.radioreference.com/soap2/index.php';
// The API's version, pinned: what this was written against, so a later one
// changing a reply's shape doesn't change it under us. 18 is "latest" as of 2026-11.
const API_VERSION = '18';
const KEYS = { username: 'rr.username', password: 'rr.password', appKey: 'rr.appKey', zip: 'rr.zip' };
const TTL = 6 * 60 * 60 * 1000;   // the database changes slowly, and a lookup asks the same things twice
const MAX_PLACES = 10;            // candidates offered for one channel

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * A lookup's detail that the service refused (a callsign it has no licence
 * for, say) is left out rather than losing the rest. A refused sign-in isn't.
 * @param {Promise<unknown>} p - The call.
 * @returns {Promise<unknown>} Its answer, or null.
 */
const soft = (p) => p.catch((e) => {
  if (e.code && e.code !== 'AUTH') return null;
  throw e;
});

/**
 * @param {unknown} lat - Latitude, as the API gave it.
 * @param {unknown} lon - Longitude.
 * @returns {{lat: number, lon: number} | null} A place, or null for none (the API's 0, 0 included).
 */
function point(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: la, lon: lo };
}

/** @returns {number} Kilometres between two places, great circle. */
function km(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A radio has ten letters for a name, so names are cut down: "Holden PD",
// "Rutld FD". These are read as the words a listing spells out.
const SAME = {
  pd: 'police', police: 'police', pol: 'police',
  fd: 'fire', fire: 'fire', fireground: 'fire',
  ems: 'ems', ambulance: 'ems', amb: 'ems', rescue: 'ems',
  dpw: 'dpw', hwy: 'highway', highway: 'highway',
  sp: 'state', msp: 'state', state: 'state',
  disp: 'dispatch', dispatch: 'dispatch', tac: 'tactical', tactical: 'tactical',
  rptr: 'repeater', rpt: 'repeater', repeater: 'repeater',
};
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => SAME[w] ?? w);

/** Whether every letter of `a` appears in `b`, in order: Rutld in Rutland. */
function within(a, b) {
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length;
}

function like(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  if (a.startsWith(b) || b.startsWith(a)) return 0.8;
  if (a[0] === b[0] && a.length >= 4 && within(a, b)) return 0.6;
  return 0;
}

/**
 * How well a listing matches the channel's name, which is the best clue to
 * which of several listings on one frequency it is.
 * @param {string} name - The channel's name, as the radio has it.
 * @param {string} text - What the listing says about itself.
 * @returns {number} 0 for nothing in common, about 1 per word shared.
 */
export function similarity(name, text) {
  const theirs = [...new Set(words(text))];
  if (!theirs.length) return 0;
  return words(name).reduce((sum, a) => sum + Math.max(...theirs.map((b) => like(a, b))), 0);
}

/** The subcategory a listing is in, and the category it's under. */
function subcat(info, scid) {
  for (const cat of list(info?.cats)) {
    for (const sc of list(cat?.subcats)) if (sc?.scid === scid) return { cat, sc };
  }
  return null;
}

/**
 * Where a channel is, from RadioReference: its frequency looked up in the
 * county of a ZIP code (the state's, when the county has nothing), and for
 * each listing, the FCC licence's transmitter sites on that frequency and the
 * place RadioReference gives the listing's area.
 *
 * It needs a RadioReference Premium subscription, whose username and password
 * an admin enters, and an app key for the application, which RadioReference
 * issues to its developer. They are kept in the database, as settings changed
 * from the page are, and never sent back to the page.
 */
export class RadioReference {
  /**
   * @param {object} o - Dependencies.
   * @param {import('./store.js').Store} o.store - Where the settings are kept.
   * @param {{endpoint?: string|null, appKey?: string|null}} [o.config] - The settings file's radioreference section.
   * @param {typeof fetch} [o.fetch] - For tests.
   * @param {() => number} [o.now] - The clock, for tests.
   */
  constructor({ store, config = {}, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    this.endpoint = config?.endpoint || RR_ENDPOINT;
    this.configKey = config?.appKey || null;
    this.fetch = fetch;
    this.now = now;
    this.cache = new Map();
  }

  /** @returns {string} A saved setting, or ''. */
  get(name) {
    return this.store.setting(KEYS[name]) ?? '';
  }

  /** @returns {string} The app key: an admin's, or the settings file's. */
  appKey() {
    return this.get('appKey') || this.configKey || '';
  }

  /** @returns {boolean} Whether a lookup can be made. */
  ready() {
    return Boolean(this.get('username') && this.get('password') && this.appKey() && this.get('zip'));
  }

  /**
   * What the Admin page shows: never the password or the key themselves.
   * @returns {{username: string, password: boolean, appKey: 'saved'|'settings file'|null, zip: string, ready: boolean}}
   */
  settings() {
    return {
      username: this.get('username'),
      password: Boolean(this.get('password')),
      appKey: this.get('appKey') ? 'saved' : this.configKey ? 'settings file' : null,
      zip: this.get('zip'),
      ready: this.ready(),
    };
  }

  /**
   * Save what the Admin page sends. A password or key left blank keeps the one
   * saved, since the page is never given it to send back; `forget` clears all.
   * @param {{username?: string, password?: string, appKey?: string, zip?: string, forget?: boolean}} body - The form.
   * @returns {object} settings().
   */
  save({ username, password, appKey, zip, forget } = {}) {
    if (forget === true) {
      for (const key of Object.values(KEYS)) this.store.setSetting(key, null);
      this.cache.clear();
      return this.settings();
    }
    const text = (v, what, max) => {
      const s = String(v ?? '').trim();
      if (s.length > max) throw fail(`that ${what} is too long`);
      return s;
    };
    const z = zip === undefined ? undefined : text(zip, 'ZIP code', 10);
    if (z && !/^\d{5}$/.test(z)) throw fail('a ZIP code is five digits');
    const user = username === undefined ? undefined : text(username, 'username', 100);
    const pass = password ? String(password) : '';
    if (pass.length > 200) throw fail('that password is too long');
    const key = appKey ? text(appKey, 'app key', 200) : '';
    if (z !== undefined) this.store.setSetting(KEYS.zip, z || null);
    if (user !== undefined) this.store.setSetting(KEYS.username, user || null);
    if (pass) this.store.setSetting(KEYS.password, pass);
    if (key) this.store.setSetting(KEYS.appKey, key);
    this.cache.clear();
    return this.settings();
  }

  /**
   * One call, signed in as the admin's account.
   * @param {string} method - The operation.
   * @param {Record<string, object>} params - Its parameters, before authInfo.
   * @returns {Promise<unknown>} The reply.
   */
  async rr(method, params) {
    if (!this.get('username') || !this.get('password') || !this.appKey()) {
      throw fail('RadioReference isn’t set up: add a username, password and app key in Admin → RadioReference.');
    }
    const authInfo = struct('ns1:authInfo', {
      username: xsd.string(this.get('username')),
      password: xsd.string(this.get('password')),
      appKey: xsd.string(this.appKey()),
      version: xsd.string(API_VERSION),
      style: xsd.string('rpc'),
    });
    try {
      return await call({
        endpoint: this.endpoint, ns: NS, method, params: { ...params, authInfo },
        fetch: this.fetch, userAgent: `AirScribe/${VERSION}`,
      });
    } catch (e) {
      // The fault's code kept, so a sign-in refused (AUTH) can be told from a callsign not found
      if (e instanceof SoapFault) throw Object.assign(fail(`RadioReference: ${e.message}`, 502), { code: e.code });
      if (e.name === 'TimeoutError') throw fail('RadioReference didn’t answer in time', 504);
      throw fail(`RadioReference couldn’t be reached: ${e.cause?.message ?? e.message}`, 502);
    }
  }

  /** @returns {Promise<unknown>} The cached answer, or a fresh one. */
  async cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL) return hit.value;
    const value = await fn();
    this.cache.set(key, { at: this.now(), value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  /**
   * Whether the account signs in, and until when it's Premium; and where the
   * ZIP code is, when there is one.
   * @returns {Promise<{username: string, expires: string|null, zip?: object}>}
   */
  async test() {
    const user = await this.rr('getUserData', {});
    const out = { username: user?.username || this.get('username'), expires: user?.subExpireDate || null };
    if (this.get('zip')) out.zip = await this.zipInfo();
    return out;
  }

  /** @returns {Promise<{zip: string, city: string, ctid: number, stid: number, lat: number|null, lon: number|null}>} */
  async zipInfo() {
    const zip = this.get('zip');
    if (!zip) throw fail('Set a ZIP code in Admin → RadioReference: the search starts in its county.');
    return this.cached(`zip:${zip}`, async () => {
      // An xsd:int that keeps its leading zero: 01520 is Holden, 1520 is nothing
      const z = await this.rr('getZipcodeInfo', { zipcode: xsd.int(zip) });
      if (!z?.ctid) throw fail(`RadioReference doesn’t know the ZIP code ${zip}`, 502);
      const p = point(z.lat, z.lon);
      return { zip, city: z.city || '', ctid: z.ctid, stid: z.stid || null, lat: p?.lat ?? null, lon: p?.lon ?? null };
    });
  }

  county(ctid) {
    return this.cached(`county:${ctid}`, () => this.rr('getCountyInfo', { ctid: xsd.int(ctid) }));
  }

  agency(aid) {
    return this.cached(`agency:${aid}`, () => this.rr('getAgencyInfo', { aid: xsd.int(aid) }));
  }

  fcc(callsign) {
    return this.cached(`fcc:${callsign}`, () => this.rr('fccGetCallsign', { callsign: xsd.string(callsign) }));
  }

  /**
   * The place RadioReference gives a listing's area, and the names it's under.
   * @param {object} r - A searchFreqResult.
   * @returns {Promise<{lat: number, lon: number, range: number|null, where: string[], countyWide: boolean} | null>}
   */
  async area(r) {
    if (r.aid) {
      const a = await this.agency(r.aid);
      const hit = subcat(a, r.scid);
      const p = point(hit?.sc.lat, hit?.sc.lon) ?? point(a?.lat, a?.lon);
      const where = [a?.agencyName, hit?.cat.cName, hit?.sc.scName].filter(Boolean);
      return p ? { ...p, range: Number(hit?.sc.range || a?.range) || null, where, countyWide: false } : { where };
    }
    if (r.ctid) {
      const c = await this.county(r.ctid);
      const hit = subcat(c, r.scid);
      const own = point(hit?.sc.lat, hit?.sc.lon);
      const p = own ?? point(c?.lat, c?.lon);
      const where = [c?.countyName, hit?.cat.cName, hit?.sc.scName].filter(Boolean);
      return p ? { ...p, range: Number((own ? hit?.sc.range : c?.range) || 0) || null, where, countyWide: !own } : { where };
    }
    return null;
  }

  /**
   * Where a licence's transmitters on this frequency are. A licence that lists
   * the frequency at none of its sites still has its fixed sites, which are
   * offered as such.
   * @param {string} callsign - The listing's.
   * @param {number} mhz - The channel's frequency.
   * @param {{lat: number|null, lon: number|null}} home - The ZIP code's place.
   * @returns {Promise<object[]>} Sites, each with lat, lon, address, and whether it's listed on the frequency.
   */
  async sites(callsign, mhz, home) {
    const d = await soft(this.fcc(callsign));
    const onFreq = new Set(list(d?.frequencies)
      .filter((f) => Math.abs(Number(f?.frequency) - mhz) < 0.0006)
      .map((f) => f.locationNumber));
    const fixed = [];
    for (const l of list(d?.locations)) {
      let p = point(l?.lat, l?.lon);
      if (!p) continue;   // a mobile's "location" is an area, with no point
      // A longitude given without its sign would put a US site in China
      if (home && home.lat !== null && home.lon !== null && km(home, p) > 1000) {
        const flipped = { lat: p.lat, lon: -p.lon };
        if (km(home, flipped) < 300) p = flipped;
      }
      fixed.push({ ...p, location: l.locationNumber, onFrequency: onFreq.has(l.locationNumber),
        address: [l.address, l.city, l.state].filter(Boolean).join(', ') });
    }
    const listed = fixed.filter((s) => s.onFrequency);
    return (listed.length ? listed : fixed).slice(0, 3).map((s) => ({ ...s, licensee: d?.licensee || '' }));
  }

  /**
   * Places a channel might be, best first.
   * @param {{name: string, hz: number|null}} channel - As the Map has it.
   * @returns {Promise<object>} The area searched, how many listings had the frequency, and the candidates.
   */
  async lookup({ name, hz }) {
    if (!hz) throw fail('This channel has no frequency to look up: no transmission on it said what it was.');
    if (!this.get('zip')) throw fail('Set a ZIP code in Admin → RadioReference: the search starts in its county.');
    const home = await this.zipInfo();
    // To 10 Hz, which keeps 460.3875 and 460.40625 as listed
    const mhz = Math.round(hz / 10) / 1e5;
    const freq = xsd.decimal(String(mhz));
    const search = async (method, params) => {
      try {
        return list(await this.rr(method, { ...params, freq, tone: xsd.string('') }));
      } catch (e) {
        // Should the service say "nothing found" as a fault rather than an empty list
        if (/no (results|records|frequencies)|not found/i.test(e.message)) return [];
        throw e;
      }
    };
    let scope = 'county';
    // Conventional listings only: a trunked system's frequency has no channel of its own
    let found = (await search('searchCountyFreq', { ctid: xsd.int(home.ctid) })).filter((r) => r?.scid);
    if (!found.length && home.stid) {
      scope = 'state';
      found = (await search('searchStateFreq', { stid: xsd.int(home.stid) })).filter((r) => r?.scid);
    }
    // Most like the channel's name first, which decides whose places are asked for
    const ranked = found
      .map((r) => ({ r, score: similarity(name, `${r.alpha ?? ''} ${r.descr ?? ''}`) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, scope === 'county' ? 15 : 8);

    const candidates = [];
    const seen = new Set();
    let licences = 0;
    for (const { r } of ranked) {
      const area = await soft(this.area(r));
      const where = (area?.where ?? []).join(' › ');
      const score = similarity(name, `${r.alpha ?? ''} ${r.descr ?? ''} ${where}`);
      const about = {
        title: r.descr || r.alpha || `${mhz} MHz`, alpha: r.alpha || '', where,
        tone: r.tone || '', mode: r.mode ?? '', score,
      };
      const signs = String(r.callsign ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter((c) => /^[A-Z0-9]{3,8}$/.test(c));
      for (const callsign of signs.slice(0, 2)) {
        if (licences >= 5) break;   // each is a call; the best listings' licences are the ones worth it
        licences++;
        for (const s of await this.sites(callsign, mhz, home)) {
          const id = `fcc:${callsign}:${s.location}`;
          if (seen.has(id)) continue;
          seen.add(id);
          candidates.push({ id, kind: 'fcc', ...about, callsign, lat: s.lat, lon: s.lon, address: s.address,
            licensee: s.licensee, onFrequency: s.onFrequency });
        }
      }
      if (area?.lat !== undefined) {
        const id = `area:${r.scid}:${r.aid || r.ctid}`;
        if (!seen.has(id)) {
          seen.add(id);
          candidates.push({ id, kind: 'area', ...about, callsign: signs[0] ?? '', lat: area.lat, lon: area.lon,
            range: area.range, countyWide: area.countyWide });
        }
      }
    }
    for (const c of candidates) {
      c.km = home.lat === null ? null : Math.round(km(home, c) * 10) / 10;
    }
    // Best name first; a licensed site before an area; the nearer before the further
    candidates.sort((a, b) => b.score - a.score ||
      (a.kind === 'fcc' ? 0 : 1) - (b.kind === 'fcc' ? 0 : 1) ||
      (a.onFrequency === false ? 1 : 0) - (b.onFrequency === false ? 1 : 0) ||
      (a.km ?? Infinity) - (b.km ?? Infinity));
    return {
      channel: name, mhz, scope, listings: found.length,
      area: { zip: home.zip, city: home.city, lat: home.lat, lon: home.lon },
      candidates: candidates.slice(0, MAX_PLACES),
    };
  }
}
