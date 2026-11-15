// Admin: Updates (docs/updating.md) and Storage. Shown only to an admin; the
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

// ---- Storage ---------------------------------------------------------------

/**
 * @param {number} n - Bytes.
 * @returns {string} The size, readably.
 */
function size(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} bytes`;
}
const day = (ms) => new Date(ms).toLocaleDateString();
const plural = (n, one) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

function renderStorage(r) {
  $('storage-summary').replaceChildren(el('p', {},
    r.count ? `${plural(r.count, 'transmission')}, ${day(r.oldest)} to ${day(r.newest)}. ` : 'No transmissions yet. ',
    `Audio ${size(r.clipBytes)}, database ${size(r.databaseBytes)}.`));
  $('keep-days').value = r.retentionDays ?? '';
  const last = r.lastSweep;
  $('keep-status').textContent = r.retentionDays
    ? `Transmissions older than ${plural(r.retentionDays, 'day')} are deleted every hour.` +
      (last ? ` Last run ${new Date(last.at).toLocaleString()}: ${plural(last.deleted, 'transmission')} deleted (${size(last.bytes)}).` : '')
    : 'Off: transmissions are kept until they’re deleted here.';
}

async function loadStorage() {
  try {
    renderStorage(await api('/admin/storage'));
  } catch (e) {
    $('storage-summary').replaceChildren(el('p', { className: 'tx-text error' }, e.message));
  }
}

/** @returns {{olderThanDays: string|null, noSpeech: boolean}} What the delete form asks for. */
const purgeAsk = () => ({ olderThanDays: $('purge-days').value.trim() || null, noSpeech: $('purge-silent').checked });

// Deleting is shown before it's done: Preview says what would go, and only
// its own button, for exactly that, deletes. Changing the form takes it away.
$('purge-preview').onclick = async () => {
  const ask = purgeAsk();
  try {
    const p = await api('/admin/storage/preview', { method: 'POST', body: ask });
    if (!p.count) return $('purge-result').replaceChildren(el('p', { className: 'meta' }, 'Nothing matches.'));
    $('purge-result').replaceChildren(el('div', { className: 'notice' },
      `This deletes ${plural(p.count, 'transmission')} with their transcripts and ${size(p.bytes)} of audio, `,
      `from ${day(p.oldest)} to ${day(p.newest)}. `,
      el('button', { className: 'danger', onclick: () => purge(ask, p.count) }, `Delete ${p.count.toLocaleString()}`)));
  } catch (e) {
    $('purge-result').replaceChildren(el('p', { className: 'tx-text error' }, e.message));
  }
};
for (const id of ['purge-days', 'purge-silent']) $(id).oninput = () => $('purge-result').replaceChildren();

async function purge(ask, count) {
  if (!confirm(`Delete ${plural(count, 'transmission')}, with their transcripts and audio? This can’t be undone.`)) return;
  try {
    const r = await api('/admin/storage/delete', { method: 'POST', body: ask });
    $('purge-result').replaceChildren(el('p', { className: 'notice done' },
      `Deleted ${plural(r.deleted, 'transmission')}; ${size(r.bytes)} of audio freed.`));
    loadStorage();
  } catch (e) {
    $('purge-result').replaceChildren(el('p', { className: 'tx-text error' }, e.message));
  }
}

$('keep-save').onclick = async () => {
  try {
    renderStorage(await api('/admin/storage/retention', {
      method: 'PUT', body: { days: $('keep-days').value.trim() || null },
    }));
  } catch (e) {
    alert(e.message);
  }
};

// ---- RadioReference: the account the Map's Find signs in with ------------------

/** @param {object} s - What the server says is saved: never the password or the key. */
function renderRR(s) {
  $('rr-username').value = s.username ?? '';
  $('rr-zip').value = s.zip ?? '';
  // Never sent back, so left blank they stay as saved
  $('rr-password').value = '';
  $('rr-password').placeholder = s.password ? 'saved' : '';
  $('rr-appkey').value = '';
  $('rr-appkey').placeholder = s.appKey === 'saved' ? 'saved' : s.appKey === 'settings file' ? 'in the settings file' : '';
  $('rr-forget').hidden = !(s.username || s.password || s.appKey === 'saved' || s.zip);
  // The Map offers Find once it can work
  document.dispatchEvent(new CustomEvent('airscribe:lookup', { detail: { ready: s.ready } }));
}

function rrSay(text, error = false) {
  $('rr-status').textContent = text;
  $('rr-status').className = error ? 'tx-text error' : 'meta';
}

/** @param {object} r - A test's answer. @returns {string} Said plainly. */
function rrTested(r) {
  const zip = r.zip ? ` ZIP code ${r.zip.zip} is ${r.zip.city || 'known'}; Find searches its county first.` : '';
  return `Signed in as ${r.username}, Premium${r.expires ? ` until ${r.expires}` : ''}.${zip}`;
}

async function loadRR() {
  try {
    const s = await api('/admin/radioreference');
    renderRR(s);
    rrSay(s.ready ? 'Set up: the Map’s Channels can be looked up with Find.' : '');
  } catch (e) {
    rrSay(e.message, true);
  }
}

$('rr-save').onclick = async () => {
  try {
    const s = await api('/admin/radioreference', {
      method: 'PUT',
      body: {
        username: $('rr-username').value, password: $('rr-password').value,
        appKey: $('rr-appkey').value, zip: $('rr-zip').value,
      },
    });
    renderRR(s);
    if (!s.username || !s.password || !s.appKey) return rrSay('Saved. Find needs a username, password and app key.');
    if (!s.zip) return rrSay('Saved. Find needs a ZIP code to know where to search.');
    rrSay('Saved. Signing in…');
    rrSay(rrTested(await api('/admin/radioreference/test', { method: 'POST' })));
  } catch (e) {
    rrSay(e.message, true);
  }
};

$('rr-test').onclick = async () => {
  rrSay('Signing in…');
  try {
    rrSay(rrTested(await api('/admin/radioreference/test', { method: 'POST' })));
  } catch (e) {
    rrSay(e.message, true);
  }
};

$('rr-forget').onclick = async () => {
  if (!confirm('Forget the RadioReference username, password, app key and ZIP code?')) return;
  try {
    renderRR(await api('/admin/radioreference', { method: 'PUT', body: { forget: true } }));
    rrSay('Forgotten.');
  } catch (e) {
    rrSay(e.message, true);
  }
};

// Loaded when Admin is opened (views.js switches the page)
document.addEventListener('airscribe:view', (e) => {
  if (e.detail !== 'admin') return;
  load();
  loadStorage();
  loadRR();
});
$('updates-check').onclick = async () => {
  $('updates-check').disabled = true;
  await load(true);
  $('updates-check').disabled = false;
};

// Offer Admin to an admin, once app.js has signed in and says who we are
document.addEventListener('airscribe:signed-in', (e) => {
  $('admin-toggle').hidden = e.detail?.role !== 'admin';
});
