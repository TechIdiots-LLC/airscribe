// The Map view: each channel at the place an admin gave it, lit while a radio
// is receiving on it and pulsing when its transmission has been saved. Beside
// it, what is being said, newest first; and for a few seconds, the words at the
// channel on the map. Channels close enough to cover each other at the zoom
// shown are drawn as one marker naming them all. An admin places a channel by
// hand, or with Find, which looks its frequency up in RadioReference.
// MapLibre (public/vendor, through the import map in index.html) is imported
// only when the view is first opened.
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

/** @returns {Promise<Response>} The response, or throws with the server's reason. */
async function request(path, opts = {}) {
  const res = await fetch(withToken(`/api${path}`), {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res;
}

async function api(path, opts = {}) {
  const res = await request(path, opts);
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

/** A choice remembered in this browser: a convenience, so a blocked store is no matter. */
function recall(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

const STYLE_KEY = 'airscribe.mapStyle';
let maplibregl = null;
let map = null;
let role = null;          // an admin may place and move channels
let channels = [];
let placing = null;       // the channel the next click on the map places
let lookupReady = false;  // Uniden's database or RadioReference is set up in Admin, so Find can work
let finding = null;       // the channel Find is looking up, with its numbered places
let popup = null;         // the one popup open, so another replaces it
const markers = new Map(); // channel name -> {marker, element, channel}
const liveBy = new Map();  // radio mac -> the channel it is receiving on now
const radioMarkers = new Map(); // radio mac -> marker, where its GPS puts it
const radioNames = new Map();   // radio mac -> the name it was given
const pulsed = new Set();  // transmissions already pulsed for, so each pulses once

const isPlaced = (c) => c.lat !== null && c.lon !== null;
// Channels this browser keeps off the map: every one, or some by name
const CH_SHOW_KEY = 'airscribe.map.channels';
const CH_HIDDEN_KEY = 'airscribe.map.channelsHidden';
const hiddenChannels = new Set((() => {
  try { return JSON.parse(recall(CH_HIDDEN_KEY, '[]')); } catch { return []; }
})());
const isShown = (c) => isPlaced(c) && $('map-ch-show').checked && !hiddenChannels.has(c.name);
const mhz = (hz) => (hz ? `${(hz / 1e6).toFixed(4)} MHz` : '');

document.addEventListener('airscribe:signed-in', (e) => { role = e.detail?.role ?? null; });

function status(text) {
  $('map-status').textContent = text ?? '';
  $('map-status').hidden = !text;
}

/** @returns {Promise<void>} The map, made on first opening. */
async function open() {
  if (!map) {
    status('Loading the map…');
    document.head.append(el('link', { rel: 'stylesheet', href: 'vendor/maplibre-gl/maplibre-gl.css' }));
    maplibregl = await import('maplibre-gl');
    const { styles, lookup, rr, uniden } = await api('/map');
    canFind.rr = Boolean(rr ?? lookup);
    canFind.uniden = Boolean(uniden);
    lookupReady = canFind.rr || canFind.uniden;
    if (!styles.length) throw new Error('No base maps are set (map.styles in the settings file).');
    const chosen = recall(STYLE_KEY, null);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    // (dark && …) would be false in a light browser, which ?? doesn't pass over: no style at all
    const style = styles.find((s) => s.url === chosen) ?? (dark ? styles.find((s) => s.dark) : undefined) ?? styles[0];
    $('map-style').replaceChildren(...styles.map((s) => el('option', { value: s.url, selected: s === style }, s.name)));
    map = new maplibregl.Map({ container: 'map-canvas', style: style.url, attributionControl: false });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('click', onMapClick);
    map.on('zoomend', regroup);
    map.on('moveend', onMoved);
    map.on('error', (e) => {
      // A tile that didn't load is routine; a style that didn't is the map failing
      if (!e.sourceId) status(`The base map didn't load: ${e.error?.message ?? 'unknown error'}`);
    });
    map.once('load', () => {
      status(null);
      // The credits start folded behind their (i), which opens them, rather than across the map
      map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    });
    await loadChannels(true);
    // For what draws on it from elsewhere (Findings' roads, an admin's alone), once it's framed the channels
    document.dispatchEvent(new CustomEvent('airscribe:map', { detail: { map, maplibregl } }));
  } else {
    map.resize();
    await loadChannels(false);
  }
  // Loaded once, then kept up to date by the event stream
  if (!listOpen) loadList().catch(listError);
  // And the stations the radios' modems placed: on opening, or again for a station to show
  if (!stationsLoaded || showingStation) {
    stationsLoaded = true;
    await loadStations().catch((e) => status(e.message));
  }
}
let stationsLoaded = false;

$('map-style').onchange = () => {
  const url = $('map-style').value;
  remember(STYLE_KEY, url);
  map?.setStyle(url);   // the channel markers are separate from the style, so they stay
};

/**
 * @param {boolean} fit - Frame the placed channels (on first opening).
 * @returns {Promise<void>}
 */
async function loadChannels(fit) {
  channels = await api('/channels');
  const placed = channels.filter(isPlaced);
  for (const [name, m] of markers) {
    if (!placed.some((c) => c.name === name)) {
      m.marker.remove();
      markers.delete(name);
    }
  }
  for (const c of placed) placeMarker(c);
  if (fit && placed.length) {
    const b = new maplibregl.LngLatBounds();
    for (const c of placed) b.extend([c.lon, c.lat]);
    map.fitBounds(b, { padding: 80, maxZoom: 11, duration: 0 });
  }
  // Before anything is awaited, so markers that cover each other are never drawn so
  regroup();
  renderSide(placed);
  // The radios themselves, where their GPS puts them
  const radios = await api('/radios');
  for (const r of radios) {
    radioNames.set(r.mac, r.name);
    if (r.position) placeRadio(r.mac, r.position);
  }
  renderRadioFilter(radios);
  // A channel just placed becomes a link in the list, and a renamed radio shows its new name
  for (const t of listed.values()) placeListRow(t);
}

/** Draw a channel's marker, or move it. */
function placeMarker(c) {
  const have = markers.get(c.name);
  if (have) {
    have.marker.setLngLat([c.lon, c.lat]);
    have.channel = c;
    return;
  }
  const element = el('div', { className: 'ch-marker', title: c.name },
    el('span', { className: 'ring' }), el('span', { className: 'dot' }), el('span', { className: 'label' }, c.name),
    el('span', { className: 'bubble' }));
  const marker = new maplibregl.Marker({ element, draggable: role === 'admin', anchor: 'center' })
    .setLngLat([c.lon, c.lat])
    .addTo(map);
  // Moving one is an admin's: dropped where they leave it
  marker.on('dragend', async () => {
    const { lng, lat } = marker.getLngLat();
    try {
      await api(`/channels/${encodeURIComponent(c.name)}/place`, { method: 'PUT', body: { lat, lon: lng } });
    } catch (e) {
      alert(e.message);
    }
    // Where it is now decides what it covers
    await loadChannels(false);
  });
  element.addEventListener('click', (e) => {
    e.stopPropagation();
    showPopup(markers.get(c.name).channel);
  });
  markers.set(c.name, { marker, element, channel: c });
  decorate(c.name);
}

/**
 * A radio where its own GPS puts it: a square, to tell it from the channels.
 * @param {string} mac - The radio.
 * @param {{lat: number, lon: number}} pos - Its fix.
 * @returns {void}
 */
function placeRadio(mac, pos) {
  if (!map || !Number.isFinite(pos?.lat) || !Number.isFinite(pos?.lon)) return;
  const have = radioMarkers.get(mac);
  if (have) {
    have.setLngLat([pos.lon, pos.lat]);
    return;
  }
  const name = radioNames.get(mac) ?? mac;
  const element = el('div', { className: 'radio-marker', title: `${name}: from its GPS` },
    el('span', { className: 'square' }), el('span', { className: 'label' }, name));
  radioMarkers.set(mac, new maplibregl.Marker({ element, anchor: 'center' }).setLngLat([pos.lon, pos.lat]).addTo(map));
}

// ---- Channels that would cover each other ----------------------------------
// Several channels at one place (a public safety complex has police, fire and
// EMS) are one blot when zoomed out. They are drawn as one marker with a count
// and each name, a name lighting up while its channel is on the air. Clicking
// it zooms in until they part, or lists them when they're too close to.
// Worked out here rather than by MapLibre's clustering, which needs the
// channels as a map layer: the markers are elements, for the glow and pulse.

/** A group names this many channels, or one fewer and "+N more". */
const GROUP_NAMES = 4;
/** The most of a name drawn beside its dot (the rest shows on hover, or on the air): what grouping allows for. */
const LABEL_MAX = 110;
/** The furthest a group's click zooms in to part its channels. */
const SPLIT_ZOOM = 19;
let groups = [];               // the markers standing for several channels now
const groupOf = new Map();     // channel name -> its group, while it is in one

// Where a place falls on the Web Mercator square, 0 to 1 on each side; at
// zoom z the world is 512 * 2^z pixels across
const mercX = (lon) => (lon + 180) / 360;
function mercY(lat) {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

const measure = document.createElement('canvas').getContext('2d');
const widths = new Map();
/** @param {string} name - A channel. @returns {number} Its label's width in pixels, as the marker draws it. */
function labelWidth(name) {
  if (!widths.has(name)) {
    measure.font = '600 12px system-ui, sans-serif';
    widths.set(name, Math.min(LABEL_MAX, measure.measureText(name).width));
  }
  return widths.get(name);
}

/**
 * Whether two channels' markers would cover each other: their dots touch, or
 * the name drawn to the right of one runs into the other.
 * @param {{x: number, y: number, w: number}} a - One, in screen pixels, with its label's width.
 * @param {{x: number, y: number, w: number}} b - The other.
 * @returns {boolean} Whether they overlap.
 */
function covers(a, b) {
  const dx = b.x - a.x;
  const dy = Math.abs(b.y - a.y);
  if (Math.hypot(dx, dy) < 22) return true;
  if (dy >= 16) return false;
  return dx >= 0 ? dx < 24 + a.w : -dx < 24 + b.w;
}

/**
 * The channels that would cover one another at a zoom, gathered: any two that
 * overlap are together, and so is anything overlapping either of them.
 * @param {object[]} list - Placed channels.
 * @param {number} zoom - The zoom to judge at.
 * @returns {object[][]} The groups, each in name order, singles included.
 */
function cluster(list, zoom) {
  const scale = 512 * 2 ** zoom;
  const pts = [...list].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({
    c, x: mercX(c.lon) * scale, y: mercY(c.lat) * scale, w: labelWidth(c.name) }));
  const parent = pts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (covers(pts[i], pts[j])) parent[find(j)] = find(i);
    }
  }
  const out = new Map();
  pts.forEach((p, i) => {
    const root = find(i);
    if (!out.has(root)) out.set(root, []);
    out.get(root).push(p.c);
  });
  return [...out.values()];
}

/** @param {object[]} members - Channels. @returns {[number, number]} The middle of them. */
const middle = (members) => [
  members.reduce((s, c) => s + c.lon, 0) / members.length,
  members.reduce((s, c) => s + c.lat, 0) / members.length,
];

/** @returns {void} Draw each channel alone, or with those it would cover, at the zoom showing now. */
function regroup() {
  if (!map) return;
  const before = new Map(groups.map((g) => [g.key, g]));
  groupOf.clear();
  groups = [];
  // A hidden channel neither shows nor groups with those that do
  for (const m of markers.values()) if (!isShown(m.channel)) m.element.hidden = true;
  for (const members of cluster(channels.filter(isShown), map.getZoom())) {
    if (members.length === 1) {
      const m = markers.get(members[0].name);
      if (m) m.element.hidden = false;
      continue;
    }
    const key = members.map((c) => c.name).join('\n');
    const g = before.get(key) ?? makeGroup(key, members);
    before.delete(key);
    g.members = members;
    g.marker.setLngLat(middle(members));
    groups.push(g);
    for (const c of members) {
      groupOf.set(c.name, g);
      const m = markers.get(c.name);
      if (m) m.element.hidden = true;
    }
  }
  for (const g of before.values()) g.marker.remove();
  for (const g of groups) drawGroup(g);
  drawSaid();
}

/**
 * A marker for several channels: a count, and their names below one another.
 * @param {string} key - The channels' names, which identify it.
 * @param {object[]} members - The channels, in name order.
 * @returns {object} The group.
 */
function makeGroup(key, members) {
  const named = members.length > GROUP_NAMES ? members.slice(0, GROUP_NAMES - 1) : members;
  const names = el('span', { className: 'names' }, ...named.map((c) => {
    const nm = el('span', { className: 'nm' }, c.name);
    nm.dataset.name = c.name;
    return nm;
  }));
  if (named.length < members.length) names.append(el('span', { className: 'nm more' }, `+${members.length - named.length} more`));
  const element = el('div', { className: 'ch-group', title: members.map((c) => c.name).join(', ') },
    el('span', { className: 'ring' }), el('span', { className: 'badge' }, String(members.length)), names,
    el('span', { className: 'bubble' }));
  const g = { key, members, element, marker: null, named: named.length };
  g.marker = new maplibregl.Marker({ element, anchor: 'center' }).setLngLat(middle(members)).addTo(map);
  element.addEventListener('click', (e) => {
    e.stopPropagation();
    openGroup(g);
  });
  return g;
}

/**
 * Zoom in just far enough for a group's channels to part, a little further so
 * their names are clear of each other, and no further than keeps them all in
 * view where that can be done. Where they're too close to part (one building),
 * list them instead.
 * @param {object} g - The group.
 * @returns {void}
 */
function openGroup(g) {
  for (let z = map.getZoom() + 0.5; z <= SPLIT_ZOOM; z += 0.5) {
    if (cluster(g.members, z).length < 2) continue;
    const b = new maplibregl.LngLatBounds();
    for (const c of g.members) b.extend([c.lon, c.lat]);
    const fits = map.cameraForBounds(b, { padding: 40 })?.zoom ?? Infinity;
    map.easeTo({ center: middle(g.members), zoom: Math.min(SPLIT_ZOOM, z + 0.5, Math.max(z, fits)) });
    return;
  }
  showGroupPopup(g);
}

// ---- What a marker shows: on the air, playing, pointed at --------------------

let hovered = null;  // the channel of the transmission the pointer is over

/** @param {string} name - A channel. @returns {boolean} Whether a radio is receiving on it now. */
const isLive = (name) => [...liveBy.values()].includes(name);

/**
 * Bring a channel's marker, and the group it's in, up to date.
 * @param {string} name - The channel.
 * @returns {void}
 */
function decorate(name) {
  const m = markers.get(name);
  if (m) {
    m.element.classList.toggle('live', isLive(name));
    m.element.classList.toggle('playing', playingTx?.channel_name === name);
    m.element.classList.toggle('hl', hovered === name);
  }
  const g = groupOf.get(name);
  if (g) drawGroup(g);
}

/** @param {object} g - A group. @returns {void} Light it, and the names in it, for what its channels are doing. */
function drawGroup(g) {
  const live = new Set(liveBy.values());
  const playing = playingTx?.channel_name;
  const unnamed = g.members.slice(g.named).map((c) => c.name);
  const any = (names, test) => names.some(test);
  const all = g.members.map((c) => c.name);
  g.element.classList.toggle('live', any(all, (n) => live.has(n)));
  g.element.classList.toggle('playing', all.includes(playing));
  g.element.classList.toggle('hl', all.includes(hovered));
  for (const nm of g.element.querySelectorAll('.nm')) {
    const names = nm.dataset.name ? [nm.dataset.name] : unnamed;
    nm.classList.toggle('live', any(names, (n) => live.has(n)));
    nm.classList.toggle('playing', names.includes(playing));
    nm.classList.toggle('hl', names.includes(hovered));
  }
}

/** @param {string} name - A channel. @returns {HTMLElement | undefined} The marker it's drawn by now: its own, or its group's. */
const hostOf = (name) => groupOf.get(name)?.element ?? markers.get(name)?.element;

/** @param {string} name - A channel whose transmission has just been saved. @returns {void} */
function pulse(name) {
  const host = hostOf(name);
  if (!host) return;
  // Restarted rather than stacked when two arrive close together
  host.classList.remove('pulse');
  void host.offsetWidth;
  host.classList.add('pulse');
}

/**
 * Point at a channel on the map, while the pointer is over its transmission.
 * @param {string} name - The channel.
 * @param {boolean} on - Pointing or not.
 * @returns {void}
 */
function highlight(name, on) {
  const was = hovered;
  hovered = on ? name : hovered === name ? null : hovered;
  if (was && was !== hovered) decorate(was);
  if (hovered) decorate(hovered);
}

// ---- The words, at the channel, for a few seconds --------------------------

const said = new Map();     // channel -> {text, at, until}: the latest words, while shown
const saidFor = new Set();  // transmissions whose words have been shown, so each is once

/**
 * Show what a channel said at its marker, for longer the more there is.
 * @param {string} name - The channel.
 * @param {string} text - What it said.
 * @returns {void}
 */
function sayOnMap(name, text) {
  const ms = Math.min(20000, 6000 + text.length * 60);
  said.set(name, { text, at: Date.now(), until: Date.now() + ms });
  drawSaid();
  setTimeout(drawSaid, ms + 50);
}

/** @returns {void} Each marker with the latest words of its channels, and none once they're old. */
function drawSaid() {
  const now = Date.now();
  for (const [name, s] of said) if (s.until <= now) said.delete(name);
  const showing = new Map();  // marker element -> the words it carries
  if ($('map-words').checked) {
    for (const [name, s] of said) {
      const host = hostOf(name);
      if (host && !(showing.get(host)?.at > s.at)) showing.set(host, { name, ...s });
    }
  }
  for (const host of document.querySelectorAll('#map-canvas .saying')) {
    if (!showing.has(host)) host.classList.remove('saying');
  }
  for (const [host, s] of showing) {
    // A group says whose words they are
    host.querySelector('.bubble').replaceChildren(
      host.classList.contains('ch-group') ? el('b', {}, `${s.name}: `) : '', s.text);
    host.classList.add('saying');
  }
}

// ---- Popups ---------------------------------------------------------------

/**
 * @param {object} t - A transmission.
 * @returns {{text: string, state: string}} What it said, as the feed shows it: the default
 *   engine's transcript, or how far that has got.
 */
function words(t) {
  // A packet the radio's modem decoded: what it said
  if (t.data) return { text: (t.packets ?? []).map((p) => `${p.source}: ${p.summary}`).join(' · ') || '(packet)', state: 'silent' };
  // Static, by how it measured: what a model made of the hiss isn't shown
  if (t.static) return { text: '(static)', state: 'silent' };
  const scripts = t.transcripts ?? [];
  const s = scripts.find((x) => x.engine === t.engine) ?? scripts[0] ?? t;
  if (s.status === 'pending') return { text: 'transcribing…', state: 'pending' };
  if (s.status === 'error') return { text: `transcription failed: ${s.error}`, state: 'error' };
  const text = (s.text ?? '').trim();
  return text ? { text, state: '' } : { text: '(no speech recognised)', state: 'silent' };
}

/** When, as briefly as it can be said: the time today, the date and time before. */
function when(ms) {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** @returns {object} A popup with this content, replacing any other. */
function openPopup(lngLat, body) {
  popup?.remove();
  popup = new maplibregl.Popup({ offset: 14, maxWidth: '360px' }).setLngLat(lngLat).setDOMContent(body).addTo(map);
  return popup;
}

/** What a channel has said lately, and what can be done with it. */
async function showPopup(c) {
  const body = el('div', { className: 'ch-popup' },
    el('strong', {}, c.name), el('div', { className: 'meta' },
      [mhz(c.hz), `${c.count.toLocaleString()} transmissions`, `last ${new Date(c.last).toLocaleString()}`]
        .filter(Boolean).join(' · ')),
    el('ul', { className: 'ch-latest' }, el('li', { className: 'meta' }, 'Loading…')));
  const actions = el('div', { className: 'actions' },
    el('button', { onclick: () => { mine.remove(); setFocus([c.name]); } }, 'Show in the list'),
    el('button', { onclick: () => openFeed(c.name) }, 'Open in feed'));
  if (role === 'admin') {
    if (findable(c)) {
      actions.append(el('button', { title: 'Look it up in Uniden’s database or RadioReference', onclick: () => { mine.remove(); find(c); } }, 'Find'));
    }
    actions.append(
      // A channel at the same spot as another can't be dragged out from
      // under it, so it can be placed again with a click instead
      el('button', { onclick: () => { mine.remove(); startPlacing(c.name); } }, 'Move'),
      el('button', {
        onclick: async () => {
          if (!confirm(`Take ${c.name} off the map?`)) return;
          try { await api(`/channels/${encodeURIComponent(c.name)}/place`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
          mine.remove();
          await loadChannels(false);
        },
      }, 'Remove from map'));
  }
  body.append(actions);
  const mine = openPopup([c.lon, c.lat], body);
  try {
    const latest = await api(`/transmissions?channel=${encodeURIComponent(c.name)}&limit=3`);
    body.querySelector('.ch-latest').replaceChildren(...(latest.length ? latest : [null]).map((t) => (t
      ? el('li', {}, el('span', { className: 'meta' }, `${new Date(t.started_at).toLocaleTimeString()} `),
        words(t).state === 'silent' ? el('em', { className: 'meta' }, words(t).text) : words(t).text)
      : el('li', { className: 'meta' }, 'Nothing yet.'))));
  } catch (e) {
    body.querySelector('.ch-latest').replaceChildren(el('li', { className: 'tx-text error' }, e.message));
  }
}

/**
 * The channels of a group too close together to part: each with what it last
 * said, opening its own popup.
 * @param {object} g - The group.
 * @returns {Promise<void>}
 */
async function showGroupPopup(g) {
  const names = g.members.map((c) => c.name);
  const lines = new Map();
  const list = el('ul', { className: 'ch-latest ch-group-list' }, ...g.members.map((c) => {
    const line = el('div', { className: 'meta' }, 'Loading…');
    lines.set(c.name, line);
    return el('li', {},
      el('div', {},
        el('button', { className: 'link', onclick: () => showPopup(c) }, c.name),
        el('span', { className: 'meta' }, ` ${mhz(c.hz)}`),
        isLive(c.name) ? el('span', { className: 'on-air' }, ' on the air') : ''),
      line);
  }));
  const body = el('div', { className: 'ch-popup' },
    el('strong', {}, `${names.length} channels here`), list,
    el('div', { className: 'actions' },
      el('button', { onclick: () => { mine.remove(); setFocus(names); } }, 'Show these in the list')));
  const mine = openPopup(g.marker.getLngLat(), body);
  await Promise.all(g.members.map(async (c) => {
    try {
      const [t] = await api(`/transmissions?channel=${encodeURIComponent(c.name)}&limit=1`);
      lines.get(c.name).replaceChildren(t ? `${when(t.started_at)} · ${words(t).text}` : 'Nothing yet.');
    } catch (e) {
      lines.get(c.name).textContent = e.message;
    }
  }));
}

/** The feed, filtered to one channel. */
function openFeed(name) {
  $('filter-channel').value = name;
  $('filter-channel').dispatchEvent(new Event('change'));
  showView('main');
}

/** A channel on the map, from the list: flown to, with its popup. */
function goTo(c) {
  map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 12) });
  showPopup(c);
  // On a phone the list is under the map
  $('map-canvas').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- The Channels tab: placing them -----------------------------------------

function renderSide(placed) {
  const all = $('map-ch-show').checked;
  $('map-ch-all').hidden = !(all && placed.some((c) => hiddenChannels.has(c.name)));
  $('map-placed').replaceChildren(...(placed.length ? placed.map((c) => el('li', {},
    el('input', {
      type: 'checkbox', checked: !hiddenChannels.has(c.name), disabled: !all,
      title: 'Show it on the map', ariaLabel: `Show ${c.name} on the map`,
      onchange: (e) => showChannel(c.name, e.target.checked),
    }),
    el('button', { className: 'link', onclick: () => goTo(c) }, c.name),
    el('span', { className: 'meta' }, ` ${mhz(c.hz)}`)))
    : [el('li', { className: 'meta' }, 'None yet.')]));
  const unplaced = channels.filter((c) => !isPlaced(c));
  $('map-unplaced').replaceChildren(...(unplaced.length ? unplaced.map((c) => el('li', {},
    el('span', {}, c.name), el('span', { className: 'meta' }, ` ${mhz(c.hz)} `),
    role === 'admin' && findable(c)
      ? el('button', { className: finding?.name === c.name ? 'active' : '', title: 'Look it up in Uniden’s database or RadioReference',
        onclick: () => find(c) }, 'Find')
      : '',
    role === 'admin'
      ? el('button', { className: placing === c.name ? 'active' : '', onclick: () => startPlacing(c.name) },
        placing === c.name ? 'Click the map…' : 'Place')
      : ''))
    : [el('li', { className: 'meta' }, channels.length ? 'Every channel is placed.' : 'No channels heard yet.')]));
  $('map-find-hint').hidden = !(role === 'admin' && !lookupReady && unplaced.length);
  $('map-find-all').hidden = !(role === 'admin' && unplaced.some(findable));
  $('map-find-all').classList.toggle('active', Boolean(finding?.all));
}

/** Keep one channel on the map in this browser, or off it. */
function showChannel(name, on) {
  if (on) hiddenChannels.delete(name);
  else hiddenChannels.add(name);
  remember(CH_HIDDEN_KEY, JSON.stringify([...hiddenChannels]));
  if (!on) popup?.remove();
  regroup();
  renderSide(channels.filter(isPlaced));
}

$('map-ch-show').checked = recall(CH_SHOW_KEY, '1') === '1';
$('map-ch-show').onchange = () => {
  remember(CH_SHOW_KEY, $('map-ch-show').checked ? '1' : '0');
  if (!$('map-ch-show').checked) popup?.remove();
  regroup();
  renderSide(channels.filter(isPlaced));
};
$('map-ch-all').onclick = () => {
  hiddenChannels.clear();
  remember(CH_HIDDEN_KEY, '[]');
  regroup();
  renderSide(channels.filter(isPlaced));
};

$('map-find-admin').onclick = () => showView('admin');
$('map-find-all').onclick = () => findAll();

/** The next click on the map puts this channel there; asked again, or Esc, cancels. */
function startPlacing(name) {
  if (finding && placing !== name) closeFinder();   // one way of placing at a time
  placing = placing === name ? null : name;
  map.getCanvas().style.cursor = placing ? 'crosshair' : '';
  status(placing ? `Click the map where ${placing} is, or press Esc to cancel.` : null);
  renderSide(channels.filter(isPlaced));
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (placing) startPlacing(placing);
  else if (finding) closeFinder();
});

async function onMapClick(e) {
  if (!placing) return;
  const name = placing;
  placing = null;
  map.getCanvas().style.cursor = '';
  status(null);
  try {
    await api(`/channels/${encodeURIComponent(name)}/place`, { method: 'PUT', body: { lat: e.lngLat.lat, lon: e.lngLat.lng } });
  } catch (err) {
    alert(err.message);
  }
  await loadChannels(false);
}

// ---- Find: where Uniden's database and RadioReference say a channel is -----------
// Uniden's database (Admin, from a scanner's SD card) by the channel's name, frequency or talkgroup, near home;
// RadioReference by its frequency near the ZIP code set in Admin. Each place it might be is numbered, in the list
// and on the map, best first; Place here puts it there. Find all does every channel not placed, ticking those
// Uniden's database is sure of, to place at once. Admins only, as placing is.

const canFind = { rr: false, uniden: false };   // set up in Admin
document.addEventListener('airscribe:lookup', (e) => {
  canFind[e.detail?.source ?? 'rr'] = Boolean(e.detail?.ready);
  lookupReady = canFind.rr || canFind.uniden;
  if (map) renderSide(channels.filter(isPlaced));
});

/** @param {object} c - A channel. @returns {boolean} Whether Find has something to look it up by. */
const findable = (c) => lookupReady && (Boolean(c.hz) || canFind.uniden);

/** @param {number} km - Kilometres. @returns {string} In miles, as the databases' ranges are. */
const miles = (km) => `${(km / 1.609344).toFixed(km < 16 ? 1 : 0)} mi`;

function closeFinder() {
  for (const m of finding?.markers ?? []) m.remove();
  finding = null;
  $('map-find').hidden = true;
  $('map-find').replaceChildren();
  if (map) renderSide(channels.filter(isPlaced));
}

/** @param {object} r - /lookup's answer. @returns {object[]} Every place, Uniden's first. */
const placesIn = (r) => [...(r.uniden?.candidates ?? []), ...(r.rr?.candidates ?? [])];

/** @param {object} c - The channel. @returns {Promise<void>} Its places, listed. */
async function find(c) {
  closeFinder();
  if (placing) startPlacing(placing);   // one way of placing at a time
  showTab('ch');
  const mine = { name: c.name, markers: [], items: [] };
  finding = mine;
  renderSide(channels.filter(isPlaced));
  const head = el('div', { className: 'row' },
    el('strong', {}, `Find ${c.name}`), el('span', { className: 'meta' }, mhz(c.hz)),
    el('span', { className: 'spacer' }), el('button', { onclick: closeFinder }, 'Close'));
  $('map-find').hidden = false;
  $('map-find').replaceChildren(head, el('p', { className: 'meta' }, 'Looking it up…'));
  $('map-find').scrollIntoView({ block: 'nearest' });
  let found;
  try {
    found = await api(`/channels/${encodeURIComponent(c.name)}/lookup`);
  } catch (e) {
    if (finding === mine) $('map-find').replaceChildren(head, el('p', { className: 'tx-text error' }, e.message));
    return;
  }
  if (finding === mine) showFound(c, found, head);   // unless closed, or another looked up, meanwhile
}

/** @param {number} i - Which place. @param {boolean} on - Pointed at, or not. */
function markFound(i, on) {
  finding?.items[i]?.classList.toggle('hl', on);
  finding?.markers[i]?.getElement().classList.toggle('hl', on);
}

/** A numbered marker for a place found, pointing at its row. */
function foundMarker(k, i) {
  const e = el('div', { className: 'find-marker', title: k.title }, el('span', {}, String(i + 1)));
  e.addEventListener('click', (ev) => {
    ev.stopPropagation();
    finding?.items[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  e.addEventListener('mouseenter', () => markFound(i, true));
  e.addEventListener('mouseleave', () => markFound(i, false));
  return new maplibregl.Marker({ element: e }).setLngLat([k.lon, k.lat]).addTo(map);
}

function showFound(c, r, head) {
  const parts = [head];
  const all = placesIn(r);
  const from = r.rr?.area?.zip ?? 'home';
  if (r.uniden) {
    const n = r.uniden.candidates.length;
    parts.push(el('p', { className: 'meta' }, n
      ? `Uniden’s database${r.uniden.date ? ` (${r.uniden.date.split(' ')[0]})` : ''}: ${n === 1 ? 'one place' : `${n} places`}` +
        `${r.uniden.confident ? ', and the first is surely it' : ', best match first'}.`
      : 'Nothing near here in Uniden’s database by its name, frequency or talkgroup.'));
  }
  if (r.rr) {
    const county = `the county of ${r.rr.area.zip}${r.rr.area.city ? ` (${r.rr.area.city})` : ''}`;
    const where = r.rr.scope === 'state' ? `in the state, with nothing in ${county}` : `in ${county}`;
    const n = r.rr.candidates.length;
    parts.push(el('p', { className: 'meta' }, !r.rr.listings
      ? `RadioReference has nothing on ${r.rr.mhz} MHz in ${county}${r.rr.scope === 'state' ? ', or anywhere in the state' : ''}.`
      : !n ? `RadioReference lists ${r.rr.mhz} MHz ${where}, but has no place for it.`
      : `RadioReference: ${n === 1 ? 'one place' : `${n} places`}, from ${r.rr.listings === 1 ? 'one listing' : `${r.rr.listings} listings`} ` +
        `of ${r.rr.mhz} MHz ${where}${n > 1 ? ', best match first' : ''}.`));
  } else if (r.rrError) {
    parts.push(el('p', { className: 'meta' }, `RadioReference: ${r.rrError}`));
  }
  if (!all.length) {
    parts.push(el('p', { className: 'meta' }, 'It can be placed by hand instead.'));
  } else {
    finding.items = all.map((k, i) => foundItem(c, k, i, from));
    parts.push(el('ul', { className: 'find-list' }, ...finding.items));
    // Numbered on the map too, framed with where the channel is now
    const bounds = new maplibregl.LngLatBounds();
    all.forEach((k, i) => {
      finding.markers.push(foundMarker(k, i));
      bounds.extend([k.lon, k.lat]);
    });
    if (isPlaced(c)) bounds.extend([c.lon, c.lat]);
    map.fitBounds(bounds, { padding: 80, maxZoom: 15 });
  }
  if (r.rr) {
    parts.push(el('p', { className: 'credit' }, 'Data courtesy of ',
      el('a', { href: 'https://www.radioreference.com', target: '_blank', rel: 'noopener' }, 'RadioReference.com')));
  }
  $('map-find').replaceChildren(...parts);
}

/** @param {object} k - A place found. @returns {string} What it is, and why it's offered. */
function foundWhat(k) {
  if (k.kind === 'uniden') {
    return `${k.where}${k.site ? `, the site ${k.site}` : ''}: Uniden’s database${k.range ? `, about ${k.range} mi around` : ''}`;
  }
  if (k.kind === 'fcc') {
    return `FCC licence ${k.callsign}${k.licensee ? `, ${k.licensee}` : ''}: ${k.address || 'a licensed site'}` +
      (k.onFrequency ? '' : '. The licence doesn’t say this frequency is sent from there.');
  }
  return k.countyWide
    ? `${k.where || 'The county'}: the middle of the county, as RadioReference has no closer place for it`
    : `${k.where}: the area RadioReference gives it${k.range ? `, about ${k.range} mi around` : ''}`;
}

/**
 * One place a channel might be.
 * @param {object} c - The channel.
 * @param {object} k - The candidate, as /lookup gives it.
 * @param {number} i - Its place in the list.
 * @param {string} from - Where distances are from.
 * @returns {HTMLElement} Its row.
 */
function foundItem(c, k, i, from) {
  const facts = [k.alpha && k.alpha !== k.title ? k.alpha : '', k.tone, k.tgid ? `talkgroup ${k.tgid}` : '',
    k.km === null || k.km === undefined ? '' : `${miles(k.km)} from ${from}`].filter(Boolean).join(' · ');
  const li = el('li', {},
    el('div', { className: 'find-head' },
      el('span', { className: 'find-n' }, String(i + 1)),
      el('button', {
        className: 'link', title: 'Show it on the map',
        onclick: () => map.flyTo({ center: [k.lon, k.lat], zoom: Math.max(map.getZoom(), 15) }),
      }, k.title),
      el('button', { onclick: () => placeFound(c, k) }, 'Place here')),
    el('div', { className: 'meta' }, foundWhat(k)),
    facts ? el('div', { className: 'meta' }, facts) : '');
  li.addEventListener('mouseenter', () => markFound(i, true));
  li.addEventListener('mouseleave', () => markFound(i, false));
  return li;
}

async function placeFound(c, k) {
  try {
    await api(`/channels/${encodeURIComponent(c.name)}/place`, { method: 'PUT', body: { lat: k.lat, lon: k.lon } });
  } catch (e) {
    alert(e.message);
    return;
  }
  closeFinder();
  await loadChannels(false);
  const placed = channels.find((x) => x.name === c.name);
  if (placed && isPlaced(placed)) goTo(placed);
}

/**
 * Every channel not placed, looked up one after another: each with the best place found, ticked when Uniden's
 * database is sure of it, and placed together.
 * @returns {Promise<void>}
 */
async function findAll() {
  closeFinder();
  if (placing) startPlacing(placing);
  showTab('ch');
  const todo = channels.filter((c) => !isPlaced(c) && findable(c));
  const mine = { name: null, all: true, markers: [], items: [], rows: [] };
  finding = mine;
  renderSide(channels.filter(isPlaced));
  const count = el('span', { className: 'meta' });
  const place = el('button', { disabled: true, onclick: () => placeTicked(mine) }, 'Place the ticked');
  const head = el('div', { className: 'row' }, el('strong', {}, 'Find all'), count,
    el('span', { className: 'spacer' }), el('button', { onclick: closeFinder }, 'Close'));
  const list = el('ul', { className: 'find-list find-all' });
  $('map-find').hidden = false;
  $('map-find').replaceChildren(head, el('p', { className: 'meta' },
    'Each channel not placed, with the best place found for it. Those Uniden’s database is sure of (the channel’s ' +
    'own name, and its frequency or department) are ticked; check the others, or open one to see every place.'),
    list, el('div', { className: 'row' }, place));
  $('map-find').scrollIntoView({ block: 'nearest' });
  const bounds = new maplibregl.LngLatBounds();
  let done = 0;
  for (const c of todo) {
    if (finding !== mine) return;   // closed, or another Find started
    const status = el('div', { className: 'meta' }, 'Looking it up…');
    const li = el('li', {}, el('div', { className: 'what' }, el('strong', {}, c.name), el('span', { className: 'meta' }, ` ${mhz(c.hz)}`), status));
    list.append(li);
    count.textContent = `${++done} of ${todo.length}`;
    let r;
    try {
      r = await api(`/channels/${encodeURIComponent(c.name)}/lookup?quick=1`);
    } catch (e) {
      status.textContent = e.message;
      continue;
    }
    if (finding !== mine) return;
    const all = placesIn(r);
    const k = all[0];
    if (!k) {
      status.textContent = 'Nothing found.';
      continue;
    }
    const i = mine.rows.length;
    const box = el('input', { type: 'checkbox', checked: Boolean(r.uniden?.confident && k.kind === 'uniden'),
      title: 'Place it here', onchange: () => drawCount() });
    mine.rows.push({ c, k, box });
    mine.items[i] = li;
    li.prepend(box);
    status.replaceChildren(
      el('button', { className: 'link', title: 'Show it on the map', onclick: () => map.flyTo({ center: [k.lon, k.lat], zoom: Math.max(map.getZoom(), 14) }) },
        `${i + 1}. ${k.title}`),
      ` · ${foundWhat(k)}${k.km === null || k.km === undefined ? '' : ` · ${miles(k.km)} away`}`,
      all.length > 1 ? ' · ' : '', all.length > 1 ? el('button', { className: 'link', onclick: () => find(c) }, `${all.length - 1} more`) : '');
    li.addEventListener('mouseenter', () => markFound(i, true));
    li.addEventListener('mouseleave', () => markFound(i, false));
    mine.markers[i] = foundMarker(k, i);
    bounds.extend([k.lon, k.lat]);
    drawCount();
  }
  if (finding !== mine) return;
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 80, maxZoom: 13 });
  count.textContent = todo.length ? `${todo.length} looked up` : 'Every channel that can be looked up is placed.';

  function drawCount() {
    const n = mine.rows.filter((x) => x.box.checked).length;
    place.disabled = !n;
    place.textContent = n ? `Place the ${n} ticked` : 'Place the ticked';
  }
}

/** @param {object} mine - Find all's state. @returns {Promise<void>} Each ticked channel placed where it was found. */
async function placeTicked(mine) {
  const ticked = mine.rows.filter((x) => x.box.checked);
  const failed = [];
  for (const { c, k } of ticked) {
    try {
      await api(`/channels/${encodeURIComponent(c.name)}/place`, { method: 'PUT', body: { lat: k.lat, lon: k.lon } });
    } catch (e) {
      failed.push(`${c.name}: ${e.message}`);
    }
  }
  closeFinder();
  await loadChannels(false);
  if (failed.length) alert(failed.join('\n'));
}

// ---- The Transmissions tab: what is said, beside the map ----------------------
// The feed's transmissions, compact, newest first and live. For every channel,
// the channels in view, or those a popup chose ("Show in the list"); for one
// radio if asked, so a radio scanning amateur channels, whose conversations run
// long, can be left out while watching another scanning emergency services.

const LIST_PAGE = 50;
const LIST_CAP = 200;      // left open, the list keeps this many
const RADIO_KEY = 'airscribe.map.radio';
const INVIEW_KEY = 'airscribe.map.inView';
const SILENT_KEY = 'airscribe.map.hideSilent';
const WORDS_KEY = 'airscribe.map.words';
const TAB_KEY = 'airscribe.map.tab';
const listed = new Map();  // id -> transmission
const rows = new Map();    // id -> its <li>
let listOpen = false;      // loaded once; kept up to date from then on
let listCursor = null;     // where "Load older" starts, or null at the end
let listTotal = 0;         // how many match, for "50 of 1,234"
let listSeq = 0;           // the latest load: a slower, earlier answer is dropped
let listPagedBack = false; // older pages were asked for: keep them
let listScopeKey = '';     // the channels in view when it was loaded
let focus = null;          // the channels "Show in the list" chose, or null
const player = $('map-player');
let playingTx = null;      // the transmission the list is playing

$('map-inview').checked = recall(INVIEW_KEY, '0') === '1';
// Until it is chosen here, as the feed has it
$('map-hide-silent').checked = recall(SILENT_KEY, recall('airscribe.hideSilent', '0')) === '1';
$('map-words').checked = recall(WORDS_KEY, '1') === '1';

/** @returns {boolean} Whether `a` comes before `b`: newer, or the same moment and a later id. */
const newer = (a, b) => a.started_at > b.started_at || (a.started_at === b.started_at && a.id > b.id);

/** @returns {string[]} The placed channels within the part of the map showing. */
function inView() {
  const b = map.getBounds();
  return channels.filter((c) => isPlaced(c) && b.contains([c.lon, c.lat])).map((c) => c.name);
}

/** @returns {string[] | null} The channels the list keeps to: chosen, in view, or null for all. */
function listScope() {
  if (focus) return focus;
  if ($('map-inview').checked && map) return inView();
  return null;
}

/** @param {object[]} radios - The radios. @returns {void} The radio filter's choices, keeping the one chosen. */
function renderRadioFilter(radios) {
  const sel = $('map-radio');
  const cur = sel.options.length > 1 ? sel.value : recall(RADIO_KEY, '');
  sel.replaceChildren(el('option', { value: '' }, 'All radios'),
    ...radios.map((r) => el('option', { value: r.mac }, r.name)));
  sel.value = radios.some((r) => r.mac === cur) ? cur : '';
}

/**
 * Load the list's first page for its filter, or with `more`, the next older one.
 * @param {{more?: boolean}} [o] - Options.
 * @returns {Promise<void>}
 */
async function loadList({ more = false } = {}) {
  const seq = ++listSeq;
  const scope = listScope();
  if (scope && !scope.length) {
    // Asking for no channel in particular would be asking for all of them
    clearList();
    listOpen = true;
    listScopeKey = '';
    listCursor = null;
    listTotal = 0;
    drawListFoot();
    return;
  }
  const p = new URLSearchParams({ limit: String(LIST_PAGE) });
  if ($('map-radio').value) p.set('mac', $('map-radio').value);
  if ($('map-hide-silent').checked) p.set('speech', '1');
  for (const name of scope ?? []) p.append('channel', name);
  if (more && listCursor) p.set('before', listCursor);
  const res = await request(`/transmissions?${p}`);
  const got = await res.json();
  if (seq !== listSeq) return;   // the filter changed while this was on its way
  if (!more) clearList();
  listOpen = true;
  listScopeKey = scope ? scope.join('\n') : '';
  listPagedBack = more;
  listCursor = res.headers.get('X-Next-Before');
  listTotal = Number(res.headers.get('X-Total-Count')) || 0;
  for (const t of got) {
    listed.set(t.id, t);
    placeListRow(t);
  }
  drawListFoot();
}

const listError = (e) => { $('map-tx-count').textContent = e.message; };

function clearList() {
  listed.clear();
  rows.clear();
  $('map-tx').replaceChildren();
}

/** @returns {void} The count and "Load older" under the list. */
function drawListFoot() {
  const scope = listScope();
  $('map-tx-more').hidden = !listCursor;
  $('map-tx-count').textContent = listed.size
    ? `Showing ${listed.size.toLocaleString()} of ${Math.max(listTotal, listed.size).toLocaleString()}`
    : scope && !scope.length ? 'No channel on the map is in view: zoom out, or untick “In view only”.'
    : scope || $('map-radio').value || $('map-hide-silent').checked ? 'Nothing matches.'
    : 'No transmissions yet.';
}

/**
 * One transmission in the list: when, which channel (a link to it on the map
 * once placed), which radio, and what was said.
 * @param {object} t - The transmission.
 * @returns {HTMLLIElement} Its row.
 */
function renderListRow(t) {
  const c = channels.find((x) => x.name === t.channel_name);
  const where = t.channel_name || (t.channel === null || t.channel === undefined ? '' : `ch ${t.channel}`);
  const { text, state } = words(t);
  const playing = playingTx?.id === t.id;
  const li = el('li', { className: [t.transmit ? 'sent' : '', playing ? 'playing' : ''].join(' ').trim() },
    el('div', { className: 'mtx-head' },
      el('button', { className: 'play', title: playing ? 'Stop' : 'Play', onclick: () => play(t) }, playing ? '■' : '▶'),
      el('span', {}, when(t.started_at)),
      !where ? ''
        : c && isPlaced(c) ? el('button', { className: 'link chan', title: 'Show it on the map', onclick: () => goTo(c) }, where)
        : el('span', { className: 'chan', title: t.channel_name ? 'Not placed on the map' : '' }, where),
      el('span', {}, `${radioNames.get(t.mac) ?? t.radio_name ?? t.mac} · ${((t.duration_ms ?? 0) / 1000).toFixed(1)}s`)),
    el('div', { className: `tx-text ${state}` }, text));
  li.dataset.at = String(t.started_at);
  li.dataset.id = String(t.id);
  if (t.channel_name) {
    li.onmouseenter = () => highlight(t.channel_name, true);
    li.onmouseleave = () => highlight(t.channel_name, false);
  }
  return li;
}

/** @param {object} t - A transmission. @returns {void} Draw its row, or redraw it in place. */
function placeListRow(t) {
  const li = renderListRow(t);
  const old = rows.get(t.id);
  if (old) old.replaceWith(li);
  else {
    const list = $('map-tx');
    // Mostly new rows go first and older pages go last; look only otherwise
    const at = (n) => ({ started_at: Number(n.dataset.at), id: Number(n.dataset.id) });
    let next = list.firstElementChild;
    if (list.lastElementChild && newer(at(list.lastElementChild), t)) next = null;
    else while (next && newer(at(next), t)) next = next.nextElementSibling;
    list.insertBefore(li, next);
  }
  rows.set(t.id, li);
}

/**
 * Whether a transmission arriving live belongs in the list: the test the
 * server makes for a page.
 * @param {object} t - The transmission.
 * @returns {boolean} Whether to show it.
 */
function listMatches(t) {
  const mac = $('map-radio').value;
  if (mac && t.mac !== mac) return false;
  // Hiding no speech: a clip joins once it has words, rather than showing
  // while it's transcribed and vanishing if it turns out a chirp
  if ($('map-hide-silent').checked && (t.data || t.static || !(t.text ?? '').trim())) return false;
  const scope = listScope();
  return !scope || scope.includes(t.channel_name);
}

/** @param {object} t - A transmission that arrived or changed. @returns {void} */
function onListTransmission(t) {
  if (!listOpen) return;
  if (listed.has(t.id)) {
    if ($('map-hide-silent').checked && words(t).state === 'silent') return dropRow(t.id);
    listed.set(t.id, t);
    placeListRow(t);
    return;
  }
  if (!listMatches(t)) return;
  // Older than the pages loaded (an old clip transcribed again): not news
  const oldest = [...listed.values()].reduce((o, x) => (!o || newer(o, x) ? x : o), null);
  if (listCursor && oldest && !newer(t, oldest)) return;
  listed.set(t.id, t);
  listTotal += 1;
  placeListRow(t);
  trimList();
  drawListFoot();
}

/** @param {number} id - A transmission deleted. @returns {void} */
function dropRow(id) {
  if (!listed.has(id)) return;
  listed.delete(id);
  rows.get(id)?.remove();
  rows.delete(id);
  listTotal = Math.max(0, listTotal - 1);
  drawListFoot();
}

/** @returns {void} Keep a list left open from growing without end. */
function trimList() {
  if (listPagedBack || listed.size <= LIST_CAP) return;
  const all = [...listed.values()].sort((a, b) => (newer(a, b) ? -1 : 1));
  for (const t of all.slice(LIST_CAP)) {
    listed.delete(t.id);
    rows.get(t.id)?.remove();
    rows.delete(t.id);
  }
  const last = all[LIST_CAP - 1];
  listCursor = `${last.started_at}.${last.id}`;
}

/**
 * Play a transmission from the list, or stop it if it's the one playing. Its
 * channel is marked on the map meanwhile, so it can be seen where it came from.
 * @param {object} t - The transmission.
 * @returns {void}
 */
function play(t) {
  if (playingTx?.id === t.id) {
    player.pause();
    return;
  }
  setPlaying(t);
  player.src = withToken(`/api/transmissions/${t.id}/audio`);
  player.play().catch((e) => { if (e.name !== 'AbortError') setPlaying(null); });
}

/** @param {object | null} t - The transmission playing now, or null. @returns {void} */
function setPlaying(t) {
  const before = playingTx;
  playingTx = t;
  for (const x of [before, t]) {
    if (!x) continue;
    const li = rows.get(x.id);
    const on = x === t;
    if (li) {
      li.classList.toggle('playing', on);
      const b = li.querySelector('.play');
      b.textContent = on ? '■' : '▶';
      b.title = on ? 'Stop' : 'Play';
    }
    if (x.channel_name) decorate(x.channel_name);
  }
}

// Changing the clip pauses the last one on the way, after the new one has
// started; only a player that has really stopped ends what's marked
for (const type of ['pause', 'ended', 'error']) {
  player.addEventListener(type, () => {
    if (player.paused || player.ended || player.error) setPlaying(null);
  });
}

/** @param {string[] | null} names - Channels to keep the list to, or null for the usual. @returns {void} */
function setFocus(names) {
  focus = names?.length ? names : null;
  $('map-focus').hidden = !focus;
  $('map-focus-names').textContent = focus ? `Only ${focus.join(', ')}` : '';
  $('map-inview').disabled = Boolean(focus);
  if (focus) showTab('tx');
  loadList().catch(listError);
}

let movedTimer = null;
/** @returns {void} With "In view only", the map moved: list what's in view now. */
function onMoved() {
  if (focus || !$('map-inview').checked || !listOpen) return;
  clearTimeout(movedTimer);
  movedTimer = setTimeout(() => {
    if (inView().join('\n') !== listScopeKey) loadList().catch(listError);
  }, 300);
}

$('map-radio').onchange = () => {
  remember(RADIO_KEY, $('map-radio').value);
  loadList().catch(listError);
};
$('map-inview').onchange = () => {
  remember(INVIEW_KEY, $('map-inview').checked ? '1' : '0');
  loadList().catch(listError);
};
$('map-hide-silent').onchange = () => {
  remember(SILENT_KEY, $('map-hide-silent').checked ? '1' : '0');
  loadList().catch(listError);
};
$('map-words').onchange = () => {
  remember(WORDS_KEY, $('map-words').checked ? '1' : '0');
  drawSaid();
};
$('map-focus-clear').onclick = () => setFocus(null);
$('map-tx-more').onclick = async () => {
  $('map-tx-more').disabled = true;
  try { await loadList({ more: true }); } catch (e) { alert(e.message); }
  $('map-tx-more').disabled = false;
};

/** @param {'tx' | 'ch' | 'st' | 'fd'} name - Transmissions, Channels, Stations or Findings. @returns {void} */
function showTab(name) {
  for (const b of document.querySelectorAll('#map-side [data-tab]')) {
    b.classList.toggle('active', b.dataset.tab === name);
    $(`map-tab-${b.dataset.tab}`).hidden = b.dataset.tab !== name;
  }
  remember(TAB_KEY, name);
  document.dispatchEvent(new CustomEvent('airscribe:map-tab', { detail: name }));
}
for (const b of document.querySelectorAll('#map-side [data-tab]')) b.onclick = () => showTab(b.dataset.tab);
showTab(['ch', 'st', 'fd'].includes(recall(TAB_KEY, 'tx')) ? recall(TAB_KEY, 'tx') : 'tx');
// Findings' tab is only for the signed-in: back to Transmissions should it be hidden
document.addEventListener('airscribe:signed-in', (e) => {
  $('map-fd-tab').hidden = !e.detail?.role;
  if (!e.detail?.role && recall(TAB_KEY, 'tx') === 'fd') showTab('tx');
});

// ---- Stations: positions the radios' own modems decoded ----------------------------
// APRS stations, objects and the location these radios share with each other,
// each where its latest packet put it, within the hours chosen. Kept up to date
// by the event stream: a packet with a place moves its station, and lights it.

const ST_SHOW_KEY = 'airscribe.map.stations';
const ST_HOURS_KEY = 'airscribe.map.stationHours';
const stationMarkers = new Map();   // who -> {marker, element, station}
let stationList = [];               // the latest packet with a place, per station, newest first
let showingStation = null;          // a station to open once the map has its stations: {who, lat, lon}

$('map-st-show').checked = recall(ST_SHOW_KEY, '1') === '1';
$('map-st-hours').value = recall(ST_HOURS_KEY, '24');

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const stationHours = () => Number($('map-st-hours').value) || 24;

/** @returns {Promise<void>} The stations heard in the hours chosen, on the map and in the list. */
async function loadStations() {
  stationList = await api(`/stations?hours=${stationHours()}`);
  const keep = new Set(stationList.map((s) => s.who));
  for (const [who, m] of stationMarkers) {
    if (!keep.has(who) || !$('map-st-show').checked) {
      m.marker.remove();
      stationMarkers.delete(who);
    }
  }
  if ($('map-st-show').checked) for (const s of stationList) placeStation(s);
  renderStations();
  if (showingStation) {
    const want = showingStation;
    showingStation = null;
    goToStation(stationList.find((s) => s.who === want.who) ?? want);
  }
}

/** A station's marker: its symbol and its name. */
function placeStation(s) {
  if (!map || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return;
  const have = stationMarkers.get(s.who);
  if (have) {
    have.marker.setLngLat([s.lon, s.lat]);
    have.station = s;
    have.element.querySelector('.icon').textContent = s.symbol?.icon ?? '📍';
    return;
  }
  const element = el('div', { className: `st-marker${isMine(s) ? ' mine' : ''}`, title: `${s.who}: ${s.symbol?.name ?? 'station'}` },
    el('span', { className: 'icon' }, s.symbol?.icon ?? '📍'), el('span', { className: 'label' }, s.who));
  element.addEventListener('click', (e) => {
    e.stopPropagation();
    stationPopup(stationMarkers.get(s.who)?.station ?? s);
  });
  const marker = new maplibregl.Marker({ element, anchor: 'center' }).setLngLat([s.lon, s.lat]).addTo(map);
  stationMarkers.set(s.who, { marker, element, station: s });
}

/** What a station last said, and how it was heard. */
function stationPopup(s) {
  const facts = [];
  if (s.device) facts.push(s.device);
  if (s.speed >= 1) facts.push(`${Math.round(s.speed / 1.609344)} mph${s.course ? ` heading ${s.course}°` : ''}`);
  if (Number.isFinite(s.altitude)) facts.push(`${Math.round(s.altitude / 0.3048).toLocaleString()} ft up`);
  const wx = s.wx ? [
    s.wx.temp !== undefined ? `${Math.round((s.wx.temp * 9) / 5 + 32)}°F` : '',
    s.wx.windSpeed !== undefined ? `wind ${s.wx.windDirection ?? '?'}° at ${Math.round((s.wx.windSpeed * 3.6) / 1.609344)} mph` : '',
    s.wx.humidity !== undefined ? `${s.wx.humidity}% humidity` : '',
    s.wx.pressure !== undefined ? `${s.wx.pressure} hPa` : '',
  ].filter(Boolean).join(', ') : '';
  const radio = radioNames.get(s.mac) ?? s.mac;
  const body = el('div', { className: 'st-popup' },
    el('div', { className: 'row' }, el('span', { className: 'pk-icon' }, s.symbol?.icon ?? '📍'), el('strong', {}, s.who),
      el('span', { className: 'meta' }, s.symbol?.name ?? ''), isMine(s) ? el('span', { className: 'pill' }, 'you') : ''),
    s.who !== s.source ? el('p', { className: 'meta' }, `${s.type === 'object' || s.type === 'item' ? 'Placed' : 'Sent'} by ${s.source}`) : '',
    s.comment ? el('p', {}, s.comment) : '',
    s.micE && s.micE !== 'Off duty' ? el('p', { className: 'meta' }, s.micE) : '',
    wx ? el('p', {}, wx) : '',
    facts.length ? el('p', { className: 'meta' }, facts.join(' · ')) : '',
    el('p', { className: 'meta' }, `${s.format === 'bss' ? 'Shared location' : 'Heard'} ${ago(s.received_at)}` +
      `${s.heard > 1 ? `, ${s.heard} places since ${when(s.first_heard)}` : ''}, by ${radio}` +
      `${s.channel_name ? ` on ${s.channel_name}` : ''}${s.path?.length ? `, via ${s.path.join(', ')}` : ''}.`),
    s.format === 'aprs'
      ? el('a', { href: `https://aprs.fi/#!call=a%2F${encodeURIComponent(s.who)}`, target: '_blank', rel: 'noopener' }, 'On aprs.fi')
      : '');
  openPopup([s.lon, s.lat], body);
}

function goToStation(s) {
  if (!map || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return;
  map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 12) });
  stationPopup(stationMarkers.get(s.who)?.station ?? s);
}

function renderStations() {
  $('map-st-list').replaceChildren(...(stationList.length ? stationList.map((s) => el('li', {},
    el('div', { className: 'row' },
      el('span', { className: 'pk-icon' }, s.symbol?.icon ?? '📍'),
      el('button', { className: 'link', onclick: () => goToStation(s) }, s.who),
      el('span', { className: 'meta' }, ago(s.received_at))),
    el('div', { className: 'meta' }, s.summary)))
    : [el('li', { className: 'meta' }, 'No stations heard in that time. They come in when a radio is listening on a packet frequency.')]));
}

/** A station moved or was heard: its marker, its place in the list, and a flash. */
function onStation(p) {
  if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon) || p.alive === false) return;
  const was = stationList.find((s) => s.who === p.who);
  const s = { ...p, heard: (was?.heard ?? 0) + 1, first_heard: was?.first_heard ?? p.received_at };
  stationList = [s, ...stationList.filter((x) => x.who !== p.who)];
  renderStations();
  if (!map || !$('map-st-show').checked) return;
  placeStation(s);
  const element = stationMarkers.get(s.who)?.element;
  element?.classList.remove('flash');
  void element?.offsetWidth;   // start the animation again
  element?.classList.add('flash');
}

$('map-st-show').onchange = () => {
  remember(ST_SHOW_KEY, $('map-st-show').checked ? '1' : '0');
  if (map) loadStations().catch((e) => status(e.message));
};
$('map-st-hours').onchange = () => {
  remember(ST_HOURS_KEY, $('map-st-hours').value);
  if (map) loadStations().catch((e) => status(e.message));
};
document.addEventListener('airscribe:packet', (e) => onStation(e.detail?.packet));

// Your own stations, by the callsign in your profile (any SSID), are marked
let myCall = '';
const baseCall = (c) => String(c ?? '').toUpperCase().replace(/-\d+$/, '');
function isMine(s) {
  return Boolean(myCall) && (baseCall(s.source) === myCall || baseCall(s.who) === myCall);
}
function markMine() {
  for (const { element, station } of stationMarkers.values()) element.classList.toggle('mine', isMine(station));
}
document.addEventListener('airscribe:signed-in', (e) => {
  myCall = e.detail?.user?.radio?.callsign ?? '';
  markMine();
});
document.addEventListener('airscribe:profile', (e) => {
  myCall = e.detail?.callsign ?? '';
  markMine();
});
// From the Packets view: open this station on the map, once it's loaded
document.addEventListener('airscribe:show-station', (e) => {
  showTab('st');
  if (map && stationList.length) goToStation(stationList.find((s) => s.who === e.detail.who) ?? e.detail);
  else showingStation = e.detail;
});

// ---- The event stream ----------------------------------------------------------

// While a radio is receiving, its channel is lit: the radio's own status, as
// it happens, rather than the clip saved afterwards
document.addEventListener('airscribe:activity', (e) => {
  const a = e.detail;
  const before = liveBy.get(a.mac);
  if (a.rx && a.channelName) liveBy.set(a.mac, a.channelName);
  else liveBy.delete(a.mac);
  const now = liveBy.get(a.mac);
  if (before && before !== now) decorate(before);
  if (now) decorate(now);
  if (a.position) placeRadio(a.mac, a.position);
});

// A transmission saved, then transcribed: into the list; one pulse at its
// channel the first time it's heard of, and its words there once it has some
document.addEventListener('airscribe:transmission', (e) => {
  const t = e.detail;
  onListTransmission(t);
  if (!t.channel_name || !map) return;
  // A channel heard for the first time joins the Channels tab
  if (!channels.some((c) => c.name === t.channel_name)) loadChannels(false).catch(() => {});
  if (t.started_at < Date.now() - 5 * 60 * 1000) return;   // an old clip transcribed again isn't news
  if (!pulsed.has(t.id)) {
    pulsed.add(t.id);
    if (pulsed.size > 500) pulsed.delete(pulsed.values().next().value);
    pulse(t.channel_name);
  }
  const text = (t.text ?? '').trim();
  if (text && !saidFor.has(t.id)) {
    saidFor.add(t.id);
    if (saidFor.size > 500) saidFor.delete(saidFor.values().next().value);
    sayOnMap(t.channel_name, text);
  }
});

document.addEventListener('airscribe:deleted', (e) => e.detail.ids.forEach(dropRow));
document.addEventListener('airscribe:purged', () => { if (listOpen) loadList().catch(listError); });

document.addEventListener('airscribe:view', (e) => {
  if (e.detail !== 'mapview') return;
  open().catch((err) => status(`The map couldn't open: ${err.message}`));
});
