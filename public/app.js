// A `?token=` on the page URL is carried onto API calls, the event stream and
// download links, none of which can all send a header.
const token = new URLSearchParams(location.search).get('token');
const url = (p) => (token ? `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : p);
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(url(`/api${path}`), {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
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
      const state = r.rx ? 'rx' : r.state === 'connected' ? 'connected' : '';
      const connected = r.state === 'connected';
      return el(
        'li', {},
        el('div', { className: 'radio-head' },
          el('span', { className: `dot ${state}` }),
          el('strong', {}, r.name),
          el('span', { className: 'pill' }, r.rx ? 'receiving' : r.state ?? 'disconnected')),
        el('div', { className: 'meta' }, `${models.get(r.model)?.name ?? 'unknown model'} · ${r.mac}`),
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
  const text = t.status === 'pending' ? 'transcribing…' : t.status === 'error' ? `transcription failed: ${t.error}` : t.text || '(no speech recognised)';
  return el('li', { id: `tx-${t.id}` },
    el('div', { className: 'meta' }, `${new Date(t.started_at).toLocaleString()} · ${radio?.name ?? t.mac} · ${(t.duration_ms / 1000).toFixed(1)}s`),
    el('div', { className: `tx-text ${t.status === 'done' ? '' : t.status}` }, text),
    el('audio', { controls: true, preload: 'none', src: url(`/api/transmissions/${t.id}/audio`) }),
    el('div', { className: 'links' },
      el('a', { href: url(`/api/transmissions/${t.id}/audio`) }, 'Download audio'),
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
}

async function loadFeed() {
  for (const t of await api('/transmissions?limit=200')) txs.set(t.id, t);
  renderFeed();
}

$('filter-radio').onchange = renderFeed;
$('search').oninput = renderFeed;

function listen() {
  const es = new EventSource(url('/api/events'));
  es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'pill ok'; };
  es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'pill bad'; };
  es.onmessage = (m) => {
    const u = JSON.parse(m.data);
    if (u.type === 'transmission') { txs.set(u.id, u); renderFeed(); }
    else if (u.type === 'status' || u.type === 'rx') {
      const r = radios.find((x) => x.mac === u.mac);
      if (r) { Object.assign(r, u); delete r.type; renderRadios(); }
    }
  };
}

for (const m of await api('/models')) models.set(m.id, m);
await loadRadios();
await loadFeed();
listen();
