/**
 * Plates read out on the radio: "Mass reg 4 Sierra Sierra Romeo 33" is 4SSR33. Found in the words themselves,
 * not left to the model, which reads a phonetic alphabet as names ("Sierra Street") or drops it (docs/findings.md).
 */

import { words } from './roads.js';

// Both alphabets dispatchers use: ICAO/NATO and the older APCO one
const LETTERS = {
  alpha: 'a', alfa: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e', foxtrot: 'f', golf: 'g', hotel: 'h',
  india: 'i', juliet: 'j', juliett: 'j', kilo: 'k', lima: 'l', mike: 'm', november: 'n', oscar: 'o', papa: 'p',
  quebec: 'q', romeo: 'r', sierra: 's', tango: 't', uniform: 'u', victor: 'v', whiskey: 'w', whisky: 'w', xray: 'x',
  yankee: 'y', zulu: 'z',
  adam: 'a', boy: 'b', charles: 'c', david: 'd', edward: 'e', frank: 'f', george: 'g', henry: 'h', ida: 'i',
  john: 'j', king: 'k', lincoln: 'l', mary: 'm', nora: 'n', ocean: 'o', paul: 'p', peter: 'p', queen: 'q',
  robert: 'r', sam: 's', tom: 't', union: 'u', william: 'w', young: 'y', zebra: 'z',
};
const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINALS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th',
  eighth: '8th', ninth: '9th', tenth: '10th',
};
// What comes before a plate: "Mass reg", "registration", "plate", "tag"; "Mass range" is how it's often misheard
const CUES = new Set(['reg', 'registration', 'plate', 'plates', 'tag', 'tags']);
// A ham callsign spelled out the same way ("November 1 Victor Zulu" is N1VZ) isn't a plate
const CALLSIGN = /^[a-z]{1,2}\d[a-z]{1,3}$/;
// Said between a plate and its repeat: "6 Papa Tango Papa 38, that's 6 PTP 38"
const FILLER = new Set(['thats', 'that', 'is', 'its', 'again', 'say', 'repeat', 'correction']);

/**
 * words() with numbers said as words made digits: "twenty four" is 24, "one two three" 1 2 3, "second" 2nd.
 * @param {string} s - Text.
 * @returns {string[]} The words.
 */
export function numerals(s) {
  // "I'm" is one word, not the letters I and M; "X ray" is one letter
  // "114.8" (a tone, a frequency) is a number with a point, not digits to run together
  // A letter on its own stays one: words() makes "W" west and "N" north, as in a road's name
  const t = String(s ?? '').replace(/\bx[- ]ray\b/gi, 'xray').replace(/['’]/g, '').replace(/(\d)\.(\d)/g, '$1 point $2')
    .split(/\s+/).flatMap((w) => (/^[a-z]\W*$/i.test(w) ? [w.slice(0, 1).toLowerCase()] : words(w).split(' ')))
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (w in TENS && t[i + 1] in ONES && ONES[t[i + 1]] > 0 && ONES[t[i + 1]] < 10) out.push(String(TENS[w] + ONES[t[++i]]));
    else if (w in TENS) out.push(String(TENS[w]));
    else if (w in ONES) out.push(String(ONES[w]));
    else if (w in ORDINALS) out.push(ORDINALS[w]);
    else out.push(w);
  }
  return out;
}

/** What one word adds to a plate being read out, or null if it ends one. */
function part(w) {
  if (w in LETTERS) return { s: LETTERS[w], letter: true, said: true };
  if (/^\d+$/.test(w)) return { s: w, digit: true };
  if (/^[a-z]$/.test(w)) return { s: w, letter: true };
  // A run the recogniser already wrote as one ("6LAM", "KC1"); not "6th". "A1" is more often a unit ("5 A1")
  if (/^[a-z0-9]{2,7}$/.test(w) && /\d/.test(w) && /[a-z]/.test(w) && !/^\d+(st|nd|rd|th)$/.test(w)) {
    return { s: w, digit: true, letter: true, said: w.length >= 3 };
  }
  return null;
}

/**
 * A plate said twice in a row, as dispatch does to confirm it: "4 Foxtrot Yankee Victor 34, 4 FYV 34". The
 * repeat says where the plate ends, which the run of letters and digits alone doesn't (4FYV344).
 * @returns {{plate: string, to: number}|null} The plate, and the word after its repeat.
 */
function twice(t, from) {
  let s = '';
  const end = [];
  for (let j = from; j < t.length && s.length < 20; j++) {
    if (s && FILLER.has(t[j])) continue;
    // Letters written as a word ("FYV") count here: only an exact repeat is taken
    const p = part(t[j]) ?? (/^[a-z]{2,3}$/.test(t[j]) ? { s: t[j] } : null);
    if (!p) break;
    s += p.s;
    for (let k = 0; k < p.s.length; k++) end.push(j + 1);
  }
  for (let n = 8; n >= 4; n--) {
    const a = s.slice(0, n);
    if (s.slice(n, 2 * n) === a && /\d/.test(a) && /[a-z]/.test(a) && !CALLSIGN.test(a)) return { plate: a, to: end[2 * n - 1] };
  }
  return null;
}

/**
 * The plates read out in some text.
 * @param {string} text - A transcript.
 * @returns {{plates: {plate: string, cued: boolean}[], unclear: boolean, rest: string}} Each plate (upper case),
 *   and whether "reg" or "plate" was said before it; unclear when one was said with no plate after it; and the
 *   text without the words a plate was read out in, so "Sierra" spelled out isn't taken for a road's name.
 */
export function readPlates(text) {
  const t = numerals(text);
  const plates = [];
  const used = new Set();
  let unclear = false;
  for (let i = 0; i < t.length; i++) {
    if (used.has(i)) continue;
    const cue = CUES.has(t[i]) || (t[i] === 'range' && t[i - 1] === 'mass');
    // A run starts at a cue (a word or two after it: "reg is 4…") or anywhere at all
    let from = i;
    if (cue) {
      from = i + 1;
      while (from < t.length && from <= i + 3 && !part(t[from])) from++;
    } else if (!part(t[i])) continue;
    // A number read out after "location number", "log number", "case number is": a reference, not a plate
    else if (t[i - 1] === 'number' || (t[i - 1] === 'is' && t[i - 2] === 'number')) {
      let end = twice(t, i)?.to ?? i;
      while (end < t.length && part(t[end])) end++;
      i = end - 1;
      continue;
    }
    // Or a word in: a stray letter before it ("H six Papa Tango Papa 38, that's 6 PTP 38")
    const stray = part(t[from]);
    const rep = twice(t, from) ?? (stray?.letter && stray.s.length === 1 && !stray.said ? twice(t, from + 1) : null);
    if (rep) {
      for (let k = from; k < rep.to; k++) used.add(k);
      if (!plates.some((p) => p.plate === rep.plate.toUpperCase())) plates.push({ plate: rep.plate.toUpperCase(), cued: cue });
      i = rep.to - 1;
      continue;
    }
    let s = '';
    let letters = 0;
    let spoken = 0;   // letters said as a word, or written in a run: a bare "a" or "i" is more likely a word
    let digits = 0;
    let j = from;
    for (; j < t.length; j++) {
      const p = part(t[j]);
      if (!p) break;
      s += p.s;
      if (p.letter) letters += p.s.replace(/\d/g, '').length;
      if (p.said) spoken += p.s.replace(/\d/g, '').length;
      if (p.digit) digits += p.s.replace(/\D/g, '').length;
    }
    // Ending in a number with a point ("PL 114.8"): a tone or a frequency
    const decimal = t[j] === 'point' && /^\d/.test(t[j + 1] ?? '');
    // A unit said twice ("A12. A12 shutting it down")
    const unit = s.length % 2 === 0 && s.length < 8 && s.slice(0, s.length / 2).repeat(2) === s;
    const ok = !decimal && !unit && (cue
      ? s.length >= 2 && s.length <= 8 && (letters > 0 || digits >= 3)
      // Read out with no cue: letters and digits both, as a plate is, and not a time, a phone number or a callsign
      : s.length >= 5 && s.length <= 8 && spoken >= 2 && digits >= 1);
    if (ok && !CALLSIGN.test(s)) {
      for (let k = from; k < j; k++) used.add(k);
      if (!plates.some((p) => p.plate === s.toUpperCase())) plates.push({ plate: s.toUpperCase(), cued: cue });
      i = j - 1;
    } else if (cue) {
      unclear = !decimal;
    } else if (j > i + 1) {
      // Not from a word further in: the end of a name spelled out ("Mike Charlie India November November India
      // Sierra 528 74") or of a licence number is no plate either
      i = j - 1;
    }
  }
  return { plates, unclear, rest: t.filter((_, k) => !used.has(k)).join(' ') };
}

/**
 * Text as letters and digits, with a phonetic alphabet and numbers said as words turned into them: "Adam Boy
 * Charlie one two three" holds abc123.
 * @param {string} text - A transcript.
 * @returns {string} The compacted text.
 */
export function spelled(text) {
  return numerals(text).map((w) => LETTERS[w] ?? w).join('');
}

/** Whether "reg", "plate" or "tag" was said in some text. */
export function cuedIn(text) {
  const t = numerals(text);
  return t.some((w, i) => CUES.has(w) || (w === 'range' && t[i - 1] === 'mass'));
}

/** Two plates one is a mishearing of: one inside the other, or four characters in a row the same. */
export function variant(a, b) {
  if (a === b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  for (let i = 0; i + 4 <= a.length; i++) if (b.includes(a.slice(i, i + 4))) return true;
  return false;
}

/**
 * The plates spelled out in a transmission, across its readings. Engines hear the ends of a plate differently
 * (6PTP38, H6PTP38): of two that are variants, the one more readings read is kept. Read as often, both are: one
 * may be cut short (ABC1, ABC123), and hearing it again can settle it.
 * @param {string[]} texts - Its readings.
 * @param {{cuedOnly?: boolean}} [o] - Only those after "reg" or "plate": on a ham channel a callsign is spelled
 *   the same way.
 * @returns {string[]} The plates.
 */
export function platesIn(texts, { cuedOnly = false } = {}) {
  const each = texts.map((s) => readPlates(s).plates.filter((p) => !cuedOnly || p.cued).map((p) => p.plate));
  const all = [...new Set(each.flat())];
  const n = new Map(all.map((p) => [p, each.filter((r) => r.includes(p)).length]));
  return all.filter((p) => !all.some((q) => variant(p, q) && n.get(q) > n.get(p)));
}

/**
 * Whether a plate the model wrote could be one: letters and digits, 5 to 8 of them; any 2 to 8 after "reg" or
 * "plate". A unit ("A12"), an apartment ("918") or a word ("REVOKED") the model put in plates isn't.
 * @param {string} plate - Upper case, letters and digits only.
 * @param {boolean} cued - Whether "reg" or "plate" was said.
 * @returns {boolean}
 */
export function plausible(plate, cued) {
  if (!/^[A-Z0-9]{2,8}$/.test(plate) || CALLSIGN.test(plate.toLowerCase())) return false;
  return cued || (plate.length >= 5 && /\d/.test(plate) && /[A-Z]/.test(plate));
}

/** How many words of a phonetic alphabet some text says. */
export function phonetic(text) {
  return numerals(text).filter((w) => w in LETTERS).length;
}
