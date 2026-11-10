// Admin: for now, Updates (docs/updating.md). Shown only to an admin; the
// server enforces that regardless.
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
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

const BUSY = new Set(['downloading', 'installing', 'checking', 'rolling_back']);
const STATE_TEXT = {
  downloading: 'Downloading', installing: 'Installing', checking: 'Starting the new version',
  rolling_back: 'Going back', rolled_back: 'Went back', done: 'Updated', failed: 'Failed',
};
let startedOn = null;   // the version this page was loaded from
let polling = null;

function when(iso) {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function render(r) {
  startedOn ??= r.current;
  const busy = r.pending || BUSY.has(r.status?.state);
  const parts = [
    el('p', {}, 'Running AirScribe ', el('strong', {}, r.current), '. ',
      el('a', { href: r.page, target: '_blank', rel: 'noopener' }, 'All releases')),
  ];
  if (r.whyNot) parts.push(el('p', { className: 'meta' }, r.whyNot));
  if (r.error) parts.push(el('p', { className: 'tx-text error' }, r.error));
  if (r.pending && !BUSY.has(r.status?.state)) {
    parts.push(el('p', { className: 'notice' },
      'Waiting for the updater to start. If this stays, see “When it doesn’t work” in docs/updating.md.'));
  }
  if (r.status && (busy || r.status.id)) {
    const s = r.status;
    parts.push(el('div', { className: `notice ${s.state}` },
      el('strong', {}, `${STATE_TEXT[s.state] ?? s.state}: `), s.message ?? '',
      el('div', { className: 'meta' }, `${when(s.updatedUtc)}${s.log ? ` · log: ${s.log}` : ''}`)));
  }

  if (r.releases.length) {
    parts.push(el('ul', {}, ...r.releases.map((rel) => el('li', {},
      el('div', { className: 'radio-head' },
        el('strong', {}, rel.name || rel.version),
        rel.prerelease ? el('span', { className: 'pill' }, 'pre-release') : ''),
      el('div', { className: 'meta' },
        `${when(rel.publishedUtc)} · `, el('a', { href: rel.url, target: '_blank', rel: 'noopener' }, 'release page')),
      rel.notes ? el('div', { className: 'notes' }, rel.notes) : '',
      el('div', { className: 'actions' },
        rel.ready
          ? el('button', {
              disabled: Boolean(r.whyNot) || busy,
              onclick: () => install(rel.version),
            }, `Update to ${rel.version}`)
          : el('span', { className: 'meta' }, `No ${rel.file} with checksums in this release.`))))));
  } else if (!r.error) {
    parts.push(el('p', { className: 'meta' },
      r.checkedUtc ? `No newer release${r.prereleases ? '' : ' (pre-releases aren’t offered)'}.` : 'Not checked yet.'));
  }
  parts.push(el('p', { className: 'meta' }, `Last checked: ${when(r.checkedUtc)}.`));
  $('updates').replaceChildren(...parts);
  watch(busy);
}

async function install(version) {
  if (!confirm(`Update to AirScribe ${version}? AirScribe restarts, so the radios disconnect and reconnect, and ` +
               'anything arriving in the meantime is missed.')) return;
  try {
    render(await api('/admin/updates/install', { method: 'POST', body: { version } }));
  } catch (e) {
    alert(e.message);
  }
}

/** While an update runs, keep asking; the server restarting in the middle is expected. */
function watch(busy) {
  if (busy && !polling) {
    polling = setInterval(async () => {
      try {
        const r = await api('/admin/updates');
        if (startedOn && r.current !== startedOn) {
          $('updates').replaceChildren(el('p', { className: 'notice done' },
            `Now running AirScribe ${r.current}. Reloading…`));
          setTimeout(() => location.reload(), 1500);
          clearInterval(polling);
          return;
        }
        render(r);
      } catch {
        /* restarting: try again */
      }
    }, 3000);
  } else if (!busy && polling) {
    clearInterval(polling);
    polling = null;
  }
}

async function load(check = false) {
  try {
    render(await api(check ? '/admin/updates/check' : '/admin/updates', check ? { method: 'POST' } : {}));
  } catch (e) {
    $('updates').replaceChildren(el('p', { className: 'tx-text error' }, e.message));
  }
}

function show(admin) {
  $('admin').hidden = !admin;
  $('main').hidden = admin;
  $('admin-toggle').textContent = admin ? 'Back to radios' : 'Admin';
  if (admin) load();
}

$('admin-toggle').onclick = () => show($('admin').hidden);
$('updates-check').onclick = async () => {
  $('updates-check').disabled = true;
  await load(true);
  $('updates-check').disabled = false;
};

// Offer Admin once signed in as an admin. app.js signs in; this asks who we are
// until it has, and stops there.
(async function offer() {
  for (let i = 0; i < 600; i++) {
    try {
      const s = await api('/session');
      if (s.role === 'admin') { $('admin-toggle').hidden = false; return; }
      if (s.role) return;   // a viewer: nothing here for them
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
})();
