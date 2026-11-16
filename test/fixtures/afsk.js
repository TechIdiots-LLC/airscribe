// A 1200-baud AFSK transmitter, for testing the decoder (src/afsk.js) against packets it didn't make.
import { fcs } from '../../src/afsk.js';

/** An AX.25 UI frame: addresses (an asterisk marks a digipeater that repeated it), UI, no layer 3, the text. */
export function frame(source, destination, path, info) {
  const calls = [destination, source, ...path];
  const parts = calls.map((c, i) => {
    const [base, ssid = '0'] = c.replace('*', '').split('-');
    const a = Buffer.alloc(7);
    for (let k = 0; k < 6; k++) a[k] = base.padEnd(6).charCodeAt(k) << 1;
    a[6] = 0x60 | ((Number(ssid) & 0x0f) << 1) | (c.endsWith('*') ? 0x80 : 0) | (i === calls.length - 1 ? 1 : 0);
    return a;
  });
  return Buffer.concat([...parts, Buffer.from([0x03, 0xf0]), Buffer.from(info, 'latin1')]);
}

/** A seeded random source, so a test's noise is the same every run. */
export function random(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

/** A frame's bits as sent: its bytes and FCS low bit first, a zero stuffed after every five ones. */
function bits(f, badFcs) {
  const check = fcs(f) ^ (badFcs ? 0x0100 : 0);
  const out = [];
  let ones = 0;
  for (const b of [...f, check & 0xff, check >> 8]) {
    for (let k = 0; k < 8; k++) {
      const bit = (b >> k) & 1;
      out.push(bit);
      ones = bit ? ones + 1 : 0;
      if (ones === 5) {
        out.push(0);
        ones = 0;
      }
    }
  }
  return out;
}

const FLAG = [0, 1, 1, 1, 1, 1, 1, 0];

/**
 * Frames as a transmitter sends them, one burst each: flags, the frame, three flags, with silence between.
 * NRZI: a zero changes tone (1200 and 2200 Hz), a one keeps it; the tone's phase runs on through each change.
 * @param {Buffer[]} frames - The frames, without FCS.
 * @param {object} [o] - rate; baud (1200, or a little off); spaceDb, the 2200 Hz tone against the 1200
 *   (twist); amp; flags before each; gap of silence in seconds; badFcs to send each with its FCS wrong.
 * @returns {Float64Array} The samples, -1 to 1.
 */
export function modulate(frames, { rate = 32000, baud = 1200, spaceDb = 0, amp = 0.3, flags = 30, gap = 0.15, badFcs = false } = {}) {
  const out = [];
  let phase = 0;
  let tone = 1200;
  let owed = 0;
  const spaceAmp = amp * 10 ** (spaceDb / 20);
  const send = (list) => {
    for (const bit of list) {
      if (!bit) tone = tone === 1200 ? 2200 : 1200;
      owed += rate / baud;
      for (; owed >= 1; owed--) {
        phase += (2 * Math.PI * tone) / rate;
        out.push((tone === 2200 ? spaceAmp : amp) * Math.sin(phase));
      }
    }
  };
  const quiet = () => {
    for (let i = 0; i < gap * rate; i++) out.push(0);
  };
  quiet();
  for (const f of frames) {
    for (let i = 0; i < flags; i++) send(FLAG);
    send(bits(f, badFcs));
    for (let i = 0; i < 3; i++) send(FLAG);
    quiet();
  }
  return Float64Array.from(out);
}

/**
 * Samples as 16-bit PCM, clipped, with white noise added at an SNR against the tones' power if one is given.
 * @param {Float64Array} x - Samples, -1 to 1.
 * @param {{snrDb?: number, rng?: () => number}} [o] - The noise, and its random source.
 * @returns {Buffer} 16-bit little-endian PCM.
 */
export function toPcm(x, { snrDb = null, rng = random(1) } = {}) {
  let gain = 0;
  if (snrDb !== null) {
    let power = 0;
    let n = 0;
    for (const v of x) if (v !== 0) (power += v * v), n++;
    gain = Math.sqrt(power / n) / 10 ** (snrDb / 20);
  }
  const b = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const noise = gain ? gain * Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()) : 0;
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((x[i] + noise) * 32767))), i * 2);
  }
  return b;
}
