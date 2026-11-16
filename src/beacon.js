/**
 * A radio's beacon (its "BSS settings": what it sends of itself over APRS or to
 * the radios like it) and an account's amateur radio profile, which can fill it
 * in. Checked here as the radio will take them, before they reach it; the radio
 * link checks again.
 */

const fail = (message) => Object.assign(new Error(message), { status: 400 });

/** Symbols to choose from for a beacon: table and code, and what they are. */
export const BEACON_SYMBOLS = [
  ['/[', 'Person'], ['/>', 'Car'], ['/-', 'House'], ['/k', 'Truck'], ['/v', 'Van'], ['/j', 'Jeep'],
  ['/R', 'RV'], ['/<', 'Motorcycle'], ['/b', 'Bicycle'], ['/Y', 'Yacht'], ['/s', 'Ship'], ["/'", 'Small aircraft'],
  ['/_', 'Weather station'], ['/#', 'Digipeater'], ['/r', 'Repeater'], ['/l', 'Laptop'], ['/a', 'Ambulance'],
  ['/f', 'Fire truck'], ['/P', 'Police'], ['/o', 'EOC'],
];

/**
 * A callsign as the radio keeps one: up to six letters and digits, with a
 * digit and a letter, as every amateur callsign has.
 * @param {unknown} v - The callsign.
 * @returns {string} Upper case; '' for none.
 */
export function callsign(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return '';
  if (!/^[A-Z0-9]{3,6}$/.test(s) || !/\d/.test(s) || !/[A-Z]/.test(s)) {
    throw fail(`${v} isn’t a callsign the radio can hold: three to six letters and digits, without the SSID`);
  }
  return s;
}

const text = (v, width, what) => {
  const s = String(v ?? '').trim();
  if (s.length > width || /[^\x20-\x7e]/.test(s)) throw fail(`${what} is up to ${width} plain letters, digits and signs`);
  return s;
};

const ssid = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 15) throw fail('an SSID is 0 to 15');
  return n;
};

const symbol = (v) => {
  const s = String(v ?? '');
  if (!/^[/\\A-Z0-9][\x21-\x7e]$/.test(s)) throw fail('a symbol is two characters: its table (/ or \\) and its code');
  return s;
};

/**
 * An account's amateur radio profile: callsign, SSID, symbol and beacon
 * message. No callsign clears it.
 * @param {object} p - The profile, as the Account page sends it.
 * @returns {object|null} Checked, or null for none.
 */
export function checkProfile(p) {
  const call = callsign(p?.callsign);
  if (!call) return null;
  return { callsign: call, ssid: ssid(p.ssid ?? 0), symbol: symbol(p.symbol ?? '/['), beacon: text(p.beacon, 18, 'A beacon message') };
}

const BOOLEANS = ['share_location', 'ptt_send_location', 'ptt_send_id'];

/**
 * Changes to a radio's beacon, checked; only the fields given.
 * @param {object} c - The fields: callsign, ssid, symbol, beacon, share_location, share_interval (seconds, in
 *   tens up to 2550), ptt_send_location, ptt_send_id, ptt_id_text, format (aprs or bss).
 * @returns {object} The changes.
 */
export function checkBeacon(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw fail('the changes are an object of fields');
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'callsign') out.callsign = callsign(v);
    else if (k === 'ssid') out.ssid = ssid(v);
    else if (k === 'symbol') out.symbol = symbol(v);
    else if (k === 'beacon') out.beacon = text(v, 18, 'The beacon message');
    else if (k === 'ptt_id_text') out.ptt_id_text = text(v, 12, 'The ID text');
    else if (k === 'share_interval') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 2550 || n % 10) throw fail('the sharing interval is 0 to 2550 seconds, in tens');
      out.share_interval = n;
    } else if (BOOLEANS.includes(k)) {
      if (typeof v !== 'boolean') throw fail(`${k} is true or false`);
      out[k] = v;
    } else if (k === 'format') {
      if (v !== 'aprs' && v !== 'bss') throw fail('the format is aprs or bss');
      out.format = v;
    } else throw fail(`a radio’s beacon has no ${k}`);
  }
  if (!Object.keys(out).length) throw fail('nothing to change');
  // Sending a position needs a callsign to send it as
  return out;
}
