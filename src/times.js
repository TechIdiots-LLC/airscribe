/**
 * Times said in a transmission: dispatch logs a unit en route, on scene or clear by the 24-hour clock ("en route
 * 1447"), and a number that's the clock when it was said is that, not a road or an address. See
 * docs/findings.md#times-said.
 */

import { TYPES, words } from './roads.js';

// How far from the clock a number may be and still be the time: those in real traffic were 0 to 3 minutes off
export const NEAR_MIN = 5;
// A number after these is one of theirs ("Unit 1447", "room 315"), not a time
const OWNERS = new Set(['unit', 'units', 'car', 'engine', 'medic', 'ladder', 'rescue', 'squad', 'truck', 'tower',
  'ambulance', 'code', 'signal', 'room', 'apartment', 'apt', 'suite', 'number', 'no', 'box', 'station', 'district',
  'channel', 'exit', 'interstate', 'highway']);

const clock = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;

/**
 * The numbers in a transmission's readings that are the time it was said.
 * @param {string[]} texts - Its readings.
 * @param {number} at - When it was said (ms); the hour is read in the server's time zone.
 * @returns {{said: string, number: string, clock: string}[]} Each once: as said ("1447"), as a number ("1447",
 *   "216" for "0216") and as a clock ("2:47 PM").
 */
export function timesIn(texts, at) {
  if (!Number.isFinite(at)) return [];
  const d = new Date(at);
  const now = d.getHours() * 60 + d.getMinutes();
  const out = new Map();
  for (const s of texts) {
    const text = String(s ?? '');
    for (const m of text.matchAll(/(?<![\w:.,]|\d-)(\d{1,2})(:?)([0-5]\d)(?![\w:]|[.,-]\d)/g)) {
      const h = Number(m[1]);
      const min = Number(m[3]);
      if (h > 23) continue;
      const before = words(text.slice(0, m.index)).split(' ').at(-1);
      const after = words(text.slice(m.index + m[0].length)).split(' ').slice(0, 3);
      // A house number ("1447 Main Street"), or one of a unit's, a room's...
      if (OWNERS.has(before) || after.some((w) => TYPES.has(w))) continue;
      // Route 146 is a road: only a number no route has (four digits) is a time after "route"
      if (before === 'route' && m[1].length + m[3].length < 4) continue;
      // "8:30" said on the 12-hour clock
      const hours = m[2] && h <= 12 ? [h, h + 12] : [h];
      const hit = hours.find((x) => {
        const off = Math.abs(x * 60 + min - now);
        return Math.min(off, 1440 - off) <= NEAR_MIN;
      });
      if (hit === undefined) continue;
      const number = String(h * 100 + min);
      if (!out.has(number)) out.set(number, { said: m[0], number, clock: clock(hit % 24, min) });
    }
  }
  return [...out.values()];
}

/**
 * An answer with the addresses, roads and units that are only a time said taken out ("Route 1447" from "in route
 * 1447"), as `unheard` with why: 'time'. One with a road's kind in it ("1447 Main Street") stays, unless the
 * addresses imported say that street has no such number ("1720 Lancaster Street" for "1720. On arrival").
 * @param {object} found - The answer.
 * @param {{number: string}[]} times - timesIn() of its readings.
 * @param {Set<string>} [missing] - Addresses checked and not there, as "1720 lancaster street" (Roads.checkAddresses).
 * @returns {object} The answer.
 */
export function withoutTimes(found, times, missing = new Set()) {
  if (!times.length) return found;
  const numbers = new Set(times.map((t) => t.number));
  const unheard = [...(found.unheard ?? [])];
  const out = { ...found };
  for (const k of ['addresses', 'roads', 'units']) {
    out[k] = (found[k] ?? []).filter((v) => {
      const t = words(v).split(' ');
      const n = t.filter((w) => /^\d+$/.test(w));
      const nowhere = k === 'addresses' && n.length === 1 && missing.has(`${Number(n[0])} ${t.filter((w) => !/^\d+$/.test(w)).join(' ')}`);
      const time = n.length > 0 && n.every((w) => numbers.has(String(Number(w)))) && (!t.some((w) => TYPES.has(w)) || nowhere);
      if (time) unheard.push({ field: k, value: v, why: 'time' });
      return !time;
    });
  }
  return { ...out, unheard };
}
