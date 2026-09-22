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
