// The token rides on the query string rather than a header, because the event
// stream and the audio and text download links cannot set one.
//
// It arrives either in the page URL or from a previous visit. A token in the
// URL is moved into storage and stripped from the address bar, so it stops
// appearing in history, bookmarks and screenshots.
const KEY = 'airscribe.token';

/** @returns {string} The stored token, or '' when there is none. */
function storedToken() {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return ''; // private windows and blocked site data
  }
}

/** @param {string} value - Token to remember, or '' to forget it. */
function rememberToken(value) {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* not fatal: the in-memory copy still works for this page load */
  }
}

let token = storedToken();
const fromUrl = new URLSearchParams(location.search).get('token');
if (fromUrl) {
  token = fromUrl;
  rememberToken(fromUrl);
  const clean = new URL(location.href);
  clean.searchParams.delete('token');
  history.replaceState(null, '', clean);
}

const url = (p) => (token ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : p);
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(url(`/api${path}`), {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const err = new Error((await res.json().catch(() => ({}))).error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const models = new Map();
let radios = [];
const txs = new Map(); // id -> row

function renderRadios() {
  const list = $('radios');
  list.replaceChildren(
    ...radios.map((r) => {
      const connected = r.state === 'connected';
      const retrying = r.state === 'connecting';
      const dot = r.tx ? 'tx' : r.rx ? 'rx' : connected ? 'connected' : retrying ? 'retry' : '';
      const activity = r.tx ? 'transmitting' : r.rx ? 'receiving'
        : retrying ? 'reconnecting…' : (r.state ?? 'disconnected');
      return el(
        'li', {},
        el('div', { className: 'radio-head' },
          el('span', { className: `dot ${dot}` }),
          el('strong', {}, r.name),
          el('span', { className: 'pill' }, activity)),
        // Identity on one line, live state on another: together they wrap
        // badly and leave a channel name broken across lines.
        el('div', { className: 'meta' },
          `${models.get(r.model)?.name ?? 'unknown model'} · ${r.mac}`),
        connected
          ? el('div', { className: 'meta live' },
              // Signal is the only visible sign the radio is being polled,
              // and the difference between hearing nothing and not connected.
              r.rssi !== undefined
                ? el('span', { className: 'signal', title: `RSSI ${r.rssi} of 15` },
                    `${'█'.repeat(Math.min(5, Math.round(r.rssi / 3)))}` +
                    `${'░'.repeat(5 - Math.min(5, Math.round(r.rssi / 3)))} ${r.rssi}`)
                : '',
              // A flat battery ends a session and nothing here can reconnect
              // to a radio that is off, so it is worth seeing beforehand.
              r.battery !== undefined && r.battery !== null
                ? el('span', { className: `battery ${r.battery <= 20 ? 'low' : ''}` },
                    ` · ${r.battery}%`)
                : '',
              r.channelName || r.channel !== undefined
                ? el('span', { className: 'chan' },
                    ` · ${r.channelName || `ch ${r.channel}`}`)
                : '')
          : '',
        el('div', { className: 'actions' },
          el('button', { onclick: () => act(r.mac, connected ? 'disconnect' : 'connect') }, connected ? 'Disconnect' : 'Connect'),
          el('button', { onclick: () => remove(r) }, 'Remove')),
      );
    }),
  );
  const sel = $('filter-radio');
  const cur = sel.value;
  sel.replaceChildren(el('option', { value: '' }, 'All radios'), ...radios.map((r) => el('option', { value: r.mac }, r.name)));
  sel.value = cur;
}

async function act(mac, what) {
  try { await api(`/radios/${mac}/${what}`, { method: 'POST' }); } catch (e) { alert(e.message); }
}
async function remove(r) {
  if (confirm(`Remove ${r.name}? Its past transmissions are kept.`)) { await api(`/radios/${r.mac}`, { method: 'DELETE' }); await loadRadios(); }
}
async function loadRadios() { radios = await api('/radios'); renderRadios(); }

$('scan').onclick = async () => {
  const box = $('found');
  const list = $('found-list');
  box.hidden = false;
  list.replaceChildren(el('li', {}, 'Scanning…'));
  try {
    const found = await api('/scan');
    list.replaceChildren(
      ...(found.length ? found : [{ none: true }]).map((d) => d.none ? el('li', {}, 'Nothing found. Pair the radio with the host first.') :
        el('li', {},
          el('strong', {}, d.name), el('div', { className: 'meta' }, `${d.mac} · ${models.get(d.model)?.name ?? 'model unrecognised'}`),
          el('div', { className: 'actions' }, d.saved ? el('span', { className: 'pill ok' }, 'added') : el('button', { onclick: () => add(d) }, 'Add'))),
      ),
    );
  } catch (e) { list.replaceChildren(el('li', { className: 'tx-text error' }, e.message)); }
};

async function add(d) {
  let model = d.model;
  if (!model) {
    const ids = [...models.keys()].join(', ');
    model = prompt(`Which model is this? (${ids})`);
    if (!model) return;
  }
  try { await api('/radios', { method: 'POST', body: { mac: d.mac, name: d.name, model } }); await loadRadios(); $('scan').click(); } catch (e) { alert(e.message); }
}

function renderTx(t) {
  const radio = radios.find((r) => r.mac === t.mac);
  const scripts = t.transcripts ?? [];
  /** @param {object} s - A transcript row. @returns {string} What to show. */
  const bodyOf = (s) => s.status === 'pending' ? 'transcribing…'
    : s.status === 'error' ? `transcription failed: ${s.error}`
    : (s.text || '').trim() || '(no speech recognised)';
  const text = scripts.length ? bodyOf(scripts.find((s) => s.engine === t.engine) ?? scripts[0])
    : t.status === 'pending' ? 'transcribing…'
    : t.status === 'error' ? `transcription failed: ${t.error}`
    : t.text || '(no speech recognised)';
  const primaryScript = scripts.find((s) => s.engine === t.engine) ?? scripts[0];
  // Only worth labelling once more than one model has had a go at it.
  const others = scripts.filter((s) => s !== primaryScript);
  const dir = t.transmit ? 'sent' : 'heard';
  return el('li', { id: `tx-${t.id}`, className: t.transmit ? 'sent' : '' },
    el('div', { className: 'meta' },
      el('span', { className: `tag ${dir}` }, dir), ' ',
      `${new Date(t.started_at).toLocaleString()} · ${radio?.name ?? t.mac} · ${(t.duration_ms / 1000).toFixed(1)}s`,
      // Which channel it came in on. On a scanner this is most of the
      // context: the same words mean different things on fire and on police.
      t.channel_name || t.channel_hz || t.channel !== null
        ? el('span', { className: 'chan' },
            ` · ${t.channel_name || `ch ${t.channel}`}` +
            (t.channel_hz ? ` ${(t.channel_hz / 1e6).toFixed(4)} MHz` : ''))
        : ''),
    el('div', { className: `tx-text ${(primaryScript?.status ?? t.status) === 'done' ? '' : (primaryScript?.status ?? t.status)}` },
      others.length ? el('span', { className: 'engine' }, `${primaryScript.engine} `) : '', text),
    ...others.map((s) =>
      el('div', { className: `tx-text alt ${s.status === 'done' ? '' : s.status}` },
        el('span', { className: 'engine' }, `${s.engine} `), bodyOf(s))),
    // 'metadata' rather than 'none' so the player shows the clip's length
    // instead of 0:00 until it is played. A transmission is seconds long, so
    // the headers this costs are cheap; the audio itself is still not fetched.
    el('audio', { controls: true, preload: 'metadata',
                  src: url(`/api/transmissions/${t.id}/audio`) }),
    el('div', { className: 'links' },
      el('a', { href: url(`/api/transmissions/${t.id}/audio?download`) }, 'Download audio'),
      t.text ? el('a', { href: url(`/api/transmissions/${t.id}/text`) }, 'Download text') : ''),
  );
}

function renderFeed() {
  const mac = $('filter-radio').value;
  const q = $('search').value.toLowerCase();
  const rows = [...txs.values()]
    .filter((t) => (!mac || t.mac === mac) && (!q || (t.text ?? '').toLowerCase().includes(q)))
    .sort((a, b) => b.started_at - a.started_at);
  $('feed').replaceChildren(...rows.map(renderTx));
  refreshExport();
}

async function loadFeed() {
  for (const t of await api('/transmissions?limit=200')) txs.set(t.id, t);
  renderFeed();
}

/** Point the export link at whatever the feed is currently showing. */
function refreshExport() {
  const mac = $('filter-radio').value;
  const q = $('search').value.trim();
  const params = new URLSearchParams({ format: 'csv', limit: '500' });
  if (mac) params.set('mac', mac);
  if (q) params.set('q', q);
  $('export').href = url(`/api/transmissions/export?${params}`);
  $('export').title = 'Every engine’s transcript for these clips, as CSV';
}

$('filter-radio').onchange = () => { renderFeed(); refreshExport(); };
$('search').oninput = () => { renderFeed(); refreshExport(); };

function listen() {
  const es = new EventSource(url('/api/events'));
  es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'pill ok'; };
  es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'pill bad'; };
  es.onmessage = (m) => {
    const u = JSON.parse(m.data);
    if (u.type === 'transmission') { txs.set(u.id, u); renderFeed(); }
    else if (u.type === 'status' || u.type === 'activity') {
      const r = radios.find((x) => x.mac === u.mac);
      if (r) { Object.assign(r, u); delete r.type; renderRadios(); }
    }
  };
}

/**
 * Ask for a token instead of failing silently.
 *
 * The page itself is served without one — it has to be, or this could never
 * be reached — so a 401 means the API wants a credential and nothing has
 * offered it yet.
 * @param {string} [message] - Why the last attempt failed.
 * @returns {void}
 */
function showSignIn(message) {
  const input = el('input', { type: 'password', id: 'token-input', placeholder: 'API token',
                              autocomplete: 'current-password' });
  const submit = () => {
    const value = input.value.trim();
    if (!value) return;
    token = value;
    rememberToken(value);
    boot();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  $('signin-body').replaceChildren(
    el('p', { className: 'meta' },
      message || 'This server requires a token. It is the one set in auth.tokens in its config.'),
    el('div', { className: 'row' }, input, el('button', { onclick: submit }, 'Sign in')),
  );
  $('signin').hidden = false;
  $('main').hidden = true;
  input.focus();
}

/** @returns {Promise<void>} Loads everything, or asks for a token. */
async function boot() {
  try {
    for (const m of await api('/models')) models.set(m.id, m);
    await loadRadios();
    await loadFeed();
  } catch (e) {
    if (e.status === 401) {
      rememberToken('');   // a stored token that no longer works is worse than none
      showSignIn(token ? 'That token was not accepted. Try another.' : undefined);
      return;
    }
    $('conn').textContent = 'error';
    $('conn').className = 'pill bad';
    $('signin-body').replaceChildren(el('p', { className: 'tx-text error' }, e.message));
    $('signin').hidden = false;
    $('main').hidden = true;
    return;
  }
  $('signin').hidden = true;
  $('main').hidden = false;
  listen();
}

boot();
