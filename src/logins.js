import crypto from 'node:crypto';
import { generateToken, hashToken, same } from './auth.js';
import { VERSION } from './updates.js';

/**
 * The providers one can sign in with, as in WifiDB and tippr. Each needs its
 * own OAuth app, made in its console, whose client ID and secret an admin
 * enters in Admin → Sign-in providers.
 */
export const PROVIDERS = {
  google: {
    name: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    pkce: true,
    console: 'https://console.cloud.google.com/apis/credentials',
    who: (u) => ({ subject: u.sub, name: u.name, email: u.email }),
  },
  github: {
    name: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    scope: 'read:user',
    pkce: false,
    console: 'https://github.com/settings/developers',
    who: (u) => ({ subject: u.id, name: u.name || u.login, email: u.email }),
  },
  discord: {
    name: 'Discord',
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    scope: 'identify',
    pkce: false,
    console: 'https://discord.com/developers/applications',
    who: (u) => ({ subject: u.id, name: u.global_name || u.username, email: u.email }),
  },
  facebook: {
    name: 'Facebook',
    authorize: 'https://www.facebook.com/dialog/oauth',
    token: 'https://graph.facebook.com/oauth/access_token',
    userinfo: 'https://graph.facebook.com/me?fields=id,name,email',
    scope: 'email public_profile',
    pkce: false,
    tokenByGet: true,   // its token endpoint is documented as a GET
    console: 'https://developers.facebook.com/apps/',
    who: (u) => ({ subject: u.id, name: u.name, email: u.email }),
  },
};

/** A sign-in under way, or an outside account waiting to be linked: this long. */
const PENDING_MS = 10 * 60 * 1000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const key = (provider, field) => `login.${provider}.${field}`;
const base64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Signing in with Google, GitHub, Discord or Facebook: OAuth 2's authorization
 * code flow, on the server, with PKCE where the provider takes it.
 *
 * An outside account only ever signs in to the AirScribe account it was linked
 * to; nothing is matched by e-mail address. Linking is done from one's own
 * account page, giving the password. Signing in with one not linked yet holds
 * it for ten minutes, while the person signs in with their password to link it.
 * The `state` sent to the provider must come back to the browser that set the
 * matching cookie, and works once.
 *
 * Sign-ins under way are kept in memory (one AirScribe process): a restart in
 * the middle of one means starting it again.
 */
export class Logins {
  /**
   * @param {object} o - Dependencies.
   * @param {import('./store.js').Store} o.store - Where the providers' settings are kept.
   * @param {import('./accounts.js').Accounts} o.accounts - Who to sign in, and their links.
   * @param {{providerEndpoints?: object}} [o.config] - The settings file's auth section: endpoints may be pointed elsewhere for tests.
   * @param {typeof fetch} [o.fetch] - For tests.
   * @param {() => number} [o.now] - The clock, for tests.
   */
  constructor({ store, accounts, config = {}, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    this.accounts = accounts;
    this.endpoints = config?.providerEndpoints ?? {};
    this.fetch = fetch;
    this.now = now;
    this.flows = new Map();     // hash of the state token -> a sign-in under way
    this.waiting = new Map();   // hash of a token -> an outside account not yet linked
  }

  /** @returns {object} A provider, with any endpoints the settings file points elsewhere. */
  info(id) {
    if (!Object.hasOwn(PROVIDERS, id)) throw fail('no such sign-in provider', 404);
    const over = this.endpoints[id] ?? {};
    return { ...PROVIDERS[id], ...Object.fromEntries(['authorize', 'token', 'userinfo'].filter((k) => over[k]).map((k) => [k, over[k]])) };
  }

  setting(id, field) {
    return this.store.setting(key(id, field)) ?? '';
  }

  /** @returns {boolean} Whether a provider is on, with what it needs. */
  isOn(id) {
    return this.setting(id, 'enabled') === '1' && Boolean(this.setting(id, 'clientId') && this.setting(id, 'secret'));
  }

  /** @returns {{id: string, name: string}[]} The providers one may sign in with now. */
  enabled() {
    return Object.keys(PROVIDERS).filter((id) => this.isOn(id)).map((id) => ({ id, name: PROVIDERS[id].name }));
  }

  /** @returns {string} This server's address as the providers know it, set in Admin, or ''. */
  publicUrl() {
    return this.store.setting('login.publicUrl') ?? '';
  }

  /**
   * Where a provider sends the browser back to. The address set in Admin, or
   * the one this request came to (a proxy's X-Forwarded-Proto and -Host
   * honoured): a provider only ever sends people to an address registered
   * with it, so a wrong one fails there rather than going astray.
   * @param {string} id - The provider.
   * @param {import('express').Request} req - The request.
   * @returns {string} The redirect URI.
   */
  callbackUrl(id, req) {
    let origin = this.publicUrl();
    if (!origin) {
      const proto = String(req.get?.('x-forwarded-proto') ?? '').split(',')[0].trim() || req.protocol || 'http';
      const host = String(req.get?.('x-forwarded-host') ?? '').split(',')[0].trim() || req.get?.('host') || 'localhost';
      origin = `${proto}://${host}`;
    }
    return `${origin.replace(/\/+$/, '')}/api/auth/${id}/callback`;
  }

  /**
   * What Admin → Sign-in providers shows: never a secret itself.
   * @param {import('express').Request} req - For the redirect URIs.
   * @returns {object} The address, and each provider.
   */
  settings(req) {
    return {
      publicUrl: this.publicUrl(),
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({
        id, name: p.name, console: p.console, scope: p.scope,
        enabled: this.setting(id, 'enabled') === '1', on: this.isOn(id),
        clientId: this.setting(id, 'clientId'), secret: Boolean(this.setting(id, 'secret')),
        redirect: this.callbackUrl(id, req),
      })),
    };
  }

  /**
   * Save Admin's form. A secret left blank stays as saved.
   * @param {{publicUrl?: string, providers?: Record<string, {enabled?: boolean, clientId?: string, secret?: string}>}} body - The form.
   * @returns {void}
   */
  save({ publicUrl, providers = {} } = {}) {
    if (publicUrl !== undefined) {
      const url = String(publicUrl ?? '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url)) throw fail('the address is like https://airscribe.example.com');
      this.store.setSetting('login.publicUrl', url || null);
    }
    for (const [id, p] of Object.entries(providers ?? {})) {
      if (!Object.hasOwn(PROVIDERS, id)) throw fail(`no sign-in provider called ${id}`);
      const clientId = p.clientId === undefined ? undefined : String(p.clientId ?? '').trim();
      if (clientId !== undefined && clientId.length > 300) throw fail('that client ID is too long');
      if (p.secret && String(p.secret).length > 500) throw fail('that client secret is too long');
      if (clientId !== undefined) this.store.setSetting(key(id, 'clientId'), clientId || null);
      if (p.secret) this.store.setSetting(key(id, 'secret'), String(p.secret).trim());
      if (p.secret === null) this.store.setSetting(key(id, 'secret'), null);
      if (p.enabled !== undefined) this.store.setSetting(key(id, 'enabled'), p.enabled ? '1' : null);
      if (p.enabled && !this.isOn(id)) throw fail(`${PROVIDERS[id].name} needs a client ID and secret to be turned on`);
    }
  }

  /** Forget what's run out. */
  prune() {
    const now = this.now();
    for (const m of [this.flows, this.waiting]) for (const [k, v] of m) if (v.until < now) m.delete(k);
  }

  /**
   * Begin a sign-in: where to send the browser, and the token for its cookie.
   * @param {string} id - The provider.
   * @param {import('express').Request} req - For the redirect URI.
   * @param {{purpose: 'signin'|'link', userId?: number}} why - Signing in, or linking to this account.
   * @returns {{url: string, token: string}} The provider's address, and the state, which the cookie carries too.
   */
  start(id, req, { purpose, userId = null }) {
    const p = this.info(id);
    if (!this.isOn(id)) throw fail(`signing in with ${p.name} isn’t turned on`, 404);
    this.prune();
    const token = generateToken();
    const redirect = this.callbackUrl(id, req);
    const flow = { provider: id, purpose, userId, redirect, until: this.now() + PENDING_MS };
    const params = new URLSearchParams({
      client_id: this.setting(id, 'clientId'), redirect_uri: redirect, response_type: 'code', scope: p.scope, state: token,
    });
    if (p.pkce) {
      flow.verifier = generateToken() + generateToken();
      params.set('code_challenge', base64url(crypto.createHash('sha256').update(flow.verifier).digest()));
      params.set('code_challenge_method', 'S256');
    }
    this.flows.set(hashToken(token), flow);
    return { url: `${p.authorize}?${params}`, token };
  }

  /**
   * Finish one: the provider sent the browser back with a code, which is
   * swapped for an access token and that for who the person is.
   * @param {string} id - The provider, from the path.
   * @param {{code?: string, state?: string, error?: string, cookie?: string|null}} back - The query, and the browser's cookie.
   * @returns {Promise<{purpose: string, userId: number|null, identity: {subject: string, name: string, email: string}}>}
   */
  async finish(id, { code, state, error, cookie }) {
    const p = this.info(id);
    this.prune();
    const flow = state ? this.flows.get(hashToken(state)) : null;
    // The browser that began it, once, in time, with this provider
    if (!flow || !cookie || !same(cookie, state) || flow.provider !== id) {
      throw fail(`that ${p.name} sign-in didn’t start here, or has run out: try again`);
    }
    this.flows.delete(hashToken(state));
    try {
      return await this.exchange(p, id, flow, { code, error });
    } catch (e) {
      e.purpose = flow.purpose;   // so a link that failed goes back to the account page
      throw e;
    }
  }

  /** The code for an access token, and that for who the person is. */
  async exchange(p, id, flow, { code, error }) {
    if (error) throw fail(error === 'access_denied' ? `${p.name} sign-in was cancelled` : `${p.name} said: ${error}`);
    if (!code) throw fail(`${p.name} sent no sign-in code back`);

    const form = new URLSearchParams({
      grant_type: 'authorization_code', code: String(code), redirect_uri: flow.redirect,
      client_id: this.setting(id, 'clientId'), client_secret: this.setting(id, 'secret'),
    });
    if (flow.verifier) form.set('code_verifier', flow.verifier);
    const headers = { Accept: 'application/json', 'User-Agent': `AirScribe/${VERSION}` };
    const got = await this.ask(p, p.tokenByGet ? `${p.token}?${form}` : p.token, p.tokenByGet
      ? { headers }
      : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: String(form) });
    if (!got.access_token) throw fail(`${p.name} didn’t sign you in: ${got.error_description || got.error || 'no access token'}`, 502);
    const user = await this.ask(p, p.userinfo, { headers: { ...headers, Authorization: `Bearer ${got.access_token}` } });
    const identity = p.who(user ?? {});
    if (identity.subject === undefined || identity.subject === null || identity.subject === '') {
      throw fail(`${p.name} didn’t say who you are`, 502);
    }
    return {
      purpose: flow.purpose, userId: flow.userId,
      identity: { subject: String(identity.subject), name: identity.name ?? '', email: identity.email ?? '' },
    };
  }

  /** One call to a provider: its JSON, or why not. */
  async ask(p, url, opts) {
    let res;
    try {
      res = await this.fetch(url, { ...opts, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw fail(`${p.name} couldn’t be reached: ${e.cause?.message ?? e.message}`, 502);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const why = body?.error_description || body?.error?.message || body?.error || body?.message || `HTTP ${res.status}`;
      throw fail(`${p.name} said: ${typeof why === 'string' ? why : JSON.stringify(why)}`, 502);
    }
    return body;
  }

  /**
   * Hold an outside account that isn't linked to anyone, while its owner
   * signs in with their password to link it.
   * @param {string} provider - Whose.
   * @param {object} identity - Who, as finish() gave it.
   * @returns {string} A token for the browser's cookie.
   */
  hold(provider, identity) {
    this.prune();
    const token = generateToken();
    this.waiting.set(hashToken(token), { provider, identity, until: this.now() + PENDING_MS });
    return token;
  }

  /** @returns {{provider: string, identity: object} | null} The outside account a cookie holds, if it's still held. */
  held(token) {
    this.prune();
    return token ? this.waiting.get(hashToken(token)) ?? null : null;
  }

  /** It's linked, or abandoned. */
  release(token) {
    if (token) this.waiting.delete(hashToken(token));
  }
}
