/**
 * Channels as AirScribe writes them to a radio: what a channel may be, checked
 * before it reaches the radio, so a bad one is a clear 400 rather than a
 * message from the radio link (which checks again).
 *
 * The bands are the UV-Pro's, the radio this is developed against; the other
 * radios HTCommander supports share its design. A channel transmits only in
 * the ham bands: anything else AirScribe writes is receive-only.
 */

/** What the radio can receive, in hertz: VHF and UHF, and the airband in AM only. */
export const RECEIVE_BANDS = [
  { from: 108e6, to: 136e6, mod: 'AM', name: 'airband' },
  { from: 136e6, to: 174e6, name: 'VHF' },
  { from: 400e6, to: 520e6, name: 'UHF' },
];

/** The 2 m and 70 cm ham bands (US), the only ones a channel is written to transmit on. */
export const HAM_BANDS = [
  { from: 144e6, to: 148e6 },
  { from: 420e6, to: 450e6 },
];

const within = (hz, bands) => bands.find((b) => hz >= b.from && hz <= b.to) ?? null;

/** @returns {object|null} The receive band a frequency is in, or null when the radio can't hear it. */
export const receiveBand = (hz) => within(hz, RECEIVE_BANDS);

/** @returns {boolean} Whether a frequency is in a ham band the radio transmits in. */
export const isHam = (hz) => Boolean(within(hz, HAM_BANDS));

/**
 * A repeater's input by the US band plan, for a listing that gives only what it sends (Uniden's database): 2 m
 * 145.1–145.5 and 146.61–146.97 MHz down 600 kHz, 147.0–147.39 up 600 kHz; 70 cm 442–445 MHz up 5 MHz, 447–450 down
 * 5 MHz. Anything else is taken as simplex. Some areas pair them the other way: it's a guess to check.
 * @param {number} hz - What it sends on.
 * @returns {number|null} Its input, or null for simplex.
 */
export function standardInput(hz) {
  const m = hz / 1e6;
  const shift = (m >= 145.1 && m <= 145.5) || (m >= 146.61 && m <= 146.97) ? -0.6e6
    : m >= 147 && m <= 147.39 ? 0.6e6
      : m >= 442 && m < 445 ? 5e6
        : m >= 447 && m < 450 ? -5e6 : 0;
  return shift ? Math.round(hz + shift) : null;
}

const fail = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * A tone as the radio link takes it: "" (none), CTCSS in hertz ("127.3"), or
 * D and a DCS code ("D023"). RadioReference's "127.3 PL", "023 DPL", "D023N"
 * and "CSQ" are read too.
 * @param {unknown} value - The tone.
 * @returns {string} Normalised.
 */
export function tone(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s || s === 'CSQ' || s === 'NONE') return '';
  // DCS: D023, D023N, 023 DPL. The radio has no inverted codes (D023I).
  const dcs = /^D(\d{3})N?$/.exec(s) ?? /^(\d{3})\s*(?:DPL|DCS)$/.exec(s);
  if (dcs) {
    if (!/^[0-7]{3}$/.test(dcs[1])) throw fail(`${value} isn’t a DCS code`);
    return `D${dcs[1]}`;
  }
  // CTCSS: 127.3, 127.3 PL, 67 Hz
  const ctcss = /^(\d{2,3}(?:\.\d{1,2})?)\s*(?:PL|HZ)?$/.exec(s);
  if (ctcss) {
    const hz = Number(ctcss[1]);
    if (hz < 60 || hz > 260) throw fail(`${value} Hz isn’t a CTCSS tone`);
    return hz.toFixed(1);
  }
  throw fail(`${value} isn’t a tone the radio takes: CTCSS in hertz, or D and a DCS code`);
}

/**
 * A name the radio can show: ten plain characters. Anything else is dropped,
 * and a longer name cut short.
 * @param {unknown} text - A name.
 * @returns {string} The radio's version of it.
 */
export function radioName(text) {
  return String(text ?? '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10).trim();
}

/**
 * One channel to write, checked and filled out. A slot with no receive
 * frequency is written empty. Outside the ham bands, transmit is turned off
 * whatever was asked.
 * @param {object} c - The channel: id (its slot, from 0), name, rx_hz, tx_hz,
 *   mod, bandwidth, rx_tone, tx_tone, scan, power, tx_disable.
 * @returns {object} The channel as the radio link takes it.
 */
export function checkChannel(c) {
  if (!c || typeof c !== 'object') throw fail('a channel is an object');
  const id = c.id;
  if (!Number.isInteger(id) || id < 0 || id > 255) throw fail('a channel’s slot (id) is a whole number from 0');
  const rx = c.rx_hz ?? 0;
  if (rx === 0) return { id, rx_hz: 0 };
  if (!Number.isInteger(rx)) throw fail(`channel ${id + 1}: the receive frequency is in whole hertz`);
  const band = receiveBand(rx);
  if (!band) throw fail(`channel ${id + 1}: the radio can’t receive ${rx / 1e6} MHz`);
  const tx = c.tx_hz ?? rx;
  if (!Number.isInteger(tx) || tx <= 0) throw fail(`channel ${id + 1}: the transmit frequency is in whole hertz`);
  const mod = String(c.mod ?? band.mod ?? 'FM').toUpperCase();
  if (mod !== 'FM' && mod !== 'AM') throw fail(`channel ${id + 1}: a channel is FM or AM`);
  if (band.mod && mod !== band.mod) throw fail(`channel ${id + 1}: the ${band.name} is ${band.mod} only`);
  const bandwidth = c.bandwidth ?? 'wide';
  if (bandwidth !== 'wide' && bandwidth !== 'narrow') throw fail(`channel ${id + 1}: bandwidth is wide or narrow`);
  const power = c.power ?? 'low';
  if (!['high', 'medium', 'low'].includes(power)) throw fail(`channel ${id + 1}: power is high, medium or low`);
  const name = radioName(c.name);
  if (typeof c.name === 'string' && c.name.trim() && !name) throw fail(`channel ${id + 1}: the name has nothing the radio can show`);
  return {
    id, name, rx_hz: rx, tx_hz: tx, mod, bandwidth,
    rx_tone: tone(c.rx_tone), tx_tone: tone(c.tx_tone),
    scan: Boolean(c.scan), power,
    tx_disable: Boolean(c.tx_disable) || !(isHam(rx) && isHam(tx)),
  };
}

/** RadioReference's analog modes, as the radio plays them: modulation and bandwidth. */
const ANALOG = { FM: ['FM', 'wide'], FMN: ['FM', 'narrow'], NFM: ['FM', 'narrow'], AM: ['AM', 'wide'] };

/**
 * A RadioReference listing as a station to write: whether the radio can
 * receive it (and if not, why), and the channel to write for it.
 *
 * Outside the ham bands it's receive-only, with the listing's tone to open the
 * squelch, as a scanner is programmed. A ham repeater gets its input frequency
 * to transmit on and its tone to transmit with, but none to receive: the tone
 * listed is the one it's accessed with, and it may not send one back.
 * @param {object} f - The listing (a freq, as getSubcatFreqs gives it).
 * @param {string} mode - Its mode's name: FM, FMN, AM, P25, ...
 * @returns {object} The station.
 */
export function fromListing(f, mode) {
  const rx = Math.round(Number(f.out) * 1e6);
  const input = Number(f.in) ? Math.round(Number(f.in) * 1e6) : null;
  const m = String(mode ?? '').trim();
  const analog = ANALOG[m.toUpperCase()];
  const band = receiveBand(rx);
  let why = '';
  if (!analog) why = m ? `${m} is digital or data, and the radio plays FM and AM` : 'RadioReference doesn’t say what mode it is';
  else if (!band) why = `${Number(f.out)} MHz is outside the radio’s bands`;
  else if (band.mod && band.mod !== analog[0]) why = `the ${band.name} is ${band.mod} only`;
  let t = '';
  let toneNote = '';
  try {
    t = tone(f.tone);
  } catch {
    toneNote = `${f.tone} isn’t a tone the radio takes, so it’s written with none`;
  }
  const ham = isHam(rx) && (input === null || isHam(input));
  return {
    fid: f.fid ?? null,
    mhz: Number(f.out),
    input: input === null ? null : Number(f.in),
    alpha: f.alpha || '', descr: f.descr || '', tone: f.tone || '', mode: m, callsign: f.callsign || '',
    ok: !why, why, toneNote,
    channel: why ? null : {
      name: radioName(f.alpha || f.descr),
      rx_hz: rx, tx_hz: ham && input ? input : rx,
      mod: analog[0], bandwidth: analog[1],
      rx_tone: ham ? '' : t, tx_tone: ham ? t : '',
      scan: true, power: ham ? 'high' : 'low', tx_disable: !ham,
    },
  };
}

/**
 * The channels of one write, each checked; no slot twice.
 * @param {unknown} list - The channels.
 * @returns {object[]} Checked.
 */
export function checkChannels(list) {
  if (!Array.isArray(list) || !list.length) throw fail('channels is a list of at least one');
  if (list.length > 256) throw fail('that’s more channels than a region holds');
  const out = list.map(checkChannel);
  const slots = new Set(out.map((c) => c.id));
  if (slots.size !== out.length) throw fail('a slot is given twice');
  return out;
}

const SETTABLE = ['name', 'rx_hz', 'tx_hz', 'mod', 'bandwidth', 'rx_tone', 'tx_tone', 'scan', 'power', 'tx_disable'];

/**
 * A change to some of an existing channel's fields, checked against the
 * channel as the radio has it now. Transmit is never turned on outside the
 * ham bands, and a channel moved out of them is made receive-only; one that
 * only has its scan or name changed keeps its transmit as it was.
 * @param {number} id - The slot.
 * @param {object} current - The channel as read from the radio (decode_channel's fields).
 * @param {object} set - The fields to change.
 * @returns {object} The fields to change, normalised, for the radio link to patch in.
 */
export function applySet(id, current, set) {
  const at = `channel ${id + 1}`;
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw fail(`${at}: a change is an object of fields`);
  const unknown = Object.keys(set).filter((k) => !SETTABLE.includes(k));
  if (unknown.length) throw fail(`${at}: a channel has no ${unknown.join(', ')} to change`);
  if (!current || current.empty) throw fail(`${at} is empty: there’s nothing on it to change`);
  const out = {};
  if ('name' in set) {
    out.name = radioName(set.name);
    if (!out.name) throw fail(`${at}: a channel needs a name the radio can show`);
  }
  const rx = 'rx_hz' in set ? set.rx_hz : current.rx_hz;
  const mod = 'mod' in set ? String(set.mod).toUpperCase() : current.mod;
  if ('rx_hz' in set || 'mod' in set) {
    if (!Number.isInteger(rx) || rx <= 0) throw fail(`${at}: the receive frequency is in whole hertz`);
    const band = receiveBand(rx);
    if (!band) throw fail(`${at}: the radio can’t receive ${rx / 1e6} MHz`);
    if (mod !== 'FM' && mod !== 'AM') throw fail(`${at}: a channel is FM or AM`);
    if (band.mod && mod !== band.mod) throw fail(`${at}: the ${band.name} is ${band.mod} only`);
    if ('rx_hz' in set) out.rx_hz = rx;
    if ('mod' in set) out.mod = mod;
  }
  const tx = 'tx_hz' in set ? set.tx_hz : current.tx_hz;
  if ('tx_hz' in set) {
    if (!Number.isInteger(tx) || tx <= 0) throw fail(`${at}: the transmit frequency is in whole hertz`);
    out.tx_hz = tx;
  }
  if ('bandwidth' in set) {
    if (set.bandwidth !== 'wide' && set.bandwidth !== 'narrow') throw fail(`${at}: bandwidth is wide or narrow`);
    out.bandwidth = set.bandwidth;
  }
  if ('rx_tone' in set) out.rx_tone = tone(set.rx_tone);
  if ('tx_tone' in set) out.tx_tone = tone(set.tx_tone);
  if ('scan' in set) out.scan = Boolean(set.scan);
  if ('power' in set) {
    if (!['high', 'medium', 'low'].includes(set.power)) throw fail(`${at}: power is high, medium or low`);
    out.power = set.power;
  }
  const ham = isHam(rx) && isHam(tx);
  if ('tx_disable' in set) out.tx_disable = Boolean(set.tx_disable) || !ham;
  else if (('rx_hz' in set || 'tx_hz' in set) && !ham) out.tx_disable = true;
  return out;
}

/**
 * A write's channels, checked as far as they can be before the radio is read:
 * each a new channel (its fields), an empty slot ({id, rx_hz: 0}), or a change
 * to the channel in a slot ({id, set}), which is checked once the region has
 * been read for its backup (resolveWrite).
 * @param {unknown} list - The channels.
 * @returns {object[]} Each with its kind: 'new', 'clear' or 'set'.
 */
export function checkWrite(list) {
  if (!Array.isArray(list) || !list.length) throw fail('channels is a list of at least one');
  if (list.length > 256) throw fail('that’s more channels than a region holds');
  const out = list.map((c) => {
    if (c && typeof c === 'object' && 'set' in c) {
      if (!Number.isInteger(c.id) || c.id < 0 || c.id > 255) throw fail('a channel’s slot (id) is a whole number from 0');
      if (!c.set || typeof c.set !== 'object') throw fail(`channel ${c.id + 1}: a change is an object of fields`);
      return { kind: 'set', id: c.id, set: c.set };
    }
    const checked = checkChannel(c);
    return checked.rx_hz ? { kind: 'new', ...checked } : { kind: 'clear', ...checked };
  });
  if (new Set(out.map((c) => c.id)).size !== out.length) throw fail('a slot is given twice');
  return out;
}

/**
 * What the radio link writes, given the region as it was read: a change
 * becomes the channel's record with those fields patched in, so the bits
 * AirScribe doesn't model are kept. A change that changes nothing is left out.
 * @param {object[]} items - From checkWrite.
 * @param {object[]} slots - The region's every slot, as read (decode_channel's fields, with raw).
 * @returns {object[]} For the radio link.
 */
export function resolveWrite(items, slots) {
  const out = [];
  for (const { kind, ...c } of items) {
    if (kind !== 'set') {
      out.push(c);
      continue;
    }
    const current = slots.find((s) => s.id === c.id);
    const set = applySet(c.id, current, c.set);
    const changed = Object.fromEntries(Object.entries(set).filter(([k, v]) => current[k] !== v));
    if (Object.keys(changed).length) out.push({ id: c.id, raw: current.raw, set: changed });
  }
  return out;
}
