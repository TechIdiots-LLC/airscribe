// The Map view: each channel at the place an admin gave it, lit while a radio
// is receiving on it and pulsing when its transmission has been saved.
// Channels close enough to cover each other at the zoom shown are drawn as one
// marker naming them all.
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
let popup = null;         // the one popup open, so another replaces it
const markers = new Map(); // channel name -> {marker, element, channel}
const liveBy = new Map();  // radio mac -> the channel it is receiving on now
const radioMarkers = new Map(); // radio mac -> marker, where its GPS puts it
const radioNames = new Map();   // radio mac -> the name it was given
const pulsed = new Set();  // transmissions already pulsed for, so each pulses once

const isPlaced = (c) => c.lat !== null && c.lon !== null;
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
    const { styles } = await api('/map');
    if (!styles.length) throw new Error('No base maps are set (map.styles in the settings file).');
    const chosen = recall(STYLE_KEY, null);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const style = styles.find((s) => s.url === chosen) ?? (dark && styles.find((s) => s.dark)) ?? styles[0];
    $('map-style').replaceChildren(...styles.map((s) => el('option', { value: s.url, selected: s === style }, s.name)));
    map = new maplibregl.Map({ container: 'map-canvas', style: style.url, attributionControl: false });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('click', onMapClick);
    map.on('zoomend', regroup);
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
  } else {
    map.resize();
    await loadChannels(false);
  }
}

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
    el('span', { className: 'ring' }), el('span', { className: 'dot' }), el('span', { className: 'label' }, c.name));
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
    widths.set(name, measure.measureText(name).width);
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
  for (const members of cluster(channels.filter(isPlaced), map.getZoom())) {
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
    el('span', { className: 'ring' }), el('span', { className: 'badge' }, String(members.length)), names);
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

// ---- What a marker shows: on the air -----------------------------------------

/** @param {string} name - A channel. @returns {boolean} Whether a radio is receiving on it now. */
const isLive = (name) => [...liveBy.values()].includes(name);

/**
 * Bring a channel's marker, and the group it's in, up to date.
 * @param {string} name - The channel.
 * @returns {void}
 */
function decorate(name) {
  const m = markers.get(name);
  if (m) m.element.classList.toggle('live', isLive(name));
  const g = groupOf.get(name);
  if (g) drawGroup(g);
}

/** @param {object} g - A group. @returns {void} Light it, and the names in it, for what its channels are doing. */
function drawGroup(g) {
  const live = new Set(liveBy.values());
  const unnamed = g.members.slice(g.named).map((c) => c.name);
  const any = (names, test) => names.some(test);
  const all = g.members.map((c) => c.name);
  g.element.classList.toggle('live', any(all, (n) => live.has(n)));
  for (const nm of g.element.querySelectorAll('.nm')) {
    const names = nm.dataset.name ? [nm.dataset.name] : unnamed;
    nm.classList.toggle('live', any(names, (n) => live.has(n)));
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

// ---- Popups ---------------------------------------------------------------

/**
 * @param {object} t - A transmission.
 * @returns {{text: string, state: string}} What it said, as the feed shows it: the default
 *   engine's transcript, or how far that has got.
 */
function words(t) {
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
    el('button', { onclick: () => openFeed(c.name) }, 'Open in feed'));
  if (role === 'admin') {
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
    el('strong', {}, `${names.length} channels here`), list);
  openPopup(g.marker.getLngLat(), body);
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

/** A channel on the map, from the side: flown to, with its popup. */
function goTo(c) {
  map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 12) });
  showPopup(c);
  // On a phone the side is under the map
  $('map-canvas').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- Placing channels ---------------------------------------------------------

function renderSide(placed) {
  $('map-placed').replaceChildren(...(placed.length ? placed.map((c) => el('li', {},
    el('button', { className: 'link', onclick: () => goTo(c) }, c.name),
    el('span', { className: 'meta' }, ` ${mhz(c.hz)}`)))
    : [el('li', { className: 'meta' }, 'None yet.')]));
  const unplaced = channels.filter((c) => !isPlaced(c));
  $('map-unplaced').replaceChildren(...(unplaced.length ? unplaced.map((c) => el('li', {},
    el('span', {}, c.name), el('span', { className: 'meta' }, ` ${mhz(c.hz)} `),
    role === 'admin'
      ? el('button', { className: placing === c.name ? 'active' : '', onclick: () => startPlacing(c.name) },
        placing === c.name ? 'Click the map…' : 'Place')
      : ''))
    : [el('li', { className: 'meta' }, channels.length ? 'Every channel is placed.' : 'No channels heard yet.')]));
}

/** The next click on the map puts this channel there; asked again, or Esc, cancels. */
function startPlacing(name) {
  placing = placing === name ? null : name;
  map.getCanvas().style.cursor = placing ? 'crosshair' : '';
  status(placing ? `Click the map where ${placing} is, or press Esc to cancel.` : null);
  renderSide(channels.filter(isPlaced));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && placing) startPlacing(placing);
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

// A transmission saved: one pulse at its channel, the first time it's heard of
document.addEventListener('airscribe:transmission', (e) => {
  const t = e.detail;
  if (!t.channel_name || !map) return;
  // A channel heard for the first time joins the side list
  if (!channels.some((c) => c.name === t.channel_name)) loadChannels(false).catch(() => {});
  if (t.started_at < Date.now() - 5 * 60 * 1000) return;   // an old clip transcribed again isn't news
  if (!pulsed.has(t.id)) {
    pulsed.add(t.id);
    if (pulsed.size > 500) pulsed.delete(pulsed.values().next().value);
    pulse(t.channel_name);
  }
});

document.addEventListener('airscribe:view', (e) => {
  if (e.detail !== 'mapview') return;
  open().catch((err) => status(`The map couldn't open: ${err.message}`));
});
