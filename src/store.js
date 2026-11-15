import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
                    channel = null, channelName = null, channelHz = null }) {
    const r = this.db
      .prepare(
        `INSERT INTO transmissions
           (mac, started_at, duration_ms, audio_file, status, transmit,
            channel, channel_name, channel_hz)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(mac, startedAt, Math.round(durationMs), audioFile, transmit ? 1 : 0,
           channel, channelName, channelHz);
    return Number(r.lastInsertRowid);
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
    return rows.map((r) => {
      const ts = byTx.get(r.id) ?? [];
      const best = ts.find((t) => t.engine === this.defaultEngine && t.status === 'done')
        ?? ts.find((t) => t.status === 'done')
        ?? ts[0];
      return { ...r, transcripts: ts, text: best?.text ?? null,
               engine: best?.engine ?? null, error: best?.error ?? null };
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
   * @param {{mac?: string, q?: string, group?: string, channel?: string,
   *   publicOnly?: boolean, notAfter?: number}} f - Filters.
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
    if (channel) (where.push('t.channel_name = ?'), args.push(channel));
    // The publishing gate applied in the query rather than after it, so the
    // delay does not depend on every caller remembering to subtract it.
    if (publicOnly) where.push('r.public = 1');
    if (notAfter !== undefined) (where.push('t.started_at <= ?'), args.push(notAfter));
    if (q) {
      // Any engine's transcript, or the channel name — searching for "fire"
      // should find the fire channel's traffic, not only clips that say it.
      where.push(
        '(t.id IN (SELECT transmission_id FROM transcripts WHERE text LIKE ?)' +
          ' OR t.channel_name LIKE ?)',
      );
      args.push(`%${q}%`, `%${q}%`);
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
    if (!this.defaultEngine) return { sql: '(0)', args: [] };
    return {
      sql: `EXISTS (SELECT 1 FROM transcripts x WHERE x.transmission_id = t.id AND x.engine = ?
                       AND x.status = 'done' AND trim(coalesce(x.text, '')) = '')`,
      args: [this.defaultEngine],
    };
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

  /** @returns {void} */
  close() {
    this.db.close();
  }
}
