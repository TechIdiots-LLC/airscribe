/**
 * Trying channels on a radio before keeping them (docs/channels.md#trying-channels): the empty slots of one region
 * are filled with candidates from Uniden's database, and the radio listens to that region. Each is graded by what
 * comes in on it while the radio is there: one with words is kept, one that only opens on static is taken out at
 * once, and one still without words after the hours set is taken out too. A slot taken out is filled with the next
 * candidate, until none are left.
 */
import { checkChannel, radioName } from './channels.js';
import { SERVICES } from './uniden.js';

const TICK_MS = 30 * 1000;
const KEEP_SPEECH = 2;            // openings with words that keep a channel at once
const OUT_STATIC = 3;             // static openings, with no words, that take it out at once
const GAP_MS = 5 * 60 * 1000;     // longer between steps than this (the server was off): not counted as listening
const GRADE_WAIT_MS = 10 * 60 * 1000;   // how long the last grading waits on transcripts still to come

/**
 * What a frequency came to.
 * - **good**: words more than once, or once with no more than one static opening.
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
    this.working = new Set();   // radios a step is busy with
    this.db.exec(`
      -- A channel trial on one radio: the region tried in and its slots (docs/channels.md). home_region, trial_min,
      -- home_min, home_hz and batch_at were the first version's schedule, which moved the radio between regions
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
    const has = (table) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    const trials = has('trials');
    // The slots it fills; when it last counted listening; when it last changed the region
    if (!trials.has('slots')) this.db.exec('ALTER TABLE trials ADD COLUMN slots TEXT');
    if (!trials.has('listened_at')) this.db.exec('ALTER TABLE trials ADD COLUMN listened_at INTEGER');
    if (!trials.has('changed_at')) this.db.exec('ALTER TABLE trials ADD COLUMN changed_at INTEGER');
    const channels = has('trial_channels');
    // How long the radio has listened to it; whether it stayed on the radio
    if (!channels.has('listened_ms')) this.db.exec('ALTER TABLE trial_channels ADD COLUMN listened_ms INTEGER NOT NULL DEFAULT 0');
    if (!channels.has('kept')) this.db.exec('ALTER TABLE trial_channels ADD COLUMN kept INTEGER NOT NULL DEFAULT 0');
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error(`[trial] ${e.message}`)), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** @returns {object|null} The radio's trial under way: running, or ending. */
  active(mac) {
    return this.db.prepare(`SELECT * FROM trials WHERE mac = ? AND state IN ('running', 'ending')
                             ORDER BY id DESC LIMIT 1`).get(mac) ?? null;
  }

  trial(id) {
    return this.db.prepare('SELECT * FROM trials WHERE id = ?').get(id);
  }

  /**
   * Start trying channels on a radio, in a region's empty slots. The radio is put on that region, and left there.
   * @param {string} mac - The radio.
   * @param {object} o - region (to try in), hours (each channel listened to at most), services and miles (which
   *   candidates).
   * @returns {Promise<object>} status().
   */
  async begin(mac, o = {}) {
    if (this.active(mac)) throw fail('this radio is trying channels already: stop that first', 409);
    if (!this.uniden?.count()) throw fail('import Uniden’s database in Admin first');
    const region = int(o.region, 0, 63, NaN);
    if (!Number.isInteger(region)) throw fail('region is a region number');
    const services = [].concat(o.services ?? []).map(String).filter(Boolean);
    if (!services.length) throw fail('tick at least one service to try');
    const hours = Math.min(Math.max(Number(o.hours) || 12, 0.5), 48);
    const miles = int(o.miles, 1, 300, 30);
    const there = await this.manager.readChannels(mac, region);
    const slots = there.channels.filter((c) => c.empty).map((c) => c.id);
    if (!slots.length) throw fail(`${there.name || `region ${region + 1}`} has no empty channels: clear some to try channels in`);
    const toTry = this.toTry(mac);
    if (!this.uniden.stations(await this.home(), { miles, services }).stations.some((s) => toTry(s))) {
      throw fail(`every one of those within ${miles} mi has been tried on this radio already: tick another service, ` +
        'go further, or forget what was found (all of it, or the quiet ones) to try them again', 409);
    }
    // Only its empty slots are written, but it's backed up anyway
    const backup = this.store.addChannelBackup({ mac, region: there.region, regionName: there.name,
      label: 'Before trying channels', channels: there.channels });
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO trials (mac, region, home_region, trial_min, home_min, hours,
        services, miles, backup_id, slots, state, started_at, listened_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'running', ?, ?)`)
      .run(mac, region, region, hours, JSON.stringify(services), miles, backup.id, JSON.stringify(slots), this.now(), this.now());
    await this.listen(mac);
    await this.step(this.trial(lastInsertRowid));
    return this.status(mac);
  }

  /** Put the radio on its trial's region, scanning. @returns {Promise<object>} status(). */
  async listen(mac) {
    const t = this.active(mac);
    if (!t) throw fail('this radio isn’t trying channels', 404);
    const st = this.manager.state.get(mac);
    if (st?.region !== t.region) await this.manager.control(mac, 'region', t.region);
    await this.manager.control(mac, 'scan', true);
    return this.status(mac);
  }

  /**
   * End a radio's trial now: each channel still being tried is graded on what's come in, the good ones stay on the
   * radio, and the rest are taken off.
   * @returns {Promise<object>} status().
   */
  async end(mac) {
    const t = this.active(mac);
    if (!t) throw fail('this radio isn’t trying channels', 404);
    this.db.prepare("UPDATE trials SET state = 'ending' WHERE id = ?").run(t.id);
    await this.step(this.trial(t.id));
    return this.status(mac);
  }

  /**
   * Keep one channel being tried now, or take it out and try the next.
   * @param {string} mac - The radio.
   * @param {number} slot - Its slot.
   * @param {'keep'|'drop'} what - Which.
   * @returns {Promise<object>} status().
   */
  async decide(mac, slot, what) {
    const t = this.active(mac);
    if (!t || t.state !== 'running') throw fail('this radio isn’t trying channels', 404);
    if (!['keep', 'drop'].includes(what)) throw fail('keep or drop');
    const c = this.trying(t).find((x) => x.slot === Number(slot));
    if (!c) throw fail('no channel being tried there', 404);
    if (this.working.has(mac)) throw fail('busy with the radio: try again in a moment', 409);
    this.working.add(mac);
    try {
      await this.settle(t, [{ c, keep: what === 'keep' }]);
      await this.fill(this.trial(t.id));
    } finally {
      this.working.delete(mac);
    }
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

  /** One trial, a step on: listening counted, each channel kept or taken out when it's decided, the slots filled. */
  async step(t) {
    if (this.working.has(t.mac)) return;
    this.working.add(t.mac);
    try {
      // One of the first version's, under way at an upgrade: its region put back as it was
      if (!t.slots) return await this.putBack(t);
      if (t.state === 'ending') return await this.finish(t);
      this.count(t);
      const decided = [];
      for (const c of this.trying(t)) {
        const up = t.hours * 3600e3;
        if (c.speech >= KEEP_SPEECH) decided.push({ c, keep: true });
        else if (!c.speech && c.static >= OUT_STATIC && !c.pending) decided.push({ c, keep: false });
        // Its time up: graded once its transcripts are in, or have been waited on long enough
        else if (c.listened_ms >= up && (!c.pending || c.listened_ms >= up + GRADE_WAIT_MS)) {
          decided.push({ c, keep: verdict(c) === 'good' });
        }
      }
      if (decided.length) await this.settle(t, decided);
      if (!(await this.fill(this.trial(t.id))) && !this.trying(this.trial(t.id)).length) {
        this.db.prepare("UPDATE trials SET state = 'done', ended_at = ? WHERE id = ?").run(this.now(), t.id);
      }
      this.db.prepare('UPDATE trials SET error = NULL WHERE id = ?').run(t.id);
    } finally {
      this.working.delete(t.mac);
    }
  }

  /** Count the time since the last step as listening, for each channel being tried, if the radio was on the region. */
  count(t) {
    const now = this.now();
    const gap = now - (t.listened_at ?? now);
    const st = this.manager.state.get(t.mac);
    if (gap > 0 && gap <= GAP_MS && st?.state === 'connected' && st.region === t.region) {
      this.db.prepare('UPDATE trial_channels SET listened_ms = listened_ms + ? WHERE trial_id = ? AND verdict IS NULL').run(gap, t.id);
    }
    this.db.prepare('UPDATE trials SET listened_at = ? WHERE id = ?').run(now, t.id);
  }

  /** The channels being tried, with what's come in on each since it was written. */
  trying(t) {
    const rows = this.db.prepare('SELECT * FROM trial_channels WHERE trial_id = ? AND verdict IS NULL ORDER BY slot').all(t.id);
    const since = Math.min(...rows.map((r) => r.started_at));
    const heard = rows.length ? this.store.heardByFrequency({ mac: t.mac, since }) : new Map();
    return rows.map((r) => {
      // Only what came in since this one was written: a slot's earlier channel may have been on the same frequency
      const own = rows.length && r.started_at > since ? this.store.heardByFrequency({ mac: t.mac, since: r.started_at }) : heard;
      const c = own.get(r.hz) ?? { heard: 0, static: 0, speech: 0, pending: 0, sample: null };
      return { ...r, ...c, station: JSON.parse(r.station) };
    });
  }

  /**
   * Channels decided: each kept one written as found (a ham repeater with its input and tone), each other one taken
   * off the radio, and their verdicts kept.
   * @param {object} t - The trial.
   * @param {{c: object, keep: boolean}[]} decided - Which, and whether each is kept.
   */
  async settle(t, decided) {
    const read = await this.manager.readChannels(t.mac, t.region);
    const out = [];
    for (const { c, keep } of decided) {
      const slot = read.channels.find((s) => s.id === c.slot);
      // Changed on the radio since (by hand, in Channels): left as it is
      if (!slot || slot.empty || slot.rx_hz !== c.hz) continue;
      out.push(keep ? checkChannel({ ...c.station.channel, id: c.slot, name: c.name, scan: true }) : { id: c.slot, rx_hz: 0 });
    }
    if (out.length) await this.manager.writeChannels(t.mac, t.region, out);
    const set = this.db.prepare(`UPDATE trial_channels SET ended_at = ?, heard = ?, static = ?, speech = ?, sample = ?,
                                   verdict = ?, kept = ? WHERE id = ?`);
    const kept = new Set();
    for (const { c, keep } of decided) {
      set.run(this.now(), c.heard, c.static, c.speech, c.sample ? JSON.stringify(c.sample) : null, verdict(c), keep ? 1 : 0, c.id);
      if (keep) kept.add(c.slot);
    }
    // A kept one's slot is the radio's now, not the trial's
    const slots = JSON.parse(t.slots).filter((s) => !kept.has(s));
    this.db.prepare('UPDATE trials SET slots = ?, changed_at = ? WHERE id = ?').run(JSON.stringify(slots), this.now(), t.id);
  }

  /**
   * What a candidate is tried as on a radio: itself if it hasn't been, else a noisy ham repeater listened to only with
   * its tone (which keeps out noise and other users if the repeater sends it), else nothing.
   * @param {string} mac - The radio.
   * @returns {(s: object) => object|null} The station to try, or null.
   */
  toTry(mac) {
    const tried = new Set(this.db.prepare('SELECT key FROM trial_channels WHERE mac = ?').all(mac).map((r) => r.key));
    const noisy = new Set(this.db.prepare(`SELECT key FROM trial_channels c WHERE mac = ? AND verdict IN ('static', 'some')
        AND id = (SELECT max(id) FROM trial_channels d WHERE d.mac = c.mac AND d.key = c.key)`).all(mac).map((r) => r.key));
    return (found) => {
      const s = tried.has(found.key) && noisy.has(found.key) ? withTone(found) : found;
      return s && s.ok && !tried.has(s.key) ? s : null;
    };
  }

  /** The trial's empty slots filled with the next candidates. @returns {Promise<boolean>} False when none are left. */
  async fill(t) {
    const busy = new Set(this.trying(t).map((c) => c.slot));
    const free = JSON.parse(t.slots).filter((s) => !busy.has(s));
    if (!free.length) return true;
    const read = await this.manager.readChannels(t.mac, t.region);
    // Still empty on the radio: one filled by hand since is left alone
    const open = free.filter((s) => read.channels.find((c) => c.id === s)?.empty);
    if (!open.length) return true;
    const onRadio = new Set(read.channels.filter((c) => !c.empty && c.rx_hz).map((c) => c.rx_hz));
    const { stations } = this.uniden.stations(await this.home(), { miles: t.miles, services: JSON.parse(t.services) });
    const toTry = this.toTry(t.mac);
    const next = [];
    for (const found of stations) {
      if (next.length >= open.length) break;
      const s = toTry(found);
      if (!s || onRadio.has(s.channel.rx_hz)) continue;
      onRadio.add(s.channel.rx_hz);
      next.push(s);
    }
    if (!next.length) return false;
    // Listened to only, whatever it is: the station as found is kept, to be written as it is if it's kept
    const names = new Set(read.channels.filter((c) => !c.empty).map((c) => String(c.name).toLowerCase()));
    const channels = next.map((s, i) => {
      let name = radioName(s.name) || 'Trial';
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `${radioName(s.name).slice(0, 10 - String(n).length - 1)} ${n}`;
      names.add(name.toLowerCase());
      return checkChannel({ ...s.channel, id: open[i], name, tx_hz: s.channel.rx_hz, tx_tone: '', tx_disable: true, power: 'low', scan: true });
    });
    const wrote = await this.manager.writeChannels(t.mac, t.region, channels);
    const at = this.now();
    const ins = this.db.prepare(`INSERT INTO trial_channels (trial_id, mac, batch, slot, key, hz, name, station, started_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    next.forEach((s, i) => {
      const slot = open[i];
      const name = wrote.results?.find((r) => r.id === slot)?.channel?.name ?? channels[i].name;
      ins.run(t.id, t.mac, t.batch + 1, slot, s.key, s.channel.rx_hz, name, JSON.stringify(s), at);
      if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) this.store.placeChannelIfUnplaced(name, s.lat, s.lon);
    });
    this.db.prepare('UPDATE trials SET batch = batch + 1, changed_at = ? WHERE id = ?').run(at, t.id);
    return true;
  }

  /** Each channel still being tried graded on what's come in: the good ones stay, the rest come off. */
  async finish(t) {
    const left = this.trying(t);
    if (left.length) await this.settle(t, left.map((c) => ({ c, keep: verdict(c) === 'good' })));
    this.db.prepare("UPDATE trials SET state = 'done', ended_at = ?, error = NULL WHERE id = ?").run(this.now(), t.id);
  }

  /** A first-version trial: the region as it was before, and the radio back on its own. */
  async putBack(t) {
    const backup = this.store.channelBackup(t.backup_id);
    if (backup) await this.manager.writeChannels(t.mac, t.region, backup.channels.map((c) => ({ id: c.id, raw: c.raw })));
    if (this.manager.state.get(t.mac)?.region !== t.home_region) {
      await this.manager.control(t.mac, 'region', t.home_region);
      await this.manager.control(t.mac, 'scan', true);
    }
    this.db.prepare("UPDATE trials SET state = 'done', ended_at = ?, batch_at = NULL, error = NULL WHERE id = ?").run(this.now(), t.id);
  }

  /**
   * A radio's trial, and every frequency tried on it.
   * @param {string} mac - The radio.
   * @returns {{trial: object|null, channels: object[], results: object[]}} The trial under way (or the last), the
   *   channels being tried with what's come in, and the verdict on each frequency tried, good first.
   */
  status(mac) {
    const t = this.active(mac) ?? this.db.prepare('SELECT * FROM trials WHERE mac = ? ORDER BY id DESC LIMIT 1').get(mac) ?? null;
    const st = this.manager.state.get(mac);
    const counts = t ? this.db.prepare(`SELECT count(*) AS tried, coalesce(sum(kept), 0) AS kept FROM trial_channels
                                         WHERE trial_id = ? AND verdict IS NOT NULL`).get(t.id) : null;
    const trial = t && {
      id: t.id, state: t.state, region: t.region, hours: t.hours, services: JSON.parse(t.services ?? '[]'), miles: t.miles,
      slots: JSON.parse(t.slots ?? '[]').length, startedAt: t.started_at, endedAt: t.ended_at, changedAt: t.changed_at,
      error: t.error, backupId: t.backup_id, tried: counts.tried, kept: counts.kept,
      // Listening only counts while the radio is on the region
      listening: st?.state === 'connected' && st.region === t.region, radioRegion: st?.region ?? null,
    };
    const channels = t?.state === 'running' && t.slots ? this.trying(t).map(({ station, ...c }) => ({
      slot: c.slot, name: c.name, hz: c.hz, key: c.key, service: station.service, toneSquelch: Boolean(station.toneSquelch),
      km: station.km ?? null, where: station.where ?? '', heard: c.heard, static: c.static, speech: c.speech, pending: c.pending,
      sample: c.sample, verdict: verdict(c), listenedHours: c.listened_ms / 3600e3, startedAt: c.started_at,
    })) : [];
    // The latest verdict on each frequency tried on this radio
    const order = { good: 0, some: 1, static: 2, quiet: 3 };
    const results = this.db.prepare(`SELECT * FROM trial_channels c WHERE mac = ? AND verdict IS NOT NULL
        AND id = (SELECT max(id) FROM trial_channels d WHERE d.mac = c.mac AND d.key = c.key AND d.verdict IS NOT NULL)`)
      .all(mac).map((r) => ({
        key: r.key, name: r.name, hz: r.hz, verdict: r.verdict, kept: Boolean(r.kept), heard: r.heard, static: r.static,
        speech: r.speech, sample: JSON.parse(r.sample ?? 'null'), triedAt: r.started_at,
        hours: r.listened_ms ? r.listened_ms / 3600e3 : ((r.ended_at ?? r.started_at) - r.started_at) / 3600e3,
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
   * @param {string|null} [key] - One frequency; null for every one not being tried now.
   * @param {{verdict?: string|null}} [o] - Only those whose latest result is this ("quiet").
   * @returns {{forgotten: number}} How many frequencies.
   */
  forget(mac, key = null, { verdict = null } = {}) {
    const keys = key ? [key] : this.db.prepare(`SELECT key FROM trial_channels c WHERE mac = ? AND verdict IS NOT NULL
        AND (? IS NULL OR verdict = ?)
        AND id = (SELECT max(id) FROM trial_channels d WHERE d.mac = c.mac AND d.key = c.key AND d.verdict IS NOT NULL)`)
      .all(mac, verdict, verdict).map((r) => r.key);
    const del = this.db.prepare('DELETE FROM trial_channels WHERE mac = ? AND key = ? AND verdict IS NOT NULL');
    return { forgotten: keys.filter((k) => del.run(mac, k).changes > 0).length };
  }
}
