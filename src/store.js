import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATIC_DB, isStatic } from './quality.js';

/**
 * Radios and transmissions, in SQLite. `node:sqlite` needs Node 22.5+, which
 * is why package.json pins the engine; it keeps the project free of native
 * add-ons to build on the target machine.
 */
export class Store {
  /**
   * @param {string} file - Database path, or ':memory:'.
   * @param {string | null} [defaultEngine] - Whose transcript `text` reports.
   */
  constructor(file, defaultEngine = null) {
    // Named so `text` can mean "what the default engine heard" rather than
    // whichever transcript happens to be first.
    this.defaultEngine = defaultEngine;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured dataDir
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS radios (
        mac TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT, added_at INTEGER NOT NULL,
        public INTEGER NOT NULL DEFAULT 0, "group" TEXT);
      CREATE TABLE IF NOT EXISTS transmissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        audio_file TEXT NOT NULL, status TEXT NOT NULL,
        transmit INTEGER NOT NULL DEFAULT 0,
        channel INTEGER, channel_name TEXT, channel_hz INTEGER,
        text TEXT, engine TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS tx_time ON transmissions(started_at DESC);
      -- One row per engine per transmission, so a clip can be transcribed by
      -- more than one model and re-run without destroying what came before.
      CREATE TABLE IF NOT EXISTS transcripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transmission_id INTEGER NOT NULL,
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        text TEXT, error TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(transmission_id, engine));
      CREATE INDEX IF NOT EXISTS transcripts_tx ON transcripts(transmission_id);
      -- Settings changed from the page rather than the settings file, which
      -- the service may only read: so far, how long to keep transmissions.
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      -- Where a channel is, for the Map view: set by an admin, by the name the
      -- radio gives the channel, as the feed's channel filter uses
      CREATE TABLE IF NOT EXISTS channel_places (
        name TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, updated_at INTEGER NOT NULL);
      -- A radio's channels as they were: every slot of one region, each as the
      -- radio's own record, taken before AirScribe writes over them (or when an
      -- admin asks), so they can be put back exactly
      CREATE TABLE IF NOT EXISTS channel_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL, region INTEGER NOT NULL, region_name TEXT,
        label TEXT NOT NULL, created_at INTEGER NOT NULL, channels TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS channel_backups_mac ON channel_backups(mac, id DESC);
      -- Packets decoded (APRS, or the radios' BSS), each once: who it's about
      -- (an object's name, else the sender), what it said in a line, where,
      -- and everything else decoded as JSON; the transmission it came in, when
      -- the radio's audio carried it too; and what decoded it: the radio's own
      -- modem, AirScribe from the audio (src/afsk.js), or both
      CREATE TABLE IF NOT EXISTS packets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL, received_at INTEGER NOT NULL,
        channel INTEGER, channel_name TEXT, channel_hz INTEGER,
        format TEXT NOT NULL, source TEXT NOT NULL, destination TEXT, path TEXT,
        who TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL,
        lat REAL, lon REAL, info TEXT, raw TEXT NOT NULL, data TEXT NOT NULL,
        transmission_id INTEGER, decoded_by TEXT NOT NULL DEFAULT 'radio');
      CREATE INDEX IF NOT EXISTS packets_time ON packets(received_at DESC);
      CREATE INDEX IF NOT EXISTS packets_who ON packets(who, received_at DESC);
      CREATE INDEX IF NOT EXISTS packets_tx ON packets(transmission_id);
    `);
    this.migrate();
  }

  /**
   * Bring an older database up to the current schema. Columns added after a
   * table exists are invisible to CREATE TABLE IF NOT EXISTS, so each one is
   * added here instead of rebuilding the table and losing its rows.
   * @returns {void}
   */
  migrate() {
    const columns = this.db.prepare('PRAGMA table_info(transmissions)').all();
    const added = [
      ['transmit', 'INTEGER NOT NULL DEFAULT 0'],
      // Which channel the radio was on. Older rows have none; a scanner's
      // transcript is far less useful without it, but it cannot be recovered
      // after the fact.
      ['channel', 'INTEGER'],
      ['channel_name', 'TEXT'],
      ['channel_hz', 'INTEGER'],
      // How it came through: the radio's strongest signal reading while it did
      // (0 to 15), and its quieting in dB (src/quality.js). Older rows have none.
      ['rssi', 'INTEGER'],
      ['snr_db', 'REAL'],
      // A short transmission that was only a packet (the radio's modem decoded
      // it): shown as the packet, and not transcribed
      ['data', 'INTEGER NOT NULL DEFAULT 0'],
      // What a scanner said about it besides the channel (system, department, talkgroup, unit...), as JSON
      ['details', 'TEXT'],
    ];
    for (const [name, decl] of added) {
      if (!columns.some((c) => c.name === name)) {
        this.db.exec(`ALTER TABLE transmissions ADD COLUMN ${name} ${decl}`);
      }
    }
    // Publishing is opt-in per radio, so an existing radio stays private
    // when the feature arrives. That default is the whole point.
    const radioCols = this.db.prepare('PRAGMA table_info(radios)').all();
    for (const [name, decl] of [['public', 'INTEGER NOT NULL DEFAULT 0'], ['"group"', 'TEXT']]) {
      if (!radioCols.some((c) => `"${c.name}"` === name || c.name === name)) {
        this.db.exec(`ALTER TABLE radios ADD COLUMN ${name} ${decl}`);
      }
    }
    // What decoded a packet; every one kept before AirScribe decoded any itself was the radio's
    if (!this.db.prepare('PRAGMA table_info(packets)').all().some((c) => c.name === 'decoded_by')) {
      this.db.exec("ALTER TABLE packets ADD COLUMN decoded_by TEXT NOT NULL DEFAULT 'radio'");
    }
    this.migrateTranscripts(columns);
    // whisper.cpp's "heard nothing" marker, stored as text before the engines
    // dropped it: without this, those clips would never count as no speech
    this.db.exec(`UPDATE transcripts SET text = trim(replace(text, '[BLANK_AUDIO]', ''))
                   WHERE text LIKE '%[BLANK_AUDIO]%'`);
  }

  /**
   * Move transcripts off `transmissions` and into their own table.
   *
   * They used to be three columns on the transmission, which allowed exactly
   * one transcript that a re-run would overwrite. Leaving those columns in
   * place alongside the new table would be two sources of truth, so the rows
   * are copied across and the columns dropped — in a transaction, because a
   * half-done version of this loses transcripts.
   * @param {object[]} columns - `PRAGMA table_info(transmissions)` rows.
   * @returns {void}
   */
  migrateTranscripts(columns) {
    if (!columns.some((c) => c.name === 'text')) return; // already migrated
    this.db.exec('BEGIN');
    try {
      // A failure with no engine never got as far as running one — the
      // module was missing, the model path was wrong — so attributing it to
      // 'unknown' would leave a phantom entry beside every clip that is later
      // transcribed properly. A finished transcript with no engine is
      // different: its text is the only copy, so it is kept as 'unknown'
      // rather than dropped.
      this.db.exec(`
        INSERT OR IGNORE INTO transcripts
          (transmission_id, engine, status, text, error, created_at)
        SELECT id, COALESCE(engine, 'unknown'), status, text, error, started_at
          FROM transmissions
         WHERE (engine IS NOT NULL AND status IN ('done', 'error'))
            OR (engine IS NULL AND status = 'done')
      `);
      // Those unattributable ones have no transcript now, which is what
      // 'pending' means: audio present, nothing has read it.
      this.db.exec(`
        UPDATE transmissions SET status = 'pending'
         WHERE engine IS NULL AND status = 'error'
      `);
      for (const name of ['text', 'engine', 'error']) {
        this.db.exec(`ALTER TABLE transmissions DROP COLUMN ${name}`);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw new Error(`transcript migration failed, database unchanged: ${e.message}`);
    }
  }

  /** @returns {object[]} All saved radios. */
  radios() {
    return this.db.prepare('SELECT * FROM radios ORDER BY added_at').all();
  }

  /**
   * @param {string} mac - Normalised MAC.
   * @returns {object | undefined} The radio, if saved.
   */
  radio(mac) {
    return this.db.prepare('SELECT * FROM radios WHERE mac = ?').get(mac);
  }

  /**
   * @param {{mac: string, name: string, model: string | null}} r - The radio.
   * @returns {void}
   */
  saveRadio({ mac, name, model }) {
    this.db
      .prepare(
        `INSERT INTO radios (mac, name, model, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(mac) DO UPDATE SET name = excluded.name, model = excluded.model`,
      )
      .run(mac, name, model, Date.now());
  }

  /**
   * Change what a radio is called, whether it is published, and its group.
   *
   * Publishing is deliberately a separate call from saving a radio, so that
   * adding one can never turn it on by accident.
   * @param {string} mac - The radio.
   * @param {{name?: string, public?: boolean, group?: string|null}} patch - Changes.
   * @returns {object | undefined} The updated row.
   */
  updateRadio(mac, patch) {
    const sets = [];
    const args = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(String(patch.name).slice(0, 60)));
    if (patch.public !== undefined) (sets.push('public = ?'), args.push(patch.public ? 1 : 0));
    if (patch.group !== undefined) {
      sets.push('"group" = ?');
      args.push(patch.group ? String(patch.group).slice(0, 40) : null);
    }
    if (sets.length) this.db.prepare(`UPDATE radios SET ${sets.join(', ')} WHERE mac = ?`).run(...args, mac);
    return this.radio(mac);
  }

  /** @returns {string[]} The groups in use, for a filter. */
  groups() {
    return this.db
      .prepare(`SELECT DISTINCT "group" AS g FROM radios
                 WHERE g IS NOT NULL AND g <> '' ORDER BY g`)
      .all()
      .map((r) => r.g);
  }

  /**
   * @param {string} mac - Radio to forget. Its transmissions are kept.
   * @returns {void}
   */
  deleteRadio(mac) {
    this.db.prepare('DELETE FROM radios WHERE mac = ?').run(mac);
  }

  /**
   * @param {{mac: string, startedAt: number, durationMs: number, audioFile: string,
   *   transmit?: boolean, channel?: number, channelName?: string,
   *   channelHz?: number}} t - A new clip.
   * @returns {number} Its id.
   */
  addTransmission({ mac, startedAt, durationMs, audioFile, transmit = false,
                    channel = null, channelName = null, channelHz = null, rssi = null, snrDb = null, details = null }) {
    const r = this.db
      .prepare(
        `INSERT INTO transmissions
           (mac, started_at, duration_ms, audio_file, status, transmit,
            channel, channel_name, channel_hz, rssi, snr_db, details)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(mac, startedAt, Math.round(durationMs), audioFile, transmit ? 1 : 0,
           channel, channelName, channelHz, rssi, snrDb,
           details && Object.keys(details).length ? JSON.stringify(details) : null);
    return Number(r.lastInsertRowid);
  }

  /**
   * @param {string} mac - A radio.
   * @param {number} startedAt - When (ms).
   * @returns {number|null} The id of its transmission that started then, if there is one: a recording sent twice.
   */
  transmissionAt(mac, startedAt) {
    return this.db.prepare('SELECT id FROM transmissions WHERE mac = ? AND started_at = ?').get(mac, startedAt)?.id ?? null;
  }

  /**
   * How each channel came through since a time: for each name a radio gave
   * its received transmissions, the signal readings, quieting and whether
   * each came to no speech, for src/quality.js to judge.
   * @param {{since?: number, mac?: string}} f - Since when (ms), and which radio.
   * @returns {Map<string, {rssi: number|null, snr_db: number|null, no_speech: number}[]>} By channel name.
   */
  channelQuality({ since = 0, mac } = {}) {
    const none = this.#noSpeech();
    const rows = this.db.prepare(
      `SELECT t.channel_name AS name, t.rssi, t.snr_db, (${none.sql}) AS no_speech
         FROM transmissions t
        WHERE t.transmit = 0 AND t.started_at >= ? AND t.channel_name IS NOT NULL AND t.channel_name <> ''
              ${mac ? 'AND t.mac = ?' : ''}
        ORDER BY t.started_at`,
    ).all(...none.args, since, ...(mac ? [mac] : []));
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.name)) out.set(r.name, []);
      out.get(r.name).push({ rssi: r.rssi, snr_db: r.snr_db, no_speech: r.no_speech ? 1 : 0 });
    }
    return out;
  }

  /**
   * What one radio heard on each frequency over a time, for a channel trial (src/trial.js): how many times the
   * squelch opened, how many were static, and how many came to words (two or more, from the main engine, not static
   * or data), with the latest of those.
   * @param {{mac: string, since: number, until?: number}} f - The radio and the time.
   * @returns {Map<number, {heard: number, static: number, speech: number, pending: number, sample: object|null}>}
   *   By receive frequency in hertz.
   */
  heardByFrequency({ mac, since, until = Number.MAX_SAFE_INTEGER }) {
    const engine = this.defaultEngine ? 'AND x.engine = ?' : '';
    const rows = this.db.prepare(
      `SELECT t.id, t.channel_hz AS hz, t.started_at, t.status, t.data,
              (t.snr_db IS NOT NULL AND t.snr_db < ${STATIC_DB}) AS static,
              (SELECT x.text FROM transcripts x WHERE x.transmission_id = t.id AND x.status = 'done' ${engine}
                 AND instr(trim(coalesce(x.text, '')), ' ') > 0 ORDER BY x.id LIMIT 1) AS words
         FROM transmissions t
        WHERE t.mac = ? AND t.transmit = 0 AND t.channel_hz IS NOT NULL AND t.started_at >= ? AND t.started_at < ?
        ORDER BY t.started_at`,
    ).all(...(this.defaultEngine ? [this.defaultEngine] : []), mac, since, until);
    const out = new Map();
    for (const r of rows) {
      const c = out.get(r.hz) ?? { heard: 0, static: 0, speech: 0, pending: 0, sample: null };
      out.set(r.hz, c);
      c.heard++;
      if (r.static) c.static++;
      else if (r.words && !r.data) {
        c.speech++;
        c.sample = { id: r.id, at: r.started_at, text: r.words };
      } else if (r.status === 'pending') c.pending++;
    }
    return out;
  }

  /**
   * Record what one engine made of one transmission, replacing any earlier
   * attempt by the same engine.
   * @param {number} id - Transmission id.
   * @param {string} engine - Engine name.
   * @param {{status: string, text?: string, error?: string}} r - Outcome.
   * @returns {void}
   */
  saveTranscript(id, engine, { status, text = null, error = null }) {
    this.db
      .prepare(
        `INSERT INTO transcripts (transmission_id, engine, status, text, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(transmission_id, engine) DO UPDATE SET
           status = excluded.status, text = excluded.text,
           error = excluded.error, created_at = excluded.created_at`,
      )
      .run(id, engine, status, text, error, Date.now());
    this.refreshTransmissionStatus(id);
  }

  /**
   * Keep `transmissions.status` as a summary of its transcripts, so the feed
   * can be listed and filtered without joining for every row.
   * @param {number} id - Transmission id.
   * @returns {void}
   */
  refreshTransmissionStatus(id) {
    const rows = this.transcripts(id);
    const status = rows.some((t) => t.status === 'done')
      ? 'done'
      : rows.some((t) => t.status === 'pending')
        ? 'pending'
        : rows.length
          ? 'error'
          : 'pending';
    this.db.prepare('UPDATE transmissions SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * @param {number} id - Transmission id.
   * @returns {object[]} Its transcripts, oldest first.
   */
  transcripts(id) {
    return this.db
      .prepare('SELECT * FROM transcripts WHERE transmission_id = ? ORDER BY id')
      .all(id);
  }

  /**
   * @param {number} id - Transmission id.
   * @returns {object | undefined} The row.
   */
  transmission(id) {
    // With the radio's name, as the list has it: a single clip's download and
    // a live update name the radio too
    const row = this.db
      .prepare(`SELECT t.*, r.name AS radio_name, r."group" AS radio_group
                  FROM transmissions t LEFT JOIN radios r ON r.mac = t.mac WHERE t.id = ?`)
      .get(id);
    return row ? this.withTranscripts([row])[0] : undefined;
  }

  /**
   * Attach each transmission's transcripts, and the best one as `text`.
   *
   * `text` is kept because most callers want one transcript, and because it
   * is what the feed and the downloads have always used. It is the default
   * engine's where there is one, so adding a comparison engine does not
   * change what the page shows.
   * @param {object[]} rows - Transmission rows.
   * @returns {object[]} The same rows, with `transcripts`, `text` and `engine`.
   */
  withTranscripts(rows) {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    // In chunks: an export can name tens of thousands of clips, more than one
    // statement may bind
    const all = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      all.push(...this.db
        .prepare(`SELECT * FROM transcripts WHERE transmission_id IN (${chunk.map(() => '?').join(',')})
                  ORDER BY id`)
        .all(...chunk));
    }
    const byTx = new Map();
    for (const t of all) {
      if (!byTx.has(t.transmission_id)) byTx.set(t.transmission_id, []);
      byTx.get(t.transmission_id).push(t);
    }
    // Packets that came in each one, as one line each
    const linked = new Map();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const p of this.db
        .prepare(`SELECT id, transmission_id, source, type, summary, data FROM packets
                   WHERE transmission_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`)
        .all(...chunk)) {
        if (!linked.has(p.transmission_id)) linked.set(p.transmission_id, []);
        linked.get(p.transmission_id).push({ id: p.id, source: p.source, type: p.type, summary: p.summary,
          icon: JSON.parse(p.data).symbol?.icon ?? null });
      }
    }
    return rows.map((r) => {
      const ts = byTx.get(r.id) ?? [];
      const best = ts.find((t) => t.engine === this.defaultEngine && t.status === 'done')
        ?? ts.find((t) => t.status === 'done')
        ?? ts[0];
      return { ...r, details: r.details ? JSON.parse(r.details) : null, transcripts: ts, text: best?.text ?? null,
               engine: best?.engine ?? null, error: best?.error ?? null,
               // Mostly noise, by its quieting: marked in the feed, whatever a model wrote for it
               static: isStatic(r.snr_db),
               packets: linked.get(r.id) ?? [] };
    });
  }

  /**
   * A page of transmissions, newest first.
   *
   * Paged by key rather than by offset: `before` is the last row already
   * shown, and the page is what is older than it, by time and then id. New
   * transmissions arriving meanwhile then don't shift the pages, and the
   * boundary is exact even when two radios start in the same millisecond.
   * @param {object} f - Filters, as for countTransmissions, and:
   * @param {number} [f.limit] - Rows wanted, up to `max`.
   * @param {{at: number, id: number}} [f.before] - Only rows older than this one.
   * @param {number} [f.max] - The most `limit` may ask for: 500 for a page, more for an export.
   * @returns {object[]} Newest first.
   */
  transmissions({ limit = 100, before, max = 500, ...f } = {}) {
    const { where, args } = this.#filters(f);
    if (before) {
      where.push('(t.started_at < ? OR (t.started_at = ? AND t.id < ?))');
      args.push(before.at, before.at, before.id);
    }
    // Left join, so a transmission whose radio was removed is still listed
    // to an operator — but never publicly, since r.public is then null.
    const sql = `SELECT t.*, r.name AS radio_name, r."group" AS radio_group
                   FROM transmissions t LEFT JOIN radios r ON r.mac = t.mac
                  WHERE ${where.join(' AND ')}
                  ORDER BY t.started_at DESC, t.id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, Math.min(Number(limit) || 100, max));
    return this.withTranscripts(rows);
  }

  /**
   * How many transmissions a filter matches, for "50 of 1,234".
   * @param {object} [f] - The same filters as transmissions().
   * @returns {number} The count.
   */
  countTransmissions(f = {}) {
    const { where, args } = this.#filters(f);
    return this.db
      .prepare(`SELECT COUNT(*) AS n FROM transmissions t LEFT JOIN radios r ON r.mac = t.mac
                 WHERE ${where.join(' AND ')}`)
      .get(...args).n;
  }

  /**
   * The WHERE clause the page, its count and the exports share.
   * @param {{mac?: string, q?: string, group?: string, channel?: string | string[],
   *   publicOnly?: boolean, notAfter?: number}} f - Filters. `channel` may name several
   *   channels, as the Map's list does for those in view; an empty list is no filter.
   * @returns {{where: string[], args: any[]}} Conditions and their values.
   */
  #filters({ mac, q, group, channel, publicOnly, notAfter, speech } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (mac) (where.push('t.mac = ?'), args.push(mac));
    if (speech) {
      const none = this.#noSpeech();
      where.push(`NOT ${none.sql}`);
      args.push(...none.args);
    }
    if (group) (where.push('r."group" = ?'), args.push(group));
    const channels = [].concat(channel ?? []).filter(Boolean);
    if (channels.length) {
      where.push(`t.channel_name IN (${channels.map(() => '?').join(', ')})`);
      args.push(...channels);
    }
    // The publishing gate applied in the query rather than after it, so the
    // delay does not depend on every caller remembering to subtract it.
    if (publicOnly) where.push('r.public = 1');
    if (notAfter !== undefined) (where.push('t.started_at <= ?'), args.push(notAfter));
    if (q) {
      // Any engine's transcript, or the channel name — searching for "fire"
      // should find the fire channel's traffic, not only clips that say it.
      // A scanner's details too: its system, department, talkgroup or unit.
      where.push(
        '(t.id IN (SELECT transmission_id FROM transcripts WHERE text LIKE ?)' +
          ' OR t.channel_name LIKE ?' +
          ' OR (t.details IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(t.details) WHERE value LIKE ?)))',
      );
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    return { where, args };
  }

  /**
   * "No speech": the transcript the feed shows, the default engine's, is
   * finished and empty, which the page shows as "(no speech recognised)". A
   * clip still being transcribed, or never, doesn't count.
   * @returns {{sql: string, args: any[]}} A condition on `t`.
   */
  #noSpeech() {
    // Static counts too, whatever a model made of it: Whisper writes sentences
    // into a minute of hiss (src/quality.js)
    // And a transmission that was only a packet: data, not speech
    const noise = `(t.data = 1 OR (t.snr_db IS NOT NULL AND t.snr_db < ${STATIC_DB}))`;
    if (!this.defaultEngine) return { sql: noise, args: [] };
    return {
      sql: `(${noise} OR EXISTS (SELECT 1 FROM transcripts x WHERE x.transmission_id = t.id AND x.engine = ?
                       AND x.status = 'done' AND trim(coalesce(x.text, '')) = ''))`,
      args: [this.defaultEngine],
    };
  }

  /**
   * Received transmissions not yet measured for static, newest first: those
   * from before it was measured as they came in.
   * @param {{before?: number, limit?: number}} f - Only ids below this; how many.
   * @returns {{id: number, audio_file: string}[]} Their audio.
   */
  needingQuality({ before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    return this.db.prepare(`SELECT id, audio_file FROM transmissions
                             WHERE transmit = 0 AND snr_db IS NULL AND id < ? ORDER BY id DESC LIMIT ?`).all(before, limit);
  }

  /**
   * @param {number} id - A transmission.
   * @param {number} snrDb - Its quieting, in dB.
   * @returns {void}
   */
  setQuality(id, snrDb) {
    this.db.prepare('UPDATE transmissions SET snr_db = ? WHERE id = ?').run(snrDb, id);
  }

  // ---- Packets ---------------------------------------------------------------

  /**
   * Keep a decoded packet (src/aprs.js), unless the same one from the same
   * sender came in the last 30 seconds: a digipeater's copy of it, or the
   * same packet from the other decoder, which marks the one kept as decoded
   * by both.
   * @param {object} p - Where and when it was heard (mac, receivedAt, channel, channelName, channelHz, raw), what
   *   decoded it (decodedBy: radio or airscribe), and the packet.
   * @returns {number|null} Its id, or null for a copy.
   */
  addPacket({ mac, receivedAt, channel = null, channelName = null, channelHz = null, raw, decodedBy = 'radio', ...p }) {
    const { format, source, destination = null, path = [], type, summary, lat = null, lon = null, info = null, ...rest } = p;
    const copy = this.db.prepare('SELECT id, decoded_by FROM packets WHERE source = ? AND info IS ? AND received_at > ? ORDER BY id DESC LIMIT 1')
      .get(source, info, receivedAt - 30000);
    if (copy) {
      if (copy.decoded_by !== decodedBy && copy.decoded_by !== 'both') {
        this.db.prepare("UPDATE packets SET decoded_by = 'both' WHERE id = ?").run(copy.id);
      }
      return null;
    }
    // Who it's about: an object or item by its own name, so a station's several objects are several places
    const who = (type === 'object' || type === 'item' || (type === 'weather' && rest.name)) && rest.name ? rest.name : source;
    const r = this.db.prepare(`INSERT INTO packets (mac, received_at, channel, channel_name, channel_hz, format, source,
        destination, path, who, type, summary, lat, lon, info, raw, data, decoded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(mac, receivedAt, channel, channelName, channelHz, format, source, destination, path.join(','), who, type, summary,
        Number.isFinite(lat) ? lat : null, Number.isFinite(lon) ? lon : null, info, raw, JSON.stringify(rest), decodedBy);
    return Number(r.lastInsertRowid);
  }

  /** A packets row as the API gives it: its columns, with everything else decoded spread in. */
  #packetRow(r) {
    if (!r) return undefined;
    const { data, path, rn, ...cols } = r;
    return { ...JSON.parse(data), ...cols, path: path ? path.split(',') : [] };
  }

  /** @returns {object|undefined} One packet. */
  packet(id) {
    return this.#packetRow(this.db.prepare('SELECT * FROM packets WHERE id = ?').get(id));
  }

  /**
   * Packets, newest first.
   * @param {{limit?: number, before?: number, kind?: string, q?: string, mac?: string}} f - How many; only ids below
   *   `before`; a kind (positions, weather, messages, status, bss, other); text in who, the sender, or what it said.
   * @returns {object[]} The packets.
   */
  packets({ limit = 100, before, kind, q, mac } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (before) (where.push('id < ?'), args.push(before));
    if (mac) (where.push('mac = ?'), args.push(mac));
    const kinds = { positions: ['position', 'object', 'item'], weather: ['weather'], messages: ['message'],
      status: ['status'], bss: ['bss'], other: ['telemetry', 'other', 'invalid'] }[kind];
    if (kinds) where.push(`type IN (${kinds.map(() => '?').join(', ')})`), args.push(...kinds);
    if (q) (where.push('(who LIKE ? OR source LIKE ? OR summary LIKE ?)'), args.push(`%${q}%`, `%${q}%`, `%${q}%`));
    return this.db.prepare(`SELECT * FROM packets WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(500, Math.max(1, limit)))
      .map((r) => this.#packetRow(r));
  }

  /**
   * Each station's (or object's) latest place since a time, most recently heard first, with how many
   * places it sent and when it was first heard. Objects taken off the map are left out.
   * @param {{since?: number, mac?: string}} f - Since when (ms), and which radio heard them.
   * @returns {object[]} The latest packet with a place, per station.
   */
  stations({ since = 0, mac } = {}) {
    return this.db.prepare(`SELECT * FROM (
        SELECT p.*, ROW_NUMBER() OVER (PARTITION BY who ORDER BY received_at DESC, id DESC) AS rn,
               COUNT(*) OVER (PARTITION BY who) AS heard, MIN(received_at) OVER (PARTITION BY who) AS first_heard
          FROM packets p WHERE received_at >= ? AND lat IS NOT NULL ${mac ? 'AND mac = ?' : ''})
       WHERE rn = 1 ORDER BY received_at DESC`)
      .all(since, ...(mac ? [mac] : []))
      .map((r) => this.#packetRow(r))
      .filter((p) => p.alive !== false);
  }

  /**
   * Where a station has been since a time, oldest first, each place once.
   * @param {string} who - The station, or object.
   * @param {number} [since] - Since when (ms).
   * @returns {{lat: number, lon: number, at: number}[]} Its places.
   */
  stationTrack(who, since = 0) {
    const out = [];
    for (const r of this.db.prepare(`SELECT lat, lon, received_at AS at FROM packets
                                     WHERE who = ? AND received_at >= ? AND lat IS NOT NULL ORDER BY received_at`).all(who, since)) {
      const last = out.at(-1);
      if (!last || last.lat !== r.lat || last.lon !== r.lon) out.push(r);
    }
    return out;
  }

  /** @returns {object|undefined} A radio's latest transmission: id, when, how long, and which way. */
  lastTransmission(mac) {
    return this.db.prepare('SELECT id, started_at, duration_ms, transmit FROM transmissions WHERE mac = ? ORDER BY id DESC LIMIT 1')
      .get(mac);
  }

  /**
   * Packets came in a transmission (the radio's audio carried them too).
   * @param {number} transmissionId - The transmission.
   * @param {number[]} packetIds - The packets.
   * @param {boolean} dataOnly - Whether the transmission was nothing but them.
   * @returns {void}
   */
  linkPackets(transmissionId, packetIds, dataOnly) {
    const set = this.db.prepare('UPDATE packets SET transmission_id = ? WHERE id = ?');
    for (const id of packetIds) set.run(transmissionId, id);
    if (dataOnly) this.db.prepare('UPDATE transmissions SET data = 1 WHERE id = ?').run(transmissionId);
  }

  /**
   * @param {number} before - Packets older than this (ms) go.
   * @returns {number} How many went.
   */
  prunePackets(before) {
    return Number(this.db.prepare('DELETE FROM packets WHERE received_at < ?').run(before).changes);
  }

  /**
   * Transmissions a cleanup would delete, oldest first.
   * @param {{before?: number, noSpeech?: boolean, limit?: number}} f - Started before this
   *   time (ms), and/or only those with no speech.
   * @returns {{id: number, audio_file: string, started_at: number}[]} The rows.
   */
  purgeCandidates({ before, noSpeech, limit = 1e9 } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (before !== undefined) (where.push('t.started_at < ?'), args.push(before));
    if (noSpeech) {
      const none = this.#noSpeech();
      where.push(none.sql);
      args.push(...none.args);
    }
    return this.db
      .prepare(`SELECT t.id, t.audio_file, t.started_at FROM transmissions t
                 WHERE ${where.join(' AND ')} ORDER BY t.started_at, t.id LIMIT ?`)
      .all(...args, limit);
  }

  /**
   * Delete transmissions and their transcripts, in one transaction. The audio
   * files are the caller's to remove: it gets their paths back.
   * @param {number[]} ids - Transmissions to delete.
   * @returns {{id: number, audio_file: string}[]} What was deleted.
   */
  deleteTransmissions(ids) {
    const gone = [];
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const marks = chunk.map(() => '?').join(',');
        gone.push(...this.db.prepare(`SELECT id, audio_file FROM transmissions WHERE id IN (${marks})`).all(...chunk));
        this.db.prepare(`DELETE FROM transcripts WHERE transmission_id IN (${marks})`).run(...chunk);
        // Its packets stay, a record of their own, no longer pointing at it
        this.db.prepare(`UPDATE packets SET transmission_id = NULL WHERE transmission_id IN (${marks})`).run(...chunk);
        this.db.prepare(`DELETE FROM transmissions WHERE id IN (${marks})`).run(...chunk);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return gone;
  }

  /**
   * What Insights summarises: transmissions per hour, per channel, and the
   * transcripts the feed shows (the default engine's), newest first.
   *
   * Hours are UTC hour starts. Every whole-hour time zone has the same hour
   * boundaries, so the page can label them in local time and add them up into
   * local days and weekdays itself.
   * @param {{since?: number, mac?: string, channel?: string, textLimit?: number}} [f] - From when
   *   (ms), for one radio or channel, and how many transcripts at most.
   * @returns {{hourly: object[], channels: object[], texts: string[]}} The rows.
   */
  insightRows({ since = 0, mac, channel, textLimit = 20000 } = {}) {
    const { where, args } = this.#filters({ mac, channel });
    where.push('t.started_at >= ?');
    args.push(since);
    const from = `FROM transmissions t LEFT JOIN radios r ON r.mac = t.mac WHERE ${where.join(' AND ')}`;
    const hourly = this.db
      .prepare(`SELECT (t.started_at / 3600000) * 3600000 AS hour, COUNT(*) AS count, SUM(t.duration_ms) AS ms
                ${from} GROUP BY hour ORDER BY hour`)
      .all(...args);
    const channels = this.db
      .prepare(`SELECT t.channel_name AS name, MAX(t.channel_hz) AS hz, COUNT(*) AS count,
                       SUM(t.duration_ms) AS ms, MAX(t.started_at) AS last
                ${from} GROUP BY t.channel_name ORDER BY count DESC, name`)
      .all(...args);
    // Not what a model wrote for static: those are words nobody said
    const texts = !this.defaultEngine ? [] : this.db
      .prepare(`SELECT x.text FROM transmissions t LEFT JOIN radios r ON r.mac = t.mac
                  JOIN transcripts x ON x.transmission_id = t.id AND x.engine = ? AND x.status = 'done'
                 WHERE ${where.join(' AND ')} AND t.data = 0 AND NOT (t.snr_db IS NOT NULL AND t.snr_db < ${STATIC_DB})
                 ORDER BY t.started_at DESC LIMIT ?`)
      .all(this.defaultEngine, ...args, textLimit)
      .map((r) => r.text);
    return { hourly, channels, texts };
  }

  /**
   * The channels transmissions came in on, for the feed's channel filter.
   * @returns {{name: string, hz: number|null, count: number, last: number}[]} By name.
   */
  channelsSeen() {
    // With its place on the map, where one has been set
    return this.db
      .prepare(`SELECT t.channel_name AS name, MAX(t.channel_hz) AS hz, COUNT(*) AS count, MAX(t.started_at) AS last,
                       p.lat AS lat, p.lon AS lon
                  FROM transmissions t LEFT JOIN channel_places p ON p.name = t.channel_name
                 WHERE t.channel_name IS NOT NULL AND t.channel_name <> ''
                 GROUP BY t.channel_name ORDER BY t.channel_name`)
      .all();
  }

  /**
   * Put a channel on the map, or move it.
   * @param {string} name - The channel's name.
   * @param {number} lat - Latitude, -90 to 90.
   * @param {number} lon - Longitude, -180 to 180.
   * @returns {void}
   */
  setChannelPlace(name, lat, lon) {
    this.db
      .prepare(`INSERT INTO channel_places (name, lat, lon, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at`)
      .run(name, lat, lon, Date.now());
  }

  /**
   * @param {string} name - The channel's name.
   * @returns {boolean} Whether it had a place to remove.
   */
  clearChannelPlace(name) {
    return this.db.prepare('DELETE FROM channel_places WHERE name = ?').run(name).changes > 0;
  }

  /**
   * Put a channel on the map unless it's there already: for channels written
   * from a listing, whose place an admin may have set more exactly by hand.
   * It shows on the map once a transmission comes in on it.
   * @param {string} name - The channel's name, as the radio has it.
   * @param {number} lat - Latitude.
   * @param {number} lon - Longitude.
   * @returns {boolean} Whether it was placed.
   */
  placeChannelIfUnplaced(name, lat, lon) {
    return this.db
      .prepare('INSERT INTO channel_places (name, lat, lon, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING')
      .run(name, lat, lon, Date.now()).changes > 0;
  }

  /**
   * Keep a region's channels. Each radio keeps its newest 50.
   * @param {{mac: string, region: number, regionName?: string, label: string, channels: object[]}} b - The backup.
   * @returns {object} It, as channelBackups lists one.
   */
  addChannelBackup({ mac, region, regionName = '', label, channels }) {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO channel_backups (mac, region, region_name, label, created_at, channels) VALUES (?, ?, ?, ?, ?, ?)')
      .run(mac, region, regionName || '', label, Date.now(), JSON.stringify(channels));
    this.db.prepare(`DELETE FROM channel_backups WHERE mac = ? AND id NOT IN
                       (SELECT id FROM channel_backups WHERE mac = ? ORDER BY id DESC LIMIT 50)`).run(mac, mac);
    return this.channelBackups(mac).find((b) => b.id === Number(lastInsertRowid));
  }

  /**
   * @param {string} mac - The radio.
   * @returns {object[]} Its backups, newest first: when, which region, and the channels' names.
   */
  channelBackups(mac) {
    return this.db.prepare('SELECT * FROM channel_backups WHERE mac = ? ORDER BY id DESC').all(mac).map((row) => {
      const channels = JSON.parse(row.channels).filter((c) => !c.empty);
      return { id: row.id, mac: row.mac, region: row.region, region_name: row.region_name, label: row.label,
        created_at: row.created_at, programmed: channels.length, names: channels.map((c) => c.name || '').slice(0, 30) };
    });
  }

  /**
   * @param {number} id - A backup.
   * @returns {object | undefined} It, with every slot.
   */
  channelBackup(id) {
    const row = this.db.prepare('SELECT * FROM channel_backups WHERE id = ?').get(id);
    return row && { ...row, channels: JSON.parse(row.channels) };
  }

  /**
   * @param {number} id - A backup.
   * @returns {boolean} Whether there was one to delete.
   */
  deleteChannelBackup(id) {
    return this.db.prepare('DELETE FROM channel_backups WHERE id = ?').run(id).changes > 0;
  }

  /**
   * @param {number} id - Transmission id.
   * @returns {boolean} Whether it (still) exists.
   */
  hasTransmission(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM transmissions WHERE id = ?').get(id));
  }

  /** @returns {{count: number, oldest: number|null, newest: number|null}} How much is kept. */
  storageStats() {
    return this.db
      .prepare('SELECT COUNT(*) AS count, MIN(started_at) AS oldest, MAX(started_at) AS newest FROM transmissions')
      .get();
  }

  /**
   * @param {string} key - Setting name.
   * @returns {string | null} Its value, or null when unset.
   */
  setting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  /**
   * @param {string} key - Setting name.
   * @param {string | null} value - New value; null removes it.
   * @returns {void}
   */
  setSetting(key, value) {
    if (value === null || value === undefined) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  /**
   * Transmissions an engine has not successfully transcribed.
   *
   * What the recovery sweep works through: a clip whose transcription failed
   * still has its audio, so it can be tried again once the cause is fixed.
   * @param {string} engine - Engine name.
   * @param {number} [limit] - Most to return.
   * @returns {object[]} Oldest first, so a backlog is worked in order.
   */
  needingTranscript(engine, limit = 500) {
    return this.db
      .prepare(
        `SELECT t.* FROM transmissions t
          WHERE NOT EXISTS (
            SELECT 1 FROM transcripts x
             WHERE x.transmission_id = t.id AND x.engine = ? AND x.status = 'done')
          ORDER BY t.started_at LIMIT ?`,
      )
      .all(engine, limit);
  }

  /**
   * Clips an engine never finished, since a time: queued when the server stopped. Data bursts aren't read.
   * @param {string} engine - The engine.
   * @param {number} since - Epoch ms.
   * @param {number} [limit] - Most rows.
   * @returns {object[]} Transmission rows, oldest first.
   */
  unfinished(engine, since, limit = 500) {
    return this.db.prepare(`SELECT t.* FROM transmissions t
                             WHERE t.started_at >= ? AND coalesce(t.data, 0) = 0
                               AND NOT EXISTS (SELECT 1 FROM transcripts x WHERE x.transmission_id = t.id AND x.engine = ?)
                             ORDER BY t.started_at LIMIT ?`).all(since, engine, limit);
  }

  /** @returns {void} */
  close() {
    this.db.close();
  }
}
