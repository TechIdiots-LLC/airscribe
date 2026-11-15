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

/** @returns {Promise<Response>} The response, or throws one with `status` for an error. */
async function request(path, opts = {}) {
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
  return res;
}

async function api(path, opts = {}) {
  const res = await request(path, opts);
  return res.status === 204 ? null : res.json();
}

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const models = new Map();
let radios = [];
const txs = new Map(); // id -> row, what the feed is showing

// The feed is paged from the server, newest first: the search box and the
// radio filter ask the server, so they cover the whole history rather than the
// rows that happened to be loaded. "Load older" asks for the next page with
// the cursor the last one gave.
const PAGE = 50;
// Left open, a page gains every new transmission; without paging back it
// keeps this many and lets "Load older" fetch the rest again
const LIVE_CAP = 300;
let feedCursor = null;   // where the next page starts, or null at the end
let feedTotal = 0;       // how many match the filter, for "50 of 1,234"
let feedSeq = 0;         // the latest load: a slower, earlier answer is dropped
let pagedBack = false;   // older pages were asked for: keep them
const nodes = new Map(); // id -> its <li>, so one row is redrawn, not the feed
let role = null;         // who signed in: an admin may delete

// "Hide no speech" is remembered per browser
const HIDE_KEY = 'airscribe.hideSilent';
try { $('hide-silent').checked = localStorage.getItem(HIDE_KEY) === '1'; } catch { /* storage blocked */ }

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
          el('button', { onclick: () => rename(r) }, 'Rename'),
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
/**
 * Give a radio its own name. Radios of one model scan in with the same name,
 * and the feed labels each transmission with it, so two UV-Pros can't be told
 * apart until one is renamed. A prompt rather than editing in place: the list
 * redraws on every status poll, which would take an input box away mid-typing.
 * @param {object} r - The radio.
 * @returns {Promise<void>}
 */
async function rename(r) {
  const name = prompt(`New name for ${r.name} (${r.mac}):`, r.name);
  if (name === null || !name.trim() || name.trim() === r.name) return;
  try {
    await api(`/radios/${r.mac}`, { method: 'PATCH', body: { name: name.trim() } });
    await loadRadios();
    renderFeed();   // past transmissions take the new name too
  } catch (e) { alert(e.message); }
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
  const li = el('li', { id: `tx-${t.id}`, className: t.transmit ? 'sent' : '' },
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
      t.text ? el('a', { href: url(`/api/transmissions/${t.id}/text`) }, 'Download text') : '',
      role === 'admin' ? el('button', { className: 'link danger', onclick: () => deleteTx(t) }, 'Delete') : ''),
  );
  li.dataset.at = String(t.started_at);
  li.dataset.id = String(t.id);
  return li;
}

/** @returns {boolean} Whether `a` comes before `b` in the feed: newer, or the same moment and a later id. */
const newer = (a, b) => a.started_at > b.started_at || (a.started_at === b.started_at && a.id > b.id);

/**
 * Draw one transmission, or redraw it in place. Only that row changes: the
 * others keep their players, so a clip being listened to isn't stopped by
 * another one arriving, and the browser isn't asked to fetch every clip's
 * header again on every update. A redrawn row keeps its own player too.
 * @param {object} t - The transmission.
 * @returns {void}
 */
function placeRow(t) {
  const li = renderTx(t);
  const old = nodes.get(t.id);
  if (old) {
    const player = old.querySelector('audio');
    if (player) li.querySelector('audio')?.replaceWith(player);
    old.replaceWith(li);
  } else {
    const feed = $('feed');
    // Mostly new rows go first and older pages go last; look only otherwise
    let next = feed.firstElementChild;
    const at = (n) => ({ started_at: Number(n.dataset.at), id: Number(n.dataset.id) });
    if (feed.lastElementChild && newer(at(feed.lastElementChild), t)) next = null;
    else while (next && newer(at(next), t)) next = next.nextElementSibling;
    feed.insertBefore(li, next);
  }
  nodes.set(t.id, li);
}

/** @returns {void} Redraw every row (after a rename), keeping each one's player. */
function renderFeed() {
  for (const t of txs.values()) placeRow(t);
  renderFeedFoot();
}

/** @returns {void} The count and "Load older" under the feed. */
function renderFeedFoot() {
  const filtered = $('filter-radio').value || $('search').value.trim();
  $('feed-more').hidden = !feedCursor;
  $('feed-count').textContent = txs.size
    ? `Showing ${txs.size.toLocaleString()} of ${Math.max(feedTotal, txs.size).toLocaleString()}`
    : filtered ? 'Nothing matches.' : 'No transmissions yet.';
}

/**
 * Load the feed's first page for the current filter, or with `more`, the next
 * older page after what is shown.
 * @param {{more?: boolean}} [o] - Options.
 * @returns {Promise<void>}
 */
async function loadFeed({ more = false } = {}) {
  const seq = ++feedSeq;
  const params = new URLSearchParams({ limit: String(PAGE) });
  const mac = $('filter-radio').value;
  const q = $('search').value.trim();
  if (mac) params.set('mac', mac);
  if (q) params.set('q', q);
  if ($('hide-silent').checked) params.set('speech', '1');
  if (more && feedCursor) params.set('before', feedCursor);
  const res = await request(`/transmissions?${params}`);
  const rows = await res.json();
  if (seq !== feedSeq) return;   // the filter changed while this was on its way
  if (!more) {
    txs.clear();
    nodes.clear();
    $('feed').replaceChildren();
  }
  pagedBack = more;
  feedCursor = res.headers.get('X-Next-Before');
  feedTotal = Number(res.headers.get('X-Total-Count')) || 0;
  for (const t of rows) {
    txs.set(t.id, t);
    placeRow(t);
  }
  renderFeedFoot();
  refreshExport();
}

/**
 * Whether a transmission belongs in the feed as it is filtered: the same
 * test the server makes, for rows that arrive live.
 * @param {object} t - The transmission.
 * @returns {boolean} Whether to show it.
 */
function matchesFilter(t) {
  const mac = $('filter-radio').value;
  const q = $('search').value.trim().toLowerCase();
  if (mac && t.mac !== mac) return false;
  // Hiding no speech: a live clip joins once it has words, rather than
  // showing while it's transcribed and vanishing if it turns out a chirp
  if ($('hide-silent').checked && !(t.text ?? '').trim()) return false;
  if (!q) return true;
  return [t.channel_name, t.text, ...(t.transcripts ?? []).map((s) => s.text)]
    .some((s) => (s ?? '').toLowerCase().includes(q));
}

/**
 * @param {object} t - A transmission.
 * @returns {boolean} Whether the transcript it shows is finished and empty:
 *   "(no speech recognised)", as the server decides for "Hide no speech".
 */
const silent = (t) => (t.transcripts ?? []).find((s) => s.engine === t.engine)?.status === 'done'
  && !(t.text ?? '').trim();

/**
 * Take a row out of the feed: deleted, or no longer matching.
 * @param {number} id - The transmission.
 * @returns {void}
 */
function removeRow(id) {
  if (!txs.has(id)) return;
  txs.delete(id);
  nodes.get(id)?.remove();
  nodes.delete(id);
  feedTotal = Math.max(0, feedTotal - 1);
  renderFeedFoot();
}

/**
 * Delete one transmission, its transcripts and its audio. Admins only; the
 * server checks that too.
 * @param {object} t - The transmission.
 * @returns {Promise<void>}
 */
async function deleteTx(t) {
  const radio = radios.find((r) => r.mac === t.mac)?.name ?? t.mac;
  const when = new Date(t.started_at).toLocaleString();
  if (!confirm(`Delete this ${(t.duration_ms / 1000).toFixed(1)}s transmission from ${radio} at ${when}, ` +
               'with its transcripts and audio? This can’t be undone.')) return;
  try {
    await api(`/transmissions/${t.id}`, { method: 'DELETE' });
    removeRow(t.id);   // the server tells every open page too
  } catch (e) { alert(e.message); }
}

/**
 * A transmission arrived or changed. Shown rows are redrawn; a new one is
 * added if it matches the filter and falls within the pages loaded, so
 * re-transcribing an old clip doesn't drop it among today's.
 * @param {object} t - The transmission, as the server sent it.
 * @returns {void}
 */
function onTransmission(t) {
  if (txs.has(t.id)) {
    // Transcribed as no speech while they're hidden: it goes
    if ($('hide-silent').checked && silent(t)) return removeRow(t.id);
    txs.set(t.id, t);
    placeRow(t);
    return;
  }
  if (!matchesFilter(t)) return;
  const shown = [...txs.values()];
  const oldest = shown.reduce((o, x) => (!o || newer(o, x) ? x : o), null);
  if (feedCursor && oldest && !newer(t, oldest)) return;
  txs.set(t.id, t);
  feedTotal += 1;
  placeRow(t);
  trimLive();
  renderFeedFoot();
}

/** @returns {void} Keep a feed left open from growing without end. */
function trimLive() {
  if (pagedBack || txs.size <= LIVE_CAP) return;
  const rows = [...txs.values()].sort((a, b) => (newer(a, b) ? -1 : 1));
  for (const t of rows.slice(LIVE_CAP)) {
    txs.delete(t.id);
    nodes.get(t.id)?.remove();
    nodes.delete(t.id);
  }
  const last = rows[LIVE_CAP - 1];
  feedCursor = `${last.started_at}.${last.id}`;
}

/** Point the export link at everything the feed's filter matches, not only the loaded pages. */
function refreshExport() {
  const mac = $('filter-radio').value;
  const q = $('search').value.trim();
  const params = new URLSearchParams({ format: 'csv' });
  if (mac) params.set('mac', mac);
  if (q) params.set('q', q);
  if ($('hide-silent').checked) params.set('speech', '1');
  $('export').href = url(`/api/transmissions/export?${params}`);
  $('export').title = 'Every engine’s transcript for every transmission matching the filter, as CSV';
}

const reload = () => loadFeed().catch((e) => { $('feed-count').textContent = e.message; });
let searchTimer = null;
$('filter-radio').onchange = reload;
$('hide-silent').onchange = () => {
  try { localStorage.setItem(HIDE_KEY, $('hide-silent').checked ? '1' : '0'); } catch { /* storage blocked */ }
  reload();
};
// Asked of the server, so wait for a pause in the typing
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(reload, 300); };
$('feed-more').onclick = async () => {
  $('feed-more').disabled = true;
  try { await loadFeed({ more: true }); } catch (e) { alert(e.message); }
  $('feed-more').disabled = false;
};

function listen() {
  const es = new EventSource(url('/api/events'));
  es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'pill ok'; };
  es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'pill bad'; };
  es.onmessage = (m) => {
    const u = JSON.parse(m.data);
    if (u.type === 'transmission') onTransmission(u);
    else if (u.type === 'deleted') u.ids.forEach(removeRow);
    else if (u.type === 'purged') reload();   // a large cleanup: start the feed again
    else if (u.type === 'status' || u.type === 'activity') {
      const r = radios.find((x) => x.mac === u.mac);
      if (r) { Object.assign(r, u); delete r.type; renderRadios(); }
    }
  };
}

/**
 * The sign-in page, covering everything else until it's done.
 *
 * The page itself is served without a credential (it has to be, or this
 * could never be reached), so the server is asked first whether one is
 * needed, and nothing behind this is drawn until it has been given.
 * @param {object} [session] - /api/session's answer: what to ask for.
 * @param {string} [message] - Why the last attempt failed.
 * @returns {void}
 */
function showLogin(session = {}, message = '') {
  $('login-user-field').hidden = !session.username;
  // Where only API tokens are set there is no password to ask for, and the
  // same box takes a token
  const tokensOnly = session.passwordLogin === false;
  $('login-pass-label').textContent = tokensOnly ? 'API token' : 'Password';
  $('login-hint').textContent = tokensOnly
    ? 'This server is guarded by API tokens: one from auth.tokens in its settings.'
    : 'A new Proxmox container leaves its first password in /root/airscribe-first-login.txt.';
  $('login-error').textContent = message;
  $('login').hidden = false;
  (session.username && !$('login-user').value ? $('login-user') : $('login-pass')).focus();
}

$('login-form').onsubmit = async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    // A session cookie for a password or a token alike, so nothing is kept
    // in this browser's storage
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }),
    });
    if (!res.ok) {
      $('login-error').textContent = res.status === 401
        ? 'Not accepted. Check it and try again.'
        : (await res.json().catch(() => ({}))).error || res.statusText;
      $('login-pass').select();
      return;
    }
    $('login-pass').value = '';
    token = '';
    rememberToken('');
    $('login').hidden = true;
    boot();
  } catch (e) {
    $('login-error').textContent = e.message;
  }
};

$('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  rememberToken('');
  location.reload();
};

/** @returns {Promise<void>} Asks who we are, then loads everything or asks to sign in. */
async function boot() {
  let session = null;
  try {
    session = await api('/session');
  } catch {
    // An unreachable server is reported by the loads below
  }
  if (session?.guarded && !session.authenticated) {
    // A stored token that no longer works is worse than none
    const stale = Boolean(token);
    token = '';
    rememberToken('');
    showLogin(session, stale ? 'The saved API token was not accepted. Sign in again.' : '');
    return;
  }
  // Before the feed draws, so an admin's rows have their Delete
  role = session?.role ?? null;
  try {
    for (const m of await api('/models')) models.set(m.id, m);
    await loadRadios();
    await loadFeed();
  } catch (e) {
    if (e.status === 401) return showLogin(session ?? {});
    $('conn').textContent = 'error';
    $('conn').className = 'pill bad';
    $('feed').replaceChildren(el('li', { className: 'tx-text error' }, e.message));
  }
  $('logout').hidden = !session?.guarded;
  $('main').hidden = false;
  listen();
  document.dispatchEvent(new CustomEvent('airscribe:signed-in', { detail: session }));
}

boot();
