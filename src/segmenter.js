/**
 * Splits a continuous stream of radio audio into one clip per transmission.
 *
 * The radio brackets each transmission itself — audio frames open a run and an
 * end-of-audio frame closes it — so those markers are the primary boundary,
 * delivered here as {@link Segmenter#begin} and {@link Segmenter#end}. They are
 * authoritative: `end()` closes the clip at once instead of waiting out a
 * silence timer, which is what keeps one message in one clip and two messages
 * apart even when the operators barely pause between them.
 *
 * Squelch and audio energy stay on as a fallback, because the markers cannot
 * carry it alone: a continuous broadcast (a weather channel) opens a run and
 * never ends it, a run can already be in progress when this side connects, and
 * a backend with only a squelch flag has no markers at all. So audio arriving
 * without a `begin()` still opens a clip, and a clip still closes after
 * `holdMs` of quiet when no `end()` comes.
 *
 * A clip running past `maxMs` is split rather than dropped, and the next clip
 * is seeded with the last `overlapMs` of audio so a word straddling the split
 * survives in one of the two halves.
 *
 * Time comes from the audio itself (chunk length), never the wall clock, so
 * behaviour is identical live and in tests.
 */
export class Segmenter {
  /**
   * @param {object} o - Options.
   * @param {number} o.sampleRate - PCM sample rate (Hz), 16-bit mono.
   * @param {number} o.preRollMs - Audio kept from before the clip opened.
   * @param {number} o.holdMs - Quiet time before a clip closes on its own.
   * @param {number} o.minMs - Clips with less speech than this are dropped.
   * @param {number} o.maxMs - A clip this long is split.
   * @param {number} [o.overlapMs] - Audio carried across a split; clamped to
   *   half of `maxMs`, above which a split would not make progress.
   * @param {number} o.energyThreshold - RMS (0..1) counted as voice.
   * @param {(clip: {startMs: number, durationMs: number, pcm: Buffer, transmit: boolean}) => void} o.onClip -
   *   Called with each finished clip.
   */
  constructor(o) {
    this.o = { overlapMs: 0, ...o };
    // An overlap that approaches maxMs makes a split carry the whole clip
    // forward, so the next one is born already over the limit and splits
    // again: a storm of near-duplicate clips. Half is the most that still
    // makes progress.
    this.o.overlapMs = Math.max(0, Math.min(this.o.overlapMs, this.o.maxMs / 2));
    this.bytesPerMs = (o.sampleRate * 2) / 1000;
    this.pre = [];
    this.preBytes = 0;
    this.open = null;
    this.clock = 0;
    this.quietMs = 0;
  }

  /**
   * The radio has started an audio run. Repeating this mid-run is ignored, so
   * a status refresh does not chop a transmission in half.
   * @param {{transmit?: boolean}} [o] - Whether the radio is transmitting.
   * @returns {void}
   */
  begin({ transmit = false } = {}) {
    if (this.open && this.open.transmit !== transmit) this.close();
    if (!this.open) this.openClip(transmit);
  }

  /**
   * The radio has ended the audio run. This is the boundary to trust.
   * @returns {void}
   */
  end() {
    if (this.open) this.close();
  }

  /**
   * Feed one chunk of audio.
   * @param {Buffer} pcm - 16-bit little-endian mono samples.
   * @param {{rx?: boolean, transmit?: boolean}} [o] - `rx` is the radio's own
   *   squelch/receive flag for this chunk.
   * @returns {void}
   */
  push(pcm, { rx = false, transmit = false } = {}) {
    const ms = pcm.length / this.bytesPerMs;
    const voiced = rx || transmit || rms(pcm) >= this.o.energyThreshold;

    if (!this.open) {
      // No run marker arrived: either none are sent, or the run began before
      // this side was listening. Open on the audio itself.
      if (!voiced) {
        this.keepPreRoll(pcm);
        this.clock += ms;
        return;
      }
      this.openClip(transmit);
    } else if (this.open.transmit !== transmit) {
      // The radio turned around without an end marker. Receiving someone and
      // answering them are two transmissions, never one clip.
      this.close();
      this.openClip(transmit);
    }

    this.addToClip(pcm);
    this.clock += ms;
    this.quietMs = voiced ? 0 : this.quietMs + ms;

    if (this.quietMs >= this.o.holdMs) this.close();
    else if (this.clipMs() >= this.o.maxMs) this.split();
  }

  /**
   * Close any clip in progress, e.g. when the radio disconnects.
   * @returns {void}
   */
  flush() {
    if (this.open) this.close();
  }

  /** @returns {number} Milliseconds of audio currently held as pre-roll. */
  preMs() {
    return this.preBytes / this.bytesPerMs;
  }

  /** @returns {number} Milliseconds of audio in the open clip. */
  clipMs() {
    return this.open.bytes / this.bytesPerMs;
  }

  /**
   * @param {boolean} transmit - Direction of the new clip.
   * @returns {void}
   */
  openClip(transmit) {
    this.open = {
      startMs: this.clock - this.preMs(),
      parts: [...this.pre],
      bytes: this.preBytes,
      transmit,
    };
    this.pre = [];
    this.preBytes = 0;
    this.quietMs = 0;
  }

  /**
   * @param {Buffer} pcm - Audio to append to the open clip.
   * @returns {void}
   */
  addToClip(pcm) {
    this.open.parts.push(pcm);
    this.open.bytes += pcm.length;
  }

  /**
   * @param {Buffer} pcm - Quiet audio to retain as pre-roll.
   * @returns {void}
   */
  keepPreRoll(pcm) {
    this.pre.push(pcm);
    this.preBytes += pcm.length;
    const cap = this.o.preRollMs * this.bytesPerMs;
    while (this.preBytes > cap && this.pre.length > 1) {
      this.preBytes -= this.pre.shift().length;
    }
  }

  /**
   * Emit the clip so far and carry on in a new one, seeded with the tail of
   * the old, so a word crossing the split is not lost.
   * @returns {void}
   */
  split() {
    const { transmit } = this.open;
    const tail = this.tail(this.o.overlapMs);
    this.close();
    this.openClip(transmit);
    if (tail.length) {
      this.open.startMs = this.clock - tail.length / this.bytesPerMs;
      this.addToClip(tail);
    }
  }

  /**
   * @param {number} ms - How much of the open clip's end to copy.
   * @returns {Buffer} That much audio, or less if the clip is shorter.
   */
  tail(ms) {
    let want = Math.floor(ms * this.bytesPerMs);
    want -= want % 2; // whole 16-bit samples only
    if (want <= 0) return Buffer.alloc(0);
    const parts = [];
    let have = 0;
    for (let i = this.open.parts.length - 1; i >= 0 && have < want; i--) {
      parts.unshift(this.open.parts[i]);
      have += this.open.parts[i].length;
    }
    const buf = Buffer.concat(parts);
    return have > want ? buf.subarray(have - want) : buf;
  }

  /** @returns {void} */
  close() {
    const { startMs, parts, transmit } = this.open;
    const quietMs = this.quietMs;
    this.open = null;
    this.quietMs = 0;
    const pcm = Buffer.concat(parts);
    const durationMs = pcm.length / this.bytesPerMs;
    // The hold period is silence waited through, not speech: a clip that is
    // mostly that is a squelch tail or a noise burst, not a transmission.
    if (durationMs - quietMs < this.o.minMs) return;
    this.o.onClip({ startMs, durationMs, pcm, transmit });
  }
}

/**
 * Root-mean-square level of 16-bit PCM, normalised to 0..1.
 * @param {Buffer} pcm - 16-bit little-endian samples.
 * @returns {number} The level.
 */
export function rms(pcm) {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
