// Amateur radio: your profile (callsign, SSID, symbol, beacon message) on the
// Account page, and a radio's beacon in its Controls, which the profile can
// fill in. The beacon is what the radio sends of itself: its position over
// APRS, or to the radios like it, as a callsign. The server checks everything again.
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
    ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// As src/beacon.js offers them
export const SYMBOLS = [
  ['/[', 'Person', '🚶'], ['/>', 'Car', '🚗'], ['/-', 'House', '🏠'], ['/k', 'Truck', '🚚'], ['/v', 'Van', '🚐'],
  ['/j', 'Jeep', '🚙'], ['/R', 'RV', '🚐'], ['/<', 'Motorcycle', '🏍️'], ['/b', 'Bicycle', '🚲'], ['/Y', 'Yacht', '⛵'],
  ['/s', 'Ship', '🚢'], ["/'", 'Small aircraft', '🛩️'], ['/_', 'Weather station', '🌤️'], ['/#', 'Digipeater', '📡'],
  ['/r', 'Repeater', '📡'], ['/l', 'Laptop', '💻'], ['/a', 'Ambulance', '🚑'], ['/f', 'Fire truck', '🚒'],
  ['/P', 'Police', '🚓'], ['/o', 'EOC', '🏢'],
];
/** What APRS uses each SSID for, by custom. */
const SSIDS = ['home', 'other', 'other', 'other', 'other', 'other networks', 'special event', 'handheld', 'boat or RV',
  'mobile', 'internet', 'balloon or aircraft', 'portable', 'weather', 'truck', 'other'];

function symbolSelect(value) {
  const known = SYMBOLS.some(([s]) => s === value);
  return el('select', {},
    ...(value && !known ? [el('option', { value, selected: true }, `${value} (as set)`)] : []),
    ...SYMBOLS.map(([s, name, icon]) => el('option', { value: s, selected: s === value }, `${icon} ${name}`)));
}

function ssidSelect(value) {
  return el('select', {}, ...SSIDS.map((what, i) =>
    el('option', { value: i, selected: i === value }, `${i ? `-${i}` : 'none'} (${what})`)));
}

const callOf = (p) => (p?.callsign ? `${p.callsign}${p.ssid ? `-${p.ssid}` : ''}` : '');

// ---- Your profile, on the Account page ------------------------------------------

let me = null;     // the account signed in, as /api/account has it
let profile = null;

$('ham-ssid').replaceWith(Object.assign(ssidSelect(7), { id: 'ham-ssid' }));
$('ham-symbol').replaceWith(Object.assign(symbolSelect('/['), { id: 'ham-symbol' }));

document.addEventListener('airscribe:signed-in', (e) => {
  profile = e.detail?.user?.radio ?? null;
  me = e.detail?.user ?? null;
});

document.addEventListener('airscribe:account', (e) => {
  me = e.detail;
  profile = me?.radio ?? null;
  $('ham-callsign').value = profile?.callsign ?? '';
  $('ham-ssid').value = String(profile?.ssid ?? 7);
  $('ham-symbol').value = profile?.symbol ?? '/[';
  $('ham-beacon').value = profile?.beacon ?? '';
});

$('ham-callsign').oninput = () => { $('ham-callsign').value = $('ham-callsign').value.toUpperCase(); };
$('ham-save').onclick = async () => {
  try {
    const { radio } = await api('/account/radio', { method: 'PUT', body: {
      callsign: $('ham-callsign').value, ssid: Number($('ham-ssid').value), symbol: $('ham-symbol').value,
      beacon: $('ham-beacon').value,
    } });
    profile = radio;
    $('ham-status').textContent = radio ? `Saved: you're ${callOf(radio)}.` : 'Cleared.';
    $('ham-status').className = 'meta';
    document.dispatchEvent(new CustomEvent('airscribe:profile', { detail: radio }));
  } catch (e) {
    $('ham-status').textContent = e.message;
    $('ham-status').className = 'tx-text error';
  }
};

// ---- A radio's beacon, in its Controls ------------------------------------------

const MINUTES = [1, 2, 5, 10, 15, 20, 30, 40];

/**
 * The radio's beacon settings, read when asked for, and a form to change them.
 * @param {object} r - The radio.
 * @returns {HTMLElement} The section, for the Controls dialog.
 */
export function beaconSection(r) {
  const box = el('div', { className: 'beacon' });
  const open = el('button', { className: 'link', onclick: () => load() }, 'Beacon and location sharing…');
  box.append(open);
  const say = el('p', { className: 'meta' });

  async function load() {
    open.disabled = true;
    say.textContent = 'Reading the radio’s beacon…';
    box.replaceChildren(el('h3', {}, 'Beacon'), say);
    try {
      render(await api(`/radios/${r.mac}/beacon`));
    } catch (e) {
      say.textContent = e.message;
      say.className = 'tx-text error';
    }
  }

  function render(b) {
    const call = el('input', { value: b.callsign, maxLength: 6, size: 8, spellcheck: false });
    call.oninput = () => { call.value = call.value.toUpperCase(); };
    const ssid = ssidSelect(b.ssid);
    const symbol = symbolSelect(b.symbol);
    const message = el('input', { value: b.beacon, maxLength: 18, size: 20, spellcheck: false });
    const format = el('select', {},
      el('option', { value: 'aprs', selected: b.format === 'aprs' }, 'APRS'),
      el('option', { value: 'bss', selected: b.format === 'bss' }, 'Only to radios like this one (BSS)'));
    const share = el('input', { type: 'checkbox', checked: b.share_location });
    const every = el('select', {}, ...MINUTES.map((m) => el('option', { value: m * 60, selected: b.share_interval === m * 60 }, `every ${m} min`)));
    if (!MINUTES.includes(b.share_interval / 60) && b.share_interval) {
      every.prepend(el('option', { value: b.share_interval, selected: true }, `every ${b.share_interval} s`));
    }
    const ptt = el('input', { type: 'checkbox', checked: b.ptt_send_location });
    const send = async (body, what) => {
      for (const i of box.querySelectorAll('input, select, button')) i.disabled = true;
      say.textContent = `${what}…`;
      say.className = 'meta';
      try {
        const now = await api(`/radios/${r.mac}/beacon`, { method: 'PUT', body });
        render(now);
        say.textContent = `The radio has it: ${callOf(now) || 'no callsign'}` +
          `${now.share_location || now.ptt_send_location ? ', sharing its location' : ''}.`;
      } catch (e) {
        say.textContent = e.message;
        say.className = 'tx-text error';
        for (const i of box.querySelectorAll('input, select, button')) i.disabled = false;
      }
    };
    const save = el('button', { onclick: () => send({
      callsign: call.value, ssid: Number(ssid.value), symbol: symbol.value, beacon: message.value, format: format.value,
      share_location: share.checked, share_interval: Number(every.value), ptt_send_location: ptt.checked,
    }, 'Writing to the radio') }, 'Save to radio');
    const mine = profile
      ? el('button', { onclick: () => send({ profile: true }, `Filling it in as ${callOf(profile)}`) }, `Use my profile (${callOf(profile)})`)
      : el('span', { className: 'meta' }, me ? 'Add your callsign on your account page to fill this in from it.' : '');
    const field = (label, ...kids) => el('label', {}, el('span', {}, label), ...kids);
    box.replaceChildren(
      el('h3', {}, 'Beacon'),
      el('p', { className: 'meta' }, 'What the radio sends of itself. Sharing its location makes it transmit its position ' +
        'as this callsign, on its own and after you talk: only with your licence.'),
      el('div', { className: 'channel-form' },
        field('Callsign', call), field('SSID', ssid), field('Symbol', symbol), field('Message', message),
        field('Sent as', format),
        field('Share location', el('span', { className: 'row' }, share, every)),
        field('After you talk', el('span', { className: 'row' }, ptt, el('span', { className: 'meta' }, 'send position')))),
      el('div', { className: 'row wrap' }, mine, save),
      say);
    say.textContent = b.callsign ? `Beaconing as ${callOf(b)}` + (b.share_location ? `, every ${Math.round(b.share_interval / 60)} min` : '') +
      (b.ptt_send_location ? ', and after each transmission.' : '.') : 'No callsign set.';
    say.className = 'meta';
  }
  box.append(say);
  return box;
}
