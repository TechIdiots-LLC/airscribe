/**
 * AX.25 frames as a radio's own modem hands them over (HTCommander's
 * TncDataFragment): the addresses, control and PID, and the information
 * field, without the flags or the frame check sequence.
 */

/**
 * One 7-byte address: six characters shifted left one bit, space-padded, then
 * the SSID byte (the SSID in bits 1-4, the has-been-repeated or command bit
 * in bit 7, and bit 0 set on the last address).
 * @param {Buffer} buf - The frame.
 * @param {number} at - Where the address starts.
 * @returns {{call: string, flag: boolean, last: boolean} | null} It, or null if it isn't one.
 */
function address(buf, at) {
  let call = '';
  for (let i = 0; i < 6; i++) {
    const b = buf[at + i];
    if (b & 1) return null;   // only an SSID byte ends the address field
    const c = b >> 1;
    if (c !== 0x20) call += String.fromCharCode(c);
  }
  if (!/^[A-Z0-9]{1,6}$/.test(call)) return null;
  const s = buf[at + 6];
  const ssid = (s >> 1) & 0x0f;
  return { call: ssid ? `${call}-${ssid}` : call, flag: Boolean(s & 0x80), last: Boolean(s & 1) };
}

/**
 * A UI frame: who sent it, to what, by which digipeaters ("*" on one that
 * repeated it), and its information field. Connected-mode frames, which
 * carry a session rather than a packet, aren't decoded.
 * @param {Buffer} buf - The frame.
 * @returns {{source: string, destination: string, path: string[], pid: number, info: Buffer} | null} The frame.
 */
export function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const addresses = [];
  let at = 0;
  for (;;) {
    if (at + 7 > buf.length || addresses.length >= 10) return null;
    const a = address(buf, at);
    if (!a) return null;
    addresses.push(a);
    at += 7;
    if (a.last) break;
  }
  if (addresses.length < 2 || at + 2 > buf.length) return null;
  if ((buf[at] & 0xef) !== 0x03) return null;   // UI, poll/final either way
  const [destination, source, ...path] = addresses;
  return {
    source: source.call,
    destination: destination.call,
    path: path.map((p) => (p.flag ? `${p.call}*` : p.call)),
    pid: buf[at + 1],
    info: buf.subarray(at + 2),
  };
}

/** @returns {string} The frame as text, the way APRS software writes one: SRC>DST,PATH:info */
export const tnc2 = (f, info) => `${f.source}>${[f.destination, ...f.path].join(',')}:${info}`;
