// Signing in with Google, GitHub, Discord or Facebook: linking and unlinking
// them on one's account page, and Admin → Sign-in providers, where each one's
// OAuth app is entered. The sign-in page's buttons are app.js's.
import { PROVIDER_NAMES } from './users.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== ''));
  return e;
};

function withToken(path) {
  let token = '';
  try { token = localStorage.getItem('airscribe.token') ?? ''; } catch { /* storage blocked */ }
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
}

async function api(path, opts = {}) {
  const res = await fetch(withToken(`/api${path}`), {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
  return body;
}

function say(id, text, error = false) {
  $(id).textContent = text;
  $(id).className = error ? 'tx-text error' : 'meta';
}

const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

// ---- Your account: what's linked --------------------------------------------

/** @param {object} account - /api/account: the account, its links, and the providers one may link. */
function renderLinks(account) {
  const on = account.providers ?? [];
  const links = account.links ?? [];
  // A provider turned off still shows a link that's there, so it can be unlinked
  const ids = [...new Set([...on.map((p) => p.id), ...links.map((l) => l.provider)])];
  $('links-panel').hidden = !ids.length;
  $('links').replaceChildren(...ids.map((id) => {
    const name = PROVIDER_NAMES[id] ?? id;
    const link = links.find((l) => l.provider === id);
    const isOn = on.some((p) => p.id === id);
    const about = link
      ? `Linked: ${[link.name, link.email ? `(${link.email})` : ''].filter(Boolean).join(' ') || 'an account'}, since ${when(link.linked_at)}` +
        (isOn ? '' : `. Signing in with ${name} is turned off for now.`)
      : 'Not linked.';
    return el('li', {},
      el('div', { className: 'radio-head' }, el('strong', {}, name),
        link
          ? el('button', { onclick: () => unlink(id, name) }, 'Unlink')
          : el('button', { onclick: () => link_(id) }, `Link a ${name} account`)),
      el('div', { className: 'meta' }, about));
  }));
}

/** Linking goes on at the provider, which sends the browser back to the account page. */
async function link_(id) {
  try {
    const { url } = await api(`/account/links/${id}`, { method: 'POST', body: { password: $('links-pass').value } });
    $('links-pass').value = '';
    location.href = url;
  } catch (e) {
    say('links-status', e.status === 403 ? 'Give your password first: linking one asks for it.' : e.message, true);
  }
}

async function unlink(id, name) {
  if (!confirm(`Unlink your ${name} account? You’ll sign in with your password, or link it again.`)) return;
  try {
    renderLinks(await api(`/account/links/${id}`, { method: 'DELETE', body: { password: $('links-pass').value } }));
    $('links-pass').value = '';
    say('links-status', `${name} is unlinked.`);
  } catch (e) {
    say('links-status', e.status === 403 ? 'Give your password first: unlinking one asks for it.' : e.message, true);
  }
}

document.addEventListener('airscribe:account', (e) => renderLinks(e.detail));
document.addEventListener('airscribe:account-note', (e) => {
  const { key, value } = e.detail;
  if (key === 'linked') say('links-status', `${PROVIDER_NAMES[value] ?? value} is linked: you can sign in with it now.`);
  else if (key === 'error') say('links-status', value, true);
});

// ---- Admin → Sign-in providers --------------------------------------------------

let rows = new Map();   // provider -> its inputs

function renderProviders(s) {
  $('logins-url').value = s.publicUrl ?? '';
  $('logins-url').placeholder = location.origin;
  rows = new Map();
  $('logins').replaceChildren(...s.providers.map((p) => {
    const on = el('input', { type: 'checkbox', checked: p.enabled });
    const id = el('input', { value: p.clientId, placeholder: 'client ID', size: 24, spellcheck: false, autocomplete: 'off' });
    const secret = el('input', { type: 'password', placeholder: p.secret ? 'saved' : 'client secret', size: 18, autocomplete: 'new-password' });
    const redirect = el('input', { value: p.redirect, readOnly: true, className: 'invite-link', onfocus: (e) => e.target.select() });
    rows.set(p.id, { on, id, secret });
    return el('li', { className: p.on ? '' : 'off' },
      el('div', { className: 'radio-head' },
        el('label', { className: 'toggle' }, on, ` Sign in with ${p.name}`),
        el('a', { href: p.console, target: '_blank', rel: 'noopener' }, `${p.name}’s console`)),
      el('div', { className: 'row wrap' }, id, secret),
      el('div', { className: 'row' }, el('span', { className: 'meta' }, 'Redirect URI'), redirect),
      el('div', { className: 'meta' }, `Asks for: ${p.scope}`));
  }));
}

async function loadProviders() {
  try {
    renderProviders(await api('/admin/logins'));
  } catch (e) {
    say('logins-status', e.message, true);
  }
}

$('logins-save').onclick = async () => {
  const providers = {};
  for (const [id, r] of rows) {
    providers[id] = { enabled: r.on.checked, clientId: r.id.value };
    if (r.secret.value) providers[id].secret = r.secret.value;
  }
  try {
    renderProviders(await api('/admin/logins', { method: 'PUT', body: { publicUrl: $('logins-url').value, providers } }));
    say('logins-status', 'Saved. The redirect URIs above are what each provider has to have.');
  } catch (e) {
    say('logins-status', e.message, true);
  }
};

// The address changes every redirect URI: shown as it's typed
$('logins-url').oninput = () => {
  const origin = ($('logins-url').value.trim() || location.origin).replace(/\/+$/, '');
  for (const li of $('logins').children) {
    const input = li.querySelector('.invite-link');
    if (input) input.value = input.value.replace(/^.*(\/api\/auth\/\w+\/callback)$/, `${origin}$1`);
  }
};

document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'admin') loadProviders();
});
