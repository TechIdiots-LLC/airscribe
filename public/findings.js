// Findings: what a language model reads in the transcripts (docs/findings.md). Its tab holds the watch list and
// what was found; Admin → Findings its server and roads; the Map the roads mentioned. Any signed-in user reads it;
// only an admin changes it. The server enforces both regardless.
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

function sayIn(id, text, error) {
  $(id).textContent = text;
  $(id).className = error ? 'tx-text error' : 'meta';
}
/** Admin → Findings' status line. */
const say = (text, error = false) => sayIn('fd-status', text, error);
/** The Findings tab's. */
const tabSay = (text, error = false) => sayIn('fd-tab-status', text, error);

/** On or off, how much is kept, the last error: for either status line. */
function stateOf(s) {
  const state = s.ready ? `On: ${s.counts.findings} transmissions read, ${s.counts.hits} watch matches kept` +
      `${s.queued ? `, ${s.queued} waiting` : ''}.` : s.enabled ? 'On, but it needs a server address and a model.' : 'Off.';
  return [s.lastError ? `${state} Last error: ${s.lastError.error}` : state, Boolean(s.lastError)];
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

const CONTEXT = ['contextMinutes', 'contextCount', 'othersCount', 'sameCallSeconds', 'waitMinutes', 'findingsCount', 'findingsMinutes'];

function render(s) {
  $('fd-enabled').checked = s.enabled;
  $('fd-api').value = s.api;
  $('fd-url').value = s.url ?? '';
  $('fd-model').value = s.model ?? '';
  $('fd-key').value = '';
  $('fd-key').placeholder = s.apiKey ? 'saved' : 'if the server wants one';
  $('fd-webhook').value = s.webhook ?? '';
  $('fd-keep').value = s.keepDays;
  for (const k of CONTEXT) $(`fd-${k}`).value = s[k] ?? '';
  const [state, error] = stateOf(s);
  say(s.biggestPrompt ? `${state} Biggest prompt in the last day: ${s.biggestPrompt.toLocaleString()} tokens.` : state, error);
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
    : src.from === 'tiles' ? `read from the map’s tiles (${new URL(src.tilejson).host}) for ${src.km} km around the channels`
    : `fetched from OpenStreetMap for ${src.km} km around the channels`;
  const doing = { file: 'Importing', tiles: `Reading the map’s tiles, ${r.busy?.tiles},` }[r.busy?.from] ?? 'Fetching from OpenStreetMap';
  const text = r.busy
    ? `${doing}… ${r.busy.read.toLocaleString()} roads so far.`
    : r.ways ? `${r.ways.toLocaleString()} stretches of road with ${r.names.toLocaleString()} names, ${from}, ` +
      `${new Date(src.at).toLocaleString()}. Roads © OpenStreetMap contributors.`
    : 'No roads yet.';
  $('fd-roads-status').textContent = r.lastError && !r.busy ? `${text} The last try failed: ${r.lastError.error}` : text;
  $('fd-roads-status').className = r.lastError && !r.busy ? 'tx-text error' : 'meta';
  for (const id of ['fd-roads-tiles', 'fd-roads-fetch', 'fd-roads-import', 'fd-roads-clear']) $(id).disabled = Boolean(r.busy);
  roadsReady = Boolean(r.ways);
  clearTimeout(roadsTimer);
  if (r.busy) roadsTimer = setTimeout(() => api('/admin/findings/roads').then(renderRoads, (e) => say(e.message, true)), 2000);
}

$('fd-roads-tiles').onclick = async () => {
  try {
    await api('/admin/findings/roads/tiles', { method: 'POST', body: { km: Number($('fd-roads-km').value) } });
    renderRoads(await api('/admin/findings/roads'));
  } catch (e) {
    say(e.message, true);
  }
};

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

/** Admin → Findings: the settings and roads. */
async function load() {
  try {
    render(await api('/admin/findings'));
  } catch (e) {
    say(e.message, true);
  }
}

let isAdmin = false;   // from sign-in: whether the watch list can be changed here

/** What was sent to the model, folded away; with the tokens the server counted, and the time, when it said. */
const sentBox = (label, text, usage) => el('details', { className: 'fd-sent' },
  el('summary', { className: 'meta' }, label, usage ? ` · ${tokens(usage)}` : ''), el('pre', {}, text));
function tokens(u) {
  return [u.prompt != null ? `${u.prompt.toLocaleString()} tokens in` : '', u.answer != null ? `${u.answer.toLocaleString()} out` : '',
    u.ms != null ? `${(u.ms / 1000).toFixed(1)} s` : ''].filter(Boolean).join(', ');
}

const FIELD = { addresses: 'address', roads: 'road', plates: 'plate', vehicles: 'vehicle', people: 'person', units: 'unit' };
/** Corrections between findings: those a later transmission made to this one, and those this one made. */
function corrections(r) {
  const at = (c) => `${c.channel ?? 'channel unknown'}, ${new Date(c.startedAt).toLocaleTimeString()}`;
  const change = (c) => `${FIELD[c.field] ?? c.field} ${c.was} → ${c.now}`;
  return [
    ...(r.correctedBy ?? []).map((c) => el('div', { className: 'meta fd-correction' }, el('span', { className: 'pill' }, 'corrected'),
      ` ${change(c)}, by a later transmission (${at(c)})`)),
    ...(r.corrects ?? []).map((c) => el('div', { className: 'meta fd-correction' }, el('span', { className: 'pill' }, 'corrects'),
      ` an earlier finding (${at(c)}): ${change(c)}`)),
  ];
}

/** Other radios' copies of the transmission, read with it: what each heard, and its clip where there's room. */
function copiesOf(r, clips) {
  return (r.copies ?? []).map((c) => el('div', { className: 'fd-copy' },
    el('div', { className: 'meta' }, el('span', { className: 'pill' }, 'also heard'), ` by another radio, on ${c.channel ?? 'a channel unknown'}`,
      c.text ? `: “${c.text}”` : ''),
    clips ? el('audio', { controls: true, preload: 'none', src: withToken(`/api/transmissions/${c.id}/audio`) }) : ''));
}

/** The Findings tab: its status, the model's instructions, the watch list and what was found. */
async function loadTab({ list = true } = {}) {
  try {
    const s = await api('/findings');
    if (list) listFrom = s.latestAt + 1;
    roadsReady = s.roads;
    const [text, error] = stateOf(s);
    tabSay(s.enabled ? text : `${text}${isAdmin ? ' Turn it on, and give it a model server, in Admin → Findings.' : ''}`, error);
    $('fd-instructions').replaceChildren(sentBox('The instructions the model is given, with every transmission', s.instructions));
    await Promise.all([loadWatches(), list ? loadResults() : null]);
  } catch (e) {
    tabSay(e.message, true);
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
        ...Object.fromEntries(CONTEXT.map((k) => [k, $(`fd-${k}`).value])),
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
      foundList(t.found),
      t.sent ? sentBox('Sent to the model', t.sent, t.usage) : ''));
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
  const list = await api('/findings/watches');
  $('fd-watches').replaceChildren(...(list.length ? list.map((w) => el('li', {},
    el('div', { className: 'radio-head' },
      el('strong', {}, w.term),
      w.note ? el('span', { className: 'meta' }, ` ${w.note}`) : '',
      el('span', { className: 'pill' }, `${w.hits} match${w.hits === 1 ? '' : 'es'}`),
      !isAdmin ? '' : el('button', {
        className: 'link',
        onclick: async () => {
          try {
            await api(`/admin/findings/watches/${w.id}`, { method: 'DELETE' });
            await loadWatches();
          } catch (e) {
            tabSay(e.message, true);
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
    tabSay(e.message, true);
  }
};

// ---- What was found -------------------------------------------------------------

let oldest = null;   // paging: the start of the last row shown
let paged = false;   // More was pressed: don't reload the list from under the reader
let listFrom = null; // findings made from here on are put at the top as they come

function resultRow(r) {
  const marked = new Set(r.hits.map((h) => h.value));
  const li = el('li', {},
    el('div', { className: 'radio-head' },
      el('span', { className: 'meta' }, `${new Date(r.startedAt).toLocaleString()} · ${r.channel ?? 'channel unknown'}`),
      servicePill(r.found.service),
      r.found.incident ? el('span', { className: 'pill' }, r.found.incident) : '',
      r.static ? el('span', { className: 'pill tag-static', title: 'A weak signal: the transcript, and what was found in it, may be wrong' }, 'static') : '',
      ...r.hits.map((h) => el('span', { className: 'pill' }, `watch: ${h.term}`))),
    r.found.summary ? el('div', {}, el('strong', {}, r.found.summary)) : '',
    el('div', { className: 'meta' }, `“${r.text}”`),
    foundList(r.found, marked),
    ...corrections(r),
    el('audio', { controls: true, preload: 'none', src: withToken(`/api/transmissions/${r.id}/audio`) }),
    ...copiesOf(r, true),
    r.sent ? sentBox('Sent to the model', r.sent, r.usage) : '',
    roadsReady && (r.found.roads?.length || r.found.addresses?.length)
      ? el('div', {}, el('button', { className: 'link', onclick: () => showOnMap(r.id) }, 'On the map')) : '');
  li.dataset.id = String(r.id);
  return li;
}

/** The list's search and "watch matches only", as query parameters. */
function filters() {
  const params = new URLSearchParams({ limit: '50' });
  if ($('fd-q').value.trim()) params.set('q', $('fd-q').value.trim());
  if ($('fd-hits').checked) params.set('hits', '1');
  return params;
}

/** A clip in the list is playing: rebuilding it would stop it. */
const listPlaying = () => [...$('fd-results').querySelectorAll('audio')].some((a) => !a.paused);

async function loadResults(more = false) {
  const params = filters();
  if (more && oldest) params.set('before', String(oldest));
  const rows = await api(`/findings/results?${params}`);
  const items = rows.map(resultRow);
  if (more) $('fd-results').append(...items);
  else $('fd-results').replaceChildren(...(items.length ? items : [el('li', { className: 'meta' }, 'Nothing found yet.')]));
  if (rows.length) oldest = rows.at(-1).startedAt;
  paged = more;
  $('fd-more').hidden = rows.length < 50;
}

let searchTimer = null;
$('fd-q').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadResults().catch((e) => tabSay(e.message, true)), 300);
};
$('fd-hits').onchange = () => loadResults().catch((e) => tabSay(e.message, true));
$('fd-more').onclick = () => loadResults(true).catch((e) => tabSay(e.message, true));
$('fd-refresh').onclick = load;
$('fd-tab-refresh').onclick = loadTab;
// Kept up to date while it's showing, as the Map's roads are: findings aren't on the event stream. New ones go on
// top every few seconds (paged or not); the whole list is redone now and then for corrections to older ones.
setInterval(() => {
  if (!$('findings').hidden && !document.hidden) loadTab({ list: !paged && !listPlaying() });
}, 30_000);

async function pollResults() {
  if (listFrom === null || $('findings').hidden || document.hidden) return;
  const params = filters();
  params.set('after', String(listFrom));
  const list = $('fd-results');
  for (const r of await api(`/findings/results?${params}`)) {
    listFrom = Math.max(listFrom, r.madeAt + 1);
    // Read again: moved to the top; and no "Nothing found yet."
    list.querySelector(`:scope > li[data-id="${r.id}"]`)?.remove();
    list.querySelector(':scope > li.meta')?.remove();
    list.prepend(resultRow(r));
  }
}
setInterval(() => pollResults().catch(() => {}), 5000);

document.addEventListener('airscribe:signed-in', (e) => {
  isAdmin = e.detail?.role === 'admin';
  $('findings-toggle').hidden = !e.detail?.role;
  $('fd-watch-form').hidden = !isAdmin;
});

// ---- Roads mentioned, on the Map --------------------------------------------------
// Each road a finding mentions, near its channel, lit: redder the more recent, dashed where the name was only
// like one there (misheard, maybe); a dot where an address names a corner. Clicking one lists what was said
// about it. And the Map's Findings tab: what was found in the same hours, each able to frame its roads. For the
// signed-in, as the rest of Findings is.

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

function roadNote(text) {
  $('map-roads-note').textContent = text ?? '';
  $('map-roads-note').hidden = !text;
}

/** The colour of a road by the service that last mentioned it; how long ago is its fading (withAges). */
export const SERVICE_COLOURS = {
  police: '#3a7bff', fire: '#ff3b30', ems: '#f5c400', works: '#ff8c1a', amateur: '#b26bff', other: '#9aa0a6',
};
export const SERVICE_NAMES = {
  police: 'Police', fire: 'Fire', ems: 'EMS', works: 'Public works', amateur: 'Amateur', other: 'Other',
};
const RECENT = ['match', ['get', 'service'], ...Object.entries(SERVICE_COLOURS).flat(), SERVICE_COLOURS.other];
// Newest at full strength, the oldest in the hours chosen faint
const FADE = ['get', 'fade'];

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
    paint: { 'line-color': RECENT, 'line-opacity': ['*', 0.3, FADE], 'line-blur': 4, 'line-width': sized(2.5) } });
  m.addLayer({ id: 'fd-roads-line', type: 'line', source: SRC, filter: ['all', road, ['!=', ['get', 'level'], 'fuzzy']],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': RECENT, 'line-opacity': FADE, 'line-width': width } });
  m.addLayer({ id: 'fd-roads-maybe', type: 'line', source: SRC, filter: ['all', road, ['==', ['get', 'level'], 'fuzzy']],
    layout: { 'line-join': 'round' }, paint: { 'line-color': RECENT, 'line-opacity': FADE, 'line-width': width, 'line-dasharray': [1.5, 1.2] } });
  m.addLayer({ id: 'fd-roads-corner', type: 'circle', source: SRC, filter: ['==', ['get', 'kind'], 'corner'],
    paint: { 'circle-radius': 7, 'circle-color': RECENT, 'circle-opacity': FADE, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
      'circle-stroke-opacity': FADE } });
}

/** The features, each faded by how far back in the hours chosen it was last mentioned: 1 now, 0.35 at the start. */
function withAges(fc) {
  const now = Date.now();
  const span = Number($('map-roads-hours').value) * 3600_000;
  return { type: 'FeatureCollection', features: (fc?.features ?? []).map((f) => ({
    ...f, properties: { ...f.properties, fade: 1 - 0.65 * Math.min(1, Math.max(0, (now - f.properties.last) / span)) } })) };
}

/** A small coloured pill naming a service. */
const servicePill = (s) => (s ? el('span', { className: 'pill fd-service', style: `--svc: ${SERVICE_COLOURS[s] ?? SERVICE_COLOURS.other}` },
  SERVICE_NAMES[s] ?? s) : '');

// The key to the colours, on the Map's Findings tab
$('map-fd-legend').replaceChildren(...Object.keys(SERVICE_COLOURS).map((s) => el('span', { className: 'fd-swatch' },
  el('i', { style: `background: ${SERVICE_COLOURS[s]}` }), SERVICE_NAMES[s])));

async function loadRoads() {
  const m = mapCtx?.map;
  if (!m || $('map-fd-tab').hidden) return;
  if (!$('map-tab-fd').hidden) loadMapList().catch((e) => roadNote(e.message));
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
    mentioned = await api(`/findings/map?${p}`);
    roadNote(!mentioned.ways ? 'No roads yet: fetch or import them in Admin → Findings → Roads.'
      : mentioned.features.features.length ? null : 'No roads mentioned in that time.');
  } catch (e) {
    mentioned = null;
    roadNote(`Roads mentioned: ${e.message}`);
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
      p.ids.length > 8 ? el('div', { className: 'meta' }, `and ${p.ids.length - 8} more, on the Findings tab`) : '');
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

/** The Map's Findings tab: what was found in the hours chosen, newest first. */
async function loadMapList() {
  const since = Date.now() - Number($('map-roads-hours').value) * 3600_000;
  const [rows, status] = await Promise.all([
    api(`/findings/results?${new URLSearchParams({ since: String(Math.round(since)), limit: '100' })}`), api('/findings')]);
  roadsReady = status.roads;
  $('map-fd-list').replaceChildren(...(rows.length ? rows.map((r) => el('li', {},
    el('div', { className: 'radio-head' },
      el('span', { className: 'meta' }, `${new Date(r.startedAt).toLocaleTimeString()} · ${r.channel ?? 'channel unknown'}`),
      servicePill(r.found.service),
      r.found.incident ? el('span', { className: 'pill' }, r.found.incident) : '',
      r.static ? el('span', { className: 'pill tag-static', title: 'A weak signal: the transcript may be wrong' }, 'static') : '',
      ...r.hits.map((h) => el('span', { className: 'pill' }, `watch: ${h.term}`)),
      roadsReady && (r.found.roads?.length || r.found.addresses?.length)
        ? el('button', { className: 'link', onclick: () => frame(r.id) }, 'Show') : ''),
    r.found.summary ? el('div', {}, el('strong', {}, r.found.summary)) : '',
    foundList(r.found, new Set(r.hits.map((h) => h.value))),
    ...corrections(r),
    el('div', { className: 'meta tx-text' }, `“${r.text}”`),
    el('audio', { controls: true, preload: 'none', src: withToken(`/api/transmissions/${r.id}/audio`) }),
    ...copiesOf(r, false)))
    : [el('li', { className: 'meta' }, 'Nothing found in that time.')]));
}

/** On the Map already: light the roads, and frame those one transmission mentions. */
function frame(id) {
  focusId = id;
  $('map-roads').checked = true;
  keep(ROADS_KEY, '1');
  loadRoads();
}

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
// Kept up to date while it's showing: findings aren't on the event stream
setInterval(() => {
  if (document.getElementById('mapview').hidden || document.hidden) return;
  if ($('map-roads').checked || !$('map-tab-fd').hidden) loadRoads();
}, 30_000);
document.addEventListener('airscribe:map-tab', (e) => {
  if (e.detail === 'fd' && mapCtx) loadRoads();
});

// Loaded when Admin or the Findings tab is opened (views.js switches the page), and the roads when the Map is
document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'admin') load();
  if (e.detail === 'findings') loadTab();
  if (e.detail === 'mapview' && mapCtx) loadRoads();
});

// ---- Speak new findings ---------------------------------------------------------
// Each finding made while it's on, its channel and summary read out by the browser's own speech, one after another,
// after any clip that's playing (the feed's Play new waits for it in turn). Findings aren't on the event stream, so
// it asks for new ones every few seconds. For the signed-in, in this browser.

const SPEAK_KEY = 'airscribe.findings.speak';
const VOICE_KEY = 'airscribe.findings.voice';
const SPEAK_MS = 5000;
const speech = window.speechSynthesis ?? null;
const speakQueue = [];
const spoken = new Set();   // transmissions already read out, so one read again isn't said twice
let speakFrom = null;       // findings made from then on are said
let speakTimer = null;
let speakBusy = false;
let signedIn = false;

const speakBoxes = () => [...document.querySelectorAll('.fd-speak')];
const speaking = () => signedIn && Boolean(speech) && $('fd-speak').checked;

function speakState(text = '') {
  const waiting = speakQueue.length;
  const s = text || (!speaking() ? '' : waiting ? `(${waiting} waiting)` : speech.speaking ? '(speaking)' : '');
  for (const e of document.querySelectorAll('.fd-speak-state')) e.textContent = s;
}

/** What's said: the channel and the summary; nothing for a finding with nothing in it. */
function utterance(r) {
  const summary = String(r.found?.summary ?? '').trim();
  if (!summary) return '';
  // A plate is said letter by letter
  const plates = (r.found.plates ?? []).filter(Boolean);
  let s = summary;
  for (const p of plates) s = s.replaceAll(p, p.split('').join(' '));
  return `${r.channel ?? 'Unknown channel'}${r.static ? ', through static' : ''}: ${s}`;
}

function sayNext() {
  if (!speaking() || speech.speaking || speakBusy) return;
  // A clip playing, by hand or the feed's: after it
  if ([...document.querySelectorAll('audio')].some((a) => !a.paused && !a.ended)) {
    setTimeout(sayNext, 500);
    return;
  }
  const text = speakQueue.shift();
  if (!text) return speakState();
  const u = new SpeechSynthesisUtterance(text);
  const voice = speech.getVoices().find((v) => v.voiceURI === $('fd-voice').value);
  if (voice) u.voice = voice;
  speakBusy = true;
  u.onend = u.onerror = (e) => {
    speakBusy = false;
    if (e.error === 'not-allowed') {
      // The browser wants a click on the page before it speaks
      setSpeak(false);
      speakState('(blocked by the browser: tick it again)');
      return;
    }
    speakState();
    setTimeout(sayNext, 300);
  };
  speech.speak(u);
  speakState();
}

async function pollSpoken() {
  if (!speaking()) return;
  try {
    if (speakFrom === null) speakFrom = (await api('/findings')).latestAt + 1;
    const rows = await api(`/findings/results?${new URLSearchParams({ after: String(speakFrom), limit: '50' })}`);
    for (const r of rows) {
      speakFrom = Math.max(speakFrom, r.madeAt);
      if (spoken.has(r.id)) continue;
      spoken.add(r.id);
      const text = utterance(r);
      if (text) speakQueue.push(text);
    }
    // Away a while: the latest few, not a backlog
    speakQueue.splice(0, Math.max(0, speakQueue.length - 5));
    speakState();
    sayNext();
  } catch {
    // Tried again at the next tick
  }
}

function setSpeak(on) {
  for (const b of speakBoxes()) b.checked = on;
  keep(SPEAK_KEY, on ? '1' : '0');
  clearInterval(speakTimer);
  speakTimer = null;
  speakQueue.length = 0;
  if (!on) {
    speech?.cancel();
    speakBusy = false;
    speakState();
    return;
  }
  if (!signedIn) return;
  // From now: what was found before isn't read out
  speakFrom = null;
  speakTimer = setInterval(pollSpoken, SPEAK_MS);
  pollSpoken();
  speakState();
}

function listVoices() {
  const want = recall(VOICE_KEY, '');
  const lang = (navigator.language || 'en').slice(0, 2);
  const voices = (speech?.getVoices() ?? []).filter((v) => v.lang.startsWith(lang));
  $('fd-voice').replaceChildren(el('option', { value: '' }, 'Browser’s voice'),
    ...voices.map((v) => el('option', { value: v.voiceURI }, `${v.name}${v.localService ? '' : ' (online)'}`)));
  $('fd-voice').value = voices.some((v) => v.voiceURI === want) ? want : '';
}

if (speech) {
  listVoices();
  speech.addEventListener?.('voiceschanged', listVoices);
  for (const b of speakBoxes()) {
    b.onchange = () => {
      setSpeak(b.checked);
      // Said at once, from the click: browsers let a page speak after that
      if (b.checked) speech.speak(new SpeechSynthesisUtterance('Speaking new findings'));
    };
  }
  $('fd-voice').onchange = () => keep(VOICE_KEY, $('fd-voice').value);
} else {
  for (const b of speakBoxes()) (b.disabled = true, b.parentElement.title = 'This browser can’t speak');
  $('fd-voice').hidden = true;
}

document.addEventListener('airscribe:signed-in', (e) => {
  signedIn = Boolean(e.detail?.role);
  setSpeak(signedIn && Boolean(speech) && recall(SPEAK_KEY, '0') === '1');
});
