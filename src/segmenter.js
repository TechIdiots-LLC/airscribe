/**
 * Splits a continuous stream of radio audio into one clip per transmission.
 *
 * The radio reports squelch/receive state in every status packet, so that is
 * the primary boundary. Energy is a second opinion: some radios drop squelch
 * between words, and holding the clip open until both the flag and the energy
 * have been quiet for `holdMs` keeps a single message in one piece instead of
 * chopping it at each pause. Time comes from the audio itself (chunk length),
 * not the wall clock, so behaviour is identical live and in tests.
 */
export class Segmenter {
  /**
   * @param {object} o - Options.
   * @param {number} o.sampleRate - PCM sample rate (Hz), 16-bit mono.
   * @param {number} o.preRollMs - Audio kept from before the clip opened.
   * @param {number} o.holdMs - Quiet time before a clip closes.
   * @param {number} o.minMs - Clips shorter than this are dropped as noise.
   * @param {number} o.maxMs - A clip this long is closed and a new one begun.
   * @param {number} o.energyThreshold - RMS (0..1) counted as voice.
   * @param {(clip: object) => void} o.onClip - Called with each finished clip.
   */
  constructor(o) {
    this.o = o;
    this.bytesPerMs = (o.sampleRate * 2) / 1000;
    this.pre = [];
    this.preBytes = 0;
    this.open = null;
    this.clock = 0;
    this.quietMs = 0;
  }

  /**
   * Feed one chunk of audio.
   * @param {Buffer} pcm - 16-bit little-endian mono samples.
   * @param {boolean} rx - Whether the radio reports a signal being received.
   * @returns {void}
   */
  push(pcm, rx) {
    const ms = pcm.length / this.bytesPerMs;
    const voiced = rx || rms(pcm) >= this.o.energyThreshold;

    if (!this.open) {
      if (voiced) {
        this.open = { startMs: this.clock - this.preMs(), parts: [...this.pre] };
        this.pre = [];
        this.preBytes = 0;
        this.quietMs = 0;
      } else {
        this.keepPreRoll(pcm);
        this.clock += ms;
        return;
      }
    }

    this.open.parts.push(pcm);
    this.clock += ms;
    this.quietMs = voiced ? 0 : this.quietMs + ms;

    const length = this.clock - this.open.startMs;
    if (this.quietMs >= this.o.holdMs || length >= this.o.maxMs) this.close();
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

  /** @returns {void} */
  close() {
    const { startMs, parts } = this.open;
    this.open = null;
    // The hold period is silence we waited through; keep a little, not all.
    const pcm = Buffer.concat(parts);
    const durationMs = pcm.length / this.bytesPerMs;
    if (durationMs - this.quietMs < this.o.minMs) return;
    this.o.onClip({ startMs, durationMs, pcm });
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
