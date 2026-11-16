/**
 * How well a transmission came through, from its audio and the radio's signal
 * reading, and what that says about a channel.
 */

/**
 * How far a transmission's loud moments stood above its quiet ones, in dB: an
 * FM signal's "quieting". A strong signal is all but silent between words, so
 * this is large (20 dB and more). A weak one is hiss between words, a few dB
 * to the low teens. Static that opened the squelch with no signal is hiss
 * throughout, and comes out at a few dB.
 *
 * Measured on 20 ms frames: the loudness the loudest tenth reach over the
 * loudness the quietest tenth don't. Level doesn't matter, only the ratio.
 * @param {Buffer} pcm - 16-bit little-endian mono.
 * @param {number} rate - Samples per second.
 * @returns {number|null} dB, to one place; null for a clip under half a second, or silent.
 */
export function quieting(pcm, rate) {
  const frame = Math.max(1, Math.round(rate * 0.02));
  const frames = Math.floor(pcm.length / 2 / frame);
  if (frames < 25) return null;
  const level = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0, at = f * frame * 2; i < frame; i++, at += 2) {
      const s = pcm.readInt16LE(at) / 32768;
      sum += s * s;
    }
    level[f] = Math.sqrt(sum / frame);
  }
  level.sort();
  const quiet = level[Math.floor(frames * 0.1)];
  const loud = level[Math.min(frames - 1, Math.floor(frames * 0.9))];
  if (loud < 1e-4) return null;
  return Math.round(Math.min(60, 20 * Math.log10(loud / Math.max(quiet, 1e-5))) * 10) / 10;
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A channel is judged once it has this many transmissions in the period. */
export const ENOUGH = 3;

/**
 * What a channel's recent transmissions say about it.
 *
 * - **static**: most of it was noise. The typical transmission stood under
 *   6 dB above its quiet moments, or, where that wasn't measured, at least
 *   four in five came to no speech.
 * - **weak**: the radio's typical signal reading was 3 or less of its 15.
 *
 * First guesses, to be tuned against real traffic; the numbers are shown
 * beside the tag so they can be judged.
 * @param {{rssi: number|null, snr_db: number|null, no_speech: number}[]} rows - Received transmissions.
 * @returns {{count: number, noSpeech: number, rssi: number|null, snrDb: number|null, tags: string[]}} Summary.
 */
export function judge(rows) {
  const count = rows.length;
  const noSpeech = rows.filter((r) => r.no_speech).length;
  const rssi = median(rows.map((r) => r.rssi));
  const snrDb = median(rows.map((r) => r.snr_db));
  const tags = [];
  if (count >= ENOUGH) {
    if (snrDb !== null ? snrDb < 6 : noSpeech / count >= 0.8) tags.push('static');
    if (rssi !== null && rssi <= 3) tags.push('weak');
  }
  return { count, noSpeech, rssi, snrDb, tags };
}
