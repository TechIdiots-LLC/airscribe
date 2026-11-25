/**
 * Whether what the model found was said in the transmission: a check in code, because a small model copies details
 * from the context it's given (an address from another channel's call into a ham net) however it's told not to.
 * See docs/findings.md#what-was-said.
 */

import { readPlates, spelled } from './plates.js';
import { DIRS, TYPES, addressRoads, base, distance, words } from './roads.js';

const LISTS = ['addresses', 'roads', 'plates', 'vehicles', 'people', 'units'];
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'at', 'on', 'in', 'to', 'for', 'with', 'by', 'from', 'near', 'off',
  'corner', 'his', 'her', 'their', 'old', 'year', 'years', 'number', 'no']);
// Words a value shares with half of what's said on a dispatch channel: they show nothing about this transmission
const GENERIC = new Set(['unit', 'units', 'car', 'cars', 'engine', 'medic', 'ladder', 'squad', 'truck', 'ambulance',
  'ambulances', 'rescue', 'tower', 'tanker', 'brush', 'quad', 'chief', 'battalion', 'station', 'fire', 'police', 'pd',
  'fd', 'ems', 'dispatch', 'department', 'medical', 'mutual', 'aid', 'route', 'highway', 'interstate', 'male',
  'female', 'man', 'woman', 'person', 'party', 'caller', 'driver', 'subject', 'juvenile', 'patient', 'officer']);
const numeric = (w) => /^\d+$/.test(w);
const slack = (w) => (w.length >= 8 ? 2 : w.length >= 5 ? 1 : 0);

/**
 * What a transmission said, to check answers against.
 * @param {string[]} texts - Its transcripts: the one read and its other readings.
 * @param {string[]} [roads] - Roads near its channel that sound like something in them (Roads.hint): a road the
 *   model wrote as one of those was said, misheard.
 * @returns {object} For heard().
 */
export function said(texts, roads = []) {
  const tokens = new Set();
  for (const s of texts) {
    // Not the words a plate was spelled in: "Sierra" read out isn't Sierra Street
    const t = readPlates(s).rest.split(' ').filter(Boolean);
    t.forEach((w, i) => {
      tokens.add(w);
      // "beach wood" is Beachwood; "4 12" is 412
      if (i + 1 < t.length) tokens.add(w + t[i + 1]);
    });
  }
  const keys = new Set(roads.map(words));
  const bases = new Set(roads.map((r) => base(words(r))).filter(Boolean));
  return { tokens, keys, bases, spelled: texts.map(spelled) };
}

/** Whether a word was said, or one a mishearing away from it. */
function has(heard, w) {
  if (heard.tokens.has(w)) return true;
  const max = slack(w);
  if (!max || numeric(w)) return false;
  for (const h of heard.tokens) if (Math.abs(h.length - w.length) <= max && distance(w, h, max) <= max) return true;
  return false;
}

/** Whether a road, as words(), was said, or is one of the roads near that sound like what was. */
function road(heard, key) {
  if (heard.keys.has(key)) return true;
  const b = base(key);
  if (b && heard.bases.has(b)) return true;
  return enough(heard, (b ?? key).split(' '));
}

/**
 * The words that tell a value apart, and whether enough of them were said: one of its names, or, a value only of
 * numbers ("Car 12", "Quad 1"), one of its numbers; an address's house number too.
 */
function enough(heard, t, { allNumbers = false } = {}) {
  const real = t.filter((w) => !STOP.has(w));
  const named = real.filter((w) => !numeric(w) && !GENERIC.has(w) && !TYPES.has(w) && !DIRS.has(w));
  const numbers = real.filter(numeric);
  if (allNumbers && numbers.some((n) => !heard.tokens.has(n))) return false;
  if (named.length) return named.some((w) => has(heard, w));
  if (numbers.length) return numbers.some((n) => heard.tokens.has(n));
  return real.some((w) => has(heard, w));
}

/**
 * Whether one value the model found was said.
 * @param {object} heard - said().
 * @param {string} field - One of the lists.
 * @param {string} value - As tidy() left it.
 * @returns {boolean}
 */
export function heardValue(heard, field, value) {
  if (field === 'plates') return heard.spelled.some((s) => s.includes(value.toLowerCase()));
  if (field === 'roads') return road(heard, words(value));
  if (field === 'addresses') {
    // Each road it names, and its house number, but a named place ("Walmart on Route 20") by its name
    const t = words(value).split(' ');
    if (t.some(numeric) && t.filter(numeric).some((n) => !heard.tokens.has(n))) return false;
    const parts = addressRoads(value);
    return parts.length ? parts.some((p) => road(heard, p)) : enough(heard, t);
  }
  return enough(heard, words(value).split(' '));
}

/**
 * An answer with what wasn't said taken out: values, and corrections to values not said.
 * @param {object} found - tidy() of the answer.
 * @param {object} heard - said().
 * @returns {object} The answer, with `unheard`: what was taken out, as {field, value}.
 */
export function onlyHeard(found, heard) {
  const out = { ...found, unheard: [] };
  for (const k of LISTS) {
    out[k] = (found[k] ?? []).filter((v) => heardValue(heard, k, v) || (out.unheard.push({ field: k, value: v }), false));
  }
  out.corrections = (found.corrections ?? []).filter((c) => heardValue(heard, c.field, c.now) ||
    (out.unheard.push({ field: c.field, value: c.now, correction: c.finding }), false));
  return out;
}
