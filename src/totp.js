import crypto from 'node:crypto';

// Authenticator apps' 6-digit codes (RFC 6238): HMAC-SHA1, 30-second steps, the
// form every app reads from an otpauth:// link.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

/** @param {Buffer} bytes - Raw. @returns {string} RFC 4648 base32, unpadded. */
export function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** @param {string} text - Base32, any case, spaces and padding ignored. @returns {Buffer} The bytes. */
export function fromBase32(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** @returns {string} A new secret: 20 random bytes, base32, as RFC 4226 recommends. */
export const newSecret = () => base32(crypto.randomBytes(20));

/** @param {number} ms - A time. @returns {number} Its 30-second step. */
export const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * @param {string} secret - Base32.
 * @param {number} step - The time step.
 * @returns {string} That step's code.
 */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const at = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(at) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

/**
 * Check a typed code: this step's, or the one either side of it, for a phone
 * whose clock is a little off. A step already used is refused, so a code
 * seen over someone's shoulder can't be used again.
 * @param {string} secret - Base32.
 * @param {string} typed - As typed: spaces are ignored.
 * @param {{now?: number, after?: number|null}} [o] - The time, and the last step used.
 * @returns {number|null} The step it matched, to keep as the last used, or null.
 */
export function check(secret, typed, { now = Date.now(), after = null } = {}) {
  const code = String(typed ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const here = stepAt(now);
  for (const step of [here, here - 1, here + 1]) {
    if (after !== null && step <= after) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/**
 * The link an authenticator app reads, as a QR code or opened on the device.
 * @param {string} secret - Base32.
 * @param {{issuer: string, account: string}} o - Who it's for.
 * @returns {string} An otpauth:// URI.
 */
export function otpauthUri(secret, { issuer, account }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}
