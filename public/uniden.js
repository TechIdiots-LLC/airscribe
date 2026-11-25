// Admin → Uniden's database: the HPDB folder from a scanner's SD card, a state at a time, for the Map's Find
// (docs/radioreference.md#from-unidens-database). Its files are s_<StateId>.hpd; hpdb.cfg names the states.
import { keep } from './prefs.js';

const $ =(id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

function withToken(path) {
  let token = '';
  try { token = localStorage.getItem('airscribe.token') ?? ''; } catch { /* storage blocked */ }
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
}

async function call(method, path, body) {
  const res = await fetch(withToken(`/api${path}`), {
    method, body, headers: { 'Content-Type': 'application/octet-stream' },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || res.statusText);
  return out;
}

const PICKED_KEY = 'airscribe.uniden.states';
const picked = () => { try { return JSON.parse(localStorage.getItem(PICKED_KEY) ?? '[]'); } catch { return []; } };

function say(text, error = false) {
  $('ud-status').textContent = text;
  $('ud-status').className = error ? 'tx-text error' : 'meta';
}

function render(s) {
  say(s.entries
    ? `${s.entries.toLocaleString()} frequencies and talkgroups from ${s.files} file${s.files === 1 ? '' : 's'}` +
      `${s.date ? `, the database of ${s.date.split(' ')[0]}` : ''},` +
      ` imported ${new Date(s.importedAt).toLocaleString()}.`
    : 'Not imported.');
  $('ud-clear').hidden = !s.entries;
  // The Map offers Find once it can work
  document.dispatchEvent(new CustomEvent('airscribe:lookup', { detail: { source: 'uniden', ready: s.entries > 0 } }));
}

async function load() {
  try {
    render(await call('GET', '/admin/uniden'));
  } catch (e) {
    say(e.message, true);
  }
}

// ---- A .zip of the folder, read here ----------------------------------------------
// Windows makes one from the folder's Send to menu. Only the central directory is read up front; each file is
// unpacked (DecompressionStream) as it's sent. No ZIP64: the HPDB folder is far below its 4 GB.

/**
 * The files in a zip, by name, wherever they are in it.
 * @param {File} zip - The zip.
 * @returns {Promise<{name: string, size: number, blob: () => Promise<Blob>}[]>} Its files.
 */
async function unzip(zip) {
  const tailSize = Math.min(zip.size, 65_557);
  const tail = new DataView(await zip.slice(zip.size - tailSize).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('that isn’t a .zip file');
  const count = tail.getUint16(end + 10, true);
  const dirSize = tail.getUint32(end + 12, true);
  const dirAt = tail.getUint32(end + 16, true);
  const dir = new DataView(await zip.slice(dirAt, dirAt + dirSize).arrayBuffer());
  const out = [];
  for (let p = 0, i = 0; i < count && p + 46 <= dir.byteLength; i++) {
    if (dir.getUint32(p, true) !== 0x02014b50) throw new Error('that .zip file is damaged');
    const method = dir.getUint16(p + 10, true);
    const packed = dir.getUint32(p + 20, true);
    const size = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true);
    const skip = nameLen + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
    const at = dir.getUint32(p + 42, true);
    const path = new TextDecoder().decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));
    p += 46 + skip;
    if (path.endsWith('/')) continue;
    out.push({
      name: path.split(/[\\/]/).pop(), size,
      blob: async () => {
        const local = new DataView(await zip.slice(at, at + 30).arrayBuffer());
        const start = at + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        const data = zip.slice(start, start + packed);
        if (method === 0) return data;
        if (method !== 8) {
          throw new Error(`${path} is packed in a way this page can’t read: zip it again with Windows’ Send to`);
        }
        return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      },
    });
  }
  return out;
}

let chosen = null;   // {cfg, states: [{id, name, file}]}, each file {name, blob()}

/** The database's files, from the folder or the zip: hpdb.cfg names the states the s_<StateId>.hpd files are. */
async function offer(files) {
  const cfg = files.find((f) => f.name.toLowerCase() === 'hpdb.cfg');
  if (!cfg) return say('There’s no hpdb.cfg in that: choose BCDx36HP/HPDB on the SD card, or a .zip of it.', true);
  const names = new Map();
  for (const line of (await (await cfg.blob()).text()).split(/\r?\n/)) {
    const m = /^StateInfo\tStateId=(\d+)\tCountryId=\d+\t([^\t]*)\t?([^\t]*)/.exec(line);
    if (m) names.set(Number(m[1]), m[3] ? `${m[2]} (${m[3]})` : m[2]);
  }
  const states = files.map((f) => ({ f, m: /^s_(\d{6})\.hpd$/i.exec(f.name) })).filter((x) => x.m)
    .map(({ f, m }) => ({ id: Number(m[1]), file: f,
      name: Number(m[1]) === 0 ? 'Systems across several states' : names.get(Number(m[1])) ?? f.name }))
    .sort((a, b) => (a.id === 0 ? -1 : b.id === 0 ? 1 : a.name.localeCompare(b.name)));
  if (!states.length) return say('There are no s_000000.hpd files in that folder.', true);
  chosen = { cfg, states };
  const was = new Set(picked());
  $('ud-states').replaceChildren(...states.map((s) => el('label', { className: 'toggle' },
    el('input', { type: 'checkbox', value: String(s.id), checked: s.id === 0 || was.has(s.id) }), ` ${s.name}`)));
  $('ud-pick').hidden = false;
  say(`${states.length} files. Tick the states your radios hear, then Import.`);
}

$('ud-choose').onclick = () => $('ud-folder').click();
$('ud-folder').onchange = async () => {
  const files = [...$('ud-folder').files].map((f) => ({ name: f.name, size: f.size, blob: async () => f }));
  $('ud-folder').value = '';
  await offer(files).catch((e) => say(e.message, true));
};
$('ud-choose-zip').onclick = () => $('ud-zip').click();
$('ud-zip').onchange = async () => {
  const zip = $('ud-zip').files[0];
  $('ud-zip').value = '';
  if (!zip) return;
  try {
    await offer(await unzip(zip));
  } catch (e) {
    say(`${zip.name}: ${e.message}`, true);
  }
};

$('ud-import').onclick = async () => {
  const ticked = new Set([...$('ud-states').querySelectorAll('input:checked')].map((i) => Number(i.value)));
  const todo = chosen?.states.filter((s) => ticked.has(s.id)) ?? [];
  if (!todo.length) return say('Tick at least one state.', true);
  keep(PICKED_KEY, JSON.stringify([...ticked]));
  $('ud-import').disabled = true;
  try {
    await call('PUT', '/admin/uniden/files/hpdb.cfg', await chosen.cfg.blob());
    let last = null;
    for (const [i, s] of todo.entries()) {
      say(`Importing ${s.name} (${i + 1} of ${todo.length})…`);
      last = await call('PUT', `/admin/uniden/files/${encodeURIComponent(s.file.name)}`, await s.file.blob());
    }
    $('ud-pick').hidden = true;
    render(last);
  } catch (e) {
    say(`Importing: ${e.message}`, true);
  } finally {
    $('ud-import').disabled = false;
  }
};

$('ud-clear').onclick = async () => {
  if (!confirm('Delete Uniden’s database from AirScribe? Channels already placed stay where they are.')) return;
  try {
    render(await call('DELETE', '/admin/uniden'));
  } catch (e) {
    say(e.message, true);
  }
};

document.addEventListener('airscribe:view', (e) => {
  if (e.detail === 'admin') load();
});
