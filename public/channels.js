// A radio's channels: every slot of one region as the radio has it, backups of
// them, and putting one back. Opened from a radio's Channels button. Admins
// only; the server checks again, backs a region up before writing to it, and
// the radio link reads each channel back after writing it.
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

const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** MHz to as many places as the frequency needs: 154.25, 460.3875. */
export const mhz = (hz) => (hz / 1e6).toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let radio = null;    // the radio the dialog is for
let regions = [];    // its regions' names
let shown = null;    // the region on show: {region, name, count, channels}
let marks = {};      // slot -> 'changed' | 'failed', after a write

/** Say what's happening, an error in red. */
function say(text, error = false) {
  $('channels-status').textContent = text;
  $('channels-status').className = error ? 'tx-text error' : 'meta';
}

/** Everything that talks to the radio, off while it's busy: one thing at a time. */
function busy(on) {
  for (const b of $('channels').querySelectorAll('button:not(#channels-close), select')) b.disabled = on;
  // Write stays off while what's picked can't be written
  if (!on && picked.length) preview();
}

const regionName = (i, name) => name || regions[i] || `Region ${i + 1}`;

document.addEventListener('airscribe:channels', (e) => open(e.detail));
$('channels-close').onclick = () => $('channels').close();
$('ch-region').onchange = (e) => load(Number(e.target.value));
$('ch-reread').onclick = () => load(shown?.region ?? Number($('ch-region').value));
$('ch-backup').onclick = () => backUp();

/** @param {object} r - The radio, as the radio list has it. */
async function open(r) {
  radio = r;
  shown = null;
  marks = {};
  $('channels-title').textContent = `${r.name}: channels`;
  $('ch-table').replaceChildren();
  $('ch-region').replaceChildren();
  $('ch-backups').replaceChildren();
  $('ch-stations').hidden = true;
  $('st-listen').hidden = true;
  $('channels').showModal();
  busy(true);
  say('Reading the radio…');
  loadBackups();
  // Stations near me, when RadioReference is set up (the Map's Find needs the same)
  api('/map').then((m) => { $('ch-stations-open').hidden = !m.lookup; }, () => { $('ch-stations-open').hidden = true; });
  try {
    const info = await api(`/radios/${r.mac}/controls`);
    regions = info.regions ?? [];
    const count = Math.max(regions.length, (info.region ?? 0) + 1);
    $('ch-region').replaceChildren(...Array.from({ length: count }, (_, i) =>
      el('option', { value: i, selected: i === info.region }, `${regionName(i)}${i === info.region ? ' (on now)' : ''}`)));
    await load(info.region ?? 0);
  } catch (e) {
    busy(false);
    say(e.message, true);
  }
}

/** Read every slot of a region from the radio and show it. */
async function load(region) {
  busy(true);
  marks = {};
  say(`Reading ${regionName(region)} from the radio…`);
  try {
    shown = await api(`/radios/${radio.mac}/channels?region=${region}`);
    $('ch-region').value = String(shown.region);
    render();
    slotTouched = false;
    if (picked.length) renderPicked();
    const used = shown.channels.filter((c) => !c.empty).length;
    say(`${regionName(shown.region, shown.name)}: ${used} of ${shown.count} channels programmed.`);
  } catch (e) {
    say(e.message, true);
  } finally {
    busy(false);
  }
}

/** A tone pair as one column: the same both ways, or receive / transmit. A
 * receive-only channel's transmit tone doesn't matter, so it isn't shown. */
function tones(c) {
  if (c.tx_disable || c.rx_tone === c.tx_tone) return c.rx_tone || '';
  return `${c.rx_tone || 'none'} / ${c.tx_tone || 'none'}`;
}

function render() {
  const head = el('tr', {}, ...['#', 'Name', 'Receive', 'Transmit', 'Tone', 'Mode', 'Scan']
    .map((t, i) => el('th', { className: i === 0 ? 'num' : '' }, t)));
  const all = shown.channels;
  const rows = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    const mark = marks[c.id] ? ` ${marks[c.id]}` : '';
    if (c.empty) {
      // A run of empty slots is one row: "4–30, 27 empty"
      let j = i;
      while (j + 1 < all.length && all[j + 1].empty && marks[all[j + 1].id] === marks[c.id]) j++;
      rows.push(el('tr', { className: `empty${mark}` },
        el('td', { className: 'num' }, j > i ? `${c.id + 1}–${all[j].id + 1}` : String(c.id + 1)),
        el('td', { colSpan: 6 }, j > i ? `${j - i + 1} empty` : 'empty')));
      i = j;
      continue;
    }
    rows.push(row(c, mark));
  }
  $('ch-table').replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
}

/** One programmed channel's row. */
function row(c, mark) {
  const tx = c.tx_disable ? 'off' : c.tx_hz === c.rx_hz ? 'same' : mhz(c.tx_hz);
  return el('tr', { className: mark.trim() },
    el('td', { className: 'num' }, String(c.id + 1)),
    el('td', {}, c.name || '(no name)'),
    el('td', { className: 'num' }, mhz(c.rx_hz)),
    el('td', { title: c.tx_disable ? 'Transmit is turned off on this channel' : '' }, tx),
    el('td', {}, tones(c)),
    el('td', {}, `${c.mod}${c.mod === 'FM' ? (c.bandwidth === 'narrow' ? ' narrow' : ' wide') : ''}`),
    el('td', {}, c.scan ? 'yes' : ''));
}

/**
 * Show what a write did: each slot written replaced by what the radio sent
 * back, marked, and a line saying whether every one took.
 * @param {object} res - The server's answer: {region, results, backup}.
 * @param {string} what - What was written, for the line.
 */
export function showWritten(res, what) {
  const failed = res.results.filter((r) => !r.ok);
  marks = Object.fromEntries(res.results.map((r) => [r.id, r.ok ? 'changed' : 'failed']));
  if (shown && shown.region === res.region) {
    for (const r of res.results) if (r.channel) shown.channels[r.id] = r.channel;
    render();
  }
  if (!failed.length) {
    say(`${what}: ${plural(res.results.length, 'channel')} written, and the radio sent each back as it was sent. ` +
      `The region was backed up first (${res.backup.label}).`);
  } else {
    say(`${what}: ${failed.length} of ${res.results.length} didn’t take: ` +
      `${failed.map((r) => `channel ${r.id + 1}, ${r.error}`).join('; ')}. The region was backed up first.`, true);
  }
}

async function backUp() {
  if (!shown) return;
  busy(true);
  say(`Backing up ${regionName(shown.region, shown.name)}…`);
  try {
    const b = await api(`/radios/${radio.mac}/backups`, { method: 'POST', body: { region: shown.region } });
    say(`Backed up: ${plural(b.programmed, 'channel')} in ${regionName(b.region, b.region_name)}.`);
    await loadBackups();
  } catch (e) {
    say(e.message, true);
  } finally {
    busy(false);
  }
}

export async function loadBackups() {
  try {
    const list = await api(`/radios/${radio.mac}/backups`);
    $('ch-backups').replaceChildren(...(list.length
      ? list.map(backupItem)
      : [el('li', { className: 'meta' }, 'No backups yet.')]));
  } catch (e) {
    $('ch-backups').replaceChildren(el('li', { className: 'tx-text error' }, e.message));
  }
}

function backupItem(b) {
  const names = b.names.filter(Boolean);
  return el('li', {},
    el('div', { className: 'row' }, el('strong', {}, b.label), el('span', { className: 'meta' }, when(b.created_at))),
    el('div', { className: 'meta' },
      `${regionName(b.region, b.region_name)} · ${plural(b.programmed, 'channel')}` +
      `${names.length ? `: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}` : ''}`),
    el('div', { className: 'actions' },
      el('button', { onclick: () => putBack(b) }, 'Put back'),
      el('button', { onclick: () => removeBackup(b) }, 'Delete')));
}

async function putBack(b) {
  const where = regionName(b.region, b.region_name);
  if (!confirm(`Put back “${b.label}”? Every slot of ${where} is written as it was then. ` +
    'What’s there now is backed up first, so this can be undone too.')) return;
  busy(true);
  say(`Writing ${where} to the radio…`);
  try {
    const res = await api(`/radios/${radio.mac}/backups/${b.id}/restore`, { method: 'POST' });
    if (!shown || shown.region !== res.region) {
      $('ch-region').value = String(res.region);
      shown = { region: res.region, name: res.name, count: res.results.length,
        channels: res.results.map((r) => r.channel ?? { id: r.id, empty: true }) };
    }
    showWritten(res, 'Put back');
    await loadBackups();
  } catch (e) {
    say(e.message, true);
  } finally {
    busy(false);
  }
}

// ---- Stations near me ---------------------------------------------------------
// RadioReference's listings in the county, nearest first, each group's
// frequencies asked for as it's opened. Those picked are written into the
// region on show, from a slot, after the server backs the region up.

let nearby = null;         // {area, groups}, once asked for
let showing = 25;          // groups listed
const stationsOf = new Map();   // scid -> its stations
const picked = [];         // [{key, station, group, name}], in the order they'll be written
let slotTouched = false;   // the slot was chosen by hand: don't move it

const miles = (km) => {
  const mi = km * 0.621371;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
};
/** A name as the radio can show it: ten plain characters. */
const radioName = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10).trim();

$('ch-stations-open').onclick = () => openStations();
$('st-close').onclick = () => { $('ch-stations').hidden = true; };
$('st-more').onclick = () => { showing += 25; renderGroups(); };
$('st-slot').oninput = () => { slotTouched = true; preview(); };
$('st-write').onclick = () => writeStations();
$('st-listen').onclick = () => listen();

async function openStations() {
  $('ch-stations').hidden = false;
  if (!nearby) {
    $('st-groups').replaceChildren(el('li', { className: 'meta' }, 'Asking RadioReference…'));
    try {
      nearby = await api('/radioreference/nearby');
    } catch (e) {
      $('st-groups').replaceChildren(el('li', { className: 'tx-text error' }, e.message));
      return;
    }
  }
  const a = nearby.area;
  $('st-title').textContent = `Stations near ${a.zip}${a.city ? ` (${a.city})` : ''}${a.county ? `, ${a.county} County` : ''}`;
  renderGroups();
  renderPicked();
}

function renderGroups() {
  $('st-groups').replaceChildren(...(nearby.groups.length
    ? nearby.groups.slice(0, showing).map(groupItem)
    : [el('li', { className: 'meta' }, 'RadioReference lists nothing in this county.')]));
  $('st-more').hidden = nearby.groups.length <= showing;
}

function groupItem(g) {
  const list = el('ul', { className: 'st-freqs', hidden: true });
  const head = el('button', { className: 'link' }, g.where);
  head.setAttribute('aria-expanded', 'false');
  head.onclick = async () => {
    const opening = list.hidden;
    list.hidden = !opening;
    head.setAttribute('aria-expanded', String(opening));
    if (!opening || stationsOf.has(g.scid)) return;
    list.replaceChildren(el('li', { className: 'meta' }, 'Asking RadioReference…'));
    try {
      stationsOf.set(g.scid, await api(`/radioreference/groups/${g.scid}`));
    } catch (e) {
      list.replaceChildren(el('li', { className: 'tx-text error' }, e.message));
      return;
    }
    fillGroup(list, g);
  };
  if (stationsOf.has(g.scid)) fillGroup(list, g);
  return el('li', {},
    el('div', { className: 'row' }, head,
      el('span', { className: 'meta' }, g.countyWide ? 'county-wide' : g.km === null ? '' : miles(g.km))),
    list);
}

function fillGroup(list, g) {
  const stations = stationsOf.get(g.scid);
  list.replaceChildren(...(stations.length ? stations.map((s) => stationItem(s, g))
    : [el('li', { className: 'meta' }, 'No frequencies listed.')]));
}

const keyOf = (s, g) => `${g.scid}:${s.fid ?? s.mhz}`;

function stationItem(s, g) {
  const key = keyOf(s, g);
  const box = el('input', { type: 'checkbox', disabled: !s.ok, checked: picked.some((p) => p.key === key) });
  box.onchange = () => (box.checked ? pick(s, g) : unpick(key));
  const what = [mhz(s.mhz * 1e6), s.alpha, s.descr && s.descr !== s.alpha ? s.descr : '', s.tone, s.mode]
    .filter(Boolean).join(' · ');
  const li = el('li', { className: s.ok ? '' : 'off' },
    el('label', {}, box, el('span', {}, what)),
    !s.ok ? el('div', { className: 'meta' }, `Can’t be written: ${s.why}.`)
      : s.toneNote ? el('div', { className: 'meta' }, s.toneNote) : '');
  li.dataset.key = key;
  return li;
}

/** Tick boxes follow the list of picked stations, wherever they're shown. */
function syncBoxes() {
  for (const li of $('st-groups').querySelectorAll('li[data-key]')) {
    const box = li.querySelector('input');
    if (box) box.checked = picked.some((p) => p.key === li.dataset.key);
  }
}

function pick(s, g) {
  // Two with one name would be one channel to the feed and the map: the
  // second gets a number in its last place
  let name = s.channel.name || radioName(s.descr) || mhz(s.mhz * 1e6);
  for (let n = 2; picked.some((p) => p.name === name) && n < 100; n++) {
    name = `${name.slice(0, 10 - String(n).length).trim()}${n}`;
  }
  picked.push({ key: keyOf(s, g), station: s, group: g, name });
  renderPicked();
}

function unpick(key) {
  const i = picked.findIndex((p) => p.key === key);
  if (i >= 0) picked.splice(i, 1);
  renderPicked();
  syncBoxes();
}

/** The first slot where every picked station fits into empty slots, else the first. */
function firstFree(n) {
  const all = shown?.channels ?? [];
  for (let i = 0; i + n <= all.length; i++) {
    if (all.slice(i, i + n).every((c) => c.empty)) return i;
  }
  return 0;
}

function renderPicked() {
  $('st-pick').hidden = !picked.length;
  if (!picked.length) return;
  $('st-picked').replaceChildren(...picked.map((p) => {
    const name = el('input', { type: 'text', value: p.name, maxLength: 10, spellcheck: false });
    name.setAttribute('aria-label', 'Name on the radio');
    name.oninput = () => {
      p.name = radioName(name.value);
      preview();
    };
    return el('li', {}, name, ` ${mhz(p.station.channel.rx_hz)} MHz · ${p.group.where} `,
      el('button', { className: 'link', onclick: () => unpick(p.key) }, 'Remove'));
  }));
  if (!slotTouched) $('st-slot').value = String(firstFree(picked.length) + 1);
  $('st-slot').max = String(shown?.count ?? 30);
  $('st-write').textContent = `Write ${plural(picked.length, 'station')}`;
  preview();
}

/** Which slots the stations go in, what's there now, and whether it can be written. */
function preview() {
  if (!shown || !picked.length) return;
  const n = picked.length;
  const start = Number($('st-slot').value) - 1;
  const where = regionName(shown.region, shown.name);
  let problem = '';
  if (!Number.isInteger(start) || start < 0 || start + n > shown.count) {
    problem = `${where} has slots 1 to ${shown.count}: ${plural(n, 'station')} from slot ${start + 1} don’t fit.`;
  } else if (picked.some((p) => !p.name)) {
    problem = 'Each station needs a name for the radio.';
  } else if (new Set(picked.map((p) => p.name)).size < n) {
    problem = 'Two stations have the same name; the feed and the map would take them for one channel.';
  }
  if (problem) {
    $('st-preview').textContent = problem;
    $('st-preview').className = 'tx-text error';
    $('st-write').disabled = true;
    return;
  }
  const replaced = shown.channels.slice(start, start + n).filter((c) => !c.empty);
  $('st-preview').className = 'meta';
  $('st-preview').textContent = `Into ${where}, ${n === 1 ? `slot ${start + 1}` : `slots ${start + 1}–${start + n}`}: ` +
    (replaced.length ? `replaces ${replaced.map((c) => `${c.id + 1}. ${c.name || '(no name)'}`).join(', ')}`
      : 'empty now') + '. The region is backed up first.';
  $('st-write').disabled = false;
}

async function writeStations() {
  const n = picked.length;
  const start = Number($('st-slot').value) - 1;
  const place = $('st-place').checked;
  const channels = picked.map((p, k) => ({
    ...p.station.channel, id: start + k, name: p.name,
    ...(place && p.group.lat !== null ? { lat: p.group.lat, lon: p.group.lon } : {}),
  }));
  busy(true);
  $('st-write').disabled = true;
  say(`Writing ${plural(n, 'station')} to the radio…`);
  try {
    const res = await api(`/radios/${radio.mac}/channels`, { method: 'PUT', body: {
      region: shown.region, channels, label: `Before writing ${plural(n, 'station')} from RadioReference`,
    } });
    showWritten(res, 'Stations written');
    if (res.placed) $('channels-status').textContent += ` ${plural(res.placed, 'channel')} put on the map.`;
    if (res.results.some((r) => r.ok)) $('st-listen').hidden = false;
    picked.length = 0;
    slotTouched = false;
    renderPicked();
    syncBoxes();
    await loadBackups();
  } catch (e) {
    say(e.message, true);
  } finally {
    busy(false);
    preview();
  }
}

/** Put the radio on the region just written, scanning its channels. */
async function listen() {
  busy(true);
  const where = regionName(shown.region, shown.name);
  say(`Moving the radio to ${where}…`);
  try {
    const now = await api(`/radios/${radio.mac}/controls`);
    if (now.region !== shown.region) {
      await api(`/radios/${radio.mac}/controls`, { method: 'POST', body: { action: 'region', value: shown.region } });
    }
    await api(`/radios/${radio.mac}/controls`, { method: 'POST', body: { action: 'scan', value: true } });
    for (const o of $('ch-region').options) {
      o.textContent = `${regionName(Number(o.value))}${Number(o.value) === shown.region ? ' (on now)' : ''}`;
    }
    $('st-listen').hidden = true;
    say(`The radio is on ${where}, scanning its channels.`);
  } catch (e) {
    say(e.message, true);
  } finally {
    busy(false);
  }
}

async function removeBackup(b) {
  if (!confirm(`Delete the backup “${b.label}”? The radio isn’t changed.`)) return;
  try {
    await api(`/radios/${radio.mac}/backups/${b.id}`, { method: 'DELETE' });
    await loadBackups();
  } catch (e) {
    say(e.message, true);
  }
}
