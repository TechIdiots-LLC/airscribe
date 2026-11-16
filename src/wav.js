/**
 * Wrap 16-bit mono PCM in a WAV container.
 * @param {Buffer} pcm - 16-bit little-endian samples.
 * @param {number} sampleRate - Samples per second.
 * @returns {Buffer} A complete .wav file.
 */
export function encodeWav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * The samples of a 16-bit mono WAV, as encodeWav writes one (and others
 * whose chunks are laid out differently).
 * @param {Buffer} buf - The file.
 * @returns {{rate: number, pcm: Buffer} | null} Its rate and samples, or null if it isn't one.
 */
export function decodeWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let rate = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= buf.length) {
      if (buf.readUInt16LE(at + 8) !== 1 || buf.readUInt16LE(at + 10) !== 1 || buf.readUInt16LE(at + 22) !== 16) return null;
      rate = buf.readUInt32LE(at + 12);
    } else if (id === 'data') {
      return rate ? { rate, pcm: buf.subarray(at + 8, Math.min(buf.length, at + 8 + size)) } : null;
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/**
 * Halve the sample rate by averaging sample pairs. Radio audio is 32 kHz;
 * Whisper wants 16 kHz. Averaging is a crude low-pass, adequate for speech.
 * @param {Buffer} pcm - 16-bit little-endian samples.
 * @returns {Buffer} Samples at half the rate.
 */
export function halveRate(pcm) {
  const n = pcm.length >> 2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const a = pcm.readInt16LE(i * 4);
    const b = pcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE((a + b) >> 1, i * 2);
  }
  return out;
}
