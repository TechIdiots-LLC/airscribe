// The Map view: each channel at the place an admin gave it, lit while a radio
// is receiving on it and pulsing when its transmission has been saved.
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

async function api(path, opts = {}) {
  const res = await fetch(withToken(`/api${path}`), {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body && JSON.stringify(opts.body),
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const STYLE_KEY = 'airscribe.mapStyle';
let maplibregl = null;
let map = null;
let role = null;          // an admin may place and move channels
let channels = [];
let placing = null;       // the channel the next click on the map places
const markers = new Map(); // channel name -> {marker, element}
const liveBy = new Map();  // radio mac -> the channel it is receiving on now
const radioMarkers = new Map(); // radio mac -> marker, where its GPS puts it
const radioNames = new Map();   // radio mac -> the name it was given
const pulsed = new Set();  // transmissions already pulsed for, so each pulses once

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
    let chosen = null;
    try { chosen = localStorage.getItem(STYLE_KEY); } catch { /* storage blocked */ }
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const style = styles.find((s) => s.url === chosen) ?? (dark && styles.find((s) => s.dark)) ?? styles[0];
    $('map-style').replaceChildren(...styles.map((s) => el('option', { value: s.url, selected: s === style }, s.name)));
    map = new maplibregl.Map({ container: 'map-canvas', style: style.url, attributionControl: false });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('click', onMapClick);
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
  try { localStorage.setItem(STYLE_KEY, url); } catch { /* storage blocked */ }
  map?.setStyle(url);   // the channel markers are separate from the style, so they stay
};

/**
 * @param {boolean} fit - Frame the placed channels (on first opening).
 * @returns {Promise<void>}
 */
async function loadChannels(fit) {
  channels = await api('/channels');
  const placed = channels.filter((c) => c.lat !== null && c.lon !== null);
  for (const [name, m] of markers) {
    if (!placed.some((c) => c.name === name)) {
      m.marker.remove();
      markers.delete(name);
    }
  }
  for (const c of placed) placeMarker(c);
  renderSide(placed);
  // The radios themselves, where their GPS puts them
  for (const r of await api('/radios')) {
    radioNames.set(r.mac, r.name);
    if (r.position) placeRadio(r.mac, r.position);
  }
  if (fit && placed.length) {
    const b = new maplibregl.LngLatBounds();
    for (const c of placed) b.extend([c.lon, c.lat]);
    map.fitBounds(b, { padding: 80, maxZoom: 11, duration: 0 });
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
      await loadChannels(false);
    }
  });
  element.addEventListener('click', (e) => {
    e.stopPropagation();
    showPopup(markers.get(c.name).channel);
  });
  markers.set(c.name, { marker, element, channel: c });
  // Receiving already when it was drawn
  if ([...liveBy.values()].includes(c.name)) element.classList.add('live');
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

const mhz = (hz) => (hz ? `${(hz / 1e6).toFixed(4)} MHz` : '');

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
    actions.append(el('button', {
      onclick: async () => {
        if (!confirm(`Take ${c.name} off the map?`)) return;
        try { await api(`/channels/${encodeURIComponent(c.name)}/place`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
        popup.remove();
        await loadChannels(false);
      },
    }, 'Remove from map'));
  }
  body.append(actions);
  const popup = new maplibregl.Popup({ offset: 14, maxWidth: '340px' }).setLngLat([c.lon, c.lat]).setDOMContent(body).addTo(map);
  try {
    const latest = await api(`/transmissions?channel=${encodeURIComponent(c.name)}&limit=3`);
    body.querySelector('.ch-latest').replaceChildren(...(latest.length ? latest : [null]).map((t) => (t
      ? el('li', {}, el('span', { className: 'meta' }, `${new Date(t.started_at).toLocaleTimeString()} `),
        (t.text ?? '').trim() || el('em', { className: 'meta' }, '(no speech recognised)'))
      : el('li', { className: 'meta' }, 'Nothing yet.'))));
  } catch (e) {
    body.querySelector('.ch-latest').replaceChildren(el('li', { className: 'tx-text error' }, e.message));
  }
}

/** The feed, filtered to one channel. */
function openFeed(name) {
  $('filter-channel').value = name;
  $('filter-channel').dispatchEvent(new Event('change'));
  showView('main');
}

function renderSide(placed) {
  $('map-placed').replaceChildren(...(placed.length ? placed.map((c) => el('li', {},
    el('button', { className: 'link', onclick: () => {
      map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 10) });
      showPopup(c);
    } }, c.name),
    el('span', { className: 'meta' }, ` ${mhz(c.hz)}`)))
    : [el('li', { className: 'meta' }, 'None yet.')]));
  const unplaced = channels.filter((c) => c.lat === null || c.lon === null);
  $('map-unplaced').replaceChildren(...(unplaced.length ? unplaced.map((c) => el('li', {},
    el('span', {}, c.name), el('span', { className: 'meta' }, ` ${mhz(c.hz)} `),
    role === 'admin'
      ? el('button', { className: placing === c.name ? 'active' : '', onclick: () => startPlacing(c.name) },
        placing === c.name ? 'Click the map…' : 'Place')
      : ''))
    : [el('li', { className: 'meta' }, channels.length ? 'Every channel is placed.' : 'No channels heard yet.')]));
}

/** The next click on the map puts this channel there. */
function startPlacing(name) {
  placing = placing === name ? null : name;
  map.getCanvas().style.cursor = placing ? 'crosshair' : '';
  status(placing ? `Click the map where ${placing} is. (Click Place again to cancel.)` : null);
  renderSide(channels.filter((c) => c.lat !== null && c.lon !== null));
}

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

/** @param {string} name - A channel whose transmission has just been saved. @returns {void} */
function pulse(name) {
  const m = markers.get(name);
  if (!m) return;
  // Restarted rather than stacked when two arrive close together
  m.element.classList.remove('pulse');
  void m.element.offsetWidth;
  m.element.classList.add('pulse');
}

function setLive(name, on) {
  markers.get(name)?.element.classList.toggle('live', on);
}

// While a radio is receiving, its channel is lit: the radio's own status, as
// it happens, rather than the clip saved afterwards
document.addEventListener('airscribe:activity', (e) => {
  const a = e.detail;
  const before = liveBy.get(a.mac);
  if (a.rx && a.channelName) liveBy.set(a.mac, a.channelName);
  else liveBy.delete(a.mac);
  const now = liveBy.get(a.mac);
  if (before && before !== now && ![...liveBy.values()].includes(before)) setLive(before, false);
  if (now) setLive(now, true);
  if (a.position) placeRadio(a.mac, a.position);
});

// A transmission saved: one pulse, the first time it is heard of
document.addEventListener('airscribe:transmission', (e) => {
  const t = e.detail;
  if (!t.channel_name || pulsed.has(t.id) || t.started_at < Date.now() - 5 * 60 * 1000) return;
  pulsed.add(t.id);
  if (pulsed.size > 500) pulsed.delete(pulsed.values().next().value);
  pulse(t.channel_name);
  // A channel heard for the first time joins the side list
  if (map && !channels.some((c) => c.name === t.channel_name)) loadChannels(false).catch(() => {});
});

document.addEventListener('airscribe:view', (e) => {
  if (e.detail !== 'mapview') return;
  open().catch((err) => status(`The map couldn't open: ${err.message}`));
});
