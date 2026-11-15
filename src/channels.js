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
