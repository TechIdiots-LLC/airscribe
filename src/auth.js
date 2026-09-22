import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a bind address is reachable only from this machine.
 * @param {string} host - Listen address.
 * @returns {boolean} True for loopback.
 */
export function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Refuse to listen on a reachable address with no token configured. The API
 * can key a radio's transmitter path and reads everything it hears, so an
 * open listener is not a default worth having.
 * @param {string} host - Listen address.
 * @param {{tokens: string[]}} auth - The `auth` config section.
 * @returns {void}
 */
export function assertSafeToListen(host, auth) {
  if (!isLoopback(host) && !auth.tokens.length) {
    throw new Error(
      `refusing to listen on ${host} without auth.tokens; bind to 127.0.0.1 or configure a token`,
    );
  }
}

/**
 * @param {string} a - Presented token.
 * @param {string} b - Configured token.
 * @returns {boolean} Constant-time equality.
 */
function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Express middleware. No tokens configured means loopback-only (enforced at
 * startup), so requests pass. Otherwise a bearer header or `?token=` is
 * required; the query form exists because EventSource and <audio> cannot set
 * headers.
 * @param {{tokens: string[]}} auth - The `auth` config section.
 * @returns {import('express').RequestHandler} The middleware.
 */
export function requireToken(auth) {
  return (req, res, next) => {
    if (!auth.tokens.length) return next();
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
    const given = bearer ?? (typeof req.query.token === 'string' ? req.query.token : '');
    if (given && auth.tokens.some((t) => same(given, t))) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}
