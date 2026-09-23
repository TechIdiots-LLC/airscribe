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
      // Only rows naming an engine are carried over. A failure with no
      // engine never got as far as running one — the module was missing, the
      // model path was wrong — so attributing it to 'unknown' would leave a
      // phantom entry beside every clip that is later transcribed properly.
      this.db.exec(`
        INSERT OR IGNORE INTO transcripts
          (transmission_id, engine, status, text, error, created_at)
        SELECT id, engine, status, text, error, started_at
          FROM transmissions
         WHERE engine IS NOT NULL AND status IN ('done', 'error')
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
    const row = this.db.prepare('SELECT * FROM transmissions WHERE id = ?').get(id);
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
    const all = this.db
      .prepare(
        `SELECT * FROM transcripts WHERE transmission_id IN (${ids.map(() => '?').join(',')})
         ORDER BY id`,
      )
      .all(...ids);
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
   * @param {{mac?: string, q?: string, limit?: number}} f - Filters.
   * @returns {object[]} Newest first.
   */
  transmissions({ mac, q, limit = 100, group, channel, publicOnly, notAfter } = {}) {
    const where = ['1 = 1'];
    const args = [];
    if (mac) (where.push('t.mac = ?'), args.push(mac));
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
    // Left join, so a transmission whose radio was removed is still listed
    // to an operator — but never publicly, since r.public is then null.
    const sql = `SELECT t.*, r.name AS radio_name, r."group" AS radio_group
                   FROM transmissions t LEFT JOIN radios r ON r.mac = t.mac
                  WHERE ${where.join(' AND ')}
                  ORDER BY t.started_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, Math.min(Number(limit) || 100, 500));
    return this.withTranscripts(rows);
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
