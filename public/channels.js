// A radio's channels: every slot of one region as the radio has it, changed in
// place (scan on or off, edited, removed, added by hand or from RadioReference)
// and written together, with backups to put back. Opened from a radio's
// Channels button. Admins only; the server checks again, backs the region up
// before writing to it, and the radio link reads each channel back.
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

// What the radio can take, as src/channels.js checks it (the server checks again)
const BANDS = [
  { from: 108e6, to: 136e6, mod: 'AM', name: 'airband' },
  { from: 136e6, to: 174e6, name: 'VHF' },
  { from: 400e6, to: 520e6, name: 'UHF' },
];
const HAM = [[144e6, 148e6], [420e6, 450e6]];
const bandOf = (hz) => BANDS.find((b) => hz >= b.from && hz <= b.to) ?? null;
const isHam = (hz) => HAM.some(([a, b]) => hz >= a && hz <= b);
/** A name as the radio can show it: ten plain characters. */
const radioName = (s) => String(s ?? '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10).trim();

/**
 * A tone as the radio link takes it ("", "127.3", "D023"), or null if it isn't one.
 * "127.3 PL", "023 DPL" and "CSQ" are read as RadioReference writes them.
 */
function toneOf(text) {
  const s = String(text ?? '').trim().toUpperCase();
  if (!s || s === 'CSQ' || s === 'NONE') return '';
  const dcs = /^D([0-7]{3})N?$/.exec(s) ?? /^([0-7]{3})\s*(?:DPL|DCS)$/.exec(s);
  if (dcs) return `D${dcs[1]}`;
  const ctcss = /^(\d{2,3}(?:\.\d{1,2})?)\s*(?:PL|HZ)?$/.exec(s);
  if (ctcss && Number(ctcss[1]) >= 60 && Number(ctcss[1]) <= 260) return Number(ctcss[1]).toFixed(1);
  return null;
}

let radio = null;            // the radio the dialog is for
let regions = [];            // its regions' names
let shown = null;            // the region on show: {region, name, count, channels}, as the radio has it
let marks = {};              // slot -> 'changed' | 'failed', after a write
const pending = new Map();   // slot -> {kind: 'new'|'set'|'clear', channel?, set?, key?, group?}
let editing = null;          // the slot whose form is open

/** Say what's happening, an error in red. */
function say(text, error = false) {
  $('channels-status').textContent = text;
  $('channels-status').className = error ? 'tx-text error' : 'meta';
}

/** Everything that talks to the radio, off while it's busy: one thing at a time. */
function busy(on) {
  for (const b of $('channels').querySelectorAll('button:not(#channels-close), select, input')) b.disabled = on;
  if (!on) {
    // What's disabled for its own reasons, again: a removed channel's scan box, a station the radio can't take
    render();
    for (const b of $('st-groups').querySelectorAll('li.off input')) b.disabled = true;
  }
}

const regionName = (i, name) => name || regions[i] || `Region ${i + 1}`;

/** Changes not written yet are lost by going elsewhere: asked first. */
function discardOk() {
  return !pending.size || confirm(`Discard ${plural(pending.size, 'change')} not written to the radio?`);
}

// Its own event: airscribe:channels is the server's update of a radio's channel
// table, passed on by app.js, and opening on that reopened this for no radio
document.addEventListener('airscribe:open-channels', (e) => open(e.detail));
$('channels-close').onclick = () => {
  if (discardOk()) $('channels').close();
};
$('channels').addEventListener('cancel', (e) => {
  if (!discardOk()) e.preventDefault();
});
$('ch-region').onchange = (e) => {
  if (!discardOk()) {
    e.target.value = String(shown.region);
    return;
  }
  load(Number(e.target.value));
};
$('ch-reread').onclick = () => {
  if (discardOk()) load(shown?.region ?? Number($('ch-region').value));
};
$('ch-backup').onclick = () => backUp();
$('ch-write').onclick = () => writePending();
$('ch-discard').onclick = () => {
  pending.clear();
  editing = null;
  render();
  syncBoxes();
};

/** @param {object} r - The radio, as the radio list has it. */
async function open(r) {
  radio = r;
  shown = null;
  marks = {};
  pending.clear();
  editing = null;
  $('channels-title').textContent = `${r.name}: channels`;
  $('ch-table').replaceChildren();
  $('ch-region').replaceChildren();
  $('ch-backups').replaceChildren();
  $('ch-add').hidden = true;
  $('st-listen').hidden = true;
  renderPending();
  $('channels').showModal();
  busy(true);
  say('Reading the radio…');
  loadBackups();
  // Stations near me needs RadioReference set up (the Map's Find needs the same)
  api('/map').then((m) => { lookup = Boolean(m.lookup); }, () => { lookup = false; });
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
  pending.clear();
  editing = null;
  say(`Reading ${regionName(region)} from the radio…`);
  try {
    shown = await api(`/radios/${radio.mac}/channels?region=${region}`);
    $('ch-region').value = String(shown.region);
    render();
    syncBoxes();
    const used = shown.channels.filter((c) => !c.empty).length;
    say(`${regionName(shown.region, shown.name)}: ${used} of ${shown.count} channels programmed.`);
  } catch (e) {
    say(e.message, true);
  } finally {
    busy(false);
  }
}

// ---- The list ----------------------------------------------------------------

/** A slot as it will be once what's pending is written, and what's pending for it. */
function view(slot) {
  const orig = shown.channels[slot];
  const p = pending.get(slot);
  if (!p) return { c: orig, state: '' };
  if (p.kind === 'clear') return { c: orig, state: 'removing' };
  if (p.kind === 'new') return { c: { ...p.channel, id: slot, empty: false }, state: 'adding' };
  return { c: { ...orig, ...p.set }, state: 'editing' };
}

/** A tone pair as one column: the same both ways, or receive / transmit. A
 * receive-only channel's transmit tone doesn't matter, so it isn't shown. */
function tones(c) {
  if (c.tx_disable || c.rx_tone === c.tx_tone) return c.rx_tone || '';
  return `${c.rx_tone || 'none'} / ${c.tx_tone || 'none'}`;
}

const modeText = (c) => `${c.mod}${c.mod === 'FM' ? (c.bandwidth === 'narrow' ? ' narrow' : ' wide') : ''}`;
const STATE = { adding: 'new', editing: 'changed', removing: 'removed when written' };

function render() {
  renderPending();
  if (!shown) return;
  const head = el('tr', {}, ...['#', 'Name', 'Receive', 'Transmit', 'Tone', 'Mode', 'Scan', '']
    .map((t, i) => el('th', { className: i === 0 ? 'num' : '' }, t)));
  const all = shown.channels;
  const rows = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (c.empty && !pending.has(i)) {
      // A run of empty slots is one row: "4–30, 27 empty"
      let j = i;
      while (j + 1 < all.length && all[j + 1].empty && !pending.has(j + 1) && marks[j + 1] === marks[i]) j++;
      rows.push(el('tr', { className: `empty${marks[i] ? ` ${marks[i]}` : ''}` },
        el('td', { className: 'num' }, j > i ? `${i + 1}–${j + 1}` : String(i + 1)),
        el('td', { colSpan: 7 }, j > i ? `${j - i + 1} empty` : 'empty')));
      i = j;
      continue;
    }
    rows.push(row(i));
    if (editing === i) rows.push(el('tr', { className: 'edit' }, el('td', { colSpan: 8 }, editForm(i))));
  }
  $('ch-table').replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
  renderPending();
}

/** One programmed (or pending) slot's row, with its scan box and what can be done to it. */
function row(slot) {
  const { c, state } = view(slot);
  const p = pending.get(slot);
  const tx = c.tx_disable ? 'off' : c.tx_hz === c.rx_hz ? 'same' : mhz(c.tx_hz);
  const scan = el('input', { type: 'checkbox', checked: Boolean(c.scan), disabled: state === 'removing' });
  scan.setAttribute('aria-label', `Scan ${c.name || `channel ${slot + 1}`}`);
  scan.onchange = () => setFields(slot, { scan: scan.checked });
  const actions = state === 'removing' || state === 'editing'
    ? [el('button', { className: 'link', onclick: () => undo(slot) }, 'Undo'),
      state === 'editing' ? el('button', { className: 'link', onclick: () => edit(slot) }, 'Edit') : '']
    : [el('button', { className: 'link', onclick: () => edit(slot) }, 'Edit'),
      el('button', { className: 'link', onclick: () => remove(slot) }, 'Remove')];
  const cls = [state, marks[slot] && !p ? marks[slot] : ''].filter(Boolean).join(' ');
  return el('tr', { className: cls },
    el('td', { className: 'num' }, String(slot + 1)),
    el('td', {}, c.name || '(no name)', state ? el('span', { className: `pill ${state}` }, STATE[state]) : ''),
    el('td', { className: 'num' }, mhz(c.rx_hz)),
    el('td', { title: c.tx_disable ? 'Transmit is turned off on this channel' : '' }, tx),
    el('td', {}, tones(c)),
    el('td', {}, modeText(c)),
    el('td', {}, scan),
    el('td', { className: 'acts' }, ...actions));
}

function renderPending() {
  const n = pending.size;
  $('ch-pending').hidden = !n;
  $('ch-pending-text').textContent = `${plural(n, 'change')} not written to the radio yet.`;
}

/** Change some fields of a slot: a pending new channel's, or the radio's (only what differs is kept). */
function setFields(slot, fields) {
  const p = pending.get(slot);
  if (p?.kind === 'new') {
    p.channel = { ...p.channel, ...fields };
  } else {
    const orig = shown.channels[slot];
    const set = { ...(p?.kind === 'set' ? p.set : {}), ...fields };
    for (const [k, v] of Object.entries(set)) if (orig[k] === v) delete set[k];
    if (Object.keys(set).length) pending.set(slot, { kind: 'set', set });
    else pending.delete(slot);
  }
  render();
}

function undo(slot) {
  pending.delete(slot);
  if (editing === slot) editing = null;
  render();
  syncBoxes();
}

function remove(slot) {
  const p = pending.get(slot);
  if (p?.kind === 'new') pending.delete(slot);
  else pending.set(slot, { kind: 'clear' });
  if (editing === slot) editing = null;
  render();
  syncBoxes();
}

function edit(slot) {
  editing = editing === slot ? null : slot;
  render();
  $('ch-table').querySelector('tr.edit input')?.focus();
}

// ---- A channel's form: editing one, or adding one by hand -----------------------

/**
 * The fields of a channel as a form. `onDone` gets the fields, as the radio
 * link names them, once they're valid.
 * @param {object} c - The channel to start from.
 * @param {{done: string, onDone: Function, onCancel?: Function, keepTx?: object}} o - The button's
 *   label, what to do, and (for a channel the radio has) its own transmit, which may stay as it is.
 * @returns {HTMLFormElement} The form.
 */
function channelForm(c, { done, onDone, onCancel, keepTx }) {
  const input = (props) => el('input', { spellcheck: false, ...props });
  const name = input({ value: c.name ?? '', maxLength: 10, required: true });
  const rx = input({ value: c.rx_hz ? mhz(c.rx_hz) : '', inputMode: 'decimal', placeholder: 'MHz', required: true, size: 10 });
  const mode = el('select', {},
    ...[['FM narrow', 'FM', 'narrow'], ['FM wide', 'FM', 'wide'], ['AM', 'AM', 'wide']].map(([t, m, b]) =>
      el('option', { value: `${m}/${b}`, selected: c.mod === m && (m === 'AM' || c.bandwidth === b) }, t)));
  const rxTone = input({ value: c.rx_tone ?? '', placeholder: 'none, 127.3 or D023', size: 12 });
  const txSel = el('select', {},
    el('option', { value: 'off', selected: Boolean(c.tx_disable) }, 'Off (receive only)'),
    el('option', { value: 'same', selected: !c.tx_disable && c.tx_hz === c.rx_hz }, 'Same as receive'),
    el('option', { value: 'other', selected: !c.tx_disable && c.tx_hz !== c.rx_hz }, 'Another frequency'));
  const txHz = input({ value: !c.tx_disable && c.tx_hz && c.tx_hz !== c.rx_hz ? mhz(c.tx_hz) : '', inputMode: 'decimal', placeholder: 'MHz', size: 10 });
  const txTone = input({ value: c.tx_tone ?? '', placeholder: 'none, 127.3 or D023', size: 12 });
  const power = el('select', {}, ...['high', 'medium', 'low'].map((p) =>
    el('option', { value: p, selected: (c.power ?? 'low') === p }, p[0].toUpperCase() + p.slice(1))));
  const scan = el('input', { type: 'checkbox', checked: c.scan !== false });
  const error = el('p', { className: 'tx-text error', hidden: true });
  const txOnly = [];
  const field = (label, ...kids) => el('label', {}, el('span', {}, label), ...kids);
  const txHzField = field('Transmit on', txHz);
  txOnly.push(txHzField, field('Transmit tone', txTone), field('Power', power));
  const showTx = () => {
    for (const f of txOnly) f.hidden = txSel.value === 'off';
    txHzField.hidden = txSel.value !== 'other';
  };
  txSel.onchange = showTx;
  showTx();

  const form = el('form', { className: 'channel-form' },
    field('Name', name), field('Receive', rx), field('Mode', mode), field('Receive tone', rxTone),
    field('Transmit', txSel), ...txOnly, field('Scan', scan),
    error,
    el('div', { className: 'row' }, el('button', { type: 'submit' }, done),
      onCancel ? el('button', { type: 'button', className: 'link', onclick: onCancel }, 'Cancel') : ''));
  form.onsubmit = (e) => {
    e.preventDefault();
    const bad = (msg) => {
      error.textContent = msg;
      error.hidden = false;
    };
    const n = radioName(name.value);
    if (!n) return bad('A name the radio can show: up to ten plain letters, digits and signs.');
    const rxHz = Math.round(Number(rx.value.trim()) * 1e6);
    const band = Number.isFinite(rxHz) ? bandOf(rxHz) : null;
    if (!band) return bad('The radio receives 108–136 MHz (the airband, AM), 136–174 and 400–520 MHz.');
    const [mod, bandwidth] = mode.value.split('/');
    if (band.mod && mod !== band.mod) return bad(`The ${band.name} is ${band.mod} only.`);
    const rt = toneOf(rxTone.value);
    if (rt === null) return bad('A tone is CTCSS in hertz, such as 127.3, or D and a DCS code, such as D023.');
    const f = { name: n, rx_hz: rxHz, mod, bandwidth: mod === 'AM' ? (c.bandwidth ?? 'wide') : bandwidth, rx_tone: rt, scan: scan.checked };
    if (txSel.value === 'off') {
      f.tx_disable = true;
    } else {
      const txv = txSel.value === 'same' ? rxHz : Math.round(Number(txHz.value.trim()) * 1e6);
      if (!Number.isFinite(txv) || txv <= 0) return bad('Give the frequency to transmit on.');
      const tt = toneOf(txTone.value);
      if (tt === null) return bad('A tone is CTCSS in hertz, such as 127.3, or D and a DCS code, such as D023.');
      // Transmit stays as the radio had it, or is in the ham bands: AirScribe turns it on nowhere else
      const asItWas = keepTx && !keepTx.tx_disable && keepTx.tx_hz === txv && keepTx.rx_hz === rxHz;
      if (!asItWas && !(isHam(rxHz) && isHam(txv))) {
        return bad('AirScribe writes transmit only in the 2 m and 70 cm ham bands (144–148 and 420–450 MHz): choose Off.');
      }
      Object.assign(f, { tx_disable: false, tx_hz: txv, tx_tone: tt, power: power.value });
    }
    error.hidden = true;
    onDone(f);
  };
  return form;
}

/** The form for one slot of the list. */
function editForm(slot) {
  const { c } = view(slot);
  const p = pending.get(slot);
  const orig = shown.channels[slot];
  return channelForm(c, {
    done: 'Done',
    keepTx: p?.kind === 'new' ? null : orig,
    onCancel: () => {
      editing = null;
      render();
    },
    onDone: (f) => {
      editing = null;
      if (p?.kind === 'new') {
        p.channel = { ...p.channel, ...f, ...(f.tx_disable ? { tx_hz: f.rx_hz, tx_tone: '' } : {}) };
        render();
      } else {
        // Receive-only keeps the transmit frequency it had, so only the switch changes
        setFields(slot, f);
      }
    },
  });
}

/** The first slot with nothing on it and nothing pending. */
function firstFree() {
  if (!shown) return -1;
  return shown.channels.findIndex((c, i) => c.empty && !pending.has(i));
}

/** Names on the region once written: two channels with one name are one channel to the feed and the map. */
function namesInUse(except) {
  const names = new Set();
  for (let i = 0; i < (shown?.channels.length ?? 0); i++) {
    if (i === except) continue;
    const { c, state } = view(i);
    if (!c.empty && state !== 'removing' && c.name) names.add(c.name);
  }
  return names;
}

/** A name not in use, with a number in its last place if it has to be. */
function uniqueName(name) {
  const used = namesInUse();
  let n = name;
  for (let k = 2; used.has(n) && k < 100; k++) n = `${name.slice(0, 10 - String(k).length).trim()}${k}`;
  return n;
}

/** Add a channel to the list, in the first free slot. */
function addChannel(channel, extra = {}) {
  const slot = firstFree();
  if (slot < 0) {
    say(`${regionName(shown.region, shown.name)} is full: remove a channel first, or pick another region.`, true);
    return -1;
  }
  pending.set(slot, { kind: 'new', channel: { ...channel, name: uniqueName(channel.name) }, ...extra });
  render();
  return slot;
}

async function writePending() {
  if (!pending.size) return;
  const place = $('st-place').checked;
  const channels = [...pending].map(([slot, p]) => (
    p.kind === 'clear' ? { id: slot, rx_hz: 0 }
      : p.kind === 'set' ? { id: slot, set: p.set }
        : { ...p.channel, id: slot, ...(place && p.group?.lat != null ? { lat: p.group.lat, lon: p.group.lon } : {}) }));
  const n = channels.length;
  busy(true);
  editing = null;
  say(`Writing ${plural(n, 'change')} to the radio…`);
  try {
    const res = await api(`/radios/${radio.mac}/channels`, { method: 'PUT', body: { region: shown.region, channels } });
    if (!res.results.length) {
      pending.clear();
      render();
      say('Nothing to write: the radio has these already.');
      return;
    }
    // Written, or already so on the radio: done. What didn't take stays pending, to try again
    const failed = new Set(res.results.filter((r) => !r.ok).map((r) => r.id));
    for (const c of channels) if (!failed.has(c.id)) pending.delete(c.id);
    showWritten(res, 'Written');
    if (res.placed) $('channels-status').textContent += ` ${plural(res.placed, 'channel')} put on the map.`;
    if (res.results.some((r) => r.ok)) $('st-listen').hidden = false;
    syncBoxes();
    await loadBackups();
  } catch (e) {
    say(e.message, true);
  } finally {
    busy(false);
  }
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

// ---- Backups -----------------------------------------------------------------

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
    'What’s there now is backed up first, so this can be undone too.' +
    (pending.size ? ` ${plural(pending.size, 'change')} not written yet will be discarded.` : ''))) return;
  busy(true);
  pending.clear();
  editing = null;
  say(`Writing ${where} to the radio…`);
  try {
    const res = await api(`/radios/${radio.mac}/backups/${b.id}/restore`, { method: 'POST' });
    if (!shown || shown.region !== res.region) {
      $('ch-region').value = String(res.region);
      shown = { region: res.region, name: res.name, count: res.results.length,
        channels: res.results.map((r) => r.channel ?? { id: r.id, empty: true }) };
    }
    showWritten(res, 'Put back');
    syncBoxes();
    await loadBackups();
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

// ---- Adding channels: from RadioReference, or by hand ----------------------------

let lookup = false;              // whether RadioReference is set up
let nearby = null;               // {area, groups}, once asked for
let showing = 25;                // groups listed
const stationsOf = new Map();    // scid -> its stations

const miles = (km) => {
  const mi = km * 0.621371;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
};

$('ch-add-open').onclick = () => openAdd(lookup ? 'near' : 'hand');
$('ch-add-close').onclick = () => { $('ch-add').hidden = true; };
$('add-tab-near').onclick = () => openAdd('near');
$('add-tab-hand').onclick = () => openAdd('hand');
$('st-more').onclick = () => { showing += 25; renderGroups(); };
$('st-listen').onclick = () => listen();

/** The Add panel, on one of its tabs. */
async function openAdd(tab) {
  $('ch-add').hidden = false;
  for (const [t, id] of [['near', 'add-tab-near'], ['hand', 'add-tab-hand']]) {
    $(id).setAttribute('aria-selected', String(t === tab));
    $(id).classList.toggle('on', t === tab);
  }
  $('add-near').hidden = tab !== 'near' || !lookup;
  $('add-near-off').hidden = tab !== 'near' || lookup;
  $('add-hand').hidden = tab !== 'hand';
  if (tab === 'hand') {
    $('add-hand').replaceChildren(channelForm(
      { name: '', rx_hz: 0, mod: 'FM', bandwidth: 'narrow', rx_tone: '', tx_disable: true, scan: true, power: 'low' },
      { done: 'Add to the list', onDone: (f) => {
        const slot = addChannel({ tx_hz: f.rx_hz, tx_tone: '', power: 'low', ...f });
        if (slot >= 0) {
          say(`${f.name} added as channel ${slot + 1}; write the changes to put it on the radio.`);
          openAdd('hand');
        }
      } }));
    $('add-hand').querySelector('input')?.focus();
    return;
  }
  if (!lookup) return;
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
const slotOfKey = (key) => [...pending].find(([, p]) => p.key === key)?.[0];

function stationItem(s, g) {
  const key = keyOf(s, g);
  const box = el('input', { type: 'checkbox', disabled: !s.ok, checked: slotOfKey(key) !== undefined });
  box.onchange = () => {
    if (box.checked) {
      if (addChannel(s.channel, { key, group: g }) < 0) box.checked = false;
    } else {
      const slot = slotOfKey(key);
      if (slot !== undefined) undo(slot);
    }
  };
  const what = [mhz(s.mhz * 1e6), s.alpha, s.descr && s.descr !== s.alpha ? s.descr : '', s.tone, s.mode]
    .filter(Boolean).join(' · ');
  const li = el('li', { className: s.ok ? '' : 'off' },
    el('label', {}, box, el('span', {}, what)),
    !s.ok ? el('div', { className: 'meta' }, `Can’t be written: ${s.why}.`)
      : s.toneNote ? el('div', { className: 'meta' }, s.toneNote) : '');
  li.dataset.key = key;
  return li;
}

/** Tick boxes follow what's in the list, wherever they're shown. */
function syncBoxes() {
  for (const li of $('st-groups').querySelectorAll('li[data-key]')) {
    const box = li.querySelector('input');
    if (box) box.checked = slotOfKey(li.dataset.key) !== undefined;
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
