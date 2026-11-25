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

/**
 * words() with numbers said as words made digits: "twenty four" is 24, "one two three" 1 2 3, "second" 2nd.
 * @param {string} s - Text.
 * @returns {string[]} The words.
 */
export function numerals(s) {
  // "I'm" is one word, not the letters I and M
  const t = words(String(s ?? '').replace(/x-ray/gi, 'xray').replace(/['’]/g, '')).split(' ').filter(Boolean);
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
    const ok = cue
      ? s.length >= 2 && s.length <= 8 && (letters > 0 || digits >= 3)
      // Read out with no cue: letters and digits both, as a plate is, and not a time, a phone number or a callsign
      : s.length >= 5 && s.length <= 8 && spoken >= 2 && digits >= 1;
    if (ok && !CALLSIGN.test(s)) {
      for (let k = from; k < j; k++) used.add(k);
      if (!plates.some((p) => p.plate === s.toUpperCase())) plates.push({ plate: s.toUpperCase(), cued: cue });
      i = j - 1;
    } else if (cue) {
      unclear = true;
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
