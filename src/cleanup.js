import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 'retentionDays';

/**
 * Admin → Storage: how much is kept, deleting transmissions by age or by
 * having no speech, and keeping only the last N days automatically.
 *
 * Automatic deletion is off until an admin sets a number of days. The setting
 * is kept in the database rather than the settings file, because the service
 * may only read that file and an admin sets this from the page.
 */
export class Cleanup {
  /**
   * @param {object} o - Dependencies.
   * @param {import('./manager.js').Manager} o.manager - Deletes, dropping queued work.
   * @param {import('./store.js').Store} o.store - Finds what to delete.
   * @param {string} o.dataDir - Where the clips and the database are.
   * @param {() => number} [o.now] - The clock, for tests.
   * @param {number} [o.everyMs] - How often the automatic cleanup runs.
   */
  constructor({ manager, store, dataDir, now = () => Date.now(), everyMs = 60 * 60 * 1000 }) {
    this.manager = manager;
    this.store = store;
    this.dataDir = dataDir;
    this.now = now;
    this.everyMs = everyMs;
    this.last = null;
  }

  /** @returns {number | null} Days to keep transmissions, or null to keep them all. */
  retentionDays() {
    const n = Number(this.store.setting(KEEP_DAYS));
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /**
   * @param {number | string | null} days - Days to keep; null or '' keeps everything.
   * @returns {number | null} What was set.
   */
  setRetentionDays(days) {
    if (days === null || days === undefined || days === '') {
      this.store.setSetting(KEEP_DAYS, null);
      return null;
    }
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 36500) {
      throw new Error('keep transmissions for 1 to 36500 days, or leave it blank to keep them all');
    }
    this.store.setSetting(KEEP_DAYS, n);
    return n;
  }

  /**
   * What a request asks to delete. At least one condition is required, so a
   * cleanup can't delete everything by leaving the form empty.
   * @param {{olderThanDays?: number|string|null, noSpeech?: boolean}} body - The request.
   * @returns {{before?: number, noSpeech?: boolean}} For Store.purgeCandidates.
   */
  criteria({ olderThanDays, noSpeech } = {}) {
    const c = {};
    if (olderThanDays !== undefined && olderThanDays !== null && olderThanDays !== '') {
      const n = Number(olderThanDays);
      if (!Number.isInteger(n) || n < 1) throw new Error('"older than" is a whole number of days, 1 or more');
      c.before = this.now() - n * DAY;
    }
    if (noSpeech === true) c.noSpeech = true;
    if (c.before === undefined && !c.noSpeech) {
      throw new Error('say what to delete: older than some days, with no speech, or both');
    }
    return c;
  }

  /**
   * @param {object} body - As for criteria().
   * @returns {{count: number, bytes: number, oldest: number|null, newest: number|null}} What would go.
   */
  preview(body) {
    const rows = this.store.purgeCandidates(this.criteria(body));
    return {
      count: rows.length,
      bytes: this.bytesOf(rows),
      oldest: rows[0]?.started_at ?? null,
      newest: rows.at(-1)?.started_at ?? null,
    };
  }

  /**
   * @param {object} body - As for criteria().
   * @returns {{deleted: number, bytes: number}} What went.
   */
  purge(body) {
    const rows = this.store.purgeCandidates(this.criteria(body));
    return this.manager.deleteTransmissions(rows.map((r) => r.id));
  }

  /**
   * The automatic cleanup: delete what is older than the days to keep.
   * @returns {{at: number, deleted: number, bytes: number, days: number} | null} What it did, or
   *   null when it's off.
   */
  sweep() {
    const days = this.retentionDays();
    if (!days) return null;
    const rows = this.store.purgeCandidates({ before: this.now() - days * DAY });
    const done = this.manager.deleteTransmissions(rows.map((r) => r.id));
    this.last = { at: this.now(), days, ...done };
    if (done.deleted) console.log(`[cleanup] deleted ${done.deleted} transmissions older than ${days} days`);
    return this.last;
  }

  /** @returns {void} Run the automatic cleanup a minute after starting, then hourly. */
  start() {
    const run = () => {
      try {
        this.sweep();
      } catch (e) {
        console.warn(`[cleanup] ${e.message}`);
      }
    };
    this.first = setTimeout(run, 60 * 1000);
    this.timer = setInterval(run, this.everyMs);
    this.first.unref?.();
    this.timer.unref?.();
  }

  /** @returns {void} */
  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /** @returns {object} For Admin → Storage. */
  report() {
    const db = join(this.dataDir, 'airscribe.sqlite');
    const size = (f) => (existsSync(f) ? statSync(f).size : 0);
    return {
      ...this.store.storageStats(),
      clipBytes: this.clipBytes(),
      databaseBytes: size(db) + size(`${db}-wal`),
      retentionDays: this.retentionDays(),
      lastSweep: this.last,
    };
  }

  /** @returns {number} Bytes of audio under clips/. */
  clipBytes() {
    let total = 0;
    const walk = (dir) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own data folder
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
        else if (e.isFile()) total += statSync(p).size;
      }
    };
    const clips = join(this.dataDir, 'clips');
    if (existsSync(clips)) walk(clips);
    return total;
  }

  /**
   * @param {{audio_file: string}[]} rows - Transmissions.
   * @returns {number} Bytes of their audio, both copies.
   */
  bytesOf(rows) {
    const root = resolve(this.dataDir, 'clips');
    let total = 0;
    for (const { audio_file: clip } of rows) {
      for (const name of [clip, clip.replace('.wav', '.16k.wav')]) {
        const file = resolve(root, name);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- under clips/, checked
        if (file.startsWith(root + sep) && existsSync(file)) total += statSync(file).size;
      }
    }
    return total;
  }
}
