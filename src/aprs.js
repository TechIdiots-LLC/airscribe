/**
 * What a packet the radio's own modem decoded says: APRS, or the radios' own
 * BSS packets. APRS after the APRS 1.01 spec, checked against the test packets
 * of Ham::APRS::FAP: positions (plain, compressed and Mic-E), weather, objects
 * and items, messages, status, telemetry, third-party packets and NMEA. Units
 * as FAP gives them: km/h, metres, °C, m/s, mm and hPa.
 */
import { decodeFrame, tnc2 } from './ax25.js';

const KNOT = 1.852;      // km/h
const MPH = 1.609344;    // km/h
const FOOT = 0.3048;     // m
const round1 = (x) => Math.round(x * 10) / 10;

/** A base-91 number, as compressed positions and Mic-E altitudes write them. */
function base91(s) {
  let n = 0;
  for (const ch of s) n = n * 91 + (ch.charCodeAt(0) - 33);
  return n;
}

// ---- Symbols: what a station is, for the list and the map --------------------

const PRIMARY = {
  '!': ['Police station', '🚔'], '#': ['Digipeater', '📡'], '$': ['Phone', '☎️'], '%': ['DX cluster', '🖥️'],
  '&': ['HF gateway', '📡'], "'": ['Small aircraft', '🛩️'], '(': ['Mobile satellite station', '🛰️'],
  '*': ['Snowmobile', '🛷'], '+': ['Red Cross', '➕'], ',': ['Boy Scouts', '⚜️'], '-': ['House', '🏠'],
  '.': ['X', '✖️'], '/': ['Dot', '🔴'], ':': ['Fire', '🔥'], ';': ['Campground', '⛺'], '<': ['Motorcycle', '🏍️'],
  '=': ['Train', '🚂'], '>': ['Car', '🚗'], '?': ['Server', '🖥️'], '@': ['Hurricane', '🌀'], A: ['Aid station', '⛑️'],
  B: ['BBS', '💾'], C: ['Canoe', '🛶'], E: ['Eyeball', '👁️'], F: ['Farm vehicle', '🚜'], G: ['Grid square', '🗺️'],
  H: ['Hotel', '🏨'], I: ['TCP/IP', '🌐'], K: ['School', '🏫'], L: ['PC user', '💻'], N: ['NTS station', '📨'],
  O: ['Balloon', '🎈'], P: ['Police', '🚓'], R: ['RV', '🚐'], S: ['Shuttle', '🚀'], T: ['SSTV', '📺'], U: ['Bus', '🚌'],
  V: ['ATV', '📺'], W: ['Weather service', '🌦️'], X: ['Helicopter', '🚁'], Y: ['Yacht', '⛵'], '[': ['Person', '🚶'],
  '\\': ['Triangle', '🔺'], ']': ['Mailbox', '📫'], '^': ['Large aircraft', '✈️'], _: ['Weather station', '🌤️'],
  '`': ['Dish antenna', '📡'], a: ['Ambulance', '🚑'], b: ['Bicycle', '🚲'], c: ['Incident command post', '🚩'],
  d: ['Fire station', '🚒'], e: ['Horse', '🐎'], f: ['Fire truck', '🚒'], g: ['Glider', '🪂'], h: ['Hospital', '🏥'],
  i: ['Island', '🏝️'], j: ['Jeep', '🚙'], k: ['Truck', '🚚'], l: ['Laptop', '💻'], m: ['Mic-E repeater', '📡'],
  n: ['Node', '📡'], o: ['EOC', '🏢'], p: ['Rover', '🐕'], q: ['Grid square', '🗺️'], r: ['Repeater', '📡'],
  s: ['Ship', '🚢'], t: ['Truck stop', '⛽'], u: ['Truck', '🚛'], v: ['Van', '🚐'], w: ['Water station', '💧'],
  x: ['xAPRS', '💻'], y: ['House with yagi', '🏠'], z: ['Shelter', '🏠'],
};
const ALTERNATE = {
  '#': ['Digipeater', '📡'], '&': ['Gateway', '📡'], "'": ['Crash site', '💥'], '-': ['House', '🏠'],
  '.': ['Ambiguous', '❓'], 0: ['Circle', '⭕'], ':': ['Hail', '🌨️'], ';': ['Park', '🌳'], '<': ['Advisory', '🚩'],
  '>': ['Car', '🚗'], '@': ['Hurricane', '🌀'], A: ['Box', '📦'], B: ['Blowing snow', '🌨️'], D: ['Drizzle', '🌧️'],
  E: ['Smoke', '💨'], F: ['Freezing rain', '🌧️'], G: ['Snow shower', '🌨️'], H: ['Haze', '🌫️'], I: ['Rain shower', '🌦️'],
  J: ['Lightning', '⚡'], K: ['Kenwood', '📻'], L: ['Lighthouse', '🗼'], N: ['Navigation buoy', '🛟'], O: ['Rocket', '🚀'],
  P: ['Parking', '🅿️'], Q: ['Earthquake', '🌋'], R: ['Restaurant', '🍴'], S: ['Satellite', '🛰️'], T: ['Thunderstorm', '⛈️'],
  U: ['Sunny', '☀️'], V: ['VORTAC', '✈️'], W: ['NWS site', '🌦️'], X: ['Pharmacy', '💊'], '[': ['Wall cloud', '🌩️'],
  '^': ['Aircraft', '✈️'], _: ['Weather station', '🌤️'], a: ['ARES/RACES', '📻'], c: ['Civil defence', '🔺'],
  e: ['Sleet', '🌨️'], f: ['Funnel cloud', '🌪️'], g: ['Gale flags', '🚩'], h: ['Ham store', '🏪'], j: ['Work zone', '🚧'],
  k: ['SUV', '🚙'], n: ['Triangle', '🔺'], o: ['Small circle', '⚪'], q: ['Fog', '🌫️'], r: ['Restrooms', '🚻'],
  s: ['Ship', '🚢'], t: ['Tornado', '🌪️'], u: ['Truck', '🚛'], v: ['Van', '🚐'], w: ['Flooding', '🌊'],
  y: ['Skywarn', '🌪️'], z: ['Shelter', '🏠'],
};

/**
 * @param {string} table - The symbol table: /, \, or an overlay character on the alternate.
 * @param {string} code - The symbol's code.
 * @returns {{name: string, icon: string, overlay: string|null}} What it is.
 */
export function symbolOf(table, code) {
  const [name, icon] = (table === '/' ? PRIMARY : ALTERNATE)[code] ?? ['Station', '📍'];
  return { name, icon, overlay: /^[A-Z0-9]$/.test(table) ? table : null };
}

// ---- Positions ---------------------------------------------------------------

/** Half the box a position with digits left out could be anywhere in, in minutes. */
const BLUR = [0, 0.05, 0.5, 5, 30];

/** Minutes from MM and hh digit pairs, some left out (spaces, from the right), at the box's middle. */
function minutes(mm, hh, blur) {
  const digits = [...`${mm}${hh}`];
  for (let i = 4 - blur; i < 4; i++) digits[i] = '0';
  if (digits.some((d) => d === ' ')) return null;
  return Number(`${digits[0]}${digits[1]}.${digits[2]}${digits[3]}`) + BLUR[blur];
}

/** A plain position: DDMM.hhN, the symbol table, DDDMM.hhW, the symbol code. */
function plain(s) {
  const m = /^(\d{2})([\d ]{2})\.([\d ]{2})([NS])([/\\A-Z0-9])(\d{3})([\d ]{2})\.([\d ]{2})([EW])(.)/i.exec(s);
  if (!m) return null;
  const [, latD, latM, latH, ns, table, lonD, lonM, lonH, ew, code] = m;
  const blur = (latM + latH).replace(/[^ ]/g, '').length;
  const latMin = minutes(latM, latH, blur);
  const lonMin = minutes(lonM, lonH, blur);
  if (latMin === null || lonMin === null || latMin >= 60 || lonMin >= 60) return null;
  const lat = Number(latD) + latMin / 60;
  const lon = Number(lonD) + lonMin / 60;
  if (lat > 90 || lon > 180) return null;
  return {
    lat: /s/i.test(ns) ? -lat : lat, lon: /w/i.test(ew) ? -lon : lon,
    symbolTable: table, symbolCode: code, ambiguity: blur, rest: s.slice(19),
  };
}

/** A compressed position: the table, four base-91 latitude characters, four longitude, the code, cs and type. */
function compressed(s) {
  if (s.length < 13 || !/^[/\\A-Za-j][\x21-\x7b]{8}/.test(s)) return null;
  const table = /[a-j]/.test(s[0]) ? String(s.charCodeAt(0) - 97) : s[0];
  const out = {
    lat: 90 - base91(s.slice(1, 5)) / 380926, lon: -180 + base91(s.slice(5, 9)) / 190463,
    symbolTable: table, symbolCode: s[9], compressed: true, rest: s.slice(13),
  };
  const c = s.charCodeAt(10);
  const sp = s.charCodeAt(11);
  const type = s.charCodeAt(12) - 33;
  if (c !== 0x20 && type >= 0) {
    if ((type & 0x18) === 0x10) out.altitude = 1.002 ** ((c - 33) * 91 + (sp - 33)) * FOOT;
    else if (c === 0x7b) out.range = 2 * 1.08 ** (sp - 33) * MPH;
    else if (c >= 33 && c <= 122) {
      out.course = c === 33 ? 360 : (c - 33) * 4;
      out.speed = (1.08 ** (sp - 33) - 1) * KNOT;
    }
  }
  return out;
}

const MIC_E = ['Emergency', 'Priority', 'Special', 'Committed', 'Returning', 'In service', 'En route', 'Off duty'];

/**
 * Mic-E: latitude, its hemisphere, the longitude's offset and hemisphere and
 * a status are in the destination address; longitude, speed, course and the
 * symbol in the first bytes of the information field.
 */
function micE(destination, info) {
  const d = destination.replace(/-\d+$/, '');
  if (info.length < 9 || !/^[0-9A-LP-Z]{6}$/.test(d)) return null;
  const digit = (ch) => {
    if (ch >= '0' && ch <= '9') return ch;
    if (ch >= 'A' && ch <= 'J') return String(ch.charCodeAt(0) - 65);
    if (ch >= 'P' && ch <= 'Y') return String(ch.charCodeAt(0) - 80);
    return ' ';   // K, L and Z: a digit left out
  };
  const dig = [...d].map(digit);
  const blur = dig.slice(2).join('').replace(/[^ ]/g, '').length;
  if (dig[0] === ' ' || dig[1] === ' ') return null;
  const latMin = minutes(dig[2] + dig[3], dig[4] + dig[5], blur);
  if (latMin === null || latMin >= 60) return null;
  const lat = Number(dig[0] + dig[1]) + latMin / 60;
  const kind = (ch) => (ch >= 'P' ? 'std' : ch >= 'A' ? 'custom' : 'zero');
  const bits = [...d.slice(0, 3)].map(kind);
  const n = parseInt(bits.map((b) => (b === 'zero' ? '0' : '1')).join(''), 2);
  const status = bits.includes('custom') ? (n ? `Custom ${7 - n}` : 'Emergency') : MIC_E[n];

  const at = (i) => info.charCodeAt(i) - 28;
  let lonD = at(1) + (d[4] >= 'P' ? 100 : 0);
  if (lonD >= 180 && lonD <= 189) lonD -= 80;
  else if (lonD >= 190 && lonD <= 199) lonD -= 190;
  let lonM = at(2);
  if (lonM >= 60) lonM -= 60;
  const lonH = at(3);
  if (lonD < 0 || lonD > 179 || lonM < 0 || lonM > 59 || lonH < 0 || lonH > 99) return null;
  const lonMin = minutes(String(lonM).padStart(2, '0'), String(lonH).padStart(2, '0'), blur);
  const lon = lonD + lonMin / 60;
  let speed = at(4) * 10 + Math.floor(at(5) / 10);
  if (speed >= 800) speed -= 800;
  let course = (at(5) % 10) * 100 + at(6);
  if (course >= 400) course -= 400;
  const code = info[7];
  const table = info[8];
  if (!/^[/\\A-Z0-9]$/.test(table)) return null;
  let rest = info.slice(9);
  const out = {
    lat: d[3] >= 'P' ? lat : -lat, lon: d[5] >= 'P' ? -lon : lon, symbolTable: table, symbolCode: code,
    speed: speed * KNOT, course, micE: status, ambiguity: blur,
  };
  // An altitude, xxx} in base 91 from 10 km below sea level, after a radio's type character
  const alt = /^(.?)([\x21-\x7b]{3})\}/.exec(rest);
  if (alt) {
    out.altitude = base91(alt[2]) - 10000;
    rest = alt[1] + rest.slice(alt[0].length);
  }
  // Which radio sent it, from the characters Kenwood and Yaesu put around the
  // comment: shown as the radio, not as part of what was said
  const kenwood = /^([>\]])([\s\S]*?)([=^~]?)$/.exec(rest);
  const yaesu = /^`([\s\S]*?)_([\x20-\x7e])$/.exec(rest);
  if (kenwood) {
    out.device = { '>=': 'Kenwood TH-D72', '>^': 'Kenwood TH-D74', '>~': 'Kenwood TH-D75', '>': 'Kenwood TH-D7',
      ']=': 'Kenwood TM-D710', ']': 'Kenwood TM-D700' }[kenwood[1] + kenwood[3]] ?? 'Kenwood';
    rest = kenwood[2];
  } else if (yaesu) {
    out.device = { ' ': 'Yaesu VX-8', '"': 'Yaesu FTM-350', '#': 'Yaesu VX-8G', $: 'Yaesu FT1D', '%': 'Yaesu FTM-400',
      ')': 'Yaesu FTM-100', '(': 'Yaesu FT2D', 0: 'Yaesu FT3D', 3: 'Yaesu FT5D', 4: 'Yaesu FTM-300', 5: 'Yaesu FTM-500' }[yaesu[2]] ?? 'Yaesu';
    rest = yaesu[1];
  }
  out.rest = rest;
  return out;
}

// ---- What follows a position ---------------------------------------------------

const WX = { c: 3, s: 3, g: 3, t: 3, r: 3, p: 3, P: 3, h: 2, b: 5, L: 3, l: 3, '#': 3 };

/** Weather fields: c, s, g, t, r, p, P, h, b, L and l, each a fixed width, until something else. */
function weatherFields(s, wx, positional) {
  let i = 0;
  while (i < s.length) {
    const key = s[i];
    const width = WX[key];
    if (!width) break;
    const v = s.slice(i + 1, i + 1 + width);
    if (v.length < width || !/^(-?\d+|[ .]+)$/.test(v)) break;
    const n = /^[ .]+$/.test(v) ? null : Number(v);
    if (n !== null) {
      if (key === 'c') wx.windDirection = n;
      else if (key === 's' && !positional) wx.windSpeed = round1((n * MPH) / 3.6);
      else if (key === 's') wx.snow24h = round1(n * 25.4);
      else if (key === 'g') wx.windGust = round1((n * MPH) / 3.6);
      else if (key === 't') wx.temp = round1(((n - 32) * 5) / 9);
      else if (key === 'r') wx.rain1h = round1(n * 0.254);
      else if (key === 'p') wx.rain24h = round1(n * 0.254);
      else if (key === 'P') wx.rainMidnight = round1(n * 0.254);
      else if (key === 'h') wx.humidity = n === 0 ? 100 : n;
      else if (key === 'b') wx.pressure = round1(n / 10);
      else if (key === 'L') wx.luminosity = n;
      else if (key === 'l') wx.luminosity = n + 1000;
    }
    i += 1 + width;
  }
  return { wx, rest: s.slice(i) };
}

/** A comment's extensions: course and speed, PHG, range, an altitude, telemetry; the rest is the comment. */
function extensions(rest, out) {
  let c = rest;
  let m = /^(\d{3})\/(\d{3})/.exec(c);
  if (m) {
    if (Number(m[1]) >= 1 && Number(m[1]) <= 360) out.course = Number(m[1]);
    out.speed = Number(m[2]) * KNOT;
    c = c.slice(7);
  } else if ((m = /^PHG(\d{4})\/?/.exec(c))) {
    out.phg = m[1];
    c = c.slice(m[0].length);
  } else if ((m = /^RNG(\d{4})/.exec(c))) {
    out.range = Number(m[1]) * MPH;
    c = c.slice(7);
  } else if (/^DFS\d{4}/.test(c)) {
    c = c.slice(7);
  }
  m = /\/A=(-\d{5}|\d{6})/.exec(c);
  if (m) {
    out.altitude = Number(m[1]) * FOOT;
    c = c.slice(0, m.index) + c.slice(m.index + m[0].length);
  }
  c = c.replace(/\|(?:[\x21-\x7b]{2}){2,7}\|/, '');
  out.comment = c.trim() || undefined;
}

/** After a position: weather when the symbol is a weather station's, else the comment's extensions. */
function afterPosition(out, rest) {
  if (out.symbolCode === '_') {
    const wx = {};
    let s = rest;
    const w = /^([\d .]{3})\/([\d .]{3})/.exec(s);
    if (w && /^\d{3}$/.test(w[1]) && /^\d{3}$/.test(w[2])) {
      wx.windDirection = Number(w[1]);
      wx.windSpeed = round1((Number(w[2]) * MPH) / 3.6);
      s = s.slice(7);
    } else if (w) {
      s = s.slice(7);
    } else if (out.speed !== undefined) {
      // A compressed position's course and speed are the wind
      wx.windDirection = out.course === 360 ? 0 : out.course;
      wx.windSpeed = round1(out.speed / 3.6);
      delete out.course;
      delete out.speed;
    }
    const got = weatherFields(s, wx, true);
    if (Object.keys(got.wx).length) {
      out.type = 'weather';
      out.wx = got.wx;
      out.comment = got.rest.trim() || undefined;
      return out;
    }
  }
  extensions(rest, out);
  return out;
}

/** A position packet's body: a plain or compressed position, then what follows it. */
function positionBody(s, extra) {
  const pos = /^\d/.test(s) ? plain(s) : compressed(s);
  if (!pos) return { type: 'invalid' };
  const { rest, ...p } = pos;
  return afterPosition({ type: 'position', ...extra, ...p }, rest);
}

// ---- The kinds of packet ---------------------------------------------------------

function message(info) {
  const m = /^:([^:]{9}):([\s\S]*)$/.exec(info);
  if (!m) return { type: 'invalid' };
  const out = { type: 'message', addressee: m[1].trim() };
  let text = m[2];
  const reply = /^(ack|rej)([A-Za-z0-9}]{1,5})\s*$/.exec(text);
  if (reply) {
    out[reply[1]] = reply[2];
    return out;
  }
  const id = /\{([A-Za-z0-9]{1,5})(?:\}([A-Za-z0-9]{0,5}))?\s*$/.exec(text);
  if (id) {
    out.messageId = id[1];
    if (id[2] !== undefined) out.replyAck = id[2];
    text = text.slice(0, id.index);
  }
  out.message = text.trimEnd();
  if (/^BLN/.test(out.addressee)) out.bulletin = true;
  return out;
}

function object(info) {
  if (info.length < 31 || (info[10] !== '*' && info[10] !== '_') || !/^\d{6}[zh/]/.test(info.slice(11, 18))) {
    return { type: 'invalid' };
  }
  const p = positionBody(info.slice(18), {});
  if (p.type === 'invalid') return p;
  return { ...p, type: p.type === 'weather' ? 'weather' : 'object', name: info.slice(1, 10).trimEnd(), alive: info[10] === '*' };
}

function item(info) {
  const m = /^\)([^!_]{3,9})([!_])([\s\S]*)$/.exec(info);
  if (!m) return { type: 'invalid' };
  const p = positionBody(m[3], {});
  if (p.type === 'invalid') return p;
  return { ...p, type: 'item', name: m[1].trimEnd(), alive: m[2] === '!' };
}

function nmea(info) {
  const f = info.split('*')[0].split(',');
  const coord = (v, h, degs) => {
    const x = Number(v.slice(0, degs)) + Number(v.slice(degs)) / 60;
    return Number.isFinite(x) && v ? (/[SW]/.test(h) ? -x : x) : null;
  };
  let out = null;
  if (/^\$G[PN]RMC$/.test(f[0]) && f[2] === 'A') {
    out = { lat: coord(f[3] ?? '', f[4], 2), lon: coord(f[5] ?? '', f[6], 3) };
    if (f[7]) out.speed = Number(f[7]) * KNOT;
    if (Number(f[8])) out.course = Math.round(Number(f[8]));
  } else if (/^\$G[PN]GGA$/.test(f[0]) && Number(f[6]) > 0) {
    out = { lat: coord(f[2] ?? '', f[3], 2), lon: coord(f[4] ?? '', f[5], 3) };
    if (f[9]) out.altitude = Number(f[9]);
  }
  if (!out || out.lat === null || out.lon === null) return { type: 'other' };
  return { type: 'position', format: 'nmea', symbolTable: '/', symbolCode: '/', ...out };
}

/**
 * What an APRS information field says.
 * @param {string} info - The field, as Latin-1 (Mic-E is binary).
 * @param {{destination?: string}} [frame] - The frame: Mic-E keeps half its position in the destination.
 * @returns {object} The packet: its type and what it carried.
 */
export function parseAprs(info, { destination = '' } = {}) {
  const t = info[0];
  try {
    if (t === '!' || t === '=') return positionBody(info.slice(1), { messaging: t === '=' });
    if (t === '/' || t === '@') {
      if (!/^\d{6}[zh/]/.test(info.slice(1, 8))) return { type: 'invalid' };
      return positionBody(info.slice(8), { messaging: t === '@', timestamp: info.slice(1, 8) });
    }
    if (t === "'" || t === '`' || t === '\x1c' || t === '\x1d') {
      const p = micE(destination, info);
      if (!p) return { type: 'invalid' };
      const { rest, ...pos } = p;
      return { type: 'position', format: 'mic-e', ...pos, comment: rest.trim() || undefined };
    }
    if (t === ':') return message(info);
    if (t === ';') return object(info);
    if (t === ')') return item(info);
    if (t === '>') {
      const ts = /^\d{6}z/.test(info.slice(1, 8));
      return { type: 'status', status: info.slice(ts ? 8 : 1).trim(), ...(ts ? { timestamp: info.slice(1, 8) } : {}) };
    }
    if (t === '_' && /^\d{8}/.test(info.slice(1, 9))) {
      const got = weatherFields(info.slice(9), {}, false);
      if (!Object.keys(got.wx).length) return { type: 'invalid' };
      return { type: 'weather', wx: got.wx, comment: got.rest.trim() || undefined };
    }
    if (t === 'T' && info[1] === '#') return { type: 'telemetry', telemetry: info.slice(2).trim() };
    if (t === '}') {
      const m = /^\}([A-Z0-9-]{1,9})>([^,:]+)((?:,[^,:]+)*):([\s\S]*)$/i.exec(info);
      if (!m) return { type: 'invalid' };
      const inner = parseAprs(m[4], { destination: m[2] });
      return { ...inner, thirdParty: { source: m[1], destination: m[2], path: m[3].split(',').filter(Boolean), info: m[4] } };
    }
    if (t === '$') return nmea(info);
    // Old trackers put a position further in, behind other text
    const at = info.indexOf('!');
    if (at > 0 && at < 40) {
      const p = positionBody(info.slice(at + 1), {});
      if (p.type !== 'invalid') return p;
    }
    return { type: 'other' };
  } catch {
    return { type: 'invalid' };
  }
}

// ---- The radios' own BSS packets ---------------------------------------------------

const int24 = (b, at) => {
  const v = (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
  return v & 0x800000 ? v - 0x1000000 : v;
};

/**
 * A BSS packet (HTCommander's docs/BSS-Protocol.md): 0x01, then fields of a
 * length byte (counting the tag), a tag and a value: from (0x20), to (0x21),
 * a message (0x24), a location (0x25), asking for a station's location (0x27)
 * or ringing one (0x28). A length of 0x85 is a two-byte message counter. The
 * location is read as the radio reports its own GPS: 24-bit signed minutes
 * x 500, latitude then longitude, then altitude (m), speed and heading; the
 * documentation's example reads so as near Portland, Oregon, from a 7-area call.
 * @param {Buffer} buf - The packet.
 * @returns {object|null} What it says, or null if it isn't one.
 */
export function decodeBss(buf) {
  if (!Buffer.isBuffer(buf) || buf[0] !== 0x01) return null;
  const out = { type: 'bss', others: [] };
  for (let at = 1; at < buf.length;) {
    const len = buf[at];
    if (len === 0x85) {
      if (at + 3 > buf.length) break;
      out.counter = buf.readUInt16BE(at + 1);
      at += 3;
      continue;
    }
    if (len < 1 || at + 1 + len > buf.length) break;
    const tag = buf[at + 1];
    const value = buf.subarray(at + 2, at + 1 + len);
    const text = value.toString('utf8').replace(/\0+$/, '');
    if (tag === 0x20) out.source = text;
    else if (tag === 0x21) out.destination = text || undefined;
    else if (tag === 0x24) out.message = text;
    else if (tag === 0x27) out.locationRequest = text;
    else if (tag === 0x28) out.callRequest = text;
    else if (tag === 0x25 && value.length >= 6) {
      out.lat = int24(value, 0) / 500 / 60;
      out.lon = int24(value, 3) / 500 / 60;
      if (value.length >= 12) {
        out.altitude = value.readInt16BE(6);
        out.heading = value.readUInt16BE(10);
      }
    } else out.others.push({ tag, value: value.toString('hex') });
    at += 1 + len;
  }
  if (!out.source || Math.abs(out.lat ?? 0) > 90 || Math.abs(out.lon ?? 0) > 180) return null;
  if (!out.others.length) delete out.others;
  return out;
}

// ---- A packet, whole ---------------------------------------------------------------

/** Text as it was meant: UTF-8 where it is, Latin-1 where it isn't. */
function readable(s) {
  if (typeof s !== 'string') return s;
  const u = Buffer.from(s, 'latin1').toString('utf8');
  return u.includes('�') ? s : u;
}

const f = (n, places = 4) => Number(n).toFixed(places);
const cToF = (c) => Math.round((c * 9) / 5 + 32);
const mph = (kmh) => Math.round(kmh / MPH);

/**
 * One line saying what a packet said, for the packets list and the feed.
 * @param {object} p - A decoded packet.
 * @returns {string} The line.
 */
export function describe(p) {
  const where = p.lat !== undefined && p.lat !== null ? `${f(p.lat)}, ${f(p.lon)}` : '';
  const moving = p.speed >= 1 ? `, ${mph(p.speed)} mph${p.course ? ` heading ${p.course}°` : ''}` : '';
  const said = p.comment ? ` “${p.comment}”` : '';
  switch (p.type) {
    case 'position':
      return `${p.symbol?.name ?? 'Position'} at ${where}${moving}${p.micE && p.micE !== 'Off duty' ? ` (${p.micE})` : ''}${said}`;
    case 'weather': {
      const w = p.wx ?? {};
      const bits = [
        w.temp !== undefined ? `${cToF(w.temp)}°F` : '',
        w.windSpeed !== undefined ? `wind ${w.windDirection ?? '?'}° ${mph(w.windSpeed * 3.6)} mph` : '',
        w.windGust !== undefined ? `gusting ${mph(w.windGust * 3.6)}` : '',
        w.humidity !== undefined ? `humidity ${w.humidity}%` : '',
        w.pressure !== undefined ? `${w.pressure} hPa` : '',
        w.rain1h ? `rain ${(w.rain1h / 25.4).toFixed(2)} in the last hour` : '',
      ].filter(Boolean);
      return `Weather${p.name ? ` (${p.name})` : ''}: ${bits.join(', ') || 'no readings'}${where ? ` at ${where}` : ''}`;
    }
    case 'object':
    case 'item':
      return `${p.type === 'object' ? 'Object' : 'Item'} ${p.name}${p.alive ? '' : ' (removed)'}: ${p.symbol?.name ?? ''} at ${where}${moving}${said}`;
    case 'message':
      if (p.ack) return `Acknowledges message ${p.ack} to ${p.addressee}`;
      if (p.rej) return `Rejects message ${p.rej} to ${p.addressee}`;
      return `${p.bulletin ? 'Bulletin' : 'To'} ${p.addressee}: ${p.message}`;
    case 'status':
      return `Status: ${p.status}`;
    case 'telemetry':
      return `Telemetry ${p.telemetry}`;
    case 'bss':
      return [p.destination ? `To ${p.destination}:` : '', p.message ? `“${p.message}”` : '', where ? `at ${where}` : '',
        p.locationRequest ? `asks where ${p.locationRequest} is` : '', p.callRequest ? `rings ${p.callRequest}` : '']
        .filter(Boolean).join(' ') || 'BSS packet';
    case 'invalid':
      return `Not readable as APRS: ${p.info}`;
    default:
      return p.info || '(empty)';
  }
}

/**
 * A packet as the radio's modem handed it over, decoded: BSS when it starts
 * with 0x01, else an AX.25 frame and its APRS.
 * @param {Buffer} raw - The packet.
 * @returns {object|null} Its source, destination and path, type, what it said, and a summary; null if it's neither.
 */
export function decodePacket(raw) {
  if (raw?.[0] === 0x01) {
    const b = decodeBss(raw);
    if (!b) return null;
    const out = { format: 'bss', path: [], info: b.message ?? '', ...b, symbol: { name: 'Radio', icon: '📻', overlay: null } };
    return { ...out, summary: describe(out) };
  }
  const frame = decodeFrame(raw);
  if (!frame) return null;
  const latin = frame.info.toString('latin1');
  const p = frame.pid === 0xf0 ? parseAprs(latin, frame) : { type: 'other' };
  for (const k of ['comment', 'message', 'status']) if (p[k]) p[k] = readable(p[k]);
  const out = {
    format: 'aprs', source: p.thirdParty?.source ?? frame.source, destination: frame.destination, path: frame.path,
    info: readable(latin), tnc2: tnc2(frame, readable(latin)), ...p,
  };
  if (out.thirdParty) out.via = frame.source;
  if (out.symbolTable) out.symbol = symbolOf(out.symbolTable, out.symbolCode);
  return { ...out, summary: describe(out) };
}
