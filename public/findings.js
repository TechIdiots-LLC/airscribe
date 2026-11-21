// Admin → Findings: what a language model reads in the transcripts (docs/findings.md). Shown only to an admin; the
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

function say(text, error = false) {
  $('fd-status').textContent = text;
  $('fd-status').className = error ? 'tx-text error' : 'meta';
}

const LABELS = {
  addresses: 'Addresses', roads: 'Roads', plates: 'Plates', vehicles: 'Vehicles', people: 'People', units: 'Units',
};

/** What the model found, as labelled lists, with the watched values marked. */
function foundList(found, marked = new Set()) {
  const rows = Object.entries(LABELS)
    .filter(([k]) => found?.[k]?.length)
    .map(([k, label]) => el('div', { className: 'meta' }, `${label}: `,
      ...found[k].flatMap((v, i) => [i ? ', ' : '', marked.has(v) ? el('mark', {}, v) : v])));
  return el('div', {}, ...rows);
}

// ---- Settings -------------------------------------------------------------------

function render(s) {
  $('fd-enabled').checked = s.enabled;
  $('fd-api').value = s.api;
  $('fd-url').value = s.url ?? '';
  $('fd-model').value = s.model ?? '';
  $('fd-key').value = '';
  $('fd-key').placeholder = s.apiKey ? 'saved' : 'if the server wants one';
  $('fd-webhook').value = s.webhook ?? '';
  $('fd-keep').value = s.keepDays;
  const state = s.ready ? `On: ${s.counts.findings} transmissions read, ${s.counts.hits} watch matches kept` +
      `${s.queued ? `, ${s.queued} waiting` : ''}.` : s.enabled ? 'On, but it needs a server address and a model.' : 'Off.';
  say(s.lastError ? `${state} Last error: ${s.lastError.error}` : state, Boolean(s.lastError));
}

async function load() {
  try {
    render(await api('/admin/findings'));
    await Promise.all([loadWatches(), loadResults()]);
  } catch (e) {
    say(e.message, true);
  }
}

$('fd-save').onclick = async () => {
  try {
    render(await api('/admin/findings', {
      method: 'PUT',
      body: {
        enabled: $('fd-enabled').checked, api: $('fd-api').value, url: $('fd-url').value,
        model: $('fd-model').value, apiKey: $('fd-key').value, webhook: $('fd-webhook').value,
        keepDays: $('fd-keep').value,
      },
    }));
  } catch (e) {
    say(e.message, true);
  }
};

$('fd-test').onclick = async () => {
  say('Asking the model about a made-up transmission… (the first time, it has to load)');
  $('fd-tested').replaceChildren();
  try {
    const t = await api('/admin/findings/test', { method: 'POST', body: {} });
    say(`${t.model} answered in ${(t.ms / 1000).toFixed(1)} s.`);
    $('fd-tested').replaceChildren(el('div', { className: 'notice' },
      el('div', { className: 'meta' }, `“${t.text}”`),
      el('div', {}, el('strong', {}, t.found.summary || '(no summary)'), t.found.incident ? ` · ${t.found.incident}` : ''),
      foundList(t.found)));
  } catch (e) {
    say(e.message, true);
  }
};

$('fd-backfill').onclick = async () => {
  try {
    const r = await api('/admin/findings/backfill', { method: 'POST', body: { hours: Number($('fd-hours').value) } });
    say(`${r.queued} transmissions queued for reading.`);
  } catch (e) {
    say(e.message, true);
  }
};

$('fd-forget').onclick = async () => {
  if (!confirm('Delete everything the model found, and every watch match? The watch list stays.')) return;
  try {
    render(await api('/admin/findings/forget', { method: 'POST' }));
    await loadResults();
  } catch (e) {
    say(e.message, true);
  }
};

// ---- Watches --------------------------------------------------------------------

async function loadWatches() {
  const list = await api('/admin/findings/watches');
  $('fd-watches').replaceChildren(...(list.length ? list.map((w) => el('li', {},
    el('div', { className: 'radio-head' },
      el('strong', {}, w.term),
      w.note ? el('span', { className: 'meta' }, ` ${w.note}`) : '',
      el('span', { className: 'pill' }, `${w.hits} match${w.hits === 1 ? '' : 'es'}`),
      el('button', {
        className: 'link',
        onclick: async () => {
          try {
            await api(`/admin/findings/watches/${w.id}`, { method: 'DELETE' });
            await loadWatches();
          } catch (e) {
            say(e.message, true);
          }
        },
      }, 'Remove')))) : [el('li', { className: 'meta' }, 'Nothing watched for yet.')]));
}

$('fd-watch-add').onclick = async () => {
  try {
    await api('/admin/findings/watches', { method: 'POST', body: { term: $('fd-term').value, note: $('fd-note').value } });
    $('fd-term').value = '';
    $('fd-note').value = '';
    await loadWatches();
  } catch (e) {
    say(e.message, true);
  }
};

// ---- What was found -------------------------------------------------------------

let oldest = null;   // paging: the start of the last row shown

function resultRow(r) {
  const marked = new Set(r.hits.map((h) => h.value));
  return el('li', {},
    el('div', { className: 'radio-head' },
      el('span', { className: 'meta' }, `${new Date(r.startedAt).toLocaleString()} · ${r.channel ?? 'channel unknown'}`),
      r.found.incident ? el('span', { className: 'pill' }, r.found.incident) : '',
      ...r.hits.map((h) => el('span', { className: 'pill' }, `watch: ${h.term}`))),
    r.found.summary ? el('div', {}, el('strong', {}, r.found.summary)) : '',
    el('div', { className: 'meta' }, `“${r.text}”`),
    foundList(r.found, marked),
    el('audio', { controls: true, preload: 'none', src: withToken(`/api/transmissions/${r.id}/audio`) }));
}

async function loadResults(more = false) {
  const params = new URLSearchParams({ limit: '50' });
  if ($('fd-q').value.trim()) params.set('q', $('fd-q').value.trim());
  if ($('fd-hits').checked) params.set('hits', '1');
  if (more && oldest) params.set('before', String(oldest));
  const rows = await api(`/admin/findings/results?${params}`);
  const items = rows.map(resultRow);
  if (more) $('fd-results').append(...items);
  else $('fd-results').replaceChildren(...(items.length ? items : [el('li', { className: 'meta' }, 'Nothing found yet.')]));
  if (rows.length) oldest = rows.at(-1).startedAt;
  $('fd-more').hidden = rows.length < 50;
}

let searchTimer = null;
$('fd-q').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadResults().catch((e) => say(e.message, true)), 300);
};
$('fd-hits').onchange = () => loadResults().catch((e) => say(e.message, true));
$('fd-more').onclick = () => loadResults(true).catch((e) => say(e.message, true));
$('fd-refresh').onclick = load;

// Loaded when Admin is opened (views.js switches the page)
document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'admin') load();
});
