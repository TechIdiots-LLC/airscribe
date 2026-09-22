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
   */
  constructor(file) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-configured dataDir
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS radios (
        mac TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT, added_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transmissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        audio_file TEXT NOT NULL, status TEXT NOT NULL,
        text TEXT, engine TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS tx_time ON transmissions(started_at DESC);
    `);
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
   * @param {string} mac - Radio to forget. Its transmissions are kept.
   * @returns {void}
   */
  deleteRadio(mac) {
    this.db.prepare('DELETE FROM radios WHERE mac = ?').run(mac);
  }

  /**
   * @param {{mac: string, startedAt: number, durationMs: number, audioFile: string}} t - A new clip.
   * @returns {number} Its id.
   */
  addTransmission({ mac, startedAt, durationMs, audioFile }) {
    const r = this.db
      .prepare(
        `INSERT INTO transmissions (mac, started_at, duration_ms, audio_file, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(mac, startedAt, Math.round(durationMs), audioFile);
    return Number(r.lastInsertRowid);
  }

  /**
   * @param {number} id - Transmission id.
   * @param {{status: string, text?: string, engine?: string, error?: string}} r - Outcome.
   * @returns {void}
   */
  finishTransmission(id, { status, text = null, engine = null, error = null }) {
    this.db
      .prepare('UPDATE transmissions SET status=?, text=?, engine=?, error=? WHERE id=?')
      .run(status, text, engine, error, id);
  }

  /**
   * @param {number} id - Transmission id.
   * @returns {object | undefined} The row.
   */
  transmission(id) {
    return this.db.prepare('SELECT * FROM transmissions WHERE id = ?').get(id);
  }

  /**
   * @param {{mac?: string, q?: string, limit?: number}} f - Filters.
   * @returns {object[]} Newest first.
   */
  transmissions({ mac, q, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (mac) (where.push('mac = ?'), args.push(mac));
    if (q) (where.push('text LIKE ?'), args.push(`%${q}%`));
    const sql = `SELECT * FROM transmissions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY started_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Number(limit) || 100, 500));
  }

  /** @returns {void} */
  close() {
    this.db.close();
  }
}
