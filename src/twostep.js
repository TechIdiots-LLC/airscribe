import crypto from 'node:crypto';
import { generateToken, hashToken } from './auth.js';
import * as totp from './totp.js';
import { verifyRegistration, verifyAssertion } from './webauthn.js';

// Two-step verification's records (docs/two-step.md): passkeys, an
// authenticator app's secret, recovery codes and remembered browsers.

const DAY = 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const RECOVERY_CODES = 10;
/** Wrong codes for one account before codes are refused for a while. */
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
// No 0/o, 1/l/i: read off a printout
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** @returns {string} A recovery code, as shown: two groups of five. */
function recoveryCode() {
  let s = '';
  for (const b of crypto.randomBytes(10)) s += CODE_LETTERS[b % CODE_LETTERS.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normalCode = (c) => String(c ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export class TwoStep {
  /**
   * @param {import('node:sqlite').DatabaseSync} db - The store's database.
   * @param {{now?: () => number, rememberDays?: number}} [o] - The clock, and how long a browser is remembered.
   */
  constructor(db, { now = () => Date.now(), rememberDays = 30 } = {}) {
    this.db = db;
    this.now = now;
    this.rememberMs = Math.max(1, Number(rememberDays) || 30) * DAY;
    this.challenges = new Map();   // challenge -> {purpose, owner, until}
    this.failures = new Map();     // user id -> {count, first, until}
    db.exec(`
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,           -- the credential ID, base64url
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,      -- SPKI DER, base64url
        alg INTEGER NOT NULL,
        sign_count INTEGER NOT NULL,
        transports TEXT,
        synced INTEGER NOT NULL DEFAULT 0,
        rp_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER);
      CREATE TABLE IF NOT EXISTS authenticators (
        user_id INTEGER PRIMARY KEY,
        secret TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,   -- 0 while it's being set up
        last_step INTEGER,
        created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_codes (
        user_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        PRIMARY KEY (user_id, code_hash));
      CREATE TABLE IF NOT EXISTS remembered_browsers (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL);
      -- Accounts that asked to be asked at sign-in too, not only before the radios and Admin
      CREATE TABLE IF NOT EXISTS two_step_signin (
        user_id INTEGER PRIMARY KEY);
    `);
  }

  /** @returns {boolean} Whether an account asked for its second step at sign-in too. */
  askAtSignIn(userId) {
    return Boolean(this.db.prepare('SELECT 1 FROM two_step_signin WHERE user_id = ?').get(userId));
  }

  /** Ask at sign-in, or don't. */
  setAskAtSignIn(userId, on) {
    if (on) this.db.prepare('INSERT OR IGNORE INTO two_step_signin (user_id) VALUES (?)').run(userId);
    else this.db.prepare('DELETE FROM two_step_signin WHERE user_id = ?').run(userId);
  }

  // ---- What's set up ------------------------------------------------------

  /** @returns {object[]} An account's passkeys, as kept. */
  passkeyRows(userId) {
    return this.db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId);
  }

  /** @returns {boolean} Whether the authenticator app is on. */
  hasAuthenticator(userId) {
    return Boolean(this.db.prepare('SELECT 1 FROM authenticators WHERE user_id = ? AND enabled = 1').get(userId));
  }

  /** @returns {boolean} Whether an account has a passkey or an authenticator app. */
  isSetUp(userId) {
    return this.passkeyRows(userId).length > 0 || this.hasAuthenticator(userId);
  }

  /** @returns {number} Recovery codes not yet used. */
  codesLeft(userId) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).n;
  }

  /** @returns {object} What Your account → Two-step verification shows. */
  status(userId) {
    return {
      setUp: this.isSetUp(userId),
      passkeys: this.passkeyRows(userId).map((p) => ({
        id: p.id, name: p.name, synced: Boolean(p.synced), site: p.rp_id, created_at: p.created_at, used_at: p.used_at,
      })),
      authenticator: this.hasAuthenticator(userId),
      recoveryCodesLeft: this.codesLeft(userId),
      askAtSignIn: this.askAtSignIn(userId),
    };
  }

  // ---- Questions for passkeys -----------------------------------------------

  /**
   * A new challenge, for one purpose and owner (an account, or a half-finished
   * sign-in), used once within 5 minutes.
   * @returns {string} The challenge, base64url.
   */
  challenge(purpose, owner = null) {
    const now = this.now();
    for (const [k, v] of this.challenges) if (v.until < now) this.challenges.delete(k);
    if (this.challenges.size > 5000) this.challenges.delete(this.challenges.keys().next().value);
    const c = crypto.randomBytes(32).toString('base64url');
    this.challenges.set(c, { purpose, owner, until: now + CHALLENGE_MS });
    return c;
  }

  /**
   * The challenge a passkey's answer carries, taken: it was asked for this
   * purpose and owner, and isn't asked again.
   * @returns {string} The challenge.
   */
  takeChallenge(credential, purpose, owner = null) {
    let c;
    try {
      c = JSON.parse(Buffer.from(String(credential?.response?.clientDataJSON ?? ''), 'base64url').toString('utf8')).challenge;
    } catch { /* checked below */ }
    const held = typeof c === 'string' ? this.challenges.get(c) : null;
    if (!held || held.until < this.now() || held.purpose !== purpose || held.owner !== owner) {
      throw fail('that passkey answered an old question: try again');
    }
    this.challenges.delete(c);
    return c;
  }

  // ---- Passkeys -------------------------------------------------------------

  /**
   * Keep a new passkey. The first way to verify comes with recovery codes.
   * @param {number} userId - Whose.
   * @param {object} credential - The browser's answer.
   * @param {{origins: string[], rpId: string, name?: string}} o - The page, and the name it's given.
   * @returns {{passkey: object, recoveryCodes: string[]|null}} It, and the codes when they're new.
   */
  addPasskey(userId, credential, { origins, rpId, name }) {
    const challenge = this.takeChallenge(credential, 'add', userId);
    const kept = verifyRegistration(credential, { challenge, origins, rpId });
    if (this.db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(kept.id)) throw fail('that passkey is already added', 409);
    const first = !this.isSetUp(userId);
    const label = String(name ?? '').trim().slice(0, 60) || 'Passkey';
    this.db.prepare(`INSERT INTO passkeys (id, user_id, name, public_key, alg, sign_count, transports, synced, rp_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kept.id, userId, label, kept.publicKey, kept.alg, kept.signCount, JSON.stringify(kept.transports),
        kept.backedUp ? 1 : 0, rpId, this.now());
    return { passkey: this.status(userId).passkeys.find((p) => p.id === kept.id), recoveryCodes: first ? this.newCodes(userId) : null };
  }

  /** @returns {object[]} The passkeys to offer the browser for one account, on this site. */
  allowFor(userId, rpId) {
    return this.passkeyRows(userId).filter((p) => p.rp_id === rpId)
      .map((p) => ({ id: p.id, transports: JSON.parse(p.transports || '[]') }));
  }

  /**
   * A passkey used, checked: one of this account's. Only ever a second step,
   * after a password or a linked sign-in, never a way in on its own.
   * @returns {number} The account it's for.
   */
  usePasskey(credential, { purpose, owner = null, userId, origins, rpId }) {
    if (userId === undefined || userId === null) throw fail('a passkey is a second step: sign in first', 400);
    const challenge = this.takeChallenge(credential, purpose, owner);
    const row = this.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(credential?.id ?? ''));
    if (!row || row.user_id !== userId) throw fail('that passkey isn’t one of this account’s', 403);
    if (row.rp_id !== rpId) throw fail(`that passkey was made on ${row.rp_id}; use it there, or use a code`, 403);
    const used = verifyAssertion(credential, {
      challenge, origins, rpId, publicKey: row.public_key, alg: row.alg, signCount: row.sign_count, requireUv: false,
    });
    this.db.prepare('UPDATE passkeys SET sign_count = ?, synced = ?, used_at = ? WHERE id = ?')
      .run(used.signCount, used.backedUp ? 1 : 0, this.now(), row.id);
    return row.user_id;
  }

  /** @returns {boolean} Whether there was such a passkey to remove. */
  removePasskey(userId, id) {
    const gone = this.db.prepare('DELETE FROM passkeys WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0;
    if (gone) this.offIfNone(userId);
    return gone;
  }

  // ---- The authenticator app -----------------------------------------------

  /**
   * A new secret for the authenticator app, kept unused until a code from it
   * is entered.
   * @returns {{key: string, uri: string}} The key to type in, and the link for the QR code.
   */
  startAuthenticator(userId, account) {
    if (this.hasAuthenticator(userId)) throw fail('the authenticator app is already on; turn it off first', 409);
    const secret = totp.newSecret();
    this.db.prepare(`INSERT INTO authenticators (user_id, secret, enabled, created_at) VALUES (?, ?, 0, ?)
                     ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, enabled = 0, last_step = NULL, created_at = excluded.created_at`)
      .run(userId, secret, this.now());
    return { key: secret.replace(/(.{4})/g, '$1 ').trim(), uri: totp.otpauthUri(secret, { issuer: 'AirScribe', account }) };
  }

  /** @returns {{recoveryCodes: string[]|null}} The codes, when this is the first way to verify. */
  enableAuthenticator(userId, code) {
    const a = this.db.prepare('SELECT * FROM authenticators WHERE user_id = ?').get(userId);
    if (!a || a.enabled) throw fail('start setting up the authenticator app first', 409);
    this.notLocked(userId);
    const step = totp.check(a.secret, code, { now: this.now() });
    if (step === null) {
      this.missed(userId);
      throw fail('that code isn’t right: check the phone’s clock, and use the newest code', 403);
    }
    const first = !this.isSetUp(userId);
    this.db.prepare('UPDATE authenticators SET enabled = 1, last_step = ? WHERE user_id = ?').run(step, userId);
    return { recoveryCodes: first ? this.newCodes(userId) : null };
  }

  /** @returns {boolean} Whether it was on. */
  disableAuthenticator(userId) {
    const gone = this.db.prepare('DELETE FROM authenticators WHERE user_id = ?').run(userId).changes > 0;
    if (gone) this.offIfNone(userId);
    return gone;
  }

  // ---- Codes ------------------------------------------------------------------

  /** Refuse codes for a while after five wrong ones. */
  notLocked(userId) {
    const f = this.failures.get(userId);
    if (f?.until && f.until > this.now()) {
      const minutes = Math.max(1, Math.ceil((f.until - this.now()) / 60000));
      throw fail(`too many wrong codes: try again in ${minutes} minute${minutes === 1 ? '' : 's'}`, 429);
    }
  }

  missed(userId) {
    const f = this.failures.get(userId) ?? { count: 0, first: this.now(), until: 0 };
    if (this.now() - f.first > LOCK_MS) Object.assign(f, { count: 0, first: this.now() });
    f.count += 1;
    if (f.count >= LOCK_AFTER) Object.assign(f, { until: this.now() + LOCK_MS, count: 0, first: this.now() });
    this.failures.set(userId, f);
  }

  /**
   * A code from the authenticator app, or a recovery code, checked.
   * @returns {{via: 'authenticator'|'recovery', recoveryCodesLeft?: number}} Which it was.
   */
  useCode(userId, code) {
    this.notLocked(userId);
    const a = this.db.prepare('SELECT * FROM authenticators WHERE user_id = ? AND enabled = 1').get(userId);
    if (a) {
      const step = totp.check(a.secret, code, { now: this.now(), after: a.last_step });
      if (step !== null) {
        this.db.prepare('UPDATE authenticators SET last_step = ? WHERE user_id = ?').run(step, userId);
        this.failures.delete(userId);
        return { via: 'authenticator' };
      }
    }
    const norm = normalCode(code);
    if (norm.length === 10) {
      const used = this.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .run(this.now(), userId, hashToken(norm));
      if (used.changes) {
        this.failures.delete(userId);
        return { via: 'recovery', recoveryCodesLeft: this.codesLeft(userId) };
      }
    }
    this.missed(userId);
    throw fail('that code isn’t right', 403);
  }

  /** @returns {string[]} Ten new recovery codes; the old ones stop working. */
  newCodes(userId) {
    const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
    this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const add = this.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const c of codes) add.run(userId, hashToken(normalCode(c)));
    return codes;
  }

  // ---- Remembered browsers ---------------------------------------------------

  /** @returns {string} A token for the browser's cookie: its sign-ins skip the second step until it runs out. */
  remember(userId) {
    const token = generateToken();
    const now = this.now();
    this.db.prepare('INSERT INTO remembered_browsers (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, now, now + this.rememberMs);
    this.db.prepare('DELETE FROM remembered_browsers WHERE expires_at < ?').run(now);
    return token;
  }

  /** @returns {boolean} Whether this browser is remembered for this account. */
  remembered(userId, token) {
    if (!token) return false;
    const r = this.db.prepare('SELECT * FROM remembered_browsers WHERE token_hash = ?').get(hashToken(token));
    return Boolean(r && r.user_id === userId && r.expires_at > this.now());
  }

  // ---- Turning it off ----------------------------------------------------------

  /** With the last way to verify gone, the codes and remembered browsers go too. */
  offIfNone(userId) {
    if (this.isSetUp(userId)) return;
    this.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM remembered_browsers WHERE user_id = ?').run(userId);
  }

  /** Everything, for Admin → Users → Reset two-step, and a deleted account. */
  reset(userId) {
    for (const t of ['passkeys', 'authenticators', 'recovery_codes', 'remembered_browsers', 'two_step_signin']) {
      this.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    }
    this.failures.delete(userId);
  }
}
