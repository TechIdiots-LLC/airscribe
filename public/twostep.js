// Two-step verification in the browser (docs/two-step.md): the second step of
// signing in, signing in on a passkey alone, the check that controlling radios
// and Admin ask for, and Your account → Two-step verification. As MediaRiffle's.
import { showView } from './views.js';

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false && k !== ''));
  return e;
};
const $ = (id) => document.getElementById(id);

const realFetch = window.fetch.bind(window);

async function api(path, opts = {}) {
  const res = await realFetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status, twoStep: body.twoStep });
  return body;
}

// ---- Passkeys in the browser -------------------------------------------------

/** Passkeys need a secure page (HTTPS, or localhost) and a browser with WebAuthn. */
export const passkeysSupported = () => Boolean(window.PublicKeyCredential) && window.isSecureContext;

const fromB64url = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0)).buffer;
};
const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The server sends WebAuthn's JSON form; browsers without parse…FromJSON get the byte fields made by hand
function creationOptions(json) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  return {
    ...json, challenge: fromB64url(json.challenge), user: { ...json.user, id: fromB64url(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({ ...c, id: fromB64url(c.id) })),
  };
}
function requestOptions(json) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  return { ...json, challenge: fromB64url(json.challenge), allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: fromB64url(c.id) })) };
}
function credentialJson(c) {
  if (typeof c.toJSON === 'function') return c.toJSON();
  const r = c.response;
  const response = r.attestationObject
    ? { clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject), transports: r.getTransports?.() ?? [] }
    : {
      clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature), userHandle: r.userHandle ? toB64url(r.userHandle) : null,
    };
  return { id: c.id, rawId: toB64url(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults?.() ?? {} };
}
/** Closing the browser's passkey sheet isn't an error worth shouting about. */
const cancelled = (e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError';
const passkeyError = (e) => (cancelled(e) ? 'The passkey was cancelled; try again.' : e.message);

async function getPasskey(optionsPath) {
  const options = await api(optionsPath, { method: 'POST' });
  return credentialJson(await navigator.credentials.get({ publicKey: requestOptions(options) }));
}

/** A name for a new passkey, from the device it's made on. */
function deviceName() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : /Macintosh/.test(ua) ? (navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac')
      : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  return device ? `${device} passkey` : 'Passkey';
}

// ---- A passkey or a code -------------------------------------------------------

/**
 * A passkey button and a code box, and for a sign-in, "remember this browser".
 * @param {{passkey: boolean, authenticator: boolean}} m - What the account has.
 * @param {(how: {credential?: object, code?: string, remember: boolean}) => Promise<void>} submit - Checks it; throws to say why not.
 * @param {{remember?: boolean, optionsPath: string}} o - Whether to offer remembering, and where the passkey's question comes from.
 * @returns {HTMLElement} The box.
 */
function verifyBox(m, submit, { remember = false, optionsPath }) {
  const msg = el('p', { className: 'error' });
  const keep = el('input', { type: 'checkbox', checked: true });
  const usePasskey = m.passkey && passkeysSupported();
  const code = el('input', {
    inputMode: 'text', autocomplete: 'one-time-code', size: 14, required: true,
    placeholder: m.authenticator ? '123456' : 'Recovery code', spellcheck: false,
  });
  const run = async (how) => {
    msg.textContent = '';
    try {
      await submit({ ...how, remember: remember && keep.checked });
    } catch (e) {
      msg.textContent = passkeyError(e);
    }
  };
  const passkeyBtn = usePasskey ? el('button', {
    type: 'button',
    onclick: async () => {
      try { await run({ credential: await getPasskey(optionsPath) }); } catch (e) { msg.textContent = passkeyError(e); }
    },
  }, 'Use a passkey') : null;
  const box = el('div', { className: 'twostep-verify' },
    passkeyBtn,
    el('p', { className: 'meta' }, m.authenticator
      ? (usePasskey ? 'Or the 6-digit code from your authenticator app, or a recovery code:' : 'The 6-digit code from your authenticator app, or a recovery code:')
      : (usePasskey ? 'Lost the passkey? A recovery code:' : m.passkey ? 'Your passkey works on the HTTPS address. Here, a recovery code:' : 'A recovery code:')),
    el('form', { className: 'row', onsubmit: (e) => { e.preventDefault(); run({ code: code.value }); } },
      code, el('button', { type: 'submit' }, 'Verify')),
    remember ? el('label', { className: 'row' }, keep, 'Remember this browser for 30 days') : null,
    msg);
  // Safari opens the passkey sheet only from a click, so it waits for one
  setTimeout(() => (passkeyBtn ?? code).focus(), 0);
  return box;
}

// ---- Signing in -------------------------------------------------------------------

/**
 * The sign-in's second step, over the page until it's done.
 * @param {{passkey: boolean, authenticator: boolean}} [methods] - What the account has; asked for when not given.
 * @param {() => void} onDone - Signed in.
 * @param {() => void} onBack - Start again.
 * @returns {Promise<void>} Once it's shown.
 */
export async function showSecondStep(methods, onDone, onBack) {
  const card = $('login-step-card');
  $('login-step').hidden = false;
  card.replaceChildren(el('h1', {}, 'AirScribe'), el('h2', {}, 'Confirm it’s you'), el('p', { className: 'meta' }, 'Checking…'));
  let m = methods;
  try {
    m ??= await api('/login/two-step');
  } catch (e) {
    card.replaceChildren(el('h1', {}, 'AirScribe'), el('p', { className: 'error' }, e.message),
      el('button', { type: 'button', onclick: () => { $('login-step').hidden = true; onBack(); } }, 'Sign in again'));
    return;
  }
  card.replaceChildren(
    el('h1', {}, 'AirScribe'),
    el('h2', {}, 'Confirm it’s you'),
    el('p', { className: 'meta' }, 'Your account has two-step verification: your passkey, or a code.'),
    verifyBox(m, async (how) => {
      const r = await api('/login/two-step', { body: how });
      if (r.recoveryCodesLeft !== undefined && r.recoveryCodesLeft !== null) {
        alert(`Recovery code used: ${r.recoveryCodesLeft} left. Make new ones under Your account if that’s running low.`);
      }
      $('login-step').hidden = true;
      onDone();
    }, { remember: true, optionsPath: '/login/two-step/options' }),
    el('button', { type: 'button', className: 'link', onclick: () => { $('login-step').hidden = true; onBack(); } }, 'Back'));
}

/** Sign in on a passkey alone. @returns {Promise<void>} Once signed in; throws to say why not. */
export async function passkeySignIn() {
  const credential = await getPasskey('/login/passkey/options');
  await api('/login/passkey', { body: { credential } });
}

// ---- The check that controlling radios and Admin ask for --------------------------

let dlg = null;
let asking = null;   // one question at a time, however many requests wanted it

function dialog() {
  if (!dlg) {
    dlg = el('dialog', { id: 'twostep-dlg', className: 'twostep-dlg' });
    document.body.append(dlg);
  }
  return dlg;
}

/**
 * Ask for a passkey or code in a dialog, or say where to set them up.
 * @param {'step'|'verify'|'setup'} kind - What the server asked for: a step for radios, Admin's check, or setting up.
 * @returns {Promise<boolean>} Whether it was passed.
 */
export function askCheck(kind) {
  asking ??= (async () => {
    const d = dialog();
    const admin = kind === 'verify';
    const done = new Promise((resolve) => {
      const close = (ok) => { d.close(); resolve(ok); };
      d.onclose = () => resolve(false);
      const cancel = el('button', { type: 'button', className: 'link', onclick: () => close(false) }, 'Not now');
      if (kind === 'setup') {
        d.replaceChildren(el('h3', {}, 'Two-step verification needed'),
          el('p', {}, 'Controlling the radios and opening Admin need a second step besides your password: a passkey, ' +
            'or a code from an authenticator app. It takes a minute to set up, once.'),
          el('div', { className: 'row' },
            el('button', { type: 'button', onclick: () => { close(false); showView('account'); setTimeout(() => $('twostep-panel')?.scrollIntoView(), 0); } }, 'Set it up'),
            cancel));
        return;
      }
      d.replaceChildren(el('h3', {}, 'Confirm it’s you'), el('p', { className: 'meta' }, 'Checking…'), cancel);
      api('/two-step').then((s) => {
        d.replaceChildren(
          el('h3', {}, admin ? 'Confirm it’s you to open Admin' : 'Confirm it’s you'),
          el('p', { className: 'meta' }, admin
            ? 'Admin changes settings, so it asks for your passkey or code again every 12 hours.'
            : 'Controlling the radios needs your passkey or code once each time you sign in.'),
          verifyBox({ passkey: s.passkeyHere, authenticator: s.authenticator }, async (how) => {
            const r = await api('/two-step/check', { body: { ...how, admin } });
            if (r.recoveryCodesLeft !== undefined && r.recoveryCodesLeft !== null) {
              alert(`Recovery code used: ${r.recoveryCodesLeft} left. Make new ones under Your account if that’s running low.`);
            }
            close(true);
          }, { remember: !admin, optionsPath: '/two-step/check/options' }),
          cancel);
      }, (e) => d.replaceChildren(el('p', { className: 'error' }, e.message), cancel));
    });
    if (!d.open) d.showModal();
    const ok = await done;
    // Admin's pages wanted it, and it wasn't given: back to the feed rather than a page of refusals
    if (!ok && admin) showView('main');
    document.dispatchEvent(new CustomEvent('airscribe:two-step', { detail: { ok, kind } }));
    return ok;
  })().finally(() => { asking = null; });
  return asking;
}

// Any request the server answers with "confirm it's you" is asked about, then tried again once
window.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  if (res.status !== 403) return res;
  const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
  if (!path.startsWith('/api/') || path.startsWith('/api/two-step')) return res;
  const body = await res.clone().json().catch(() => null);
  if (!['step', 'verify', 'setup'].includes(body?.twoStep)) return res;
  return (await askCheck(body.twoStep)) ? realFetch(input, init) : res;
};

// ---- Setting it up ------------------------------------------------------------------

/**
 * The guided setup: the password again, a passkey or an authenticator app,
 * then the recovery codes to keep.
 */
function setupWizard(box, s, onDone, { authenticatorOnly = false } = {}) {
  const step = (...kids) => box.replaceChildren(el('div', { className: 'twostep-setup' }, ...kids));

  const password = () => {
    const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true, size: 16 });
    const msg = el('p', { className: 'error' });
    step(el('h4', {}, 'Step 1 of 3 · Your password'),
      el('form', {
        className: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          try { await api('/two-step/password', { body: { password: pass.value } }); choose(); } catch (err) { msg.textContent = err.message; }
        },
      }, pass, el('button', { type: 'submit' }, 'Continue')),
      msg);
    pass.focus();
  };

  const choose = () => {
    const name = el('input', { value: deviceName(), maxLength: 60, size: 20 });
    const msg = el('p', { className: 'error' });
    const ok = passkeysSupported();
    step(el('h4', {}, 'Step 2 of 3 · How to verify'),
      el('div', { className: 'twostep-choices' },
        el('div', { className: 'panel' },
          el('h4', {}, 'A passkey', el('span', { className: 'meta' }, ' · recommended')),
          el('p', { className: 'meta' }, 'Face ID or Touch ID, Windows Hello, an Android phone, or a security key. Nothing to ' +
            'type, and nothing that can be phished. It also signs you in on its own, with no password.'),
          ok ? el('div', { className: 'row wrap' }, el('label', {}, 'Name ', name), el('button', {
            onclick: async () => {
              msg.textContent = '';
              try { codes((await addPasskey(name.value)).recoveryCodes); } catch (e) { msg.textContent = passkeyError(e); }
            },
          }, 'Make a passkey'))
            : el('p', {}, 'Not here: passkeys need the HTTPS address and a recent browser. An authenticator app works on any address.')),
        el('div', { className: 'panel' },
          el('h4', {}, 'An authenticator app'),
          el('p', { className: 'meta' }, '6-digit codes from Apple’s Passwords app, Google Authenticator, Microsoft Authenticator, ' +
            '1Password, Bitwarden… They work on every address AirScribe has.'),
          el('button', { onclick: authenticator }, 'Set up an authenticator app'))),
      el('p', { className: 'meta' }, 'You can add the other one too, afterwards.'),
      msg);
  };

  const authenticator = async () => {
    let a;
    try { a = await api('/two-step/authenticator/start', { method: 'POST' }); } catch (e) { box.replaceChildren(el('p', { className: 'error' }, e.message)); return; }
    const code = el('input', { inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', size: 10, required: true });
    const msg = el('p', { className: 'error' });
    const qr = el('div', { className: 'twostep-qr' });
    step(el('h4', {}, `Step ${authenticatorOnly ? '1 of 1' : '2 of 3'} · Add AirScribe to your authenticator app`),
      el('div', { className: 'row wrap twostep-totp' }, qr,
        el('div', {},
          el('p', {}, 'Scan the QR code with your authenticator app or your phone’s camera.'),
          el('p', { className: 'meta' }, 'On this device already? ', el('a', { href: a.uri }, 'Open it in the authenticator app'), '.'),
          el('p', { className: 'meta' }, 'Or type this key in: ', el('code', { className: 'twostep-key' }, a.key)),
          el('form', {
            className: 'row',
            onsubmit: async (e) => {
              e.preventDefault();
              msg.textContent = '';
              try { codes((await api('/two-step/authenticator/enable', { body: { code: code.value } })).recoveryCodes); } catch (err) { msg.textContent = err.message; }
            },
          }, el('label', {}, 'Then the code it shows ', code), el('button', { type: 'submit' }, 'Verify')),
          msg)));
    drawQr(qr, a.uri);
    code.focus();
  };

  // Recovery codes come with the first way to verify; adding another doesn't make new ones
  const codes = (list) => {
    if (!list?.length) { onDone(); return; }
    step(el('h4', {}, 'Step 3 of 3 · Keep your recovery codes'), ...recoveryCodes(list, onDone));
  };

  if (authenticatorOnly) authenticator();
  else if (s.recent || s.passwordConfirmed) choose();
  else password();
}

async function addPasskey(name) {
  const options = await api('/two-step/passkeys/options', { method: 'POST' });
  const credential = credentialJson(await navigator.credentials.create({ publicKey: creationOptions(options) }));
  return api('/two-step/passkeys', { body: { credential, name } });
}

/** The QR code for an otpauth link, drawn here: the secret never leaves the page for an image service. */
async function drawQr(box, uri) {
  try {
    const { default: qrcode } = await import('./vendor/qrcode-generator/qrcode.mjs');
    const q = qrcode(0, 'M');
    q.addData(uri);
    q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  } catch {
    box.replaceChildren(el('p', { className: 'meta' }, 'The QR code couldn’t be drawn: type the key in instead.'));
  }
}

/** The recovery codes, to copy or download, and a Continue that waits until they're kept. */
function recoveryCodes(list, onDone, doneLabel = 'Continue') {
  const text = `AirScribe recovery codes (${location.host}). Each works once:\n\n${list.join('\n')}\n`;
  const saved = el('input', { type: 'checkbox' });
  const go = el('button', { disabled: true, onclick: onDone }, doneLabel);
  saved.onchange = () => { go.disabled = !saved.checked; };
  return [
    el('p', {}, 'If you lose your passkey or phone, each of these lets you in once. Keep them somewhere safe, such as a ' +
      'password manager. They won’t be shown again.'),
    el('ul', { className: 'twostep-codes' }, ...list.map((c) => el('li', {}, el('code', {}, c)))),
    el('div', { className: 'row' },
      el('button', {
        onclick: async (e) => {
          try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { alert(text); }
        },
      }, 'Copy'),
      el('button', {
        onclick: () => {
          const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'airscribe-recovery-codes.txt' });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
      }, 'Download')),
    el('label', { className: 'row' }, saved, 'I’ve kept these somewhere safe'),
    go,
  ];
}

// ---- Your account → Two-step verification -----------------------------------------------

const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'never');

/** Draw the panel. @returns {Promise<void>} Once drawn. */
export async function twoStepPanel() {
  const box = $('twostep-body');
  if (!box) return;
  let s;
  try { s = await api('/two-step'); } catch (e) { box.replaceChildren(el('p', { className: 'error' }, e.message)); return; }
  const redraw = () => twoStepPanel();
  const msg = el('p', { className: 'error' });

  // Changing things wants a step in the last 10 minutes: asked for, then done
  const withCheck = (fn) => async () => {
    msg.textContent = '';
    try {
      await fn();
    } catch (e) {
      if (e.twoStep === 'verify' && await askCheck('step')) {
        try { await fn(); } catch (err) { if (!cancelled(err)) msg.textContent = err.message; }
      } else if (!cancelled(e)) msg.textContent = e.message;
    }
  };

  if (!s.setUp) {
    box.replaceChildren(
      el('p', { className: 'meta' }, 'Not set up. A passkey or an authenticator app adds a second step besides your password' +
        (s.required ? '. Admins need it to control the radios and open Admin.' : '.')),
      el('button', { onclick: () => setupWizard(box, s, redraw) }, 'Set up two-step verification'));
    return;
  }

  const name = el('input', { value: deviceName(), maxLength: 60, size: 18 });
  box.replaceChildren(
    el('h4', {}, 'Passkeys'),
    s.passkeys.length
      ? el('ul', { className: 'user-list' }, ...s.passkeys.map((p) => el('li', {},
        el('div', { className: 'radio-head' }, el('strong', {}, p.name), el('button', {
          onclick: withCheck(async () => {
            if (!confirm(`Remove the passkey “${p.name}”?`)) return;
            await api(`/two-step/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
            redraw();
          }),
        }, 'Remove')),
        el('div', { className: 'meta' }, [p.synced ? 'synced' : '', `for ${p.site}`, `added ${when(p.created_at)}`, `last used ${when(p.used_at)}`]
          .filter(Boolean).join(' · ')))))
      : el('p', { className: 'meta' }, 'None.'),
    passkeysSupported()
      ? el('div', { className: 'row wrap' }, name, el('button', {
        onclick: withCheck(async () => {
          try { await addPasskey(name.value); redraw(); } catch (e) { if (cancelled(e)) msg.textContent = 'The passkey was cancelled.'; else throw e; }
        }),
      }, 'Add a passkey'))
      : el('p', { className: 'meta' }, 'Passkeys can be added from the HTTPS address.'),

    el('h4', {}, 'Authenticator app'),
    s.authenticator
      ? el('div', { className: 'row' }, el('span', {}, 'On'), el('button', {
        onclick: withCheck(async () => {
          if (!confirm('Turn off the authenticator app? Its codes stop working here.')) return;
          await api('/two-step/authenticator', { method: 'DELETE' });
          redraw();
        }),
      }, 'Turn off'))
      : el('div', { className: 'row' }, el('span', { className: 'meta' }, 'Off'), el('button', {
        onclick: withCheck(async () => {
          // Asked first, so the check isn't wanted halfway through
          if (!(await api('/two-step')).recent) throw Object.assign(new Error('confirm it’s you first'), { twoStep: 'verify' });
          setupWizard(box, s, redraw, { authenticatorOnly: true });
        }),
      }, 'Set up')),

    el('h4', {}, 'Recovery codes'),
    el('div', { className: 'row' },
      el('span', { className: s.recoveryCodesLeft < 3 ? 'error' : 'meta' }, `${s.recoveryCodesLeft} left`),
      el('button', {
        onclick: withCheck(async () => {
          const r = await api('/two-step/recovery-codes', { method: 'POST' });
          box.replaceChildren(el('h4', {}, 'New recovery codes'), ...recoveryCodes(r.recoveryCodes, redraw, 'Done'));
        }),
      }, 'Make new codes')),
    msg);
}

document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'account') twoStepPanel();
});
