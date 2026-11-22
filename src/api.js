import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, SCANNER_KEYS, guessModel, linkOf, newScannerId, normalizeMac, sendsRecordings } from './models.js';
import { createAuth, readCookie } from './auth.js';
import { PROVIDERS } from './logins.js';
import { PUBLISH_DEFAULTS, publicCutoff, publishable, publicView } from './publish.js';
import { insights } from './insights.js';
import { checkWrite, resolveWrite } from './channels.js';
import { judge } from './quality.js';
import { checkBeacon, checkProfile } from './beacon.js';
import { creationOptions, requestOptions } from './webauthn.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

/** The most transmissions one export carries: all of them, for any ordinary install. */
const EXPORT_MAX = 50000;

/**
 * Wrap an async handler so a rejection becomes a 502 instead of a hang.
 * @param {Function} fn - Async route handler.
 * @returns {import('express').RequestHandler} The wrapped handler.
 */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((e) => res.status(502).json({ error: e.message }));

/**
 * A handler whose answer is what `fn` returns, and whose error is its message,
 * with the status the error carries (400 for a bad request, 404, 409, ...).
 * @param {Function} fn - (req, res) => an answer, or a promise of one.
 * @returns {import('express').RequestHandler} The handler.
 */
const answer = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
};
const refuse = (message, status) => Object.assign(new Error(message), { status });

/**
 * One transmission as readable text: its context, then each engine's version.
 * @param {object} t - A transmission row.
 * @param {object[]} scripts - Its transcripts.
 * @returns {string} The file's contents.
 */
function describe(t, scripts) {
  const where = t.channel_name || (t.channel === null || t.channel === undefined ? null : `channel ${t.channel}`);
  const hz = t.channel_hz ? `${(t.channel_hz / 1e6).toFixed(4)} MHz` : null;
  const width = Math.max(1, ...scripts.map((s) => s.engine.length));
  return [
    `${new Date(t.started_at).toISOString()}  ${t.radio_name ? `${t.radio_name} · ` : ''}${t.mac}`,
    [where, hz].filter(Boolean).join(' · ') || 'channel unknown',
    `${(t.duration_ms / 1000).toFixed(1)}s · ${t.transmit ? 'sent' : 'heard'}`,
    '',
    ...scripts.map((s) => {
      const body = s.status === 'done' ? (s.text || '').trim() : `<${s.status}: ${s.error ?? ''}>`;
      return `${s.engine.padEnd(width)}  ${body}`;
    }),
    '',
  ].join('\n');
}

/**
 * Escape one CSV cell.
 * @param {unknown} v - The value.
 * @returns {string} A quoted cell where the content needs it.
 */
function csvCell(v) {
  const str = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}

/**
 * Serve one clip's WAV.
 *
 * Shared by the operator's route and the public one so both resolve the path
 * the same way. `sendFile` sets Content-Length and honours Range, which a
 * piped read stream did not, so a player can show a duration and seek.
 * @param {import('express').Response} res - The response.
 * @param {object} t - The transmission row.
 * @param {string} dataDir - Where clips live.
 * @param {boolean} download - Whether to offer it as a file rather than media.
 * @param {Function} [onError] - Called if the file cannot be sent.
 * @returns {void}
 */
function sendClip(res, t, dataDir, download, onError) {
  // audio_file is written by this server, but resolve it under clips/ anyway.
  const root = resolve(dataDir, 'clips');
  const file = resolve(root, t.audio_file);
  if (!file.startsWith(root + sep) || !existsSync(file)) {
    return res.status(404).json({ error: 'not found' });
  }
  const headers = { 'Content-Type': 'audio/wav' };
  // Only a download link says attachment; an <audio> element playing it
  // inline wants it served as media.
  if (download) {
    headers['Content-Disposition'] =
      `attachment; filename="${t.mac.replaceAll(':', '')}-${t.started_at}.wav"`;
  }
  res.sendFile(file, { headers, acceptRanges: true }, onError ?? (() => {}));
}

/**
 * The channel filter in a query: one channel, or several when `channel` is
 * given more than once (the Map's list asks for the channels in view so).
 * @param {unknown} value - req.query.channel.
 * @returns {string | string[] | undefined} The name or names, or undefined for every channel.
 */
function channelQuery(value) {
  const names = [].concat(value ?? []).map(String).filter(Boolean);
  return names.length > 1 ? names : names[0];
}

/**
 * Build the HTTP app: static UI, JSON API, and a server-sent event stream.
 *
 * One address for everyone. Signed out, the API answers only signing in and
 * the public routes, and the page shows the public view (docs/publishing.md).
 * @param {object} o - Dependencies.
 * @param {import('./manager.js').Manager} o.manager - Radio orchestration.
 * @param {import('./store.js').Store} o.store - Persistence.
 * @param {import('./sidecar.js').Sidecar} o.sidecar - Bluetooth helper.
 * @param {object} o.config - The whole config.
 * @param {string} o.dataDir - Data directory (clips live under it).
 * @param {import('./updates.js').Updates} [o.updates] - Admin → Updates.
 * @param {import('./cleanup.js').Cleanup} [o.cleanup] - Admin → Storage.
 * @param {import('./radioreference.js').RadioReference} [o.radioreference] - Map → Find.
 * @param {import('./accounts.js').Accounts} [o.accounts] - People's accounts and invites.
 * @param {import('./logins.js').Logins} [o.logins] - Signing in with Google, GitHub, Discord or Facebook.
 * @param {import('./findings.js').Findings} [o.findings] - Admin → Findings.
 * @param {import('./uniden.js').Uniden} [o.uniden] - Uniden's database, for the Map's Find.
 * @returns {import('express').Express} The app.
 */
export function createApp({ manager, store, sidecar, config, dataDir, updates, cleanup, radioreference, accounts, logins, findings, uniden }) {
  const app = express();
  const linked = accounts && logins ? logins : null;
  const auth = createAuth(config, {
    accounts, providers: () => linked?.enabled() ?? [], publicUrl: () => store.setting?.('login.publicUrl') ?? '',
  });
  // Behind a reverse proxy: whose X-Forwarded-For and -Proto to believe (docs/publishing.md#one-address)
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '32kb' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(express.static(PUBLIC));

  const publish = { ...PUBLISH_DEFAULTS, ...(config.publish ?? {}) };

  /**
   * The one publishable row, or null.
   *
   * Every public per-clip route goes through this, so the delay cannot be
   * enforced on the listing and forgotten on a download.
   * @param {string|number} id - Transmission id.
   * @returns {object | null} The row, if a visitor may see it.
   */
  const publicRow = (id) => {
    const row = store.transmission(Number(id));
    if (!row) return null;
    return publishable(row, store.radio(row.mac), publish) ? row : null;
  };

  const api = express.Router();
  // Signing in has to be reachable before one is signed in.
  api.post('/login', (req, res) => auth.login(req, res));
  api.post('/logout', (req, res) => auth.logout(req, res));
  api.get('/session', (req, res) => auth.session(req, res));

  // Joining with an invite link: also before signing in, as it's how one
  // gets an account to sign in with. A bad invite counts as a wrong try.
  if (accounts) {
    const invited = (req) => {
      if (auth.tooMany(req)) throw refuse('too many tries from here: wait a few minutes', 429);
      try {
        return accounts.checkInvite(req.params?.token ?? req.body?.invite);
      } catch (e) {
        auth.missed(req);
        throw e;
      }
    };
    api.get('/invite/:token', answer((req) => invited(req)));
    api.post('/register', answer((req, res) => {
      invited(req);
      const user = accounts.register(req.body ?? {});
      auth.startSession(req, res, { userId: user.id, role: user.role });
      return { ok: true, user };
    }));
  }

  // ---- Signing in with Google, GitHub, Discord or Facebook ---------------
  // The provider sends the browser back to /api/auth/<provider>/callback, so
  // this is before signing in too. Where it ends, the page is told by the
  // part of the address after the # (#signin:..., #account:...).
  const STATE_COOKIE = 'airscribe_oauth';     // the sign-in under way
  const WAITING_COOKIE = 'airscribe_link';    // an outside account waiting to be linked
  const flowCookie = (req) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/api/auth', maxAge: 10 * 60 * 1000 });
  const backTo = (res, fragment) => res.redirect(303, fragment ? `/#${fragment}` : '/');
  /** A password asked for again, before linking or unlinking. */
  const checkPassword = (req, id) => {
    if (auth.tooMany(req)) throw refuse('too many tries from here: wait a few minutes', 429);
    if (!accounts.passwordIs(id, req.body?.password)) {
      auth.missed(req);
      throw refuse('that password isn’t right', 403);
    }
  };
  if (linked) {
    api.get('/auth/:provider/start', (req, res) => {
      try {
        const { url, token } = linked.start(String(req.params.provider), req, { purpose: 'signin' });
        res.cookie(STATE_COOKIE, token, flowCookie(req));
        res.redirect(303, url);
      } catch (e) {
        backTo(res, `signin:error=${encodeURIComponent(e.message)}`);
      }
    });
    api.get('/auth/:provider/callback', async (req, res) => {
      const provider = String(req.params.provider);
      const q = (k) => (typeof req.query[k] === 'string' ? req.query[k] : undefined);
      res.clearCookie(STATE_COOKIE, { path: '/api/auth' });
      let done;
      try {
        done = await linked.finish(provider, { code: q('code'), state: q('state'), error: q('error'), cookie: readCookie(req, STATE_COOKIE) });
      } catch (e) {
        return backTo(res, `${e.purpose === 'link' ? 'account' : 'signin'}:error=${encodeURIComponent(e.message)}`);
      }
      if (done.purpose === 'link') {
        try {
          if (!accounts.user(done.userId)) throw refuse('that account is gone', 404);
          accounts.link(done.userId, provider, done.identity);
          return backTo(res, `account:linked=${provider}`);
        } catch (e) {
          return backTo(res, `account:error=${encodeURIComponent(e.message)}`);
        }
      }
      // Signing in: only the account it was linked to, and never by e-mail address
      const user = accounts.linkedUser(provider, done.identity.subject);
      if (!user) {
        res.cookie(WAITING_COOKIE, linked.hold(provider, done.identity), flowCookie(req));
        return backTo(res, 'signin:link');
      }
      if (user.disabled) return backTo(res, `signin:error=${encodeURIComponent('this account is turned off; an admin can turn it back on')}`);
      accounts.touchLink(provider, done.identity.subject);
      backTo(res, auth.firstStepDone(req, res, user).signedIn ? '' : 'signin:two-step');
    });
    // The outside account waiting to be linked, and linking it with a password
    api.get('/auth/waiting', answer((req) => {
      const held = linked.held(readCookie(req, WAITING_COOKIE));
      if (!held) throw refuse('nothing is waiting to be linked: sign in with it again', 404);
      return { provider: held.provider, name: PROVIDERS[held.provider].name, who: { name: held.identity.name, email: held.identity.email } };
    }));
    api.post('/auth/waiting', answer((req, res) => {
      if (auth.tooMany(req)) throw refuse('too many tries from here: wait a few minutes', 429);
      const token = readCookie(req, WAITING_COOKIE);
      const held = linked.held(token);
      if (!held) throw refuse('nothing is waiting to be linked: sign in with it again', 404);
      let user;
      try {
        user = accounts.signIn(req.body?.username, req.body?.password);
      } catch (e) {
        if (e.status === 401) auth.missed(req);
        throw e;
      }
      if (!user) {
        auth.missed(req);
        throw refuse('not accepted', 401);
      }
      accounts.link(user.id, held.provider, held.identity);
      linked.release(token);
      res.clearCookie(WAITING_COOKIE, { path: '/api/auth' });
      accounts.touchLink(held.provider, held.identity.subject);
      if (!auth.firstStepDone(req, res, user).signedIn) {
        return { ok: false, provider: held.provider, twoStep: 'signin', methods: auth.methodsFor(user.id, auth.pageOf(req).rpId) };
      }
      return { ok: true, provider: held.provider };
    }));
  }
  // ---- Two-step at sign-in (docs/two-step.md) ---------------------------
  if (accounts) {
    const t = accounts.twoStep;
    const waitingOne = (req) => {
      const w = auth.waiting(req);
      if (!w) throw refuse('the sign-in waited too long: sign in again', 401);
      return w;
    };
    // What a sign-in waiting for its second step may use, for the page that asks
    api.get('/login/two-step', answer((req) => auth.methodsFor(waitingOne(req).userId, auth.pageOf(req).rpId)));
    api.post('/login/two-step/options', answer((req) => {
      const w = waitingOne(req);
      const { rpId } = auth.pageOf(req);
      const allow = t.allowFor(w.userId, rpId);
      if (!allow.length) throw refuse('this account has no passkey for this address: use a code', 400);
      return requestOptions({ rpId, challenge: t.challenge('signin-step', w.token), allow });
    }));
    api.post('/login/two-step', answer((req, res) => {
      if (auth.tooMany(req)) throw refuse('too many tries from here: wait a few minutes', 429);
      const w = waitingOne(req);
      let left;
      try {
        if (req.body?.credential) {
          t.usePasskey(req.body.credential, { purpose: 'signin-step', owner: w.token, userId: w.userId, ...auth.pageOf(req) });
        } else {
          left = t.useCode(w.userId, req.body?.code).recoveryCodesLeft;
        }
      } catch (e) {
        if (e.status === 403) auth.missed(req);
        throw e;
      }
      const user = auth.secondStepDone(req, res, w, { remember: Boolean(req.body?.remember) });
      return { ok: true, role: user.role, user: { id: user.id, username: user.username, role: user.role }, recoveryCodesLeft: left };
    }));
    // A passkey alone: it names the account, and its fingerprint, face or PIN is the second step
    api.post('/login/passkey/options', answer((req) => {
      const { rpId } = auth.pageOf(req);
      return requestOptions({ rpId, challenge: t.challenge('signin'), userVerification: 'required' });
    }));
    api.post('/login/passkey', answer((req, res) => {
      if (auth.tooMany(req)) throw refuse('too many tries from here: wait a few minutes', 429);
      let userId;
      try {
        userId = t.usePasskey(req.body?.credential, { purpose: 'signin', ...auth.pageOf(req) });
      } catch (e) {
        if (e.status === 403) auth.missed(req);
        throw e;
      }
      const user = accounts.user(userId);
      if (!user || user.disabled) throw refuse('this account is turned off; an admin can turn it back on', 403);
      auth.startSession(req, res, { userId: user.id, role: user.role, stepped: true });
      return { ok: true, role: user.role, user: { id: user.id, username: user.username, role: user.role } };
    }));
  }

  // ---- the public surface -------------------------------------------
  // No credential: this is what the node has chosen to publish. Everything
  // here is filtered by the same predicate, never by the caller's request.

  api.get('/public/filters', (req, res) => {
    if (!publish.enabled) return res.json({ enabled: false, groups: [], radios: [] });
    const radios = store.radios().filter((r) => r.public);
    res.json({
      enabled: true,
      delayMinutes: publish.delayMinutes,
      audio: Boolean(publish.audio),
      groups: [...new Set(radios.map((r) => r.group).filter(Boolean))],
      radios: radios.map((r) => ({ name: r.name, group: r.group ?? null })),
    });
  });

  api.get('/public/transmissions', (req, res) => {
    if (!publish.enabled) return res.json([]);
    const rows = store.transmissions({
      publicOnly: true,
      notAfter: publicCutoff(publish),
      group: req.query.group ? String(req.query.group) : undefined,
      channel: req.query.channel ? String(req.query.channel) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      limit: Math.min(Number(req.query.limit) || 100, 200),
    });
    res.json(rows.map((r) => publicView(r, publish, manager.primary)));
  });

  api.get('/public/transmissions/:id/text', (req, res) => {
    const row = publish.transcripts === false ? null : publicRow(req.params.id);
    const view = row && publicView(row, publish, manager.primary);
    if (!view?.text) return res.status(404).json({ error: 'not found' });
    res.type('text/plain').send(`${view.text}
`);
  });

  api.get('/public/transmissions/:id/audio', (req, res) => {
    // Two gates, not one: clips may be withheld even where transcripts are
    // published, because a clip is somebody's voice.
    const row = publish.audio ? publicRow(req.params.id) : null;
    if (!row) return res.status(404).json({ error: 'not found' });
    sendClip(res, row, dataDir, false);
  });


  // Everything past here needs at least a viewer.
  api.use(auth.requireRole('viewer'));
  // Admin, which changes settings, asks for a check of its own (docs/two-step.md)
  api.use('/admin', auth.settings);

  // ---- Accounts: one's own, and an admin's view of them all -------------
  if (accounts) {
    const admin = auth.requireRole('admin');
    /** The account this request signed in with; the settings file's password and tokens have none. */
    const mine = (req) => {
      if (!req.user) throw refuse('this sign-in isn’t an account’s (the settings file’s password, or a token)', 400);
      return req.user.id;
    };
    // With the providers one may link, for the account page
    api.get('/account', answer((req) => ({ ...accounts.user(mine(req)), providers: linked?.enabled() ?? [] })));
    // One's amateur radio profile: callsign, SSID, symbol, beacon message. No callsign clears it.
    api.put('/account/radio', answer((req) => ({ radio: accounts.setProfile(mine(req), checkProfile(req.body ?? {})) })));
    if (linked) {
      // Linking asks for the password, and goes on at the provider; unlinking asks for it too
      api.post('/account/links/:provider', answer((req, res) => {
        const id = mine(req);
        checkPassword(req, id);
        const { url, token } = linked.start(String(req.params.provider), req, { purpose: 'link', userId: id });
        res.cookie(STATE_COOKIE, token, flowCookie(req));
        return { url };
      }));
      api.delete('/account/links/:provider', answer((req) => {
        const id = mine(req);
        checkPassword(req, id);
        if (!accounts.unlink(id, String(req.params.provider))) throw refuse('nothing from there is linked', 404);
        return { ...accounts.user(id), providers: linked.enabled() };
      }));
    }
    api.put('/account/password', answer((req) => {
      accounts.setPassword(mine(req), req.body?.password, { current: String(req.body?.current ?? ''), keep: auth.sessionId(req) });
      return accounts.user(req.user.id);
    }));
    api.post('/account/sign-out-others', answer((req) => {
      accounts.endSessions(mine(req), auth.sessionId(req));
      return { ok: true };
    }));

    // ---- Your account → Two-step verification --------------------------
    const t = accounts.twoStep;
    const twoStepView = (req) => {
      const st = auth.standing(req);
      const page = auth.pageOf(req);
      return {
        ...t.status(mine(req)), required: st.required, stepped: st.stepped,
        checkedUntil: Number.isFinite(st.checkedUntil) ? st.checkedUntil : null,
        recent: st.recent, passwordConfirmed: st.passwordConfirmed,
        site: page.rpId, secure: page.secure, passkeyHere: t.allowFor(mine(req), page.rpId).length > 0,
      };
    };
    // Changing how one verifies wants a step in the last 10 minutes; setting up the first, the password again
    const mayChange = (req) => {
      const st = auth.standing(req);
      if (st.setUp ? !st.recent : !(st.recent || st.passwordConfirmed)) {
        throw Object.assign(refuse(st.setUp ? 'confirm it’s you first' : 'give your password again first', 403), { twoStep: st.setUp ? 'verify' : 'password' });
      }
    };
    const withTwoStep = (fn) => async (req, res) => {
      try {
        res.json(await fn(req, res));
      } catch (e) {
        res.status(e.status ?? 500).json({ error: e.message, ...(e.twoStep ? { twoStep: e.twoStep } : {}) });
      }
    };
    /** The first way to verify, just set up, passes both checks: it took the password and the new passkey or code. */
    const firstDone = (req, codes) => {
      if (codes) accounts.markSession(auth.sessionId(req), { step: true, admin: true });
    };
    api.get('/two-step', answer((req) => twoStepView(req)));
    api.post('/two-step/password', answer((req) => {
      checkPassword(req, mine(req));
      accounts.markSession(auth.sessionId(req), { password: true });
      return twoStepView(req);
    }));
    api.post('/two-step/passkeys/options', withTwoStep((req) => {
      const id = mine(req);
      mayChange(req);
      const page = auth.pageOf(req);
      if (!page.secure) throw refuse('passkeys need the HTTPS address', 400);
      return creationOptions({
        rpId: page.rpId, rpName: 'AirScribe', userId: Buffer.from(String(id)), name: req.user.username,
        challenge: t.challenge('add', id), exclude: t.passkeyRows(id).map((p) => p.id),
      });
    }));
    api.post('/two-step/passkeys', withTwoStep((req) => {
      const id = mine(req);
      mayChange(req);
      const page = auth.pageOf(req);
      const r = t.addPasskey(id, req.body?.credential, { origins: page.origins, rpId: page.rpId, name: req.body?.name });
      firstDone(req, r.recoveryCodes);
      return r;
    }));
    api.delete('/two-step/passkeys/:id', withTwoStep((req) => {
      mayChange(req);
      if (!t.removePasskey(mine(req), String(req.params.id))) throw refuse('no such passkey', 404);
      return twoStepView(req);
    }));
    api.post('/two-step/authenticator/start', withTwoStep((req) => {
      mayChange(req);
      return t.startAuthenticator(mine(req), req.user.username);
    }));
    api.post('/two-step/authenticator/enable', withTwoStep((req) => {
      mayChange(req);
      const r = t.enableAuthenticator(mine(req), req.body?.code);
      firstDone(req, r.recoveryCodes);
      return r;
    }));
    api.delete('/two-step/authenticator', withTwoStep((req) => {
      mayChange(req);
      if (!t.disableAuthenticator(mine(req))) throw refuse('the authenticator app isn’t on', 404);
      return twoStepView(req);
    }));
    api.post('/two-step/recovery-codes', withTwoStep((req) => {
      mayChange(req);
      if (!t.isSetUp(mine(req))) throw refuse('set up a passkey or an authenticator app first', 409);
      return { recoveryCodes: t.newCodes(mine(req)) };
    }));
    // A check in the session: for controlling radios, or with `admin`, for Admin
    api.post('/two-step/check/options', answer((req) => {
      const id = mine(req);
      const { rpId } = auth.pageOf(req);
      const allow = t.allowFor(id, rpId);
      if (!allow.length) throw refuse('you have no passkey for this address: use a code', 400);
      return requestOptions({ rpId, challenge: t.challenge('check', id), allow });
    }));
    api.post('/two-step/check', answer((req, res) => {
      const id = mine(req);
      if (auth.tooMany(req)) throw refuse('too many tries from here: wait a few minutes', 429);
      let left;
      try {
        if (req.body?.credential) t.usePasskey(req.body.credential, { purpose: 'check', owner: id, userId: id, ...auth.pageOf(req) });
        else left = t.useCode(id, req.body?.code).recoveryCodesLeft;
      } catch (e) {
        if (e.status === 403) auth.missed(req);
        throw e;
      }
      accounts.markSession(auth.sessionId(req), { step: true, admin: Boolean(req.body?.admin) });
      if (req.body?.remember) auth.rememberBrowser(req, res, id);
      return { ...twoStepView(req), recoveryCodesLeft: left };
    }));

    const id = (req) => Number(req.params.id);
    api.get('/admin/users', admin, answer((req) => ({
      users: accounts.users(), invites: accounts.invites(), me: req.user?.id ?? null,
      // Whether the settings file has a password or tokens, which work beside accounts
      fileCredential: auth.configGuarded,
    })));
    api.post('/admin/users', admin, answer((req) => {
      const { username, password, role } = req.body ?? {};
      // A node with no other way in would have its admin locked out by a first account that isn't one
      if (!auth.configGuarded && accounts.admins() === 0 && role !== 'admin') {
        throw refuse('the first account has to be an admin: it’s how you’ll get back in', 400);
      }
      return accounts.create({ username, password, role });
    }));
    api.patch('/admin/users/:id', admin, answer((req) => {
      const { role, username, disabled } = req.body ?? {};
      return accounts.update(id(req), {
        role, username, disabled: disabled === undefined ? undefined : Boolean(disabled),
      });
    }));
    api.put('/admin/users/:id/password', admin, answer((req) => {
      // An admin setting their own keeps the session they set it from
      accounts.setPassword(id(req), req.body?.password, { keep: req.user?.id === id(req) ? auth.sessionId(req) : undefined });
      return accounts.user(id(req));
    }));
    api.post('/admin/users/:id/two-step/reset', admin, answer((req) => {
      if (!accounts.user(id(req))) throw refuse('no such account', 404);
      if (req.user?.id === id(req)) throw refuse('change your own under Your account', 400);
      accounts.twoStep.reset(id(req));
      return accounts.user(id(req));
    }));
    api.post('/admin/users/:id/sign-out', admin, answer((req) => {
      if (!accounts.user(id(req))) throw refuse('no such account', 404);
      accounts.endSessions(id(req), req.user?.id === id(req) ? auth.sessionId(req) : undefined);
      return { ok: true };
    }));
    api.delete('/admin/users/:id', admin, answer((req) => {
      accounts.remove(id(req));
      return { ok: true };
    }));
    api.get('/admin/invites', admin, answer(() => accounts.invites()));
    // The token is in this answer only: the page makes the link from it
    api.post('/admin/invites', admin, answer((req) => accounts.invite({
      ...(req.body ?? {}), by: req.user?.username ?? 'the settings file’s admin',
    })));
    api.delete('/admin/invites/:id', admin, answer((req) => {
      if (!accounts.revokeInvite(id(req))) throw refuse('no unused invite by that number', 404);
      return { ok: true };
    }));
    // Admin → Sign-in providers: each one's OAuth app, and the address to register with it
    if (linked) {
      api.get('/admin/logins', admin, answer((req) => linked.settings(req)));
      api.put('/admin/logins', admin, answer((req) => {
        linked.save(req.body ?? {});
        return linked.settings(req);
      }));
    }
  }

  // ---- everything past here is the operator's -------------------------

  api.get('/models', (req, res) => res.json(MODELS));
  api.get('/radios', (req, res) => res.json(manager.radios()));
  // Channels transmissions came in on, by the name the radio gave them, with
  // their place on the map where one is set
  api.get('/channels', (req, res) => res.json(store.channelsSeen()));

  // Packets the radios' own modems decoded (APRS, or their BSS), and the
  // stations among them with a place: anyone's to see, as the feed is
  api.get('/packets', (req, res) => {
    const n = (v) => (v === undefined ? undefined : Number(v));
    res.json(store.packets({
      limit: n(req.query.limit) || 100, before: n(req.query.before) || undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined, q: req.query.q ? String(req.query.q) : undefined,
      mac: req.query.mac ? normalizeMac(String(req.query.mac)) : undefined,
    }));
  });
  const sinceHours = (req) => {
    const h = req.query.hours === undefined ? 24 : Number(req.query.hours);
    return Number.isFinite(h) && h > 0 ? Date.now() - Math.min(h, 24 * 365) * 3600000 : 0;
  };
  api.get('/stations', (req, res) => res.json(store.stations({
    since: sinceHours(req), mac: req.query.mac ? normalizeMac(String(req.query.mac)) : undefined,
  })));
  api.get('/stations/:who', (req, res) => {
    const who = String(req.params.who);
    const since = sinceHours(req);
    res.json({ who, track: store.stationTrack(who, since), packets: store.packets({ q: who, limit: 50 }).filter((p) => p.who === who) });
  });

  // Placing a channel on the map is an admin's; seeing the map is anyone's
  api.put('/channels/:name/place', auth.requireRole('admin'), (req, res) => {
    const lat = Number(req.body?.lat);
    const lon = Number(req.body?.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'lat must be -90 to 90 and lon -180 to 180' });
    }
    const name = String(req.params.name);
    if (!store.channelsSeen().some((c) => c.name === name)) {
      return res.status(404).json({ error: 'no transmission has come in on that channel' });
    }
    store.setChannelPlace(name, lat, lon);
    res.json(store.channelsSeen().find((c) => c.name === name));
  });
  api.delete('/channels/:name/place', auth.requireRole('admin'), (req, res) => {
    if (!store.clearChannelPlace(String(req.params.name))) return res.status(404).json({ error: 'not on the map' });
    res.status(204).end();
  });

  // A radio's controls: admins only, as everything that changes a radio is.
  // Checked here as well as on the radio's side, so a bad value is a clear
  // 400 rather than a message from the radio link.
  const CONTROLS = {
    volume: (v) => Number.isInteger(v) && v >= 0 && v <= 15,
    squelch: (v) => Number.isInteger(v) && v >= 0 && v <= 9,
    scan: (v) => typeof v === 'boolean',
    dual: (v) => typeof v === 'boolean',
    channel_a: (v) => Number.isInteger(v) && v >= 0 && v <= 255,
    channel_b: (v) => Number.isInteger(v) && v >= 0 && v <= 255,
    region: (v) => Number.isInteger(v) && v >= 0 && v <= 63,
  };
  const radioFor = (req, res) => {
    const mac = normalizeMac(req.params.mac);
    if (!mac || !store.radio(mac)) {
      res.status(404).json({ error: 'unknown radio' });
      return null;
    }
    return mac;
  };
  api.get('/radios/:mac/controls', auth.requireRole('admin'), wrap(async (req, res) => {
    const mac = radioFor(req, res);
    if (mac) res.json(await manager.radioControls(mac));
  }));
  api.post('/radios/:mac/controls', auth.requireRole('admin'), wrap(async (req, res) => {
    const mac = radioFor(req, res);
    if (!mac) return;
    const { action, value } = req.body ?? {};
    if (!Object.hasOwn(CONTROLS, action)) {
      return res.status(400).json({ error: `action is one of ${Object.keys(CONTROLS).join(', ')}` });
    }
    if (!CONTROLS[action](value)) return res.status(400).json({ error: `that isn't a ${action} the radio takes` });
    res.json(await manager.control(mac, action, value));
  }));

  // ---- An SDS150 over Bluetooth: its screen, its keys, its waterfall ------------
  // Admins only, as the radios' controls are. The screen also comes on the event stream as it changes.
  const scannerFor = (req, res) => {
    const mac = radioFor(req, res);
    if (mac && linkOf(store.radio(mac).model) !== 'sds-ble') {
      res.status(400).json({ error: 'only an SDS150 over Bluetooth has a screen and keys here' });
      return null;
    }
    return mac;
  };
  api.get('/radios/:mac/screen', auth.requireRole('admin'), (req, res) => {
    const mac = scannerFor(req, res);
    if (mac) res.json({ screen: manager.scannerScreen(mac) });
  });
  api.post('/radios/:mac/key', auth.requireRole('admin'), wrap(async (req, res) => {
    const mac = scannerFor(req, res);
    if (!mac) return;
    const key = String(req.body?.key ?? '');
    if (!SCANNER_KEYS.has(key)) {
      return res.status(400).json({ error: `key is one of ${[...SCANNER_KEYS].join(' ')}` });
    }
    const holdMs = Math.round(Number(req.body?.hold_ms ?? 100));
    if (!Number.isFinite(holdMs) || holdMs < 50 || holdMs > 3000) {
      return res.status(400).json({ error: 'hold_ms is 50 to 3000' });
    }
    await manager.scannerKey(mac, key, holdMs);
    res.status(202).json({ ok: true });
  }));
  api.post('/radios/:mac/waterfall', auth.requireRole('admin'), wrap(async (req, res) => {
    const mac = scannerFor(req, res);
    if (!mac) return;
    const seconds = Number(req.body?.seconds ?? 15);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) return res.status(400).json({ error: 'seconds is 0 to 60' });
    await manager.scannerWaterfall(mac, seconds);
    res.status(202).json({ ok: true });
  }));

  // ---- A radio's channels: read, written, backed up and put back ----------
  // Admins only. Every write backs up the region first, and so does putting a
  // backup back, so each can be undone. The radio link's errors are 502s.
  const admin = auth.requireRole('admin');
  const fromRadio = (p) => p.catch((e) => {
    throw e.status ? e : refuse(e.message, 502);
  });
  const macOf = (req) => {
    const mac = normalizeMac(req.params.mac);
    if (!mac || !store.radio(mac)) throw refuse('unknown radio', 404);
    return mac;
  };
  const regionOf = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 63) throw refuse('region is a whole number from 0', 400);
    return n;
  };
  const backupOf = (req, mac) => {
    const b = store.channelBackup(Number(req.params.id));
    if (!b || b.mac !== mac) throw refuse('no backup by that number for this radio', 404);
    return b;
  };
  // Every slot of a region, read from the radio and kept
  const backUp = async (mac, region, label) => {
    const read = await fromRadio(manager.readChannels(mac, region));
    return store.addChannelBackup({ mac, region: read.region, regionName: read.name, label, channels: read.channels });
  };
  // With how each channel came through this radio in the last week, by name:
  // how many transmissions, the typical signal reading and quieting, and
  // whether that looks like static or a weak signal (src/quality.js)
  const QUALITY_DAYS = 7;
  api.get('/radios/:mac/channels', admin, answer(async (req) => {
    const mac = macOf(req);
    const read = await fromRadio(manager.readChannels(mac, regionOf(req.query.region)));
    const rows = store.channelQuality({ since: Date.now() - QUALITY_DAYS * 24 * 60 * 60 * 1000, mac });
    return { ...read, qualityDays: QUALITY_DAYS, quality: Object.fromEntries([...rows].map(([name, r]) => [name, judge(r)])) };
  }));
  api.put('/radios/:mac/channels', admin, answer(async (req) => {
    const mac = macOf(req);
    // New channels, emptied slots, and changes to some fields of a channel,
    // which are checked against the region as it's read for the backup
    const items = checkWrite(req.body?.channels);
    const region = regionOf(req.body?.region);
    const label = String(req.body?.label ?? '').trim().slice(0, 100) ||
      `Before writing ${items.length} channel${items.length === 1 ? '' : 's'}`;
    // A channel may come with a place (a station from a listing): it's put on
    // the map under the name the radio kept, unless that name has one already
    const places = new Map();
    for (const c of req.body.channels) {
      const lat = Number(c?.lat);
      const lon = Number(c?.lon);
      if (c?.lat != null && c?.lon != null && Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180) {
        places.set(c.id, { lat, lon });
      }
    }
    // The region read first, so a change to an empty slot is refused (and one
    // that changes nothing left out) before a backup is kept for it
    const read = await fromRadio(manager.readChannels(mac, region));
    const channels = resolveWrite(items, read.channels);
    if (!channels.length) return { region: read.region, name: read.name, results: [], backup: null, placed: 0 };
    const backup = store.addChannelBackup({ mac, region: read.region, regionName: read.name, label, channels: read.channels });
    const wrote = await fromRadio(manager.writeChannels(mac, backup.region, channels));
    let placed = 0;
    for (const r of wrote.results ?? []) {
      const p = places.get(r.id);
      if (r.ok && p && r.channel?.name && store.placeChannelIfUnplaced(r.channel.name, p.lat, p.lon)) placed++;
    }
    return { ...wrote, backup, placed };
  }));
  api.get('/radios/:mac/backups', admin, answer((req) => store.channelBackups(macOf(req))));
  api.post('/radios/:mac/backups', admin, answer((req) => {
    const label = String(req.body?.label ?? '').trim().slice(0, 100) || 'Backed up by hand';
    return backUp(macOf(req), regionOf(req.body?.region), label);
  }));
  api.get('/radios/:mac/backups/:id', admin, answer((req) => backupOf(req, macOf(req))));
  api.post('/radios/:mac/backups/:id/restore', admin, answer(async (req) => {
    const mac = macOf(req);
    const b = backupOf(req, mac);
    const backup = await backUp(mac, b.region, `Before putting back “${b.label}”`);
    const wrote = await fromRadio(manager.writeChannels(mac, b.region, b.channels.map((c) => ({ id: c.id, raw: c.raw }))));
    return { ...wrote, backup };
  }));
  // A radio's beacon: what it sends of itself (APRS, or to the radios like it).
  // `profile: true` fills it in from the signed-in account's amateur radio profile.
  // (Not /beacon: tracker blockers block URLs ending so, and the page's requests with them)
  api.get('/radios/:mac/aprs', admin, answer((req) => fromRadio(manager.radioBeacon(macOf(req)))));
  api.put('/radios/:mac/aprs', admin, answer((req) => {
    const mac = macOf(req);
    const { profile, ...rest } = req.body ?? {};
    let changes = Object.keys(rest).length ? checkBeacon(rest) : {};
    if (profile === true) {
      if (!req.user || !accounts) throw refuse('Only an account has a profile: this sign-in is the settings file’s password, or a token', 400);
      const p = accounts.profile(req.user.id);
      if (!p) throw refuse('Your account has no amateur radio profile yet: add your callsign on your account page', 400);
      changes = { ...changes, callsign: p.callsign, ssid: p.ssid, symbol: p.symbol, beacon: p.beacon, format: 'aprs' };
    }
    if (!Object.keys(changes).length) throw refuse('nothing to change', 400);
    return fromRadio(manager.setRadioBeacon(mac, changes));
  }));
  api.delete('/radios/:mac/backups/:id', admin, answer((req) => {
    const mac = macOf(req);
    backupOf(req, mac);
    store.deleteChannelBackup(Number(req.params.id));
    return { ok: true };
  }));

  // The Map view's base maps, and whether channels can be looked up (Find), and where
  api.get('/map', (req, res) => res.json({
    styles: config.map?.styles ?? [],
    lookup: Boolean(radioreference?.ready() || uniden?.count()),
    rr: Boolean(radioreference?.ready()),
    uniden: Boolean(uniden?.count()),
  }));

  // ---- Find: where a channel is, from Uniden's database and RadioReference ----
  // Admins only, as placing a channel is. quick=1 (Find all) skips RadioReference when Uniden's database is sure.
  if (radioreference || uniden) {
    const admin = auth.requireRole('admin');
    const latestDetails = store.db.prepare(`SELECT details FROM transmissions WHERE channel_name = ? AND details IS NOT NULL
                                              ORDER BY started_at DESC LIMIT 1`);
    // Where the radios are, near enough: the ZIP code's, else the middle of the channels placed
    const home = async () => {
      if (radioreference?.ready()) {
        const z = await radioreference.zipInfo().catch(() => null);
        if (Number.isFinite(z?.lat) && Number.isFinite(z?.lon)) return { lat: z.lat, lon: z.lon };
      }
      const placed = store.channelsSeen().filter((c) => c.lat !== null && c.lon !== null);
      if (!placed.length) return null;
      return { lat: placed.reduce((t, c) => t + c.lat, 0) / placed.length, lon: placed.reduce((t, c) => t + c.lon, 0) / placed.length };
    };
    api.get('/channels/:name/lookup', admin, answer(async (req) => {
      const c = store.channelsSeen().find((x) => x.name === String(req.params.name));
      if (!c) throw refuse('no transmission has come in on that channel', 404);
      const rrReady = Boolean(radioreference?.ready());
      const local = uniden?.count() ? uniden : null;
      if (!rrReady && !local) throw refuse('set up RadioReference, or import Uniden’s database, in Admin first', 400);
      const row = latestDetails.get(c.name);
      let details = null;
      try { details = row?.details ? JSON.parse(row.details) : null; } catch { /* not ours to fix here */ }
      const out = { channel: c.name, mhz: c.hz ? Math.round(c.hz / 10) / 1e5 : null, uniden: null, rr: null, rrError: null };
      if (local) out.uniden = local.candidates({ name: c.name, hz: c.hz, details }, await home());
      if (rrReady && !(req.query.quick === '1' && out.uniden?.confident)) {
        try {
          out.rr = await radioreference.lookup({ name: c.name, hz: c.hz });
        } catch (e) {
          out.rrError = e.message;
        }
      }
      if (!local && !out.rr) throw refuse(out.rrError ?? 'nothing to look it up by', 400);
      return out;
    }));
  }

  // Uniden's database, imported a file at a time from the scanner's SD card (BCDx36HP/HPDB)
  if (uniden) {
    const admin = auth.requireRole('admin');
    api.get('/admin/uniden', admin, answer(() => uniden.stats()));
    api.put('/admin/uniden/files/:name', admin, express.raw({ type: () => true, limit: '32mb' }),
      answer((req) => uniden.importFile(req.params.name, req.body)));
    api.delete('/admin/uniden', admin, answer(() => uniden.clear()));
  }

  // ---- RadioReference: where a channel is -------------------------------
  // Admins only, as placing a channel is: the lookup signs in as the admin's
  // account. The account's password and the app key never come back out.
  if (radioreference) {
    const admin = auth.requireRole('admin');
    api.get('/admin/radioreference', admin, answer(() => radioreference.settings()));
    api.put('/admin/radioreference', admin, answer((req) => radioreference.save(req.body ?? {})));
    api.post('/admin/radioreference/test', admin, answer(async () => ({
      ...await radioreference.test(), settings: radioreference.settings(),
    })));
    // Stations near me: the county's groups nearest first, then one group's frequencies
    api.get('/radioreference/nearby', admin, answer(() => radioreference.nearby()));
    api.get('/radioreference/groups/:scid', admin, answer((req) => {
      const scid = Number(req.params.scid);
      if (!Number.isInteger(scid) || scid <= 0) throw refuse('a group is a number', 400);
      return radioreference.stations(scid);
    }));
  }

  // Findings: what a language model reads in the transcripts (docs/findings.md). Admin only, behind Admin's own
  // check like the rest of /admin, and never on the event stream: it's about people heard on the radio.
  if (findings) {
    const admin = auth.requireRole('admin');
    api.get('/admin/findings', admin, answer(() => findings.settings()));
    api.put('/admin/findings', admin, answer((req) => findings.save(req.body ?? {})));
    api.post('/admin/findings/test', admin, answer((req) => findings.test(req.body?.text)));
    api.post('/admin/findings/backfill', admin, answer((req) => findings.backfill(req.body?.hours)));
    api.post('/admin/findings/forget', admin, answer(() => findings.forget()));
    api.get('/admin/findings/results', admin, answer((req) => findings.results({
      q: req.query.q, hits: req.query.hits === '1', before: req.query.before, limit: req.query.limit,
    })));
    api.get('/admin/findings/watches', admin, answer(() => findings.watches()));
    api.post('/admin/findings/watches', admin, answer((req) => findings.addWatch(req.body ?? {})));
    api.delete('/admin/findings/watches/:id', admin, answer((req) => findings.removeWatch(Number(req.params.id))));
    // The roads it mentioned, for the Map; and the roads themselves, from OpenStreetMap (docs/findings.md#roads)
    api.get('/admin/findings/map', admin, answer((req) => findings.map({ hours: req.query.hours ?? 24, also: req.query.also })));
    if (findings.roads) {
      const roads = findings.roads;
      api.get('/admin/findings/roads', admin, answer(() => roads.stats()));
      api.post('/admin/findings/roads/fetch', admin, answer((req) => roads.fetchOsm({ km: req.body?.km })));
      // The file is the body, read as it arrives: GeoJSONSeq, or a FeatureCollection
      api.put('/admin/findings/roads', admin, answer((req) => {
        if (req.is('application/json')) throw refuse('send the file as the body, as application/octet-stream', 415);
        return roads.importStream(req, String(req.query.name ?? 'a file'));
      }));
      api.delete('/admin/findings/roads', admin, answer(() => roads.clear()));
    }
  }

  // Insights: the commonest words, transmissions per hour and per channel, over
  // the last `days` (0 for everything), for one radio or channel if asked
  api.get('/insights', (req, res) => {
    const days = req.query.days === undefined ? 7 : Number(req.query.days);
    if (!Number.isFinite(days) || days < 0) return res.status(400).json({ error: 'days is a number, 0 for all' });
    res.json(insights(store, {
      since: days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0,
      mac: req.query.mac ? normalizeMac(String(req.query.mac)) : undefined,
      channel: req.query.channel ? String(req.query.channel) : undefined,
    }));
  });

  // Radios the host can see. Each is annotated with a model guess and whether
  // it is already saved, so the UI can offer a one-click add.
  api.get(
    '/scan',
    auth.requireRole('admin'),
    wrap(async (req, res) => {
      const found = await sidecar.call('scan');
      res.json(
        found.map((d) => ({
          ...d,
          mac: normalizeMac(d.mac),
          model: guessModel(d.name),
          saved: !!store.radio(normalizeMac(d.mac)),
        })),
      );
    }),
  );

  api.post('/radios', auth.settings, (req, res) => {
    const model = req.body?.model ?? null;
    // A scanner has no Bluetooth address: it's given an id of the same shape
    const mac = sendsRecordings(model) && !req.body?.mac ? newScannerId() : normalizeMac(req.body?.mac);
    if (!mac) return res.status(400).json({ error: 'mac must be 12 hex digits' });
    if (model && !MODELS.some((m) => m.id === model)) {
      return res.status(400).json({ error: `unknown model ${model}` });
    }
    const name = String(req.body.name || model || mac).slice(0, 60);
    store.saveRadio({ mac, name, model });
    res.status(201).json(store.radio(mac));
  });

  // Renaming, and publishing, which is a deliberate act separate from adding a radio.
  api.patch('/radios/:mac', auth.settings, (req, res) => {
    const mac = normalizeMac(req.params.mac);
    if (!mac || !store.radio(mac)) return res.status(404).json({ error: 'unknown radio' });
    // The name is how a radio is told apart in the feed: two radios scan in
    // with the same one ("UV-PRO"), so a blank name is refused, not stored.
    const name = req.body?.name === undefined ? undefined : String(req.body.name).trim();
    if (name === '') return res.status(400).json({ error: 'a radio needs a name' });
    res.json(store.updateRadio(mac, {
      name,
      public: req.body?.public,
      group: req.body?.group,
    }));
  });

  api.get('/groups', (req, res) => res.json(store.groups()));

  api.delete(
    '/radios/:mac',
    auth.settings,
    wrap(async (req, res) => {
      const mac = normalizeMac(req.params.mac);
      if (!mac) return res.status(400).json({ error: 'bad mac' });
      await manager.disconnect(mac).catch(() => {});
      store.deleteRadio(mac);
      res.status(204).end();
    }),
  );

  for (const action of ['connect', 'disconnect']) {
    api.post(
      `/radios/:mac/${action}`,
      auth.requireRole('admin'),
      wrap(async (req, res) => {
        const mac = normalizeMac(req.params.mac);
        if (!mac || !store.radio(mac)) return res.status(404).json({ error: 'unknown radio' });
        if (sendsRecordings(store.radio(mac).model)) {
          return res.status(400).json({ error: 'a scanner isn\'t connected to: it sends its recordings in (docs/scanners.md)' });
        }
        await manager[action](mac);
        res.status(202).json({ ok: true });
      }),
    );
  }

  // A recording a scanner made (radiocli, docs/scanners.md): the WAV as the body, and what radiocli wrote
  // beside it, as base64 JSON, in X-Radiocli (base64, as a header carries only ASCII)
  api.post('/radios/:mac/recordings', auth.requireRole('admin'),
    express.raw({ type: () => true, limit: '64mb' }),
    answer((req, res) => {
      const mac = normalizeMac(req.params.mac);
      const radio = mac ? store.radio(mac) : null;
      if (!radio) throw refuse('unknown radio', 404);
      if (!sendsRecordings(radio.model)) throw refuse(`${radio.name} isn't a scanner: only a scanner sends recordings`, 400);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw refuse('no recording: send the WAV as the body', 400);
      let sidecar;
      try {
        sidecar = JSON.parse(Buffer.from(String(req.get('x-radiocli') ?? ''), 'base64').toString('utf8'));
      } catch {
        throw refuse('X-Radiocli must be the recording\'s .json, base64-encoded', 400);
      }
      const out = manager.importRecording(mac, req.body, sidecar);
      res.status(out.duplicate ? 200 : 201);
      return out;
    }));

  // A page of the feed. Still a plain array, as it always was; how many match
  // in all, and the cursor for the next (older) page when there is one, ride
  // in headers. `before` is that cursor: <started_at>.<id> of the last row.
  api.get('/transmissions', (req, res) => {
    const mac = req.query.mac ? normalizeMac(String(req.query.mac)) : undefined;
    const q = req.query.q ? String(req.query.q) : undefined;
    // speech=1 leaves out what the feed shows as "(no speech recognised)"
    const speech = req.query.speech === '1';
    const channel = channelQuery(req.query.channel);
    let before;
    if (req.query.before) {
      const m = /^(\d+)\.(\d+)$/.exec(String(req.query.before));
      if (!m) return res.status(400).json({ error: 'before must be <started_at>.<id>' });
      before = { at: Number(m[1]), id: Number(m[2]) };
    }
    const n = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    // One more than asked for says whether there is another page
    const rows = store.transmissions({ mac, q, speech, channel, before, limit: n + 1, max: 501 });
    res.set('X-Total-Count', String(store.countTransmissions({ mac, q, speech, channel })));
    if (rows.length > n) {
      rows.length = n;
      const last = rows[n - 1];
      res.set('X-Next-Before', `${last.started_at}.${last.id}`);
    }
    res.json(rows);
  });

  // What engines exist, and which is the default. The UI labels transcripts
  // with these.
  api.get('/engines', (req, res) =>
    res.json({ engines: [...manager.engines.keys()], primary: manager.primary, extra: manager.extra }),
  );

  // Catch up clips an engine has not managed. The audio outlives a failed
  // transcription, so a backlog from a missing module is recoverable.
  api.post('/transcribe-missing', auth.requireRole('admin'), (req, res) => {
    const engine = req.query.engine ? String(req.query.engine) : undefined;
    try {
      const queued = manager.retranscribe(engine, Number(req.query.limit) || 500);
      res.status(202).json({ queued, engine: engine ?? manager.primary });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  api.post('/transmissions/:id/transcribe', auth.requireRole('admin'), (req, res) => {
    const t = store.transmission(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'unknown transmission' });
    const engineName = req.query.engine ? String(req.query.engine) : manager.primary;
    if (!manager.engines.has(engineName)) {
      return res.status(400).json({ error: `unknown engine ${engineName}` });
    }
    const wav = manager.engineWavFor(t);
    if (!wav) return res.status(409).json({ error: 'the audio for this clip is gone' });
    manager.enqueue({ priority: 1, id: t.id, engineName, wav });
    res.status(202).json({ ok: true, engine: engineName });
  });

  // The whole feed at once. Comparing models over hundreds of clips is the
  // reason to run several, and that is not a per-clip download.
  api.get('/transmissions/export', (req, res) => {
    const mac = req.query.mac ? normalizeMac(String(req.query.mac)) : undefined;
    // Everything the filter matches, not one page of it, within a cap that
    // keeps a CSV of a busy year in memory comfortably
    const rows = store.transmissions({
      mac,
      q: req.query.q && String(req.query.q),
      speech: req.query.speech === '1',
      channel: channelQuery(req.query.channel),
      limit: req.query.limit ?? EXPORT_MAX,
      max: EXPORT_MAX,
    });
    const stamp = new Date().toISOString().slice(0, 10);

    if (req.query.format === 'csv') {
      // A row per transcript rather than per transmission: engines differ
      // between clips, so a column each would be mostly empty.
      const head = ['id', 'started_at', 'iso', 'mac', 'radio', 'channel', 'channel_name',
        'channel_hz', 'duration_ms', 'transmit', 'engine', 'status', 'text'];
      const lines = [head.join(',')];
      for (const t of rows) {
        for (const s of t.transcripts ?? []) {
          lines.push([t.id, t.started_at, new Date(t.started_at).toISOString(), t.mac, t.radio_name,
            t.channel, t.channel_name, t.channel_hz, t.duration_ms, t.transmit,
            s.engine, s.status, s.text].map(csvCell).join(','));
        }
      }
      return res.type('text/csv').attachment(`airscribe-${stamp}.csv`).send(`${lines.join('\n')}\n`);
    }

    if (req.query.format === 'txt') {
      return res
        .type('text/plain')
        .attachment(`airscribe-${stamp}.txt`)
        .send(rows.map((t) => describe(t, t.transcripts ?? [])).join('\n'));
    }

    res.attachment(`airscribe-${stamp}.json`).json(rows);
  });

  api.get('/transmissions/:id/audio', (req, res) => {
    const t = store.transmission(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'not found' });
    sendClip(res, t, dataDir, req.query.download !== undefined, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  api.get('/transmissions/:id/text', (req, res) => {
    const t = store.transmission(Number(req.params.id));
    const scripts = t?.transcripts ?? [];
    if (!t || !scripts.length) return res.status(404).json({ error: 'no transcript' });
    const stem = `${t.mac.replaceAll(':', '')}-${t.started_at}`;
    if (req.query.format === 'json') return res.attachment(`${stem}.json`).json(t);
    // Every engine, not just the default: where they disagree the
    // disagreement is the useful part, and a download that quietly picks one
    // hides it.
    res.type('text/plain').attachment(`${stem}.txt`).send(describe(t, scripts));
  });

  // ---- Admin → Updates ------------------------------------------------
  // Admins only, and never on the public listener (not in PUBLIC_API). The
  // install only names a version; the updater fetches and checks the rest.
  if (updates) {
    api.get('/admin/updates', auth.requireRole('admin'), (req, res) => res.json(updates.report()));
    api.post(
      '/admin/updates/check',
      auth.requireRole('admin'),
      wrap(async (req, res) => {
        await updates.check();
        res.json(updates.report());
      }),
    );
    api.post('/admin/updates/install', auth.requireRole('admin'), (req, res) => {
      const error = updates.request(String(req.body?.version ?? ''));
      if (error) return res.status(400).json({ error });
      res.json(updates.report());
    });
  }

  // ---- Deleting: admins only, and never on the public listener ---------
  // One transmission, from its row in the feed: the row, its transcripts and
  // its audio. Open pages are told to take it away.
  api.delete('/transmissions/:id', auth.requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !store.hasTransmission(id)) return res.status(404).json({ error: 'not found' });
    res.json(manager.deleteTransmissions([id]));
  });

  // Admin → Storage
  if (cleanup) {
    const admin = auth.requireRole('admin');
    const answer = (fn) => (req, res) => {
      try {
        res.json(fn(req.body ?? {}));
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    };
    api.get('/admin/storage', admin, (req, res) => res.json(cleanup.report()));
    api.post('/admin/storage/preview', admin, answer((b) => cleanup.preview(b)));
    api.post('/admin/storage/delete', admin, answer((b) => cleanup.purge(b)));
    api.put('/admin/storage/retention', admin, answer((b) => {
      cleanup.setRetentionDays(b.days);
      return cleanup.report();
    }));
  }

  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (u) => res.write(`data: ${JSON.stringify(u)}\n\n`);
    manager.on('update', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      manager.off('update', send);
    });
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}
