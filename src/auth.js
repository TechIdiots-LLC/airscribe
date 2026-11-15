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
 * Refuse to put the admin surface somewhere reachable with no credential.
 *
 * The admin surface can key a transmitter's radio, rewrite the configuration
 * and read every unpublished transcript. Unguarded on a LAN address is not a
 * default worth having. The public listener is exempt: being reachable is
 * what it is for. An admin account counts as a credential, as one in the
 * settings file does.
 * @param {object} config - The whole config.
 * @param {{admins?: number}} [o] - How many admin accounts there are.
 * @returns {void}
 */
export function assertSafeToListen(config, { admins = 0 } = {}) {
  const adminHost = config.adminPort ? (config.adminHost ?? config.host) : config.host;
  if (!isLoopback(adminHost) && !isGuarded(config.auth) && !admins) {
    throw new Error(
      `refusing to serve the admin surface on ${adminHost} with no credential; ` +
        'set auth.password or auth.tokens, make an admin account, or bind adminHost to 127.0.0.1',
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
 * @returns {object} Middleware and handlers.
 */
export function createAuth(config, { accounts = null, providers = () => [] } = {}) {
  const auth = config.auth ?? {};
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
    if (!guarded()) return { role: 'admin', user: null };

    const bearer = /^Bearer (.+)$/i.exec(req.get?.('authorization') ?? '')?.[1];
    // The query string is not a preference: an EventSource and an <audio>
    // element cannot set a header.
    const presented = bearer ?? (typeof req.query?.token === 'string' ? req.query.token : null);
    if (presented) {
      const t = tokens.get(hashToken(presented));
      return t ? { role: t.role, user: null } : null;
    }
    const sid = readCookie(req, SESSION_COOKIE);
    if (!sid) return null;
    if (accounts) return accounts.session(sid);
    const s = sessions.get(sid);
    return s ? { role: s.role, user: null } : null;
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
  function requireRole(need) {
    return (req, res, next) => {
      const w = who(req);
      const role = w?.role ?? null;
      if (role && ROLES[role] >= ROLES[need]) {
        req.role = role;
        req.user = w.user ?? null;
        return next();
      }
      res.status(role ? 403 : 401).json({
        error: role ? `this needs the ${need} role` : 'unauthorized',
      });
    };
  }

  /**
   * Start a browser session and hand it to the browser.
   * @param {import('express').Request} req - The request.
   * @param {import('express').Response} res - The response.
   * @param {{userId?: number|null, role: string}} whose - An account's, or a role's.
   * @returns {string} The session id.
   */
  function startSession(req, res, { userId = null, role }) {
    const id = accounts ? accounts.startSession({ userId, role }) : sessions.create(role);
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
          startSession(req, res, { userId: user.id, role: user.role });
          return res.json({ ok: true, role: user.role, user: { id: user.id, username: user.username, role: user.role } });
        }
      } catch (e) {
        if (e.status === 401) missed(req);
        return res.status(e.status ?? 401).json({ error: e.message });
      }
    }

    let role = null;
    if (password && auth.passwordHash && verifyPassword(password, auth.passwordHash)) {
      role = auth.role ?? 'admin';
    } else if (password && auth.password && same(password, auth.password)) {
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
      res.json({
        guarded: guarded(), role, authenticated: Boolean(role),
        user: w?.user && accounts ? accounts.user(w.user.id) : null,
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
