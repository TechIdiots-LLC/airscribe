import crypto from 'node:crypto';

/**
 * Who may do what.
 *
 * The split matters more than the mechanism. A transcript log of other
 * people's conversations has two audiences with different needs: whoever runs
 * the node, and whoever they let read it. Handing a reader the key to the
 * radios because they wanted to search last night's traffic is the thing this
 * prevents.
 *
 *   admin   everything, including settings, radios and engines
 *   viewer  reads transcripts and clips, including unpublished ones,
 *           and changes nothing
 */
export const ROLES = { viewer: 1, admin: 2 };

/** How long a browser session lasts without being used. */
const SESSION_MS = 12 * 60 * 60 * 1000;

/** The cookie a signed-in browser carries. */
export const SESSION_COOKIE = 'airscribe_session';

/**
 * Mint a token.
 *
 * 32 bytes from the CSPRNG, base64url so it survives being pasted into a
 * config file, a shell and a URL without escaping.
 * @returns {string} The new token.
 */
export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage and lookup.
 *
 * SHA-256 rather than scrypt, and the reasoning is the opposite of the
 * reasoning for passwords. A password is short, human-chosen and worth
 * attacking with a dictionary, so it wants a slow hash. A token is 32 bytes
 * of randomness with no dictionary to attack, so slowness buys nothing — and
 * it would cost one slow hash per candidate on every request, which is a
 * denial of service handed out for free.
 *
 * A fast hash also lets tokens be found by lookup rather than compared one at
 * a time, so ten tokens cost what one does.
 * @param {string} token - The token.
 * @returns {string} Hex digest.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Hash a password for storage.
 * @param {string} password - The plaintext.
 * @returns {string} A `scrypt$salt$digest` string.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

/**
 * Check a password against a stored hash.
 * @param {string} password - The plaintext offered.
 * @param {string} stored - A `scrypt$salt$digest` string.
 * @returns {boolean} Whether it matches.
 */
export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  return same(crypto.scryptSync(password, salt, 32).toString('hex'), expected);
}

/**
 * Compare two secrets without leaking their contents through timing.
 * @param {string} a - One value.
 * @param {string} b - The other.
 * @returns {boolean} Whether they match.
 */
export function same(a, b) {
  // timingSafeEqual wants equal lengths, and the lengths are not worth
  // hiding, so both are hashed and the comparison is always over 32 bytes.
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Whether a bind address is reachable only from this machine.
 * @param {string} host - Listen address.
 * @returns {boolean} True for loopback.
 */
export function isLoopback(host) {
  return host === 'localhost' || host === '::1' || String(host).startsWith('127.');
}

/**
 * Whether anything is configured that could authenticate a caller.
 * @param {object} auth - The `auth` config section.
 * @returns {boolean} True when the node is guarded.
 */
export function isGuarded(auth = {}) {
  return Boolean(
    auth.apiKey || auth.password || auth.passwordHash || (auth.tokens ?? []).length,
  );
}

/**
 * Refuse to listen somewhere reachable with no credential.
 *
 * Unguarded, the console can key a transmitter's radio, rewrite the
 * configuration and read every unpublished transcript. Unguarded on a LAN
 * address is not a default worth having. An admin account counts as a
 * credential, as one in the settings file does.
 * @param {object} config - The whole config.
 * @param {{admins?: number}} [o] - How many admin accounts there are.
 * @returns {void}
 */
export function assertSafeToListen(config, { admins = 0 } = {}) {
  if (!isLoopback(config.host) && !isGuarded(config.auth) && !admins) {
    throw new Error(
      `refusing to listen on ${config.host} with no credential; ` +
        'set auth.password or auth.tokens, make an admin account, or bind host to 127.0.0.1',
    );
  }
}

/**
 * Build the token lookup.
 * @param {object} auth - The `auth` config section.
 * @returns {Map<string, {name: string, role: string}>} Hash to record.
 */
export function tokenIndex(auth = {}) {
  const index = new Map();
  // A bare apiKey is the single-admin-token form, kept working.
  if (auth.apiKey) index.set(hashToken(auth.apiKey), { name: 'apiKey', role: 'admin' });
  for (const t of auth.tokens ?? []) {
    if (typeof t === 'string') {
      index.set(hashToken(t), { name: 'token', role: 'admin' });
    } else if (t?.token) {
      index.set(hashToken(t.token), { name: t.name ?? 'token', role: t.role ?? 'admin' });
    } else if (t?.hash) {
      index.set(t.hash, { name: t.name ?? 'token', role: t.role ?? 'admin' });
    }
  }
  return index;
}

/** Browser sessions, in memory, where there are no accounts to keep them with. */
export class Sessions {
  constructor(ttl = SESSION_MS) {
    this.ttl = ttl;
    this.byId = new Map();
  }

  /**
   * @param {string} role - The role this session carries.
   * @returns {string} A new session id.
   */
  create(role) {
    const id = generateToken();
    this.byId.set(id, { role, expires: Date.now() + this.ttl });
    return id;
  }

  /**
   * @param {string} id - Session id from the cookie.
   * @returns {{role: string} | null} The session, renewed, or null.
   */
  get(id) {
    const s = this.byId.get(id);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.byId.delete(id);
      return null;
    }
    s.expires = Date.now() + this.ttl; // used, so keep it alive
    return s;
  }

  /**
   * @param {string} id - Session to end.
   * @returns {void}
   */
  destroy(id) {
    this.byId.delete(id);
  }
}

/**
 * Read one cookie from a request.
 *
 * Parsed here rather than adding a dependency for the one cookie this sets.
 * @param {import('express').Request} req - The request.
 * @param {string} name - Cookie name.
 * @returns {string | null} Its value, or null.
 */
export function readCookie(req, name) {
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return null;   // a mangled cookie is no cookie
      }
    }
  }
  return null;
}

/**
 * Whether a request came straight from this machine or the local network, not
 * through a proxy: where the settings file's password is taken (docs/two-step.md).
 * @param {import('express').Request} req - The request.
 * @returns {boolean} True for a private address with no forwarding header.
 */
export function fromLocalNetwork(req) {
  if (req.get?.('x-forwarded-for') || req.get?.('forwarded')) return false;
  const a = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (a === '::1' || /^(127|10)\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe[89ab][0-9a-f]:/i.test(a);
}

/** The cookies of two-step: a sign-in waiting for its second step, and a remembered browser. */
export const PENDING_COOKIE = 'airscribe_pending';
export const BROWSER_COOKIE = 'airscribe_browser';
const PENDING_MS = 5 * 60 * 1000;
/** How recent a step must be to change how one verifies, and a password given again to set it up. */
const CHANGE_MS = 10 * 60 * 1000;
const PASSWORD_MS = 15 * 60 * 1000;

/** Wrong passwords or tokens from one address before it's made to wait, and for how long. */
const MISS_LIMIT = 20;
const MISS_MS = 15 * 60 * 1000;

/**
 * Authentication and authorisation for one node.
 *
 * Three ways in, checked in this order: an API token (scripts, and pages
 * opened with ?token=), a browser session from signing in, and nothing at all
 * on a node with no credential, which is loopback-only (assertSafeToListen).
 * Signing in takes an account's username and password, or the settings file's
 * password (the node's own admin, for getting back in), or where only tokens
 * are set, a token.
 * @param {object} config - The whole config.
 * @param {object} [o] - Optional parts.
 * @param {import('./accounts.js').Accounts} [o.accounts] - People's accounts. Without them sessions live in memory.
 * @param {() => object[]} [o.providers] - The sign-in providers turned on, for the sign-in page.
 * @param {() => string} [o.publicUrl] - The address set in Admin, which passkeys are also taken on.
 * @returns {object} Middleware and handlers.
 */
export function createAuth(config, { accounts = null, providers = () => [], publicUrl = () => '' } = {}) {
  const auth = config.auth ?? {};
  const twoStepRequired = config.twoStep?.required !== false;
  const adminMs = Math.max(1, Number(config.twoStep?.adminHours) || 12) * 60 * 60 * 1000;
  const rememberMs = Math.max(1, Number(config.twoStep?.rememberDays) || 30) * 24 * 60 * 60 * 1000;
  const pending = new Map();   // token -> {userId, role, until}
  const tokens = tokenIndex(auth);
  const sessions = new Sessions();
  const configGuarded = isGuarded(auth);
  /** @returns {boolean} Whether anything is needed to get in: a credential in the file, or an account. */
  const guarded = () => configGuarded || (accounts?.count() ?? 0) > 0;
  const misses = new Map();   // address -> {count, first}

  const addressOf = (req) => req.ip ?? req.socket?.remoteAddress ?? '';
  /** @returns {boolean} Whether this address has had too many wrong tries lately. */
  function tooMany(req) {
    const m = misses.get(addressOf(req));
    return Boolean(m && Date.now() - m.first < MISS_MS && m.count >= MISS_LIMIT);
  }
  /** Count a wrong try from this address. */
  function missed(req) {
    const key = addressOf(req);
    const m = misses.get(key);
    if (!m || Date.now() - m.first >= MISS_MS) misses.set(key, { count: 1, first: Date.now() });
    else m.count += 1;
    if (misses.size > 10000) misses.delete(misses.keys().next().value);
  }

  /**
   * Who this request is.
   * @param {import('express').Request} req - The request.
   * @returns {{role: string, user: {id: number, username: string, role: string}|null} | null} Or null for nobody.
   */
  function who(req) {
    // Unguarded nodes are loopback-only, enforced at startup, so everyone
    // reaching one is already on the machine.
    if (!guarded()) return { role: 'admin', user: null, kind: 'open' };

    const bearer = /^Bearer (.+)$/i.exec(req.get?.('authorization') ?? '')?.[1];
    // The query string is not a preference: an EventSource and an <audio>
    // element cannot set a header.
    const presented = bearer ?? (typeof req.query?.token === 'string' ? req.query.token : null);
    if (presented) {
      const t = tokens.get(hashToken(presented));
      return t ? { role: t.role, user: null, kind: 'token' } : null;
    }
    const sid = readCookie(req, SESSION_COOKIE);
    if (!sid) return null;
    if (accounts) {
      const s = accounts.session(sid);
      return s ? { ...s, kind: s.user ? 'account' : 'file', sid } : null;
    }
    const s = sessions.get(sid);
    return s ? { role: s.role, user: null, kind: 'file' } : null;
  }

  /**
   * Where this request stands with two-step: whether it's set up, whether the
   * session has passed a step (a remembered browser counts, and is marked),
   * and until when Admin's check lasts. The settings file, tokens and an
   * unguarded node have nothing to step through.
   * @returns {{required: boolean, setUp: boolean, stepped: boolean, checkedUntil: number|null, recent: boolean, passwordConfirmed: boolean}} Where it stands.
   */
  function standing(req, w = who(req)) {
    if (!w) return { required: twoStepRequired, setUp: false, stepped: false, checkedUntil: null, recent: false, passwordConfirmed: false };
    if (w.kind !== 'account' || !accounts) {
      return { required: false, setUp: false, stepped: true, checkedUntil: Infinity, recent: true, passwordConfirmed: true };
    }
    const t = accounts.twoStep;
    const setUp = t.isSetUp(w.user.id);
    const m = w.marks ?? {};
    let stepped = m.stepped_at !== null && m.stepped_at !== undefined;
    if (!stepped && setUp && t.remembered(w.user.id, readCookie(req, BROWSER_COOKIE))) {
      accounts.markSession(w.sid, { step: true });
      stepped = true;
    }
    const now = Date.now();
    const checkedUntil = m.checked_at ? m.checked_at + adminMs : null;
    return {
      required: twoStepRequired, setUp,
      stepped: stepped || !twoStepRequired,
      checkedUntil: twoStepRequired ? (checkedUntil && checkedUntil > now ? checkedUntil : null) : Infinity,
      recent: Boolean(m.last_step_at && now - m.last_step_at < CHANGE_MS),
      passwordConfirmed: Boolean(m.password_at && now - m.password_at < PASSWORD_MS),
    };
  }

  /**
   * What role this request carries, if any.
   * @param {import('express').Request} req - The request.
   * @returns {string | null} A role name, or null.
   */
  const roleOf = (req) => who(req)?.role ?? null;

  /**
   * Require at least the given role. The request then carries `role`, and
   * `user` when it's an account's.
   * @param {string} need - 'viewer' or 'admin'.
   * @returns {import('express').RequestHandler} The middleware.
   */
  function requireRole(need, { settings = false } = {}) {
    return (req, res, next) => {
      const w = who(req);
      const role = w?.role ?? null;
      if (!role || ROLES[role] < ROLES[need]) {
        return res.status(role ? 403 : 401).json({ error: role ? `this needs the ${need} role` : 'unauthorized' });
      }
      req.role = role;
      req.user = w.user ?? null;
      // Controlling radios needs a step this session; Admin, a check of its own (docs/two-step.md)
      if (need === 'admin') {
        const st = standing(req, w);
        if (!st.setUp && st.required && w.kind === 'account') {
          return res.status(403).json({
            error: settings ? 'Admin needs two-step verification: set it up in Your account'
              : 'controlling the radios needs two-step verification: set it up in Your account',
            twoStep: 'setup',
          });
        }
        if (!st.stepped) return res.status(403).json({ error: 'confirm it’s you with your passkey or code first', twoStep: 'step' });
        if (settings && !st.checkedUntil) return res.status(403).json({ error: 'confirm it’s you to open Admin', twoStep: 'verify' });
      }
      next();
    };
  }

  /**
   * Start a browser session and hand it to the browser.
   * @param {import('express').Request} req - The request.
   * @param {import('express').Response} res - The response.
   * @param {{userId?: number|null, role: string}} whose - An account's, or a role's.
   * @returns {string} The session id.
   */
  function startSession(req, res, { userId = null, role, stepped = false }) {
    const id = accounts ? accounts.startSession({ userId, role, stepped }) : sessions.create(role);
    res.cookie?.(SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      path: '/',
      maxAge: SESSION_MS,
    });
    return id;
  }

  /**
   * The page a request came from, as passkeys know it: its origin (a proxy's
   * X-Forwarded-Proto and -Host honoured, as for sign-in providers), the
   * address set in Admin, and the name a passkey made here belongs to.
   * @returns {{origins: string[], rpId: string, secure: boolean}} The page.
   */
  function pageOf(req) {
    const proto = String(req.get?.('x-forwarded-proto') ?? '').split(',')[0].trim() || req.protocol || 'http';
    const host = String(req.get?.('x-forwarded-host') ?? '').split(',')[0].trim() || req.get?.('host') || 'localhost';
    let url;
    try { url = new URL(`${proto}://${host}`); } catch { url = new URL('http://localhost'); }
    const origins = [url.origin];
    try { const fixed = publicUrl() && new URL(publicUrl()).origin; if (fixed && fixed !== url.origin) origins.push(fixed); } catch { /* not an address */ }
    return { origins, rpId: url.hostname, secure: url.protocol === 'https:' || url.hostname === 'localhost' };
  }

  /** This browser remembered for an account: its sign-ins skip the second step for 30 days. */
  function rememberBrowser(req, res, userId) {
    res.cookie?.(BROWSER_COOKIE, accounts.twoStep.remember(userId), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: rememberMs,
    });
  }

  /**
   * An account's first step done (a password, or a linked sign-in): signed in,
   * or, where it has two-step and this browser isn't remembered, waiting for
   * the second.
   * @param {import('express').Request} req - The request.
   * @param {import('express').Response} res - The response.
   * @param {{id: number, role: string}} user - The account.
   * @returns {{signedIn: boolean}} Whether it's signed in now.
   */
  function firstStepDone(req, res, user) {
    const t = accounts.twoStep;
    if (!t.isSetUp(user.id)) {
      startSession(req, res, { userId: user.id, role: user.role });
      return { signedIn: true };
    }
    if (t.remembered(user.id, readCookie(req, BROWSER_COOKIE))) {
      startSession(req, res, { userId: user.id, role: user.role, stepped: true });
      return { signedIn: true };
    }
    const now = Date.now();
    for (const [k, v] of pending) if (v.until < now) pending.delete(k);
    const token = generateToken();
    pending.set(token, { userId: user.id, until: now + PENDING_MS });
    res.cookie?.(PENDING_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/api', maxAge: PENDING_MS });
    return { signedIn: false };
  }

  /** @returns {{token: string, userId: number} | null} The sign-in waiting for its second step. */
  function waiting(req) {
    const token = readCookie(req, PENDING_COOKIE);
    const p = token ? pending.get(token) : null;
    if (!p || p.until < Date.now()) return null;
    return { token, userId: p.userId };
  }

  /** What a sign-in waiting for its second step may use. */
  function methodsFor(userId, rpId) {
    const t = accounts.twoStep;
    return { passkey: t.allowFor(userId, rpId).length > 0, authenticator: t.hasAuthenticator(userId), recovery: t.codesLeft(userId) > 0 };
  }

  /**
   * The second step of a waiting sign-in done: signed in, stepped, and the
   * browser remembered if asked.
   */
  function secondStepDone(req, res, w, { remember = false } = {}) {
    pending.delete(w.token);
    res.clearCookie?.(PENDING_COOKIE, { path: '/api' });
    const user = accounts.user(w.userId);
    if (!user || user.disabled) throw Object.assign(new Error('this account is turned off; an admin can turn it back on'), { status: 403 });
    startSession(req, res, { userId: user.id, role: user.role, stepped: true });
    if (remember) rememberBrowser(req, res, user.id);
    return user;
  }

  /**
   * Sign in with a password or a token, and get a session cookie.
   * @param {import('express').Request} req - The request.
   * @param {import('express').Response} res - The response.
   * @returns {void}
   */
  function login(req, res) {
    const { username, password } = req.body ?? {};
    if (tooMany(req)) return res.status(429).json({ error: 'too many tries from here: wait a few minutes' });

    // An account's name is the account's: only its own password lets it in
    if (accounts && username) {
      try {
        const user = accounts.signIn(username, password);
        if (user) {
          if (!firstStepDone(req, res, user).signedIn) {
            return res.json({ ok: false, twoStep: 'signin', methods: methodsFor(user.id, pageOf(req).rpId) });
          }
          return res.json({ ok: true, role: user.role, user: { id: user.id, username: user.username, role: user.role } });
        }
      } catch (e) {
        if (e.status === 401) missed(req);
        return res.status(e.status ?? 401).json({ error: e.message });
      }
    }

    let role = null;
    // It passes both of two-step's checks, so it's taken only from the local network
    const filePassword = !twoStepRequired || fromLocalNetwork(req);
    if (filePassword && password && auth.passwordHash && verifyPassword(password, auth.passwordHash)) {
      role = auth.role ?? 'admin';
    } else if (filePassword && password && auth.password && same(password, auth.password)) {
      role = auth.role ?? 'admin';
    } else if (password) {
      // Where only tokens are configured, the same box takes one, so the
      // page does not have to ask for a password that does not exist.
      role = tokens.get(hashToken(password))?.role ?? null;
    }
    // A username is checked only when one is configured.
    if (role && auth.username && username !== auth.username) role = null;

    if (!role) {
      missed(req);
      return res.status(401).json({ error: 'not accepted' });
    }
    startSession(req, res, { role });
    res.json({ ok: true, role });
  }

  return {
    get guarded() { return guarded(); },
    configGuarded,
    standing,
    pageOf,
    firstStepDone,
    waiting,
    methodsFor,
    secondStepDone,
    rememberBrowser,
    adminMs,
    /** Admin's middleware: an admin with Admin's check, as well as a step. */
    settings: requireRole('admin', { settings: true }),
    sessions,
    tokens,
    who,
    roleOf,
    requireRole,
    login,
    startSession,
    tooMany,
    missed,
    /** @returns {string|null} The session id this request came with. */
    sessionId: (req) => readCookie(req, SESSION_COOKIE),
    /** @param {import('express').Request} req - The request. @param {import('express').Response} res - The response. @returns {void} */
    session(req, res) {
      const w = who(req);
      const role = w?.role ?? null;
      const hasAccounts = (accounts?.count() ?? 0) > 0;
      // What the sign-in page should ask for: a username when there are
      // accounts or one is set, and "API token" rather than "password" when
      // tokens are all there is
      const st = standing(req, w);
      res.json({
        guarded: guarded(), role, authenticated: Boolean(role),
        user: w?.user && accounts ? accounts.user(w.user.id) : null,
        // What the page may offer: controlling radios, and Admin without asking again
        twoStep: { ...st, checkedUntil: Number.isFinite(st.checkedUntil) ? st.checkedUntil : null },
        canOperate: role === 'admin' && st.stepped && (st.setUp || !st.required || w.kind !== 'account'),
        canAdmin: role === 'admin' && Boolean(st.checkedUntil) && (st.setUp || !st.required || w.kind !== 'account'),
        accounts: hasAccounts,
        passwordLogin: Boolean(auth.passwordHash || auth.password) || hasAccounts,
        username: Boolean(auth.username) || hasAccounts,
        providers: providers(),
      });
    },
    /** @param {import('express').Request} req - The request. @param {import('express').Response} res - The response. @returns {void} */
    logout(req, res) {
      const sid = readCookie(req, SESSION_COOKIE);
      if (sid) {
        sessions.destroy(sid);
        accounts?.endSession(sid);
      }
      res.clearCookie?.(SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    },
  };
}
