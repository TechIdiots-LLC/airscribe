// Admin → Findings: what a language model reads in the transcripts (docs/findings.md), and the roads it heard
// mentioned, lit on the Map. Shown only to an admin; the server enforces that regardless.
import { showView } from './views.js';

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
  roadsReady = Boolean(s.roads?.ways);
  renderRoads(s.roads);
}

// ---- Roads ----------------------------------------------------------------------

let roadsReady = false;   // some are imported, so a finding can be shown on the map
let roadsTimer = null;

function renderRoads(r) {
  if (!r) return;
  const src = r.source;
  const from = !src ? '' : src.from === 'file' ? `imported from ${src.name}`
    : `fetched from OpenStreetMap for ${src.km} km around the channels`;
  const text = r.busy
    ? `${r.busy.from === 'file' ? 'Importing' : 'Fetching from OpenStreetMap'}… ${r.busy.read.toLocaleString()} roads so far.`
    : r.ways ? `${r.ways.toLocaleString()} stretches of road with ${r.names.toLocaleString()} names, ${from}, ` +
      `${new Date(src.at).toLocaleString()}. Roads © OpenStreetMap contributors.`
    : 'No roads yet.';
  $('fd-roads-status').textContent = r.lastError && !r.busy ? `${text} The last try failed: ${r.lastError.error}` : text;
  $('fd-roads-status').className = r.lastError && !r.busy ? 'tx-text error' : 'meta';
  for (const id of ['fd-roads-fetch', 'fd-roads-import', 'fd-roads-clear']) $(id).disabled = Boolean(r.busy);
  roadsReady = Boolean(r.ways);
  clearTimeout(roadsTimer);
  if (r.busy) roadsTimer = setTimeout(() => api('/admin/findings/roads').then(renderRoads, (e) => say(e.message, true)), 2000);
}

$('fd-roads-fetch').onclick = async () => {
  try {
    await api('/admin/findings/roads/fetch', { method: 'POST', body: { km: Number($('fd-roads-km').value) } });
    renderRoads(await api('/admin/findings/roads'));
  } catch (e) {
    say(e.message, true);
  }
};

$('fd-roads-import').onclick = () => $('fd-roads-file').click();
$('fd-roads-file').onchange = async () => {
  const file = $('fd-roads-file').files[0];
  $('fd-roads-file').value = '';
  if (!file) return;
  $('fd-roads-status').textContent = `Importing ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`;
  $('fd-roads-status').className = 'meta';
  try {
    // The file itself is the body, read on the server as it arrives
    const res = await fetch(withToken(`/api/admin/findings/roads?name=${encodeURIComponent(file.name)}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    renderRoads(body);
  } catch (e) {
    renderRoads(await api('/admin/findings/roads').catch(() => null));
    say(`Importing ${file.name}: ${e.message}`, true);
  }
};

$('fd-roads-clear').onclick = async () => {
  if (!confirm('Delete the roads? Findings stays as it is, without them.')) return;
  try {
    renderRoads(await api('/admin/findings/roads', { method: 'DELETE' }));
  } catch (e) {
    say(e.message, true);
  }
};

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
    el('audio', { controls: true, preload: 'none', src: withToken(`/api/transmissions/${r.id}/audio`) }),
    roadsReady && (r.found.roads?.length || r.found.addresses?.length)
      ? el('div', {}, el('button', { className: 'link', onclick: () => showOnMap(r.id) }, 'On the map')) : '');
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

// ---- Roads mentioned, on the Map --------------------------------------------------
// Each road a finding mentions, near its channel, lit: redder the more recent, dashed where the name was only
// like one there (misheard, maybe); a dot where an address names a corner. Clicking one lists what was said
// about it. Admins only, as the rest of Findings is.

const SRC = 'fd-roads';
const LAYERS = ['fd-roads-line', 'fd-roads-maybe', 'fd-roads-corner'];
const EMPTY = { type: 'FeatureCollection', features: [] };
const ROADS_KEY = 'airscribe.map.roads';
const ROADS_HOURS_KEY = 'airscribe.map.roadsHours';
let mapCtx = null;        // {map, maplibregl}, once the Map has been opened
let mentioned = null;     // the last /admin/findings/map
let focusId = null;       // a transmission to frame once loaded
let roadPopup = null;

const recall = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
$('map-roads').checked = recall(ROADS_KEY, '0') === '1';
$('map-roads-hours').value = recall(ROADS_HOURS_KEY, '24');

document.addEventListener('airscribe:signed-in', (e) => {
  $('map-roads-wrap').hidden = e.detail?.role !== 'admin';
});

function roadNote(text) {
  $('map-roads-note').textContent = text ?? '';
  $('map-roads-note').hidden = !text;
}

/** The colour of a road by how long ago it was last mentioned, in hours. */
const RECENT = ['interpolate', ['linear'], ['get', 'age'], 0, '#ff2d2d', 6, '#ff8c1a', 48, '#e8c200'];

function addLayers() {
  const m = mapCtx?.map;
  if (!m || m.getSource(SRC)) return;
  m.addSource(SRC, { type: 'geojson', data: withAges(mentioned?.features) });
  const road = ['==', ['get', 'kind'], 'road'];
  // Wider the more it's been mentioned; the zoom has to be the outermost part of the expression
  const sized = (k) => ['interpolate', ['linear'], ['zoom'],
    10, ['*', k, ['+', 3, ['min', 3, ['get', 'count']]]], 17, ['*', k, ['+', 7, ['min', 5, ['get', 'count']]]]];
  const width = sized(1);
  m.addLayer({ id: 'fd-roads-glow', type: 'line', source: SRC, filter: road,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': RECENT, 'line-opacity': 0.3, 'line-blur': 4, 'line-width': sized(2.5) } });
  m.addLayer({ id: 'fd-roads-line', type: 'line', source: SRC, filter: ['all', road, ['!=', ['get', 'level'], 'fuzzy']],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': RECENT, 'line-width': width } });
  m.addLayer({ id: 'fd-roads-maybe', type: 'line', source: SRC, filter: ['all', road, ['==', ['get', 'level'], 'fuzzy']],
    layout: { 'line-join': 'round' }, paint: { 'line-color': RECENT, 'line-width': width, 'line-dasharray': [1.5, 1.2] } });
  m.addLayer({ id: 'fd-roads-corner', type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'corner'],
    paint: { 'circle-radius': 7, 'circle-color': RECENT, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
}

/** The features, each with how many hours ago it was last mentioned, for its colour. */
function withAges(fc) {
  const now = Date.now();
  return { type: 'FeatureCollection', features: (fc?.features ?? []).map((f) => ({
    ...f, properties: { ...f.properties, age: (now - f.properties.last) / 3600_000 } })) };
}

async function loadRoads() {
  const m = mapCtx?.map;
  if (!m || $('map-roads-wrap').hidden) return;
  if (!$('map-roads').checked) {
    mentioned = null;
    roadPopup?.remove();
    m.getSource(SRC)?.setData(EMPTY);
    roadNote(null);
    return;
  }
  const p = new URLSearchParams({ hours: $('map-roads-hours').value });
  if (focusId) p.set('also', String(focusId));
  try {
    mentioned = await api(`/admin/findings/map?${p}`);
    roadNote(!mentioned.ways ? 'No roads yet: fetch or import them in Admin → Findings → Roads.'
      : mentioned.features.features.length ? null : 'No roads mentioned in that time.');
  } catch (e) {
    mentioned = null;
    roadNote(e.status === 403 ? `Roads mentioned: ${e.message} (open Admin).` : `Roads mentioned: ${e.message}`);
  }
  m.getSource(SRC)?.setData(withAges(mentioned?.features));
  if (focusId && mentioned) {
    const b = new mapCtx.maplibregl.LngLatBounds();
    for (const f of mentioned.features.features) {
      if (!mentioned.places[f.properties.key]?.ids.includes(focusId)) continue;
      const g = f.geometry;
      for (const c of g.type === 'Point' ? [g.coordinates] : g.coordinates.flat()) b.extend(c);
    }
    if (!b.isEmpty()) m.fitBounds(b, { padding: 60, maxZoom: 16 });
    else roadNote('None of the roads it mentions were found near its channel.');
  }
  focusId = null;
}

/** What was said about the roads clicked. */
function onRoadClick(e) {
  const m = mapCtx.map;
  if (!mentioned || !m.getLayer(LAYERS[0])) return;
  const { x, y } = e.point;
  const hit = m.queryRenderedFeatures([[x - 5, y - 5], [x + 5, y + 5]], { layers: LAYERS.filter((l) => m.getLayer(l)) });
  const keys = [...new Set(hit.map((f) => f.properties.key))].slice(0, 3);
  if (!keys.length) return;
  const body = el('div', { className: 'ch-popup road-popup' }, ...keys.map((key) => {
    const p = mentioned.places[key];
    const heard = p.level === 'fuzzy' ? `heard as “${p.said.join('”, “')}”: the nearest road with a name like it` : '';
    return el('div', {},
      el('strong', {}, p.name),
      heard ? el('div', { className: 'meta' }, heard) : '',
      p.anywhere ? el('div', { className: 'meta' }, 'Its channel isn’t placed, so every road of this name is lit.') : '',
      el('ul', {}, ...p.ids.slice(0, 8).map((id) => {
        const t = mentioned.transmissions[id];
        return el('li', {},
          el('div', { className: 'meta' }, `${new Date(t.startedAt).toLocaleString()} · ${t.channel ?? 'channel unknown'}`),
          t.summary ? el('div', {}, el('strong', {}, t.summary), t.incident ? ` · ${t.incident}` : '') : '',
          el('div', { className: 'meta' }, `“${t.text}”`),
          el('audio', { controls: true, preload: 'none', src: withToken(`/api/transmissions/${id}/audio`) }));
      })),
      p.ids.length > 8 ? el('div', { className: 'meta' }, `and ${p.ids.length - 8} more, in Admin → Findings`) : '');
  }), el('div', { className: 'credit' }, 'Roads © OpenStreetMap contributors'));
  roadPopup?.remove();
  roadPopup = new mapCtx.maplibregl.Popup({ offset: 8, maxWidth: '360px' }).setLngLat(e.lngLat).setDOMContent(body).addTo(m);
}

document.addEventListener('airscribe:map', (e) => {
  mapCtx = e.detail;
  const m = mapCtx.map;
  // A base map chosen again drops what was added to it
  const add = () => {
    if (!m.getSource(SRC)) try { addLayers(); } catch { /* not ready yet: the next styledata */ }
  };
  m.on('styledata', add);
  if (m.isStyleLoaded()) add();
  m.on('click', onRoadClick);
  for (const id of LAYERS) {
    m.on('mouseenter', id, () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; });
  }
  loadRoads();
});

/** From a finding: the Map, with the roads it mentions framed. */
function showOnMap(id) {
  focusId = id;
  $('map-roads').checked = true;
  keep(ROADS_KEY, '1');
  showView('mapview');
  if (mapCtx) loadRoads();
}

$('map-roads').onchange = () => {
  keep(ROADS_KEY, $('map-roads').checked ? '1' : '0');
  loadRoads();
};
$('map-roads-hours').onchange = () => {
  keep(ROADS_HOURS_KEY, $('map-roads-hours').value);
  loadRoads();
};
// Kept up to date while it's showing: findings aren't on the event stream, which viewers share
setInterval(() => {
  if ($('map-roads').checked && !document.getElementById('mapview').hidden) loadRoads();
}, 30_000);

// Loaded when Admin is opened (views.js switches the page), and the roads when the Map is
document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'admin') load();
  if (e.detail === 'mapview' && mapCtx) loadRoads();
});
