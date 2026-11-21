// People: one's own Account page, and Admin → Users, where accounts are added,
// changed and removed and invite links are made. The server enforces who may
// do what regardless of what's shown here.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== ''));
  return e;
};

/** The same credential app.js uses: a session cookie, or a stored token. */
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

/** Say something under a form: an error in red. */
function say(id, text, error = false) {
  $(id).textContent = text;
  $(id).className = error ? 'tx-text error' : 'meta';
}

export const PROVIDER_NAMES = { google: 'Google', github: 'GitHub', discord: 'Discord', facebook: 'Facebook' };
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

let me = null;   // the account signed in, or null: the settings file's password, a token, or no sign-in needed

document.addEventListener('airscribe:signed-in', (e) => {
  me = e.detail?.user ?? null;
  $('account-toggle').hidden = !me;
  $('account-toggle').textContent = me?.username ?? '';
});

// ---- Your account ----------------------------------------------------------

async function loadAccount() {
  try {
    me = await api('/account');
    $('account-title').textContent = `${me.username} · ${me.role}`;
    document.dispatchEvent(new CustomEvent('airscribe:account', { detail: me }));
  } catch (e) {
    $('account-title').textContent = e.message;
  }
}

$('pw-save').onclick = async () => {
  if ($('pw-new').value !== $('pw-new2').value) return say('pw-status', 'The two new passwords aren’t the same.', true);
  try {
    await api('/account/password', { method: 'PUT', body: { current: $('pw-current').value, password: $('pw-new').value } });
    for (const id of ['pw-current', 'pw-new', 'pw-new2']) $(id).value = '';
    say('pw-status', 'Changed. Every other browser signed in to this account has been signed out.');
  } catch (e) {
    say('pw-status', e.message, true);
  }
};

$('sign-out-others').onclick = async () => {
  try {
    await api('/account/sign-out-others', { method: 'POST' });
    say('others-status', 'Done: this is the only browser signed in to this account now.');
  } catch (e) {
    say('others-status', e.message, true);
  }
};

// ---- Admin → Users -----------------------------------------------------------

let firstAccount = false;   // no accounts and nothing in the settings file: the first must be an admin

async function loadUsers() {
  try {
    renderUsers(await api('/admin/users'));
  } catch (e) {
    $('users-about').replaceChildren(el('p', { className: 'tx-text error' }, e.message));
  }
}

function renderUsers(r) {
  firstAccount = !r.users.length && !r.fileCredential;
  $('users-about').replaceChildren(r.users.length ? '' : el('p', { className: 'meta' }, r.fileCredential
    ? 'No accounts yet: everyone signs in with the settings file’s password or a token. Add an account or invite ' +
      'someone, so each person signs in as themselves. The settings file’s password keeps working beside them.'
    : 'No accounts yet, and no password in the settings file, so anyone on this machine can use AirScribe without ' +
      'signing in. The first account has to be an admin; once it’s made, everyone signs in.'));
  if (firstAccount) $('user-role').value = 'admin';
  $('users').replaceChildren(...r.users.map((u) => userRow(u, r.me)));
  $('invites').replaceChildren(...r.invites.map(inviteRow));
}

function userRow(u, meId) {
  const self = u.id === meId;
  const role = el('select', { title: 'What this account may do', onchange: () => change(u, { role: role.value }, self) },
    ...['viewer', 'admin'].map((x) => el('option', { value: x, selected: u.role === x }, x)));
  const pass = el('input', { type: 'password', placeholder: 'new password', autocomplete: 'new-password', size: 12 });
  const setBox = el('span', { className: 'inline-form', hidden: true }, pass,
    el('button', { onclick: () => setPassword(u, pass.value) }, 'Set'));
  const facts = [
    u.disabled ? 'turned off' : '',
    u.two_step ? 'two-step on' : (u.role === 'admin' ? 'no two-step yet' : ''),
    `last signed in ${when(u.last_login_at)}`,
    u.links.length ? `signs in with ${u.links.map((l) => PROVIDER_NAMES[l.provider] ?? l.provider).join(', ')} too` : '',
  ].filter(Boolean).join(' · ');
  return el('li', { className: u.disabled ? 'off' : '' },
    el('div', { className: 'radio-head' }, el('strong', {}, self ? `${u.username} (you)` : u.username), role),
    el('div', { className: 'meta' }, facts),
    el('div', { className: 'actions' },
      el('button', { onclick: () => { setBox.hidden = !setBox.hidden; if (!setBox.hidden) pass.focus(); } }, 'Set password'),
      setBox,
      el('button', { title: 'Sign this account out of every browser', onclick: () => signOut(u, self) }, 'Sign out'),
      el('button', { onclick: () => change(u, { disabled: !u.disabled }, self) }, u.disabled ? 'Turn on' : 'Turn off'),
      u.two_step && !self ? el('button', { title: 'For someone who lost their passkeys, authenticator and recovery codes', onclick: () => resetTwoStep(u) }, 'Reset two-step') : '',
      el('button', { className: 'link danger', onclick: () => remove(u, self) }, 'Delete')));
}

async function change(u, what, self) {
  if (self && (what.role === 'viewer' || what.disabled) &&
      !confirm(what.disabled ? 'Turn your own account off? You’ll be signed out.' : 'Stop being an admin? Admin closes for you.')) {
    return loadUsers();
  }
  try {
    await api(`/admin/users/${u.id}`, { method: 'PATCH', body: what });
    if (self && (what.role === 'viewer' || what.disabled)) return location.reload();
    say('users-status', `${u.username}: ${what.role ? `now ${what.role === 'admin' ? 'an admin' : 'a viewer'}` : what.disabled ? 'turned off, and signed out' : 'turned on'}.`);
  } catch (e) {
    say('users-status', e.message, true);
  }
  loadUsers();
}

async function setPassword(u, password) {
  try {
    await api(`/admin/users/${u.id}/password`, { method: 'PUT', body: { password } });
    say('users-status', `${u.username} has a new password, and is signed out everywhere else.`);
    loadUsers();
  } catch (e) {
    say('users-status', e.message, true);
  }
}

async function resetTwoStep(u) {
  if (!confirm(`Reset ${u.username}’s two-step verification? Their passkeys, authenticator app, recovery codes and remembered browsers stop working, and they set it up again.`)) return;
  try {
    await api(`/admin/users/${u.id}/two-step/reset`, { method: 'POST' });
    say('users-status', `${u.username}’s two-step verification is reset.`);
  } catch (e) {
    say('users-status', e.message, true);
  }
  loadUsers();
}

async function signOut(u, self) {
  try {
    await api(`/admin/users/${u.id}/sign-out`, { method: 'POST' });
    say('users-status', self ? 'Your account is signed out everywhere but here.' : `${u.username} is signed out everywhere.`);
  } catch (e) {
    say('users-status', e.message, true);
  }
}

async function remove(u, self) {
  if (!confirm(`Delete the account ${u.username}${self ? ' (yours)' : ''}? Their sign-ins end. Transmissions aren’t affected.`)) return;
  try {
    await api(`/admin/users/${u.id}`, { method: 'DELETE' });
    if (self) return location.reload();
    say('users-status', `${u.username} is deleted.`);
  } catch (e) {
    say('users-status', e.message, true);
  }
  loadUsers();
}

$('user-add').onclick = async () => {
  const username = $('user-name').value.trim();
  try {
    await api('/admin/users', { method: 'POST', body: { username, password: $('user-pass').value, role: $('user-role').value } });
    $('user-name').value = '';
    $('user-pass').value = '';
    // The first account on a node that needed no sign-in: now it does
    if (firstAccount) return location.reload();
    say('users-status', `Added ${username}. They can sign in now.`);
    loadUsers();
  } catch (e) {
    say('users-status', e.message, true);
  }
};

function inviteRow(i) {
  const state = i.used_at
    ? `used by ${i.used_by ?? 'an account since deleted'}, ${when(i.used_at)}`
    : i.expires_at < Date.now() ? `ran out ${when(i.expires_at)}` : `works until ${when(i.expires_at)}`;
  return el('li', { className: i.used_at || i.expires_at < Date.now() ? 'off' : '' },
    el('div', { className: 'radio-head' },
      el('strong', {}, `Invite for a${i.role === 'admin' ? 'n admin' : ' viewer'}`),
      i.note ? el('span', { className: 'meta' }, i.note) : ''),
    el('div', { className: 'meta' }, `${state} · made by ${i.created_by ?? 'an admin'}, ${when(i.created_at)}`),
    i.used_at ? '' : el('div', { className: 'actions' },
      el('button', { className: 'link danger', onclick: () => revoke(i) }, 'Take back')));
}

async function revoke(i) {
  try {
    await api(`/admin/invites/${i.id}`, { method: 'DELETE' });
    say('users-status', 'Taken back: the link no longer works.');
  } catch (e) {
    say('users-status', e.message, true);
  }
  loadUsers();
}

$('invite-make').onclick = async () => {
  const role = $('invite-role').value;
  const note = $('invite-note').value.trim();
  try {
    const r = await api('/admin/invites', { method: 'POST', body: { role, days: Number($('invite-days').value), note } });
    const link = `${location.origin}${location.pathname}#invite=${r.token}`;
    const box = el('input', { value: link, readOnly: true, className: 'invite-link', onfocus: (e) => e.target.select() });
    const copied = el('span', { className: 'meta' });
    $('invite-made').replaceChildren(el('div', { className: 'notice done' },
      el('div', {}, `Send this link to ${note || 'them'}. It makes one ${role} account, works until ${when(r.invite.expires_at)}, `,
        'and can’t be shown again.'),
      el('div', { className: 'row' }, box,
        el('button', {
          onclick: async () => {
            // The clipboard needs a secure page; on a plain http address, the selection is copied instead
            try {
              await navigator.clipboard.writeText(link);
            } catch {
              box.select();
              document.execCommand('copy');
            }
            copied.textContent = 'Copied.';
          },
        }, 'Copy'), copied)));
    $('invite-note').value = '';
    loadUsers();
  } catch (e) {
    $('invite-made').replaceChildren(el('p', { className: 'tx-text error' }, e.message));
  }
};

document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'account') loadAccount();
  if (e.detail === 'admin') loadUsers();
});
