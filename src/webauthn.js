import crypto from 'node:crypto';

// Passkeys (WebAuthn level 2), checked here rather than with a dependency:
// attestation "none" (whose authenticator it is isn't asked), and the three
// key types browsers make: ES256, EdDSA and RS256.

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const bytes = (v, what) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(v)) throw fail(`the passkey's ${what} is missing`);
  return Buffer.from(v, 'base64url');
};
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** COSE algorithm numbers this checks, and what a browser is told it may make. */
export const ALGORITHMS = [-7, -8, -257];

/**
 * Read one CBOR value (RFC 8949): the parts authenticators use.
 * @param {Buffer} buf - The bytes.
 * @param {number} [at] - Where to start.
 * @returns {{value: unknown, end: number}} The value, and where it ended.
 */
export function cbor(buf, at = 0) {
  if (at >= buf.length) throw fail('the passkey sent a short answer');
  const head = buf[at];
  const major = head >> 5;
  const info = head & 31;
  let p = at + 1;
  let n;
  if (info < 24) n = info;
  else if (info === 24) { n = buf.readUInt8(p); p += 1; }
  else if (info === 25) { n = buf.readUInt16BE(p); p += 2; }
  else if (info === 26) { n = buf.readUInt32BE(p); p += 4; }
  else if (info === 27) { n = Number(buf.readBigUInt64BE(p)); p += 8; }
  else throw fail('the passkey sent CBOR this doesn’t read');
  switch (major) {
    case 0: return { value: n, end: p };
    case 1: return { value: -1 - n, end: p };
    case 2:
    case 3: {
      if (p + n > buf.length) throw fail('the passkey sent a short answer');
      const raw = buf.subarray(p, p + n);
      return { value: major === 2 ? Buffer.from(raw) : raw.toString('utf8'), end: p + n };
    }
    case 4: {
      const list = [];
      for (let i = 0; i < n; i++) { const r = cbor(buf, p); list.push(r.value); p = r.end; }
      return { value: list, end: p };
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < n; i++) {
        const k = cbor(buf, p);
        const v = cbor(buf, k.end);
        map.set(k.value, v.value);
        p = v.end;
      }
      return { value: map, end: p };
    }
    case 7:
      if (info === 20) return { value: false, end: p };
      if (info === 21) return { value: true, end: p };
      if (info === 22) return { value: null, end: p };
      throw fail('the passkey sent CBOR this doesn’t read');
    default:
      throw fail('the passkey sent CBOR this doesn’t read');
  }
}

/**
 * The authenticator data: whose site, which flags, the counter, and on
 * registration the new credential.
 * @param {Buffer} data - authenticatorData.
 * @returns {object} What it says.
 */
export function parseAuthData(data) {
  if (data.length < 37) throw fail('the passkey sent a short answer');
  const flags = data[32];
  const out = {
    rpIdHash: data.subarray(0, 32),
    up: Boolean(flags & 0x01), uv: Boolean(flags & 0x04),
    backupEligible: Boolean(flags & 0x08), backedUp: Boolean(flags & 0x10),
    signCount: data.readUInt32BE(33),
    credential: null,
  };
  if (flags & 0x40) {
    if (data.length < 55) throw fail('the passkey sent a short answer');
    const len = data.readUInt16BE(53);
    const id = data.subarray(55, 55 + len);
    if (id.length !== len) throw fail('the passkey sent a short answer');
    const { value } = cbor(data, 55 + len);
    out.credential = { aaguid: data.subarray(37, 53), id: Buffer.from(id), cose: value };
  }
  return out;
}

/**
 * A COSE public key as a key Node can verify with.
 * @param {Map<number, unknown>} cose - The key.
 * @returns {{spki: Buffer, alg: number}} The key as SPKI DER, and its algorithm.
 */
export function coseKey(cose) {
  if (!(cose instanceof Map)) throw fail('the passkey’s public key isn’t one this reads');
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    jwk = { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) };
  } else if (kty === 1 && alg === -8 && cose.get(-1) === 6) {
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(cose.get(-2)) };
  } else if (kty === 3 && alg === -257) {
    jwk = { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) };
  } else {
    throw fail('this passkey uses a kind of key AirScribe doesn’t check; try another');
  }
  try {
    return { spki: crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' }), alg };
  } catch {
    throw fail('the passkey’s public key isn’t one this reads');
  }
}

/**
 * The client data, checked: what the browser says it was asked, by which page.
 * @returns {Buffer} The raw JSON, for the signature.
 */
function clientData(json, { type, challenge, origins }) {
  const raw = bytes(json, 'client data');
  let c;
  try { c = JSON.parse(raw.toString('utf8')); } catch { throw fail('the passkey’s client data isn’t JSON'); }
  if (c.type !== type) throw fail('the passkey answered a different question');
  if (typeof c.challenge !== 'string' || !crypto.timingSafeEqual(sha256(c.challenge), sha256(challenge))) {
    throw fail('the passkey answered an old question: try again');
  }
  if (!origins.includes(c.origin)) throw fail(`the passkey was used on ${c.origin}, not this address`);
  if (c.crossOrigin === true) throw fail('the passkey was used from inside another site');
  return raw;
}

/**
 * What the browser is given to make a passkey.
 * @param {{rpId: string, rpName: string, userId: Buffer, name: string, challenge: string, exclude?: string[]}} o - For whom.
 * @returns {object} PublicKeyCredentialCreationOptions, in WebAuthn's JSON form.
 */
export function creationOptions({ rpId, rpName, userId, name, challenge, exclude = [] }) {
  return {
    rp: { id: rpId, name: rpName },
    user: { id: b64url(userId), name, displayName: name },
    challenge,
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    timeout: 300000,
    attestation: 'none',
    excludeCredentials: exclude.map((id) => ({ type: 'public-key', id })),
    // Kept on the device, so it can sign in with no username typed
    authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' },
  };
}

/**
 * What the browser is given to use one.
 * @param {{rpId: string, challenge: string, allow?: {id: string, transports?: string[]}[], userVerification?: string}} o - Which.
 * @returns {object} PublicKeyCredentialRequestOptions, in WebAuthn's JSON form.
 */
export function requestOptions({ rpId, challenge, allow = [], userVerification = 'preferred' }) {
  return {
    rpId, challenge, timeout: 300000, userVerification,
    allowCredentials: allow.map((c) => ({ type: 'public-key', id: c.id, ...(c.transports?.length ? { transports: c.transports } : {}) })),
  };
}

/**
 * A new passkey, checked.
 * @param {object} credential - The browser's answer, in WebAuthn's JSON form.
 * @param {{challenge: string, origins: string[], rpId: string}} expect - What it was asked.
 * @returns {{id: string, publicKey: string, alg: number, signCount: number, backedUp: boolean, transports: string[]}} What to keep.
 */
export function verifyRegistration(credential, { challenge, origins, rpId }) {
  const r = credential?.response ?? {};
  clientData(r.clientDataJSON, { type: 'webauthn.create', challenge, origins });
  const { value: att } = cbor(bytes(r.attestationObject, 'attestation'));
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw fail('the passkey’s attestation isn’t one this reads');
  const auth = parseAuthData(att.get('authData'));
  if (!auth.rpIdHash.equals(sha256(rpId))) throw fail('the passkey was made for another site');
  if (!auth.up) throw fail('the passkey wasn’t touched');
  if (!auth.credential) throw fail('the passkey sent no key');
  const { spki, alg } = coseKey(auth.credential.cose);
  const id = b64url(auth.credential.id);
  if (credential.id !== undefined && credential.id !== id) throw fail('the passkey’s ID doesn’t match its key');
  const transports = Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === 'string').slice(0, 8) : [];
  return { id, publicKey: b64url(spki), alg, signCount: auth.signCount, backedUp: auth.backedUp, transports };
}

/**
 * A passkey used, checked against the one kept.
 * @param {object} credential - The browser's answer, in WebAuthn's JSON form.
 * @param {{challenge: string, origins: string[], rpId: string, publicKey: string, alg: number, signCount: number, requireUv?: boolean}} expect - What was asked, and the passkey kept.
 * @returns {{signCount: number, uv: boolean, backedUp: boolean}} The counter now.
 */
export function verifyAssertion(credential, { challenge, origins, rpId, publicKey, alg, signCount, requireUv = false }) {
  const r = credential?.response ?? {};
  const raw = clientData(r.clientDataJSON, { type: 'webauthn.get', challenge, origins });
  const data = bytes(r.authenticatorData, 'authenticator data');
  const auth = parseAuthData(data);
  if (!auth.rpIdHash.equals(sha256(rpId))) throw fail('the passkey was made for another site');
  if (!auth.up) throw fail('the passkey wasn’t touched');
  if (requireUv && !auth.uv) throw fail('the passkey didn’t ask for a fingerprint, face or PIN, so it can’t sign in on its own');
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
  const signed = Buffer.concat([data, sha256(raw)]);
  const ok = crypto.verify(alg === -8 ? null : 'sha256', signed, key, bytes(r.signature, 'signature'));
  if (!ok) throw fail('the passkey’s signature isn’t right');
  // A counter that went backwards is a copied key; passkeys that sync send 0
  if ((auth.signCount || signCount) && auth.signCount <= signCount) throw fail('this passkey’s counter went backwards: it may have been copied');
  return { signCount: auth.signCount, uv: auth.uv, backedUp: auth.backedUp };
}
