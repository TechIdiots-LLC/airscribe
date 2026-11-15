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
  $('channels').showModal();
  busy(true);
  say('Reading the radio…');
  loadBackups();
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

async function removeBackup(b) {
  if (!confirm(`Delete the backup “${b.label}”? The radio isn’t changed.`)) return;
  try {
    await api(`/radios/${radio.mac}/backups/${b.id}`, { method: 'DELETE' });
    await loadBackups();
  } catch (e) {
    say(e.message, true);
  }
}
