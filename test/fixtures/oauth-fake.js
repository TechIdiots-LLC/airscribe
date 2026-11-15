// A stand-in for Google, GitHub, Discord and Facebook's OAuth 2: it signs
// whoever it's told to straight in, and checks what a real provider checks (the
// client ID and secret, the redirect URI, PKCE where it was asked for, a code
// used once). For the tests, and for trying linked sign-ins without an OAuth app:
//   node test/fixtures/oauth-fake.js 8102
// with auth.providerEndpoints pointing each provider at it (docs/linked-logins.md).
import { createServer } from 'node:http';
import crypto from 'node:crypto';

export const CLIENT = { id: 'test-client', secret: 'test-secret' };

/** Each provider's own shape for who someone is. */
const SHAPES = {
  google: (p) => ({ sub: p.id, name: p.name, email: p.email, email_verified: true }),
  github: (p) => ({ id: Number(p.id) || p.id, login: p.name.toLowerCase().replace(/\W+/g, ''), name: p.name, email: p.email }),
  discord: (p) => ({ id: String(p.id), username: p.name.toLowerCase().replace(/\W+/g, ''), global_name: p.name }),
  facebook: (p) => ({ id: String(p.id), name: p.name, email: p.email }),
};

/**
 * The stand-in's state and its one handler.
 * @returns {{handle: Function, as: Function, endpoints: Function}} It.
 */
export function fakeProvider() {
  const codes = new Map();    // code -> {provider, redirect, challenge, person}
  const tokens = new Map();   // access token -> {provider, person}
  const next = {};            // provider -> who signs in next, or 'deny'
  const json = (status, body) => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /**
   * @param {string} method - GET or POST.
   * @param {URL} url - The request's address.
   * @param {object} headers - Lowercased.
   * @param {string} body - The form, for POST.
   * @returns {{status: number, headers: object, body: string}} The answer.
   */
  function handle(method, url, headers, body = '') {
    const [, provider, step] = url.pathname.split('/');
    if (!SHAPES[provider]) return json(404, { error: 'no such provider' });
    const q = method === 'POST' ? new URLSearchParams(body) : url.searchParams;
    if (step === 'authorize') {
      if (q.get('client_id') !== CLIENT.id) return json(400, { error: 'invalid_client' });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('state', q.get('state') ?? '');
      const who = next[provider] ?? { id: '1001', name: 'Alice A', email: 'alice@example.com' };
      if (who === 'deny') back.searchParams.set('error', 'access_denied');
      else {
        const code = crypto.randomBytes(12).toString('hex');
        codes.set(code, { provider, redirect: q.get('redirect_uri'), challenge: q.get('code_challenge'), person: who });
        back.searchParams.set('code', code);
      }
      return { status: 302, headers: { Location: String(back) }, body: '' };
    }
    if (step === 'token') {
      const c = codes.get(q.get('code'));
      codes.delete(q.get('code'));   // once
      if (q.get('client_id') !== CLIENT.id || q.get('client_secret') !== CLIENT.secret) return json(401, { error: 'invalid_client' });
      if (!c || c.provider !== provider) return json(400, { error: 'invalid_grant', error_description: 'that code is used or unknown' });
      if (q.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri differs' });
      if (c.challenge) {
        const got = crypto.createHash('sha256').update(q.get('code_verifier') ?? '').digest('base64url');
        if (got !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verifier does not match' });
      }
      const access = crypto.randomBytes(16).toString('hex');
      tokens.set(access, { provider, person: c.person });
      return json(200, { access_token: access, token_type: 'bearer' });
    }
    if (step === 'userinfo') {
      const t = tokens.get(/^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1]);
      if (!t || t.provider !== provider) return json(401, { error: 'invalid_token' });
      return json(200, SHAPES[provider](t.person));
    }
    if (step === 'next' && method === 'POST') {
      const p = JSON.parse(body || '{}');
      next[provider] = p.deny ? 'deny' : p;
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  }

  return {
    handle,
    /** Who signs in at a provider next (or 'deny', to cancel there). */
    as(provider, person) { next[provider] = person; },
    /** @param {string} base - Where the stand-in is. @returns {object} auth.providerEndpoints for it. */
    endpoints: (base) => Object.fromEntries(Object.keys(SHAPES).map((p) => [p, {
      authorize: `${base}/${p}/authorize`, token: `${base}/${p}/token`, userinfo: `${base}/${p}/userinfo`,
    }])),
  };
}

/**
 * The stand-in over HTTP.
 * @param {number} [port] - Where; 0 for any.
 * @returns {Promise<{server: import('node:http').Server, fake: object, base: string}>} Listening on 127.0.0.1.
 */
export async function serve(port = 0) {
  const fake = fakeProvider();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r = fake.handle(req.method, new URL(req.url, 'http://x'), req.headers, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(r.status, r.headers).end(r.body);
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, fake, base: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1]?.endsWith('oauth-fake.js')) {
  const { base } = await serve(Number(process.argv[2] ?? 8102));
  console.log(`stand-in OAuth providers on ${base}/<google|github|discord|facebook>/<authorize|token|userinfo>`);
}
