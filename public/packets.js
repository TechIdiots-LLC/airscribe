// Packets decoded, by a radio's own modem or by AirScribe from its audio
// (APRS, and the BSS packets these radios send each other): newest first,
// live as they come in, by kind and by station or words. A station with a
// place opens on the Map.
import { showView } from './views.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== ''));
  return e;
};

/** The same credential app.js uses: a session cookie, or a stored token. */
function withToken(path) {
  let token = '';
  try { token = localStorage.getItem('airscribe.token') ?? ''; } catch { /* storage blocked */ }
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
}

async function api(path) {
  const res = await fetch(withToken(`/api${path}`), { headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const PAGE = 100;
const KINDS = {
  positions: ['position', 'object', 'item'], weather: ['weather'], messages: ['message'], status: ['status'],
  bss: ['bss'], other: ['telemetry', 'other', 'invalid'],
};
const TYPE_NAMES = { position: 'position', object: 'object', item: 'item', weather: 'weather', message: 'message',
  status: 'status', bss: 'BSS', telemetry: 'telemetry', other: 'other', invalid: 'unreadable' };
const DECODED_BY = {
  radio: ['the radio', 'The radio’s own modem decoded it'],
  airscribe: ['AirScribe', 'AirScribe decoded it from the radio’s audio'],
  both: ['both', 'The radio’s own modem and AirScribe, from the radio’s audio, both decoded it'],
};

let opened = false;
let oldest = null;          // the oldest packet listed, for Load older
const radios = new Map();   // mac -> its name

/** @returns {boolean} Whether a packet belongs in the list as it's filtered now. */
function matches(p) {
  const kind = $('pk-kind').value;
  if (kind && !KINDS[kind].includes(p.type)) return false;
  const q = $('pk-search').value.trim().toLowerCase();
  return !q || [p.who, p.source, p.summary].some((s) => (s ?? '').toLowerCase().includes(q));
}

/** The Map, on a station: its marker, its popup open. */
function showStation(p) {
  showView('mapview');
  document.dispatchEvent(new CustomEvent('airscribe:show-station', { detail: { who: p.who, lat: p.lat, lon: p.lon } }));
}

function row(p) {
  const when = new Date(p.received_at).toLocaleString();
  const radio = radios.get(p.mac) ?? p.mac;
  const heardOn = p.channel_name || (p.channel_hz ? `${(p.channel_hz / 1e6).toFixed(4)} MHz` : '');
  const placed = p.lat !== null && p.lat !== undefined;
  const who = placed
    ? el('button', { className: 'link', title: 'Show it on the Map', onclick: () => showStation(p) }, p.who)
    : el('strong', {}, p.who);
  const to = p.type === 'message' ? '' : p.destination && p.format === 'aprs' ? ` → ${p.destination}` : '';
  const via = p.path?.length ? ` via ${p.path.join(', ')}` : '';
  const [by, byTitle] = DECODED_BY[p.decoded_by] ?? DECODED_BY.radio;
  const li = el('li', {},
    el('div', { className: 'meta' }, `${when} · ${radio}${heardOn ? ` · ${heardOn}` : ''} · `,
      el('span', { className: 'pk-by', title: byTitle }, `decoded by ${by}`)),
    el('div', { className: 'pk-head' },
      el('span', { className: 'pk-icon', title: p.symbol?.name ?? '' }, p.symbol?.icon ?? '📦'), who,
      p.who !== p.source ? el('span', { className: 'meta' }, ` from ${p.source}`) : '',
      el('span', { className: 'meta' }, `${to}${via}`),
      el('span', { className: `tag pk-${p.type}` }, TYPE_NAMES[p.type] ?? p.type)),
    el('div', { className: 'pk-summary' }, p.summary),
    el('details', {}, el('summary', {}, 'As received'),
      el('pre', { className: 'pk-raw' }, `${p.tnc2 ?? p.info ?? ''}\n${p.raw}`)));
  li.dataset.id = String(p.id);
  return li;
}

async function load(more = false) {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if ($('pk-kind').value) params.set('kind', $('pk-kind').value);
  if ($('pk-search').value.trim()) params.set('q', $('pk-search').value.trim());
  if (more && oldest) params.set('before', String(oldest));
  try {
    if (!radios.size) for (const r of await api('/radios')) radios.set(r.mac, r.name);
    const list = await api(`/packets?${params}`);
    if (!more) $('pk-list').replaceChildren();
    $('pk-list').append(...list.map(row));
    if (list.length) oldest = list.at(-1).id;
    $('pk-more').hidden = list.length < PAGE;
    const n = $('pk-list').children.length;
    $('pk-count').textContent = n ? `Showing ${n}` : 'No packets yet. They come in when a radio is listening on a packet frequency.';
  } catch (e) {
    $('pk-count').textContent = e.message;
  }
}

let typing = null;
$('pk-kind').onchange = () => load();
$('pk-search').oninput = () => {
  clearTimeout(typing);
  typing = setTimeout(() => load(), 300);
};
$('pk-more').onclick = () => load(true);

document.addEventListener('airscribe:view', (e) => {
  if (e.detail !== 'packets') return;
  opened = true;
  load();
});

// Live: one that matches joins the top of the list
document.addEventListener('airscribe:packet', (e) => {
  const p = e.detail?.packet;
  if (!opened || !p || !matches(p) || $('pk-list').querySelector(`li[data-id="${p.id}"]`)) return;
  $('pk-list').prepend(row(p));
  $('pk-count').textContent = `Showing ${$('pk-list').children.length}`;
});
