/**
 * What radiocli (github.com/albeebe/radiocli) writes beside each transmission it records from a Uniden scanner,
 * read into what AirScribe keeps: when it started, the channel it's filed under, its frequency, and the rest of
 * what the scanner said (system, department, talkgroup, unit, ...) as details (docs/scanners.md).
 */

/** Sidecar fields kept as details, beyond those the channel and frequency are made of. */
const DETAILS = ['list', 'system', 'department', 'site', 'talkgroup', 'unit', 'nac', 'digital', 'modulation', 'rssi'];

const text = (v, max = 80) => {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * A frequency as radiocli writes it ("155.550000MHz", or a bare number of MHz), in Hz.
 * @param {unknown} v - The value.
 * @returns {number|null} Hz, or null if it isn't one.
 */
export function frequencyHz(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mhz|khz|hz)?\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'mhz').toLowerCase();
  const hz = Math.round(unit === 'mhz' ? n * 1e6 : unit === 'khz' ? n * 1e3 : n);
  return hz > 0 ? hz : null;
}

/**
 * Read one recording's sidecar.
 * @param {object} s - The sidecar, parsed.
 * @param {number} durationMs - The recording's length, for when the sidecar has no start.
 * @param {number} [now] - The time now, in ms.
 * @returns {{startedAt: number, channelName: string|null, channelHz: number|null, details: object}} What to keep.
 */
export function readSidecar(s, durationMs, now = Date.now()) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    throw Object.assign(new Error('the recording\'s description isn\'t a JSON object'), { status: 400 });
  }
  const start = Date.parse(s.start);
  const startedAt = Number.isFinite(start) ? start : now - Math.round(durationMs);
  const details = {};
  for (const k of DETAILS) {
    const v = text(s[k]);
    if (v !== null) details[k] = v;
  }
  // Filed under the name the scanner shows: a conventional channel's, or a talkgroup's
  const channelName = text(s.channel, 60) ?? (details.talkgroup ? `TG ${details.talkgroup}` : null)
    ?? text(s.department, 60) ?? text(s.frequency, 60);
  return { startedAt, channelName, channelHz: frequencyHz(s.frequency), details };
}
