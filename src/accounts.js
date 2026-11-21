import { ROLES, generateToken, hashToken, hashPassword, verifyPassword } from './auth.js';
import { TwoStep } from './twostep.js';

const DAY = 24 * 60 * 60 * 1000;
/** How long a browser stays signed in without being used. */
export const SESSION_MS = 12 * 60 * 60 * 1000;
/** Wrong passwords for one account before it's locked, and for how long. */
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * @param {unknown} name - A username as typed.
 * @returns {string} It, trimmed, if it can be one.
 */
export function checkUsername(name) {
  const u = String(name ?? '').trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,39}$/u.test(u)) {
    throw fail('a username is 1 to 40 letters or numbers, and may have . _ - or spaces after the first');
  }
  return u;
}

/**
 * @param {unknown} password - A password as typed.
 * @returns {string} It, if it's long enough to keep.
 */
export function checkPassword(password) {
  const p = String(password ?? '');
  if (p.length < 8) throw fail('a password is at least 8 characters');
  if (p.length > 200) throw fail('that password is too long');
  return p;
}

/**
 * People who sign in: accounts, the invites that make them, and the browser
 * sessions they sign in with (kept in the database, so a restart or an update
 * signs nobody out).
 *
 * Accounts sit beside the settings file's password and API tokens, which keep
 * working: the password as the node's own admin (for getting back in), the
 * tokens for scripts. Invite tokens and session ids are stored only as their
 * SHA-256, so the database alone can't be used to join or to sign in.
 */
export class Accounts {
  /**
   * @param {import('node:sqlite').DatabaseSync} db - The store's database.
   * @param {{now?: () => number, rememberDays?: number}} [o] - The clock, for tests, and how long two-step remembers a browser.
   */
  constructor(db, { now = () => Date.now(), rememberDays = 30 } = {}) {
    this.db = db;
    this.now = now;
    this.failures = new Map();   // lowercased username -> {count, first, until}
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        -- Sessions begun before this are over: signing out everywhere, a new password
        sessions_after INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id INTEGER,          -- null for the settings file's password or a token
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        note TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by INTEGER);
      -- Outside accounts (Google, GitHub, ...) linked to one, by the provider's own id for the person
      CREATE TABLE IF NOT EXISTS linked_logins (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT, email TEXT,
        linked_at INTEGER NOT NULL,
        used_at INTEGER,
        PRIMARY KEY (provider, subject),
        UNIQUE (user_id, provider));
      -- An account's amateur radio profile: what a radio's beacon is filled in
      -- with when they use it, and how their own stations are known on the Map
      CREATE TABLE IF NOT EXISTS radio_profiles (
        user_id INTEGER PRIMARY KEY,
        callsign TEXT NOT NULL, ssid INTEGER NOT NULL, symbol TEXT NOT NULL, beacon TEXT NOT NULL,
        updated_at INTEGER NOT NULL);
    `);
    // When a session passed a second step (docs/two-step.md): first, latest, for Admin, and the password asked again
    const have = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
    for (const c of ['stepped_at', 'last_step_at', 'checked_at', 'password_at']) {
      if (!have.has(c)) db.exec(`ALTER TABLE sessions ADD COLUMN ${c} INTEGER`);
    }
    this.twoStep = new TwoStep(db, { now, rememberDays });
  }

  /**
   * @param {number} userId - The account.
   * @returns {{callsign: string, ssid: number, symbol: string, beacon: string} | null} Its profile, if it has one.
   */
  profile(userId) {
    const p = this.db.prepare('SELECT callsign, ssid, symbol, beacon FROM radio_profiles WHERE user_id = ?').get(userId);
    return p ? { ...p } : null;
  }

  /**
   * Set an account's profile, or clear it with null (checkProfile, src/beacon.js).
   * @param {number} userId - The account.
   * @param {object|null} p - The checked profile.
   * @returns {object|null} The profile now.
   */
  setProfile(userId, p) {
    if (!p) {
      this.db.prepare('DELETE FROM radio_profiles WHERE user_id = ?').run(userId);
      return null;
    }
    this.db.prepare(`INSERT INTO radio_profiles (user_id, callsign, ssid, symbol, beacon, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(user_id) DO UPDATE SET callsign = excluded.callsign, ssid = excluded.ssid,
                       symbol = excluded.symbol, beacon = excluded.beacon, updated_at = excluded.updated_at`)
      .run(userId, p.callsign, p.ssid, p.symbol, p.beacon, this.now());
    return this.profile(userId);
  }

  /** @returns {number} How many accounts there are. */
  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  /** @returns {object|null} One account, without its password hash. */
  user(id) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return u ? this.view(u) : null;
  }

  /** What may be shown of an account: never the password hash. */
  view(u) {
    return {
      id: u.id, username: u.username, role: u.role, created_at: u.created_at, last_login_at: u.last_login_at,
      disabled: Boolean(u.disabled), has_password: Boolean(u.password_hash),
      links: this.linksFor(u.id).map((l) => ({ provider: l.provider, name: l.name, email: l.email, linked_at: l.linked_at })),
      radio: this.profile(u.id),
      two_step: this.twoStep.isSetUp(u.id),
    };
  }

  /** @returns {object[]} Every account, by name. */
  users() {
    return this.db.prepare('SELECT * FROM users ORDER BY username').all().map((u) => this.view(u));
  }

  /**
   * @param {{username: string, password: string, role: string}} a - The account.
   * @returns {object} It, as view() shows it.
   */
  create({ username, password, role }) {
    const name = checkUsername(username);
    const hash = hashPassword(checkPassword(password));
    if (!Object.hasOwn(ROLES, role)) throw fail('a role is admin or viewer');
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw fail(`there is already an account called ${name}`, 409);
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(name, hash, role, this.now());
    return this.user(Number(lastInsertRowid));
  }

  /** @returns {number} Enabled admin accounts, other than `except`. */
  admins(except = null) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id IS NOT ?").get(except).n;
  }

  /**
   * An admin's change to an account: its role, a new name, disabled or not.
   * The last enabled admin account can't stop being one, so accounts never
   * lock every admin out.
   * @param {number} id - The account.
   * @param {{role?: string, username?: string, disabled?: boolean}} change - What changes.
   * @returns {object} The account now.
   */
  update(id, { role, username, disabled }) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw fail('no such account', 404);
    if (role !== undefined && !Object.hasOwn(ROLES, role)) throw fail('a role is admin or viewer');
    const losesAdmin = u.role === 'admin' && !u.disabled &&
      ((role !== undefined && role !== 'admin') || disabled === true);
    if (losesAdmin && this.admins(u.id) === 0) throw fail('this is the only admin account; make another admin first', 409);
    if (username !== undefined) {
      const name = checkUsername(username);
      const other = this.db.prepare('SELECT id FROM users WHERE username = ?').get(name);
      if (other && other.id !== u.id) throw fail(`there is already an account called ${name}`, 409);
      this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(name, u.id);
    }
    if (role !== undefined) this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
    if (disabled !== undefined) {
      this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, u.id);
      if (disabled) this.endSessions(u.id);
    }
    return this.user(u.id);
  }

  /** @param {number} id - The account to delete, with its sessions and links. */
  remove(id) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw fail('no such account', 404);
    if (u.role === 'admin' && !u.disabled && this.admins(u.id) === 0) {
      throw fail('this is the only admin account; make another admin first', 409);
    }
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM linked_logins WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM radio_profiles WHERE user_id = ?').run(id);
    this.twoStep.reset(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  /**
   * A new password: set by its owner (who gives the old one) or an admin.
   * Every other session of the account ends; `keep` is the one it came from.
   * @param {number} id - The account.
   * @param {string} password - The new password.
   * @param {{current?: string, keep?: string}} [o] - The old password, when its owner changes it.
   * @returns {void}
   */
  setPassword(id, password, { current, keep } = {}) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw fail('no such account', 404);
    if (current !== undefined && u.password_hash && !verifyPassword(String(current), u.password_hash)) {
      throw fail('the current password isn’t right', 403);
    }
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(checkPassword(password)), id);
    this.endSessions(id, keep);
  }

  /** Whether an account's password is this one, for a step that asks again. */
  passwordIs(id, password) {
    const u = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id);
    return Boolean(u?.password_hash) && verifyPassword(String(password ?? ''), u.password_hash);
  }

  // ---- Signing in ---------------------------------------------------------

  /** @returns {number|null} When a locked account may try again, or null. */
  lockedUntil(username) {
    const f = this.failures.get(String(username).toLowerCase());
    return f?.until && f.until > this.now() ? f.until : null;
  }

  /**
   * An account's username and password, checked. Five wrong in a row lock it
   * for 15 minutes; a locked account isn't let in even with the right one.
   * @param {string} username - As typed.
   * @param {string} password - As typed.
   * @returns {object|null} The account (view()), or null when there is none by that name.
   * @throws When the password is wrong, the account is locked or disabled.
   */
  signIn(username, password) {
    const key = String(username ?? '').trim().toLowerCase();
    const u = key ? this.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim()) : null;
    if (!u) return null;
    const until = this.lockedUntil(key);
    if (until) {
      // In minutes rather than a time of day: the server's clock may be on another time zone than the reader's
      const minutes = Math.max(1, Math.ceil((until - this.now()) / 60000));
      throw fail(`too many wrong passwords: try again in ${minutes} minute${minutes === 1 ? '' : 's'}`, 429);
    }
    if (!u.password_hash || !verifyPassword(String(password ?? ''), u.password_hash)) {
      const f = this.failures.get(key) ?? { count: 0, first: this.now(), until: 0 };
      if (this.now() - f.first > LOCK_MS) Object.assign(f, { count: 0, first: this.now() });
      f.count += 1;
      if (f.count >= LOCK_AFTER) Object.assign(f, { until: this.now() + LOCK_MS, count: 0, first: this.now() });
      this.failures.set(key, f);
      throw fail('not accepted', 401);
    }
    this.failures.delete(key);
    if (u.disabled) throw fail('this account is turned off; an admin can turn it back on', 403);
    return this.view(u);
  }

  /**
   * A browser session for an account, or for a role without one (the settings
   * file's password, a token typed into the sign-in box).
   * @param {{userId?: number|null, role: string}} who - Whose.
   * @returns {string} The session id, for the cookie.
   */
  startSession({ userId = null, role, stepped = false }) {
    const id = generateToken();
    const now = this.now();
    const at = stepped ? now : null;
    this.db.prepare('INSERT INTO sessions (id_hash, user_id, role, created_at, expires_at, stepped_at, last_step_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hashToken(id), userId, role, now, now + SESSION_MS, at, at);
    if (userId) this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, userId);
    // Now and then, the expired ones go
    if (Math.random() < 0.05) this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    return id;
  }

  /**
   * The session a cookie carries, renewed, with its account's current role:
   * a role changed, an account turned off or a password changed takes effect
   * at once.
   * @param {string} id - From the cookie.
   * @returns {{role: string, user: object|null} | null} Who it is, or null.
   */
  session(id) {
    if (!id) return null;
    const key = hashToken(id);
    const s = this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(key);
    const now = this.now();
    if (!s || s.expires_at < now) {
      if (s) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(key);
      return null;
    }
    let user = null;
    if (s.user_id !== null) {
      const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      if (!u || u.disabled || s.created_at < u.sessions_after) {
        this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(key);
        return null;
      }
      user = { id: u.id, username: u.username, role: u.role };
    }
    // Renewed at most once a minute: every request needn't write
    if (s.expires_at - SESSION_MS < now - 60000) {
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(now + SESSION_MS, key);
    }
    const marks = { stepped_at: s.stepped_at, last_step_at: s.last_step_at, checked_at: s.checked_at, password_at: s.password_at };
    return { role: user ? user.role : s.role, user, marks };
  }

  /**
   * Mark a session: a second step passed (and for Admin, when `admin`), or the password given again.
   * @param {string} id - The session.
   * @param {{step?: boolean, admin?: boolean, password?: boolean}} what - What happened, now.
   * @returns {void}
   */
  markSession(id, { step = false, admin = false, password = false }) {
    if (!id) return;
    const now = this.now();
    const key = hashToken(id);
    if (step || admin) this.db.prepare('UPDATE sessions SET stepped_at = COALESCE(stepped_at, ?), last_step_at = ? WHERE id_hash = ?').run(now, now, key);
    if (admin) this.db.prepare('UPDATE sessions SET checked_at = ? WHERE id_hash = ?').run(now, key);
    if (password) this.db.prepare('UPDATE sessions SET password_at = ? WHERE id_hash = ?').run(now, key);
  }

  /** @param {string} id - The session to end. */
  endSession(id) {
    if (id) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashToken(id));
  }

  /**
   * End an account's sessions: all of them, or all but the one it's asked from.
   * @param {number} userId - The account.
   * @param {string} [keep] - A session id to keep.
   * @returns {void}
   */
  endSessions(userId, keep) {
    const keepHash = keep ? hashToken(keep) : '';
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?').run(userId, keepHash);
    // And any made before now that the table might yet hold, by the time they're checked
    this.db.prepare('UPDATE users SET sessions_after = ? WHERE id = ?').run(this.now(), userId);
    if (keepHash) this.db.prepare('UPDATE sessions SET created_at = ? WHERE id_hash = ?').run(this.now(), keepHash);
  }

  // ---- Invites ------------------------------------------------------------

  /**
   * An invite: a link that makes one account, with this role, until it's used
   * or it runs out.
   * @param {{role: string, days?: number, note?: string, by?: string}} o - What it's for.
   * @returns {{token: string, invite: object}} The token, which only this answer carries.
   */
  invite({ role, days = 7, note = '', by = '' }) {
    if (!Object.hasOwn(ROLES, role)) throw fail('a role is admin or viewer');
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 30) throw fail('an invite lasts 1 to 30 days');
    const text = String(note ?? '').trim();
    if (text.length > 100) throw fail('keep the note to 100 characters');
    const token = generateToken();
    const now = this.now();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO invites (token_hash, role, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hashToken(token), role, text || null, by || null, now, now + d * DAY);
    return { token, invite: this.invites().find((i) => i.id === Number(lastInsertRowid)) };
  }

  /** @returns {object[]} Invites not yet used, and those used in the last 30 days, newest first. */
  invites() {
    return this.db.prepare(`SELECT i.id, i.role, i.note, i.created_by, i.created_at, i.expires_at, i.used_at, u.username AS used_by
                              FROM invites i LEFT JOIN users u ON u.id = i.used_by
                             WHERE i.used_at IS NULL OR i.used_at > ?
                             ORDER BY i.id DESC`).all(this.now() - 30 * DAY);
  }

  /** @returns {boolean} Whether there was such an invite to take back. */
  revokeInvite(id) {
    return this.db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(id).changes > 0;
  }

  /**
   * @param {string} token - From the link.
   * @returns {{role: string, expires_at: number}} What it makes.
   * @throws When it's used, run out, or never was.
   */
  checkInvite(token) {
    const i = this.db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hashToken(String(token ?? '')));
    if (!i || i.used_at || i.expires_at < this.now()) {
      throw fail('This invite link isn’t valid any more; ask for a new one.', 410);
    }
    return { role: i.role, expires_at: i.expires_at };
  }

  /**
   * Join with an invite: the account is made with the invite's role, and the
   * invite is used up.
   * @param {{invite: string, username: string, password: string}} o - The form.
   * @returns {object} The new account.
   */
  register({ invite, username, password }) {
    const { role } = this.checkInvite(invite);
    this.db.exec('BEGIN');
    try {
      const user = this.create({ username, password, role });
      // Used once: a second sign-up racing this one finds it gone
      const used = this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL')
        .run(this.now(), user.id, hashToken(invite));
      if (!used.changes) throw fail('This invite link isn’t valid any more; ask for a new one.', 410);
      this.db.exec('COMMIT');
      return user;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- Linked sign-ins (Google, GitHub, ...) -------------------------------

  /** @returns {object[]} An account's links. */
  linksFor(userId) {
    return this.db.prepare('SELECT * FROM linked_logins WHERE user_id = ? ORDER BY provider').all(userId);
  }

  /** @returns {object|null} The account an outside account is linked to. */
  linkedUser(provider, subject) {
    const l = this.db.prepare('SELECT user_id FROM linked_logins WHERE provider = ? AND subject = ?').get(provider, String(subject));
    return l ? this.db.prepare('SELECT * FROM users WHERE id = ?').get(l.user_id) ?? null : null;
  }

  /**
   * Link an outside account. One from each provider per account, and an
   * outside account to only one AirScribe account.
   * @param {number} userId - The account.
   * @param {string} provider - google, github, ...
   * @param {{subject: string, name?: string, email?: string}} who - The provider's id for the person, and what it says of them.
   * @returns {void}
   */
  link(userId, provider, { subject, name, email }) {
    const other = this.linkedUser(provider, subject);
    if (other && other.id !== userId) throw fail('that account is already linked to another AirScribe account', 409);
    if (other) return;
    if (this.db.prepare('SELECT 1 FROM linked_logins WHERE user_id = ? AND provider = ?').get(userId, provider)) {
      throw fail('this account already has one linked from there; unlink it first', 409);
    }
    const cut = (s) => (s ? String(s).slice(0, 200) : null);
    this.db.prepare('INSERT INTO linked_logins (provider, subject, user_id, name, email, linked_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(provider, String(subject), userId, cut(name), cut(email), this.now());
  }

  /** @returns {boolean} Whether there was a link to remove. */
  unlink(userId, provider) {
    return this.db.prepare('DELETE FROM linked_logins WHERE user_id = ? AND provider = ?').run(userId, provider).changes > 0;
  }

  /** A linked sign-in happened: when, for the Account page. */
  touchLink(provider, subject) {
    this.db.prepare('UPDATE linked_logins SET used_at = ? WHERE provider = ? AND subject = ?').run(this.now(), provider, String(subject));
  }
}
