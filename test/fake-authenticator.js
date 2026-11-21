import crypto from 'node:crypto';

// A passkey authenticator for the tests: makes credentials and signs, as a
// browser would hand them to the server, in WebAuthn's JSON form.

/** CBOR encoding of the values a credential carries. */
export function encode(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [encode(k), encode(x)])]);
  if (v && typeof v === 'object') return encode(new Map(Object.entries(v)));
  throw new Error(`can't encode ${v}`);
}

const sha256 = (d) => crypto.createHash('sha256').update(d).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');

/** The COSE form of a public key. */
function cose(kind, publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = (s) => Buffer.from(s, 'base64url');
  if (kind === 'ec') return new Map([[1, 2], [3, -7], [-1, 1], [-2, raw(jwk.x)], [-3, raw(jwk.y)]]);
  if (kind === 'ed25519') return new Map([[1, 1], [3, -8], [-1, 6], [-2, raw(jwk.x)]]);
  return new Map([[1, 3], [3, -257], [-1, raw(jwk.n)], [-2, raw(jwk.e)]]);
}

/**
 * @param {{kind?: 'ec'|'ed25519'|'rsa', origin?: string, rpId?: string, uv?: boolean, synced?: boolean}} [o] - What it is.
 */
export function authenticator({ kind = 'ec', origin = 'https://air.example.net', rpId = 'air.example.net', uv = true, synced = false } = {}) {
  const pair = kind === 'ec' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : kind === 'ed25519' ? crypto.generateKeyPairSync('ed25519')
      : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const id = crypto.randomBytes(16);
  let count = synced ? 0 : 1;
  let userHandle = null;
  const flags = (at) => 0x01 | (uv ? 0x04 : 0) | (synced ? 0x18 : 0) | (at ? 0x40 : 0);
  const data = (at, extra = Buffer.alloc(0), counter = count) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags(at)]), c, extra]);
  };
  const client = (type, challenge, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o }));
  return {
    id: b64(id),
    /** navigator.credentials.create's answer to these options. */
    create(options, { origin: o = origin } = {}) {
      userHandle = options.user?.id ?? null;
      const len = Buffer.alloc(2);
      len.writeUInt16BE(id.length);
      const authData = data(true, Buffer.concat([Buffer.alloc(16), len, id, encode(cose(kind, pair.publicKey))]));
      return {
        id: b64(id), rawId: b64(id), type: 'public-key',
        response: {
          clientDataJSON: b64(client('webauthn.create', options.challenge, o)),
          attestationObject: b64(encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
          transports: ['internal'],
        },
      };
    },
    /** navigator.credentials.get's answer to these options. */
    get(options, { origin: o = origin, counter } = {}) {
      if (!synced) count += 1;
      const authData = data(false, Buffer.alloc(0), counter ?? count);
      const cd = client('webauthn.get', options.challenge, o);
      const signed = Buffer.concat([authData, sha256(cd)]);
      const signature = crypto.sign(kind === 'ed25519' ? null : 'sha256', signed, pair.privateKey);
      return {
        id: b64(id), rawId: b64(id), type: 'public-key',
        response: { clientDataJSON: b64(cd), authenticatorData: b64(authData), signature: b64(signature), userHandle },
      };
    },
  };
}
