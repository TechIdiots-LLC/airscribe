/**
 * Trying channels on a radio before keeping them (docs/channels.md#trying-channels): candidates from Uniden's
 * database are written into a spare region, a batch at a time, and the radio is moved between it and its own region
 * on a schedule. Each frequency is graded by what came in on it: words, static, or nothing. A channel whose squelch
 * keeps opening on static with no words has its scan turned off, so it stops holding up the rest. At the end the
 * region is put back as it was.
 */
import { checkChannel, radioName } from './channels.js';
import { SERVICES } from './uniden.js';

const TICK_MS = 30 * 1000;
const SKIP_STATIC = 4;            // static openings, with no words, that turn a channel's scan off
const GRADE_WAIT_MS = 10 * 60 * 1000;   // how long a batch's grading waits on transcripts still to come

/**
 * What a frequency's batch came to.
 * - **good**: words more than once, or more words than static.
 * - **some**: words, but mostly static: a weak or distant station.
 * - **static**: the squelch opened on noise, never with words.
 * - **quiet**: nothing, or too little to tell.
 * @param {{heard: number, static: number, speech: number}} c - Its counts.
 * @returns {'good'|'some'|'static'|'quiet'} The verdict.
 */
export function verdict({ heard = 0, static: noise = 0, speech = 0 }) {
  if (speech >= 2 || (speech === 1 && noise <= 1)) return 'good';
  if (speech) return 'some';
  if (noise >= 2 || heard >= 3) return 'static';
  return 'quiet';
}

/** A ham repeater listened to only with its tone, as a station of its own: null when it has no tone, or isn't a ham's. */
export function withTone(s) {
  if (s.service !== 'ham' || !s.tone || !s.channel || s.channel.rx_tone) return null;
  return { ...s, key: `${s.key}:tone`, toneSquelch: true, channel: { ...s.channel, rx_tone: s.tone } };
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const int = (v, lo, hi, dflt) => {
  const n = Number(v ?? dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), lo), hi);
};

export class Trials {
  /**
   * @param {object} o
   * @param {import('./store.js').Store} o.store - Where trials and their results are kept.
   * @param {object} o.manager - The radios (readChannels, writeChannels, control, state).
   * @param {import('./uniden.js').Uniden} o.uniden - Where the candidates come from.
   * @param {() => Promise<{lat: number, lon: number}|null>} o.home - Where the radios are.
   * @param {() => number} [o.now] - The clock.
   */
  constructor({ store, manager, uniden, home, now = Date.now }) {
    this.store = store;
    this.db = store.db;
    this.manager = manager;
    this.uniden = uniden;
    this.home = home;
    this.now = now;
    this.timer = null;
    this.working = new Set();   // radios a tick is busy with
    this.db.exec(`
      -- A channel trial on one radio: the region tried in, the radio's own, and the schedule (docs/channels.md)
      CREATE TABLE IF NOT EXISTS trials (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, region INTEGER NOT NULL, home_region INTEGER NOT NULL,
        trial_min INTEGER NOT NULL, home_min INTEGER NOT NULL, hours REAL NOT NULL, services TEXT, miles INTEGER,
        backup_id INTEGER, home_hz TEXT, state TEXT NOT NULL, batch INTEGER NOT NULL DEFAULT 0, batch_at INTEGER,
        started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT);
      CREATE INDEX IF NOT EXISTS trials_mac ON trials(mac);
      -- Each frequency tried, and what it came to
      CREATE TABLE IF NOT EXISTS trial_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT, trial_id INTEGER NOT NULL, mac TEXT NOT NULL, batch INTEGER NOT NULL,
        slot INTEGER NOT NULL, key TEXT NOT NULL, hz INTEGER NOT NULL, name TEXT, station TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, skipped_at INTEGER,
        heard INTEGER, static INTEGER, speech INTEGER, sample TEXT, verdict TEXT);
      CREATE INDEX IF NOT EXISTS trial_channels_mac ON trial_channels(mac, key);`);
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error(`[trial] ${e.message}`)), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** @returns {object|null} The radio's trial under way: running, or putting its region back. */
  active(mac) {
    return this.db.prepare(`SELECT * FROM trials WHERE mac = ? AND state IN ('running', 'ending')
                             ORDER BY id DESC LIMIT 1`).get(mac) ?? null;
  }

  /**
   * Start trying channels on a radio.
   * @param {string} mac - The radio.
   * @param {object} o - region (to try in), homeRegion (its own), trialMin and homeMin (the schedule: homeMin 0 keeps
   *   it on the trial region), hours (each batch), services and miles (which candidates).
   * @returns {Promise<object>} status().
   */
  async begin(mac, o = {}) {
    if (this.active(mac)) throw fail('this radio is trying channels already: stop that first', 409);
    if (!this.uniden?.count()) throw fail('import Uniden’s database in Admin first');
    const region = int(o.region, 0, 63, NaN);
    const homeRegion = int(o.homeRegion, 0, 63, NaN);
    if (!Number.isInteger(region) || !Number.isInteger(homeRegion)) throw fail('region and homeRegion are region numbers');
    if (region === homeRegion) throw fail('try channels in a region other than the one the radio listens on');
    const services = [].concat(o.services ?? []).map(String).filter(Boolean);
    if (!services.length) throw fail('tick at least one service to try');
    const settings = {
      trialMin: int(o.trialMin, 5, 24 * 60, 20), homeMin: int(o.homeMin, 0, 24 * 60, 40),
      hours: Math.min(Math.max(Number(o.hours) || 6, 0.5), 72), miles: int(o.miles, 1, 300, 30),
    };
    // What the radio has on its own region isn't tried again; the region tried in is kept to put back
    const own = await this.manager.readChannels(mac, homeRegion);
    const there = await this.manager.readChannels(mac, region);
    const backup = this.store.addChannelBackup({ mac, region: there.region, regionName: there.name,
      label: 'Before trying channels', channels: there.channels });
    const homeHz = own.channels.filter((c) => !c.empty && c.rx_hz).map((c) => c.rx_hz);
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO trials (mac, region, home_region, trial_min, home_min, hours,
        services, miles, backup_id, home_hz, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
      .run(mac, region, homeRegion, settings.trialMin, settings.homeMin, settings.hours, JSON.stringify(services),
        settings.miles, backup.id, JSON.stringify(homeHz), this.now());
    await this.step(this.db.prepare('SELECT * FROM trials WHERE id = ?').get(lastInsertRowid));
    return this.status(mac);
  }

  /**
   * End a radio's trial now: the batch under way is graded on what came in, and the region is put back.
   * @returns {Promise<object>} status().
   */
  async end(mac) {
    const t = this.active(mac);
    if (!t) throw fail('this radio isn’t trying channels', 404);
    if (t.batch_at) this.grade(t, { early: true });
    this.db.prepare("UPDATE trials SET state = 'ending', batch_at = NULL WHERE id = ?").run(t.id);
    await this.step(this.db.prepare('SELECT * FROM trials WHERE id = ?').get(t.id));
    return this.status(mac);
  }

  /**
   * Grade the batch under way on what's come in so far, and write the next.
   * @returns {Promise<object>} status().
   */
  async next(mac) {
    const t = this.active(mac);
    if (!t || t.state !== 'running') throw fail('this radio isn’t trying channels', 404);
    if (t.batch_at) this.grade(t, { early: true });
    this.db.prepare('UPDATE trials SET batch_at = NULL WHERE id = ?').run(t.id);
    await this.step(this.db.prepare('SELECT * FROM trials WHERE id = ?').get(t.id));
    return this.status(mac);
  }

  /** Every running trial, a step on. */
  async tick() {
    const rows = this.db.prepare("SELECT * FROM trials WHERE state IN ('running', 'ending')").all();
    for (const t of rows) {
      try {
        await this.step(t);
      } catch (e) {
        // The radio may be out of reach: tried again next time
        this.db.prepare('UPDATE trials SET error = ? WHERE id = ?').run(e.message, t.id);
      }
    }
  }

  /** One trial, a step on: its batch written, graded or moved on, the static ones skipped, the radio moved. */
  async step(t) {
    if (this.working.has(t.mac)) return;
    this.working.add(t.mac);
    try {
      if (t.state === 'ending') return await this.putBack(t);
      if (!t.batch_at) {
        if (!(await this.writeBatch(t))) return await this.putBack(t);
        t = this.db.prepare('SELECT * FROM trials WHERE id = ?').get(t.id);
      }
      await this.skipStatic(t);
      if (this.now() >= t.batch_at + t.hours * 3600e3 && this.grade(t)) {
        this.db.prepare('UPDATE trials SET batch_at = NULL WHERE id = ?').run(t.id);
        return;   // the next batch is written on the next step
      }
      await this.move(t);
      this.db.prepare('UPDATE trials SET error = NULL WHERE id = ?').run(t.id);
    } finally {
      this.working.delete(t.mac);
    }
  }

  /** The next candidates, written into the trial region. @returns {Promise<boolean>} False when none are left. */
  async writeBatch(t) {
    const read = await this.manager.readChannels(t.mac, t.region);
    const slots = read.channels.length;
    const tried = new Set(this.db.prepare('SELECT key FROM trial_channels WHERE mac = ?').all(t.mac).map((r) => r.key));
    const skipHz = new Set(JSON.parse(t.home_hz ?? '[]'));
    const { stations } = this.uniden.stations(await this.home(), { miles: t.miles, services: JSON.parse(t.services) });
    // A ham repeater that came to static or a few words is tried again listening only with its tone, which keeps
    // out noise and other users if the repeater sends it
    const noisy = new Set(this.db.prepare(`SELECT key FROM trial_channels c WHERE mac = ? AND verdict IN ('static', 'some')
        AND id = (SELECT max(id) FROM trial_channels d WHERE d.mac = c.mac AND d.key = c.key)`).all(t.mac).map((r) => r.key));
    const batch = [];
    for (const found of stations) {
      if (batch.length >= slots) break;
      const s = tried.has(found.key) && noisy.has(found.key) ? withTone(found) : found;
      if (!s || !s.ok || tried.has(s.key) || skipHz.has(s.channel.rx_hz)) continue;
      skipHz.add(s.channel.rx_hz);
      batch.push(s);
    }
    if (!batch.length) return false;
    // Listened to only, whatever it is: the station as found is kept, to be written as it is if it's kept
    const names = new Set();
    const channels = read.channels.map((c, id) => {
      const s = batch[id];
      if (!s) return { id, rx_hz: 0 };
      let name = radioName(s.name) || 'Trial';
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${radioName(s.name).slice(0, 10 - String(n).length - 1)} ${n}`;
      names.add(name.toLowerCase());
      return checkChannel({ ...s.channel, id, name, tx_hz: s.channel.rx_hz, tx_tone: '', tx_disable: true, power: 'low', scan: true });
    });
    const wrote = await this.manager.writeChannels(t.mac, t.region, channels);
    const at = this.now();
    const ins = this.db.prepare(`INSERT INTO trial_channels (trial_id, mac, batch, slot, key, hz, name, station, started_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    batch.forEach((s, slot) => {
      const name = wrote.results?.find((r) => r.id === slot)?.channel?.name ?? channels[slot].name;
      ins.run(t.id, t.mac, t.batch + 1, slot, s.key, s.channel.rx_hz, name, JSON.stringify(s), at);
      if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) this.store.placeChannelIfUnplaced(name, s.lat, s.lon);
    });
    this.db.prepare('UPDATE trials SET batch = batch + 1, batch_at = ? WHERE id = ?').run(at, t.id);
    return true;
  }

  /** The batch's channels, with what's come in on each so far. */
  batchChannels(t) {
    const rows = this.db.prepare('SELECT * FROM trial_channels WHERE trial_id = ? AND batch = ? ORDER BY slot').all(t.id, t.batch);
    const heard = t.batch_at ? this.store.heardByFrequency({ mac: t.mac, since: t.batch_at }) : new Map();
    return rows.map((r) => {
      const c = r.verdict ? { heard: r.heard, static: r.static, speech: r.speech, pending: 0, sample: JSON.parse(r.sample ?? 'null') }
        : heard.get(r.hz) ?? { heard: 0, static: 0, speech: 0, pending: 0, sample: null };
      return { ...r, ...c, station: JSON.parse(r.station) };
    });
  }

  /** Turn scan off on a channel whose squelch keeps opening on static with no words. */
  async skipStatic(t) {
    const skip = this.batchChannels(t).filter((c) => !c.skipped_at && c.speech === 0 && c.static >= SKIP_STATIC);
    if (!skip.length) return;
    const read = await this.manager.readChannels(t.mac, t.region);
    const out = [];
    for (const c of skip) {
      const slot = read.channels.find((s) => s.id === c.slot);
      if (slot && !slot.empty && slot.rx_hz === c.hz && slot.scan) out.push({ id: c.slot, raw: slot.raw, set: { scan: false } });
    }
    if (out.length) await this.manager.writeChannels(t.mac, t.region, out);
    const mark = this.db.prepare('UPDATE trial_channels SET skipped_at = ? WHERE id = ?');
    for (const c of skip) mark.run(this.now(), c.id);
  }

  /**
   * Each of the batch's channels given its verdict. Waits a while for transcripts still to come.
   * @returns {boolean} Whether it was graded.
   */
  grade(t, { early = false } = {}) {
    const rows = this.batchChannels(t).filter((c) => !c.verdict);
    const end = t.batch_at + t.hours * 3600e3;
    if (!early && rows.some((c) => c.pending) && this.now() < end + GRADE_WAIT_MS) return false;
    const set = this.db.prepare(`UPDATE trial_channels SET ended_at = ?, heard = ?, static = ?, speech = ?, sample = ?,
                                   verdict = ? WHERE id = ?`);
    for (const c of rows) {
      set.run(this.now(), c.heard, c.static, c.speech, c.sample ? JSON.stringify(c.sample) : null, verdict(c), c.id);
    }
    return true;
  }

  /** The radio on the region the schedule says, and scanning: not while something's coming in. */
  async move(t) {
    const st = this.manager.state.get(t.mac);
    if (st?.state !== 'connected' || st.rx || st.tx) return;
    const cycle = (t.trial_min + t.home_min) * 60e3;
    const want = !t.home_min || (this.now() - t.batch_at) % cycle < t.trial_min * 60e3 ? t.region : t.home_region;
    if (st.region === want) return;
    await this.manager.control(t.mac, 'region', want);
    await this.manager.control(t.mac, 'scan', true);
  }

  /** The region as it was before the trial, and the radio back on its own. */
  async putBack(t) {
    const backup = this.store.channelBackup(t.backup_id);
    if (backup) await this.manager.writeChannels(t.mac, t.region, backup.channels.map((c) => ({ id: c.id, raw: c.raw })));
    const st = this.manager.state.get(t.mac);
    if (st?.region !== t.home_region) {
      await this.manager.control(t.mac, 'region', t.home_region);
      await this.manager.control(t.mac, 'scan', true);
    }
    this.db.prepare("UPDATE trials SET state = 'done', ended_at = ?, batch_at = NULL, error = NULL WHERE id = ?").run(this.now(), t.id);
  }

  /**
   * A radio's trial, and every frequency tried on it.
   * @param {string} mac - The radio.
   * @returns {{trial: object|null, channels: object[], results: object[]}} The trial under way (or the last), its
   *   batch's channels with what's come in, and the verdict on each frequency tried, good first.
   */
  status(mac) {
    const t = this.active(mac) ?? this.db.prepare('SELECT * FROM trials WHERE mac = ? ORDER BY id DESC LIMIT 1').get(mac) ?? null;
    const trial = t && {
      id: t.id, state: t.state, region: t.region, homeRegion: t.home_region, trialMin: t.trial_min, homeMin: t.home_min,
      hours: t.hours, services: JSON.parse(t.services ?? '[]'), miles: t.miles, batch: t.batch, batchAt: t.batch_at,
      batchEnds: t.batch_at ? t.batch_at + t.hours * 3600e3 : null, startedAt: t.started_at, endedAt: t.ended_at,
      error: t.error, backupId: t.backup_id,
      on: t.state === 'running' && t.batch_at
        ? (!t.home_min || (this.now() - t.batch_at) % ((t.trial_min + t.home_min) * 60e3) < t.trial_min * 60e3 ? 'trial' : 'home')
        : null,
    };
    const channels = t?.state === 'running' ? this.batchChannels(t).map(({ station, ...c }) => ({
      slot: c.slot, name: c.name, hz: c.hz, key: c.key, service: station.service, toneSquelch: Boolean(station.toneSquelch), heard: c.heard, static: c.static,
      speech: c.speech, pending: c.pending, sample: c.sample, skipped: Boolean(c.skipped_at), verdict: verdict(c),
    })) : [];
    // The latest verdict on each frequency tried on this radio
    const order = { good: 0, some: 1, static: 2, quiet: 3 };
    const results = this.db.prepare(`SELECT * FROM trial_channels c WHERE mac = ? AND verdict IS NOT NULL
        AND id = (SELECT max(id) FROM trial_channels d WHERE d.mac = c.mac AND d.key = c.key AND d.verdict IS NOT NULL)`)
      .all(mac).map((r) => ({
        key: r.key, name: r.name, hz: r.hz, verdict: r.verdict, heard: r.heard, static: r.static, speech: r.speech,
        sample: JSON.parse(r.sample ?? 'null'), triedAt: r.started_at, hours: ((r.ended_at ?? r.started_at) - r.started_at) / 3600e3,
        station: JSON.parse(r.station),
      }))
      .sort((a, b) => order[a.verdict] - order[b.verdict] || b.speech - a.speech || (a.station.km ?? 0) - (b.station.km ?? 0));
    return { trial, channels, results, services: Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, v.name])) };
  }

  /** @returns {Map<string, string>} The latest verdict on each frequency tried on a radio, by station key. */
  verdicts(mac) {
    return new Map(this.status(mac).results.map((r) => [r.key, r.verdict]));
  }

  /**
   * Forget what was found, so those frequencies are tried again.
   * @param {string} mac - The radio.
   * @param {string|null} [key] - One frequency; null for every one not in the batch under way.
   * @returns {{forgotten: number}} How many.
   */
  forget(mac, key = null) {
    const r = key
      ? this.db.prepare('DELETE FROM trial_channels WHERE mac = ? AND key = ? AND verdict IS NOT NULL').run(mac, key)
      : this.db.prepare('DELETE FROM trial_channels WHERE mac = ? AND verdict IS NOT NULL').run(mac);
    return { forgotten: r.changes };
  }
}
