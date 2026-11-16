/**
 * A software modem for APRS on 2 m: Bell 202 AFSK at 1200 baud (mark 1200 Hz, space 2200 Hz), NRZI coded, in
 * HDLC frames. It reads a radio's receive audio, so a packet is decoded from what the radio played whether or
 * not the radio's own modem hands it over (docs/packets.md).
 *
 * The audio is band-passed and brought down to about 16 kHz. Each tone's strength is measured over a bit or so
 * (mixed down to zero and low-passed), a phase-locked bit clock samples their difference mid-bit, and NRZI and
 * HDLC are undone. Radios rarely play both tones equally loud (de-emphasis takes a few dB off 2200 Hz), so
 * several slicers weigh the tones differently. A frame counts when its FCS checks, whichever slicer got it, and
 * is handed on once.
 */

const BAUD = 1200;
const MARK = 1200;
const SPACE = 2200;
/** Two addresses, the control byte and the FCS: the shortest AX.25 frame. */
const MIN_FRAME = 7 * 2 + 1 + 2;
/** Ten addresses (two and eight digipeaters), control, PID, 256 of information and the FCS: the longest. */
const MAX_FRAME = 7 * 10 + 2 + 256 + 2;

/**
 * How the decoder is set up; tests try others. Two demodulators share the band-pass and differ in each tone's
 * low-pass: a Hann window 1.6 bits long hears through noise best, a flat one 1.3 bits long copes best with one
 * tone much louder than the other. Each has slicers weighing space against mark by these balances, and one
 * more that evens the tones out itself. The bit clock is drawn toward each change of tone, harder while
 * hunting for a signal than once inside a frame. Chosen on synthesized packets in noise, with the tones up to
 * 9 dB apart and the bit rate 1% off (docs/packets.md has the numbers).
 */
export const SETUP = {
  band: [800, 2600],
  demods: [{ window: 'hann', bits: 1.6 }, { window: 'flat', bits: 1.3 }],
  balances: [0.5, 0.7, 1, 1.4, 2],
  pull: { hunting: 0.6, locked: 0.8 },
};

const CRC = new Uint16Array(256).map((_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  return c;
});

/**
 * The AX.25 frame check sequence (CRC-16/X.25) of bytes.
 * @param {Uint8Array|number[]} bytes - The frame.
 * @param {number} [end] - Only bytes before this.
 * @returns {number} The FCS, as sent low byte first.
 */
export function fcs(bytes, end = bytes.length) {
  let c = 0xffff;
  for (let i = 0; i < end; i++) c = (c >>> 8) ^ CRC[(c ^ bytes[i]) & 0xff];
  return (c ^ 0xffff) & 0xffff;
}

/** A linear-phase band-pass: a Blackman-windowed difference of two sincs, `taps` long (odd). */
function bandPass(rate, lo, hi, taps) {
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  const sinc = (f, n) => (n === 0 ? 2 * f : Math.sin(2 * Math.PI * f * n) / (Math.PI * n));
  for (let i = 0; i < taps; i++) {
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = (sinc(hi / rate, i - mid) - sinc(lo / rate, i - mid)) * w;
  }
  return h;
}

/** A low-pass window `n` long that sums to 1: Hann, or flat. */
function lowPass(kind, n) {
  const w = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += w[i] = kind === 'flat' ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
  return w.map((v) => v / sum);
}

/**
 * The last `taps.length` values filtered by `taps` (symmetric, so order doesn't matter). Kept twice over,
 * end to end, so the newest run of them is always one unbroken stretch.
 */
class Fir {
  constructor(taps) {
    this.taps = taps;
    this.buf = new Float64Array(2 * taps.length);
    this.at = 0;
  }

  /** Take a value in. */
  put(v) {
    this.buf[this.at] = this.buf[this.at + this.taps.length] = v;
    this.at = (this.at + 1) % this.taps.length;
  }

  /** @returns {number} The filter's output now. */
  get out() {
    let s = 0;
    for (let k = 0, j = this.at; k < this.taps.length; k++, j++) s += this.taps[k] * this.buf[j];
    return s;
  }
}

/** A tone's strength, evened out: where it sits between the highs and lows it reached lately, -0.5 to 0.5. */
class Level {
  constructor(rate) {
    this.hi = 0;
    this.lo = 0;
    this.forget = 1 / (0.25 * rate); // an old high or low fades over about a quarter of a second
  }

  even(v) {
    this.hi += (v - this.hi) * (v > this.hi ? 0.5 : this.forget);
    this.lo += (v - this.lo) * (v < this.lo ? 0.5 : this.forget);
    const span = this.hi - this.lo;
    return span > 1e-9 ? (v - (this.hi + this.lo) / 2) / span : 0;
  }
}

/**
 * Bits into frames: flags (0x7E) around each, a zero stuffed after every five ones, low bit first, and the
 * FCS last. Seven ones in a row abandon whatever was coming in.
 */
class Hdlc {
  constructor(deliver) {
    this.deliver = deliver;
    this.last8 = 0;    // the latest eight bits, newest at the top
    this.bits = -1;    // bits of the byte being gathered; -1 outside a frame
    this.byte = 0;
    this.frame = [];
  }

  get inFrame() {
    return this.bits >= 0;
  }

  push(bit) {
    this.last8 = (this.last8 >>> 1) | (bit << 7);
    if (this.last8 === 0x7e) {
      // A flag. Seven of its bits went in as data, so a whole frame leaves exactly seven over
      if (this.bits === 7 && this.frame.length >= MIN_FRAME) {
        const n = this.frame.length;
        if (fcs(this.frame, n - 2) === (this.frame[n - 2] | (this.frame[n - 1] << 8))) {
          this.deliver(Buffer.from(this.frame.slice(0, n - 2)));
        }
      }
      this.bits = 0;
      this.byte = 0;
      this.frame = [];
    } else if (this.last8 === 0xfe) {
      this.bits = -1;
      this.frame = [];
    } else if ((this.last8 & 0xfc) === 0x7c) {
      // The zero stuffed after five ones: not data
    } else if (this.bits >= 0) {
      this.byte = (this.byte >>> 1) | (bit << 7);
      if (++this.bits === 8) {
        this.bits = 0;
        this.frame.push(this.byte);
        if (this.frame.length > MAX_FRAME) {
          this.bits = -1;
          this.frame = [];
        }
      }
    }
  }
}

/**
 * One way of telling the tones apart, with its own bit clock: a phase that wraps once a bit, sampled as it
 * wraps (mid-bit), and drawn toward zero at each change of tone, which belongs between bits.
 */
class Slicer {
  constructor(rate, pull, deliver) {
    this.step = Math.round((2 ** 32 * BAUD) / rate) | 0;
    this.pull = pull;
    this.phase = 0;
    this.tone = false;  // the tone at the last change
    this.held = false;  // the tone at the last bit sampled
    this.hdlc = new Hdlc(deliver);
  }

  push(d) {
    const was = this.phase;
    this.phase = (this.phase + this.step) | 0;
    if (was >= 0 && this.phase < 0) {
      // NRZI: a change of tone is a zero, the same tone a one
      const tone = d > 0;
      this.hdlc.push(tone === this.held ? 1 : 0);
      this.held = tone;
    }
    const tone = d > 0;
    if (tone !== this.tone) {
      this.tone = tone;
      this.phase = Math.trunc(this.phase * (this.hdlc.inFrame ? this.pull.locked : this.pull.hunting));
    }
  }
}

/** Each tone's strength through one low-pass, and the slicers reading them. */
class Demod {
  constructor(rate, setup, { window, bits }, deliver) {
    const taps = lowPass(window, Math.max(2, Math.round((rate * bits) / BAUD)));
    this.tones = [0, 1, 2, 3].map(() => new Fir(taps)); // mark I and Q, space I and Q
    this.markLevel = new Level(rate);
    this.spaceLevel = new Level(rate);
    this.evened = new Slicer(rate, setup.pull, deliver);
    this.balanced = setup.balances.map((g) => ({ g, slicer: new Slicer(rate, setup.pull, deliver) }));
  }

  push(mi, mq, si, sq) {
    const [a, b, c, d] = this.tones;
    a.put(mi);
    b.put(mq);
    c.put(si);
    d.put(sq);
    const ai = a.out;
    const bq = b.out;
    const ci = c.out;
    const dq = d.out;
    const mark = Math.sqrt(ai * ai + bq * bq);
    const space = Math.sqrt(ci * ci + dq * dq);
    this.evened.push(this.markLevel.even(mark) - this.spaceLevel.even(space));
    for (const { g, slicer } of this.balanced) slicer.push(mark - g * space);
  }
}

/** A streaming decoder: feed it a radio's audio as it comes, and it calls back with each frame in it. */
export class AfskDecoder {
  /**
   * @param {number} rate - Samples per second of the audio it's given.
   * @param {(frame: Buffer) => void} onFrame - Called with each AX.25 frame whose FCS checks, without the FCS.
   * @param {object} [setup] - Another set-up than SETUP, for trying one.
   */
  constructor(rate, onFrame, setup = SETUP) {
    this.onFrame = onFrame;
    this.down = Math.max(1, Math.floor(rate / 16000));
    const fs = rate / this.down;
    this.rate = fs;
    // Three bits long: the band-pass, and the filter in front of bringing the rate down
    this.input = new Fir(bandPass(rate, setup.band[0], setup.band[1], Math.round((rate * 3) / BAUD) | 1));
    this.skip = 0;
    this.markStep = (2 * Math.PI * MARK) / fs;
    this.spaceStep = (2 * Math.PI * SPACE) / fs;
    this.markPhase = 0;
    this.spacePhase = 0;
    const deliver = (frame) => this.#deliver(frame);
    this.demods = setup.demods.map((d) => new Demod(fs, setup, d, deliver));
    this.samples = 0;
    this.recent = new Map(); // frame (hex) -> when it was handed on, in samples
    this.half = null;        // the first byte of a sample split between two pushes
  }

  /**
   * More audio.
   * @param {Buffer} pcm - 16-bit little-endian mono samples.
   * @returns {void}
   */
  push(pcm) {
    let i = 0;
    if (this.half !== null && pcm.length) {
      this.#sample(((pcm[0] << 24) >> 16 | this.half) / 32768);
      this.half = null;
      i = 1;
    }
    for (; i + 1 < pcm.length; i += 2) this.#sample(pcm.readInt16LE(i) / 32768);
    if (i < pcm.length) this.half = pcm[i];
  }

  #sample(v) {
    this.input.put(v);
    if (++this.skip < this.down) return;
    this.skip = 0;
    this.samples++;
    const x = this.input.out;
    this.markPhase = (this.markPhase + this.markStep) % (2 * Math.PI);
    this.spacePhase = (this.spacePhase + this.spaceStep) % (2 * Math.PI);
    const mi = x * Math.cos(this.markPhase);
    const mq = x * Math.sin(this.markPhase);
    const si = x * Math.cos(this.spacePhase);
    const sq = x * Math.sin(this.spacePhase);
    for (const d of this.demods) d.push(mi, mq, si, sq);
  }

  /** A frame, once: several slicers usually get the same one within a few samples of each other. */
  #deliver(frame) {
    const key = frame.toString('hex');
    const last = this.recent.get(key);
    if (last !== undefined && this.samples - last < this.rate) return;
    this.recent.set(key, this.samples);
    if (this.recent.size > 32) {
      for (const [k, at] of this.recent) if (this.samples - at > this.rate) this.recent.delete(k);
    }
    this.onFrame(frame);
  }
}

/**
 * Every frame in a stretch of audio, at once.
 * @param {Buffer} pcm - 16-bit little-endian mono samples.
 * @param {number} rate - Samples per second.
 * @param {object} [setup] - Another set-up than SETUP, for trying one.
 * @returns {Buffer[]} The frames, in order, without their FCS.
 */
export function decodeAfsk(pcm, rate, setup = SETUP) {
  const out = [];
  new AfskDecoder(rate, (f) => out.push(f), setup).push(pcm);
  return out;
}
